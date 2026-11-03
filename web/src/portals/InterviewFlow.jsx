import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useI18n } from '../i18n/index.jsx';
import Icon from '../components/Icon.jsx';
import IconButton from '../components/IconButton.jsx';
import { Choice, MIC_ERROR, VoiceField } from '../components/Fields.jsx';
import { audioCue, speech } from '../speech/speech.js';
import { isConfident, labelFor, matchSpokenAny } from '../interview/matching.js';
import { MODE_ICONS, MODES, modeForNextQuestion, presentation } from '../interview/presentation.js';

// The history interview (Module A): adaptive questions by voice or touch, with a read-back, a review screen and recovery.
export default function InterviewFlow({ onComplete }) {
  const { t, lang } = useI18n();
  const [step, setStep] = useState('loading'); // loading | mode | question | review | done
  const [mode, setMode] = useState(null);       // the chosen listening mode
  const [shownMode, setShownMode] = useState(null); // the mode the current question is shown in
  const pendingMode = useRef(null);
  const [pickingMode, setPickingMode] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [question, setQuestion] = useState(null);
  const [progress, setProgress] = useState({ answered: 0, total: 0 });
  const [draft, setDraft] = useState(null);         // the answer waiting for the patient's confirmation
  const [heard, setHeard] = useState(null);         // { transcript, confidence } when the draft came from voice
  const [audioDone, setAudioDone] = useState(false);
  const [showTap, setShowTap] = useState(false);
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState(''); // the words heard so far, shown while the patient speaks
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [calm, setCalm] = useState(false); // staff have been told; the patient sees only a calm message, never why
  const trail = useRef([]); // keys answered in this run, for the Back button

  const present = presentation(shownMode);

  const speak = useCallback((text, rate = 1) => (speech.canSpeak ? speech.speak(text, lang, { rate }) : Promise.resolve(false)), [lang]);

  const reset = () => { setDraft(null); setHeard(null); setAudioDone(false); setShowTap(false); setMessage(''); };

  const showQuestion = useCallback((payload, currentMode, current = null) => {
    const m = modeForNextQuestion(currentMode, pendingMode.current);
    pendingMode.current = null;
    setMode(m);
    setShownMode(m);
    setQuestion(payload);
    reset();
    if (current && !current.skipped) setDraft(current.value);
    setStep('question');
  }, []);

  const loadNext = useCallback(async (currentMode) => {
    // With the AI interviewer the next question is written from the last answer, which can take a few seconds.
    setPreparing(true);
    const r = await api(`/patient/interview/next?lang=${lang}`).finally(() => setPreparing(false));
    if (!r.ok) { setMessage(t('signin.error.network')); return; }
    setProgress(r.body.progress);
    if (r.body.done) {
      const rev = await api(`/patient/interview/review?lang=${lang}`);
      setReview(rev.body.items ?? []);
      setStep('review');
      return;
    }
    showQuestion(r.body.question, currentMode ?? r.body.listeningMode);
  }, [lang, showQuestion, t]);

  // Start, or resume where the patient stopped: the server knows which questions are answered.
  useEffect(() => {
    api('/patient/interview/state').then((r) => {
      if (!r.ok) return;
      setCalm(Boolean(r.body.staffNotified));
      if (!r.body.listeningMode) { setStep('mode'); return; }
      setVoiceOn(r.body.listeningMode !== 'read_tap');
      loadNext(r.body.listeningMode);
    }).catch(() => setMessage(t('signin.error.network')));
  }, []);

  // Switching language mid-interview re-fetches the same question in the new language; answers are language-neutral.
  useEffect(() => {
    if (step !== 'question' || !question) return;
    api(`/patient/interview/question/${question.key}?lang=${lang}`).then((r) => { if (r.ok) setQuestion(r.body.question); });
  }, [lang]);
  useEffect(() => {
    if (step !== 'review') return;
    api(`/patient/interview/review?lang=${lang}`).then((r) => { if (r.ok) setReview(r.body.items); });
  }, [lang, step]);

  // Learn whether the server has Bhashini speech on, so the voice controls match what is available.
  const [, setSpeechProvider] = useState(null);
  useEffect(() => { speech.prepare().then(() => setSpeechProvider(speech.provider)); }, []);

  // Speak each new question when listening is on (FR-A8).
  useEffect(() => {
    if (step === 'question' && question && present?.speakPrompt && voiceOn) speak(question.text);
    return () => speech.stopSpeaking();
  }, [question?.key, step]);

  // A typed or dictated critical answer (medicines, allergies) is read back automatically once the patient stops typing.
  useEffect(() => {
    if (step !== 'question' || !question?.critical || question.type !== 'text' || !draft) return undefined;
    const timer = setTimeout(() => readBack(draft), 1200);
    return () => clearTimeout(timer);
  }, [draft, question?.key, step]);

  const chooseMode = async (m) => {
    const r = await api('/patient/interview/listening-mode', { method: 'PUT', body: { mode: m } });
    if (!r.ok) return;
    setVoiceOn(m !== 'read_tap');
    if (step === 'mode') { setMode(m); setShownMode(m); await loadNext(m); } else { pendingMode.current = m; setMode(m); }
    setPickingMode(false);
  };

  const draftText = draft == null || !question ? '' : labelFor(question, draft);
  const choose = (value) => {
    audioCue();
    setDraft(value);
    setHeard(null);
    setMessage('');
    if (question.critical) readBack(value);
    else if (voiceOn) speak(t('interview.youAnswered', { answer: labelFor(question, value) }));
  };

  // Critical answers are always read aloud, in every listening mode, and must finish before Next (PRD 8.5).
  const readBack = async (value) => {
    setAudioDone(false);
    const ok = await speak(t('interview.youAnswered', { answer: labelFor(question, value) }));
    setAudioDone(ok);
  };

  const listen = async () => {
    audioCue();
    setListening(true);
    setLiveText('');
    setMessage('');
    let said = '';
    try {
      const { transcript, confidence, alternatives = [transcript] } = await speech.listen(lang, { onInterim: setLiveText });
      said = transcript;
      // Every guess the recognizer offers is tried, best first, before the answer counts as not understood.
      const match = isConfident(confidence) ? matchSpokenAny(question, lang, alternatives) : null;
      if (!match) throw new Error('no-match');
      setDraft(match.value);
      setHeard({ transcript: match.transcript, confidence });
      if (question.critical) readBack(match.value);
      else speak(t('interview.youSaid', { answer: labelFor(question, match.value) }));
    } catch (e) {
      // Problems with the microphone itself are not the patient's answer: say what to do, offer tapping, and do not count a failure.
      if (MIC_ERROR[e.message]) { setShowTap(true); setMessage(t(MIC_ERROR[e.message])); }
      else {
        const r = await api('/patient/interview/recognition-failure', { method: 'POST', body: { questionKey: question.key } });
        const notCaught = said ? t('interview.heardNoMatch', { text: said }) : t('interview.notCaught');
        setMessage(r.body.alertedStaff ? t('interview.staffNotified') : notCaught);
        if (r.body.offerTap) setShowTap(true);
        speak(t('interview.notCaught'));
      }
    } finally {
      setListening(false);
      setLiveText('');
    }
  };

  const submit = async (skipped) => {
    setBusy(true);
    const body = skipped
      ? { questionKey: question.key, skipped: true, modality: 'tap' }
      : {
          questionKey: question.key, value: draft, modality: heard ? 'voice' : 'tap',
          ...(heard ? { confidence: heard.confidence ?? undefined, transcript: heard.transcript } : {}),
          ...(question.critical ? { confirmation: { visual: true, audio: audioDone, audioUnavailable: !speech.canSpeak } } : {}),
        };
    const r = await api('/patient/interview/answer', { method: 'POST', body });
    setBusy(false);
    if (!r.ok) { setMessage(t('flow.error.invalid')); return; }
    if (r.body.staffNotified) setCalm(true);
    trail.current.push(question.key);
    await loadNext(mode);
  };

  const back = async () => {
    const key = trail.current.pop();
    if (!key) return;
    const r = await api(`/patient/interview/question/${key}?lang=${lang}`);
    if (r.ok) { setProgress((p) => ({ ...p, answered: Math.max(0, p.answered - 1) })); showQuestion(r.body.question, mode, r.body.current); }
  };

  const editFromReview = async (key) => {
    const r = await api(`/patient/interview/question/${key}?lang=${lang}`);
    if (r.ok) showQuestion(r.body.question, mode, r.body.current);
  };

  const help = async () => {
    await api('/patient/help', { method: 'POST', body: { screen: `interview:${question?.key ?? step}` } });
    setMessage(t('interview.helpSent'));
  };

  const finish = () => { setStep('done'); onComplete?.(); };

  const canNext = draft != null && (!question?.critical || audioDone || !speech.canSpeak);

  // ---------- pieces ----------
  const modeCards = (
    <section>
      <h1>{t('interview.mode.title')}</h1>
      <div className="choices">
        {MODES.map((m) => (
          <Choice key={m} selected={mode === m} onClick={() => chooseMode(m)}>
            <span className="mode-card">
              <span className="mode-icons">{MODE_ICONS[m].map((n) => <Icon key={n} name={n} size={40} />)}</span>
              <span>{t(`interview.mode.${m}`)}</span>
              <small className="mode-desc">{t(`interview.mode.${m}.desc`)}</small>
            </span>
          </Choice>
        ))}
      </div>
      {step !== 'mode' && <IconButton name="back" onClick={() => setPickingMode(false)} />}
      <p className="draft-note">{step !== 'mode' && t('interview.mode.nextQuestion')}</p>
    </section>
  );

  // The help button is on every screen (FR-A18).
  const calmBox = calm && <p role="status" className="calm-box">{t('interview.calm')}</p>;
  const helpBar = (
    <>
      <div className="flow-nav">
        <span />
        <IconButton name="help" onClick={help} />
        {message && <p role="status" className="ok big-note">{message}</p>}
      </div>
      {calmBox}
    </>
  );

  if (step === 'loading') return <p className="lead">{t('interview.loading')}</p>;
  if (step === 'mode' || pickingMode) return <div className="flow">{helpBar}{modeCards}</div>;

  if (step === 'review') {
    return (
      <div className="flow">
        {helpBar}
        <section>
          <h1>{t('interview.review.title')}</h1>
          {review.map((i) => (
            <div key={i.key} className="review-row">
              <div>
                <p className="review-q">{i.question}</p>
                <p className="review-a">{i.skipped ? <em>{t('interview.review.notAnswered')}</em> : i.answer}</p>
              </div>
              <button type="button" className="touch" onClick={() => editFromReview(i.key)}>{t('interview.change')}</button>
            </div>
          ))}
          <button type="button" className="touch primary big" onClick={finish}><Icon name="next" size={28} /> {t('interview.review.allCorrect')}</button>
        </section>
      </div>
    );
  }

  // The AYUSH history is long, so the patient can stop here: every answer is already saved, and signing in again continues at this question.
  if (step === 'paused') {
    return (
      <div className="flow">
        {helpBar}
        <section>
          <h1>{t('interview.paused.title')}</h1>
          <p className="lead">{t('interview.paused.body')}</p>
          <button type="button" className="touch primary big" onClick={() => loadNext(mode)}>{t('interview.paused.continue')}</button>
        </section>
      </div>
    );
  }

  if (step === 'done') {
    return (
      <div className="flow">
        {helpBar}
        <section>
          <h1>{t('interview.done.title')}</h1>
          <p className="lead">{t('interview.done.body')}</p>
        </section>
      </div>
    );
  }

  // ---------- one question ----------
  const q = question;
  const showOptions = present.showOptions || showTap;
  return (
    <div className="flow interview">
      <div className="flow-nav">
        <button type="button" className="touch icon-button" onClick={() => setPickingMode(true)}>
          <span className="mode-icons">{MODE_ICONS[mode].map((n) => <Icon key={n} name={n} size={24} />)}</span>
          <span>{t(`interview.mode.${mode}`)}</span>
        </button>
        <IconButton name="listen" state={voiceOn ? 'active' : 'off'} label={`${t('icon.listen')}: ${t(voiceOn ? 'state.on' : 'state.off')}`} onClick={() => setVoiceOn((v) => !v)} />
        <IconButton name="help" onClick={help} />
      </div>
      {calmBox}
      <p className="progress">{t('interview.progress', { n: progress.answered + 1, total: progress.total })}
        {progress.total > 30 && <> <button type="button" className="linklike" onClick={() => setStep('paused')}>{t('interview.pause')}</button></>}</p>
      {preparing && <p className="preparing" role="status"><span className="spinner" aria-hidden="true" />{t('interview.preparing')}</p>}
      <div className="qbar" aria-hidden="true"><i style={{ width: `${progress.total ? Math.min(100, (progress.answered / progress.total) * 100) : 0}%` }} /></div>

      <section key={q.key}>
        {q.followUp && <span className="badge"><Icon name="followup" size={20} /> {t('icon.followup')}</span>}
        <h1>{q.text}</h1>
        {q.critical && <p className="draft-note">{t('interview.criticalNote')}</p>}
        {q.type === 'multi' && <p className="draft-note">{t('interview.chooseMany')}</p>}

        {present.openMic && !showOptions && q.type !== 'text' && (
          <div>
            <button type="button" className={`touch mic-big${listening ? ' is-listening' : ''}`} onClick={listen} disabled={listening}>
              <Icon name="speak" size={56} /> <span>{listening ? t('interview.listening') : t('interview.speakNow')}</span>
            </button>
          </div>
        )}
        {listening && <p className="live-words" aria-live="polite">{liveText ? `“${liveText}”` : t('flow.mic.listening')}</p>}

        {showOptions && ['yes_no', 'single'].includes(q.type) && (
          <div className="choices">
            {q.options.map((o) => <Choice key={o.value} selected={draft === o.value} onClick={() => choose(o.value)}>{q.type === 'yes_no' ? `${o.value === 'yes' ? '✔' : '✖'} ` : ''}{o.label}</Choice>)}
          </div>
        )}
        {showOptions && q.type === 'multi' && (
          <div className="choices">
            {q.options.map((o) => {
              const on = Array.isArray(draft) && draft.includes(o.value);
              return (
                <Choice key={o.value} selected={on} onClick={() => {
                  const cur = Array.isArray(draft) ? draft : [];
                  let next = on ? cur.filter((v) => v !== o.value) : o.value === 'none' ? ['none'] : [...cur.filter((v) => v !== 'none'), o.value];
                  if (!next.length) next = null;
                  if (next) choose(next); else { setDraft(null); setAudioDone(false); }
                }}>{on ? '✔ ' : ''}{o.label}</Choice>
              );
            })}
          </div>
        )}
        {q.type === 'number' && (showOptions || q.scale) && (
          <>
            <p className="draft-note">{t('interview.chooseNumber', { min: q.min, max: q.max })}</p>
            <div className="choices numbers">
              {Array.from({ length: q.max - q.min + 1 }, (_, i) => q.min + i).filter(() => q.max - q.min <= 10).map((n) => (
                <Choice key={n} selected={draft === n} onClick={() => choose(n)}>{n}</Choice>
              ))}
            </div>
            {q.max - q.min > 10 && (
              <div className="field"><input type="number" min={q.min} max={q.max} value={draft ?? ''} onChange={(e) => { const n = e.target.value === '' ? null : Number(e.target.value); if (n === null) setDraft(null); else choose(n); }} /></div>
            )}
          </>
        )}
        {q.type === 'text' && (
          <VoiceField label={t('interview.typeHere')} value={typeof draft === 'string' ? draft : ''}
            onChange={(v) => { setDraft(v.trim() ? v : null); setHeard(null); if (q.critical && v.trim()) setAudioDone(false); }}
            onVoice={(h) => { setHeard(h); if (q.critical) setAudioDone(false); }} />
        )}
        {q.type === 'text' && q.critical && draft && (
          <IconButton name="listen" label={t('icon.repeat')} onClick={() => readBack(draft)} />
        )}

        {message && <p role="alert" className="error big-note">{message}</p>}

        {draft != null && (
          <div className="confirm-box" role="status">
            <p className="lead">{t('interview.youAnswered', { answer: draftText })}</p>
            {q.critical && !audioDone && speech.canSpeak && <p className="draft-note">{t('interview.waitAudio')}</p>}
          </div>
        )}

        {/* Hearing and answering aids, kept apart from the moves between questions so the main choice is obvious. */}
        <div className="q-tools" role="group" aria-label={t('interview.tools')}>
          <span className="q-tools-label">{t('interview.tools')}</span>
          <IconButton name="repeat" onClick={() => speak(q.text)} />
          <IconButton name="slower" onClick={() => speak(q.text, 0.6)} />
          {present.openMic && q.type !== 'text' && <IconButton name="speak" onClick={listen} />}
          {q.type !== 'text' && <IconButton name="tap" state={showOptions ? 'active' : 'default'} onClick={() => setShowTap((v) => !v)} />}
        </div>
        <div className="controls q-actions">
          <IconButton name="back" onClick={back} state={trail.current.length ? 'default' : 'disabled'} />
          <span className="grow" />
          <IconButton name="skip" onClick={() => submit(true)} />
          <button type="button" className="touch primary big" disabled={!canNext || busy} onClick={() => submit(false)}>
            <Icon name="next" size={28} /> {t('icon.next')}
          </button>
        </div>
        {draft == null && <p className="field-hint">{t('interview.pickFirst')}</p>}
      </section>
    </div>
  );
}
