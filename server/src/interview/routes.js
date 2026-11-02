import express from 'express';
import { audit, LANGS } from '../patients.js';
import {
  AI_FOLLOWUPS, activeQuestions, deriveFromReason, displayAnswer, findQuestion, getQuestion, isAiKey, nextQuestion, presentQuestion, reviewList, staleKeys, structuredHistory, validateAnswer,
} from './dialogue.js';
import { MIN_FOLLOWUPS, checkQuestion, interviewFacts } from '../ai/interviewer.js';
import { ageBand } from '../ai/facts.js';

// Questions that can be filled from the reason in the patient's own words (dialogue.js deriveFromReason).
const DERIVABLE = ['cc.main', 'cc.duration'];

export const LISTENING_MODES = ['listen_speak', 'listen_tap', 'read_tap'];
export const RECOGNITION_OFFER_TAP_AFTER = 2; // failed recognitions before tapping is offered
export const RECOGNITION_ALERT_AFTER = 3;     // a further failure alerts staff

// Mounted under /api/patient/interview behind the session and history-consent guards, so every route here is consent-checked.
export function createInterviewRouter({ pool, redFlags, narration, help, analysis, interviewer = null }) {
  const router = express.Router();
  const bad = (res, fields) => res.status(400).json({ error: 'invalid_input', fields });
  const langOf = (req) => (LANGS.includes(req.query.lang) ? req.query.lang : req.pSession.language);

  async function loadAnswers(encounterId) {
    const { rows } = await pool.query('SELECT question_key, answer, modality, confidence, confirmed FROM interview_responses WHERE encounter_id = $1', [encounterId]);
    return Object.fromEntries(rows.map((r) => [r.question_key, { ...r.answer, modality: r.modality, confidence: r.confidence, confirmed: r.confirmed }]));
  }
  // AYUSH mode (Phase 7) adds the AYUSH questions after the standard ones; it is set per encounter by the department or by staff.
  // The interview engine is fixed when the interview starts: the AI interviewer when one is configured, else the fixed question tree.
  // An interview already under way keeps its engine, so a change of settings never reorders questions mid-way.
  async function modeOf(encounterId) {
    const { rows: [e] } = await pool.query(
      `SELECT ayush_mode, interview_engine, ai_pending, ai_done, EXISTS (SELECT 1 FROM interview_responses r WHERE r.encounter_id = encounters.id) AS started
         FROM encounters WHERE id = $1`, [encounterId]);
    let engine = e.interview_engine;
    if (!engine) {
      engine = interviewer && !e.started ? 'ai' : 'rules';
      await pool.query('UPDATE encounters SET interview_engine = $2 WHERE id = $1 AND interview_engine IS NULL', [encounterId, engine]);
    }
    return { ayush: e.ayush_mode, engine, ai: { pending: e.ai_pending, done: e.ai_done || !interviewer } };
  }

  // Asks the AI interviewer for the next question. What it proposes is checked (ai/interviewer.js checkQuestion); a refused or failed
  // proposal ends the AI part (the interview goes on to its end), or, before any AI question, hands over to the fixed question tree.
  async function writeAiQuestion(req, answers, mode) {
    const enc = req.pSession.encounter_id;
    const asked = activeQuestions(answers, mode).filter((q) => answers[q.key] && !answers[q.key].derived);
    const aiCount = Object.keys(answers).filter(isAiKey).length;
    const { rows: [p] } = await pool.query('SELECT sex, date_of_birth FROM patients WHERE id = $1', [req.user.sub]);
    const age = p.date_of_birth ? new Date().getUTCFullYear() - Number(String(p.date_of_birth).slice(0, 4)) : null;
    const facts = interviewFacts({
      reason: answers['cc.reason']?.skipped ? null : answers['cc.reason']?.value ?? null, ageGroup: ageBand(age), sex: p.sex ?? null,
      asked: asked.map((q) => ({ question: q.text[0], answer: answers[q.key].skipped ? 'not answered' : displayAnswer(q, answers[q.key], 'en') })),
      remaining: AI_FOLLOWUPS - aiCount, minimumStillNeeded: Math.max(0, MIN_FOLLOWUPS - aiCount),
    });
    // The model decides when it has enough, but not before the minimum: an early "done" is asked again once, then the interview moves on.
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = checkQuestion(await interviewer.next(facts), asked.map((q) => q.text[0]));
      } catch (err) {
        result = { ok: false, reason: `the model could not be used: ${String(err.message).slice(0, 160)}` };
      }
      if (!(result.ok && result.done && facts.minimumStillNeeded > 0 && attempt === 0)) break;
    }
    if (result.ok && result.complaint && !answers['cc.main']) {
      await pool.query(
        `INSERT INTO interview_responses (encounter_id, question_key, answer, modality, confidence, confirmed) VALUES ($1, 'cc.main', $2, 'tap', NULL, false)
         ON CONFLICT (encounter_id, question_key) DO NOTHING`, [enc, { value: result.complaint, derived: true, from: 'ai' }]);
    }
    if (result.ok && result.attention) await helpRequest(req.user.sub, 'ai_attention', { note: result.attention });
    if (!result.ok && aiCount === 0) await pool.query(`UPDATE encounters SET interview_engine = 'rules', ai_pending = NULL WHERE id = $1`, [enc]);
    else if (!result.ok || result.done) await pool.query('UPDATE encounters SET ai_done = true, ai_pending = NULL WHERE id = $1', [enc]);
    else await pool.query('UPDATE encounters SET ai_pending = $2 WHERE id = $1', [enc, { ...result.question, key: `ai.${aiCount + 1}`, provider: interviewer.name, model: interviewer.model }]);
    await audit(pool, {
      actorType: 'system', action: 'ai_question_written', objectType: 'encounter', objectId: enc,
      detail: { provider: interviewer.name, model: interviewer.model, ok: result.ok, done: Boolean(result.done), reason: result.reason ?? null, attention: Boolean(result.attention) },
    });
  }

  // The next question, asking the AI interviewer to write it when the AI part needs one (at most once per call).
  async function nextFor(req, answers) {
    let mode = await modeOf(req.pSession.encounter_id);
    let r = nextQuestion(answers, mode);
    if (r.needsAi && interviewer) {
      await writeAiQuestion(req, answers, mode);
      answers = await loadAnswers(req.pSession.encounter_id);
      mode = await modeOf(req.pSession.encounter_id);
      r = nextQuestion(answers, mode);
    }
    return { ...r, answers, mode };
  }
  const helpRequest = (patientId, reason, detail) => help.create(patientId, reason, detail);

  router.get('/state', async (req, res) => {
    const { rows: [e] } = await pool.query('SELECT listening_mode FROM encounters WHERE id = $1', [req.pSession.encounter_id]);
    const { answered, total, question, needsAi, mode } = await nextFor(req, await loadAnswers(req.pSession.encounter_id));
    // The patient only learns that staff know, never why (FR-P5): a bare yes or no, no level and no clinical wording.
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM alerts WHERE encounter_id = $1', [req.pSession.encounter_id]);
    res.json({ listeningMode: e.listening_mode, language: req.pSession.language, progress: { answered, total }, done: !question && !needsAi, staffNotified: n > 0, ayush: mode.ayush, engine: mode.engine });
  });

  // The mode applies from the next question; the client shows it from then on (FR-A9, FR-A11).
  router.put('/listening-mode', async (req, res) => {
    if (!LISTENING_MODES.includes(req.body?.mode)) return bad(res, ['mode']);
    await pool.query('UPDATE encounters SET listening_mode = $2 WHERE id = $1', [req.pSession.encounter_id, req.body.mode]);
    await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'listening_mode_set', objectType: 'encounter', objectId: req.pSession.encounter_id, detail: { mode: req.body.mode } });
    res.json({ listeningMode: req.body.mode });
  });

  router.get('/next', async (req, res) => {
    const { question, answered, total, answers } = await nextFor(req, await loadAnswers(req.pSession.encounter_id));
    const { rows: [e] } = await pool.query('SELECT listening_mode FROM encounters WHERE id = $1', [req.pSession.encounter_id]);
    res.json({ done: !question, question: question ? presentQuestion(question, langOf(req), answers) : null, listeningMode: e.listening_mode, progress: { answered, total } });
  });

  // Fetch one reachable question with its current answer, so the patient can correct it from the review screen.
  router.get('/question/:key', async (req, res) => {
    const answers = await loadAnswers(req.pSession.encounter_id);
    const q = findQuestion(req.params.key, answers, await modeOf(req.pSession.encounter_id));
    if (!q) return res.status(404).json({ error: 'not_found' });
    const a = answers[q.key];
    res.json({ question: presentQuestion(q, langOf(req), answers), current: a ? (a.skipped ? { skipped: true } : { value: a.value }) : null });
  });

  router.post('/answer', async (req, res) => {
    const { questionKey, value, skipped, modality, confidence, transcript, confirmation } = req.body ?? {};
    const answers = await loadAnswers(req.pSession.encounter_id);
    // Constrained by the ontology (or the AI question the system accepted): only a question on the patient's path can be answered.
    const mode = await modeOf(req.pSession.encounter_id);
    const q = typeof questionKey === 'string' ? findQuestion(questionKey, answers, mode) : null;
    if (!q) return res.status(422).json({ error: 'question_not_available' });
    if (!['voice', 'tap'].includes(modality)) return bad(res, ['modality']);
    if (confidence != null && !(typeof confidence === 'number' && confidence >= 0 && confidence <= 1)) return bad(res, ['confidence']);

    let stored;
    let confirmed = true;
    if (skipped === true) {
      stored = { skipped: true }; // recorded as "not answered", never as "no"
      confirmed = false;
    } else {
      if (!validateAnswer(q, value)) return bad(res, ['value']);
      stored = { value };
      if (typeof transcript === 'string') stored.transcript = transcript.slice(0, 500);
      if (q.critical) {
        // Allergies, medicines and emergency symptoms are confirmed on screen AND by audio (PRD 8.5, FR-A17).
        const ok = confirmation?.visual === true && (confirmation.audio === true || confirmation.audioUnavailable === true);
        if (!ok) return res.status(400).json({ error: 'critical_confirmation_required', needs: ['visual', 'audio'] });
        stored.confirmation = { visual: true, audio: confirmation.audio === true, audioUnavailable: confirmation.audioUnavailable === true };
        if (confirmation.audioUnavailable) await helpRequest(req.user.sub, 'critical_answer_audio_unavailable', { questionKey });
      }
      if (q.type === 'text') stored.extracted = narration.map(value); // mapper input is `value`, output is stored beside it
    }
    // An AI question is kept with its answer, so the record shows exactly what was asked, by which model and why.
    if (q.ai) {
      stored.question = { ...q };
      delete stored.question.key;
    }

    const enc = req.pSession.encounter_id;
    await pool.query(
      `INSERT INTO interview_responses (encounter_id, question_key, answer, modality, confidence, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (encounter_id, question_key) DO UPDATE SET answer = $3, modality = $4, confidence = $5, confirmed = $6`,
      [enc, q.key, stored, modality, confidence ?? null, confirmed]);

    // The reason in the patient's own words: what it names is filled in (and need not be asked); what it no longer names is
    // asked again. An answer the patient chose themselves is only replaced when the new words name something definite.
    if (q.key === 'cc.reason') {
      const derived = stored.skipped ? {} : deriveFromReason(stored.extracted);
      for (const k of DERIVABLE) {
        if (k in derived) {
          await pool.query(
            `INSERT INTO interview_responses (encounter_id, question_key, answer, modality, confidence, confirmed) VALUES ($1, $2, $3, $4, NULL, false)
             ON CONFLICT (encounter_id, question_key) DO UPDATE SET answer = $3, modality = $4, confidence = NULL, confirmed = false`,
            [enc, k, { value: derived[k], derived: true, from: 'cc.reason' }, modality]);
        } else {
          await pool.query(`DELETE FROM interview_responses WHERE encounter_id = $1 AND question_key = $2 AND (answer->>'derived')::boolean IS TRUE`, [enc, k]);
        }
      }
    }

    if (q.ai && mode.ai.pending?.key === q.key) await pool.query('UPDATE encounters SET ai_pending = NULL WHERE id = $1', [enc]);

    const fresh = await loadAnswers(enc);
    const after = await modeOf(enc);
    const stale = staleKeys(fresh, after);
    if (stale.length) {
      await pool.query('DELETE FROM interview_responses WHERE encounter_id = $1 AND question_key = ANY($2)', [enc, stale]);
      for (const k of stale) delete fresh[k];
    }
    // Medicine and allergy answers feed the cross-document analysis (Phase 5), so it is rebuilt when one changes.
    if ([q.key, ...stale].some((k) => /^(drug|allergy)\./.test(k))) analysis?.schedule(enc, 'answers_changed');
    await pool.query(
      `UPDATE patient_sessions SET speech_failures = speech_failures - $2::text WHERE id = $1`, [req.pSession.id, q.key]);
    await pool.query(`UPDATE encounters SET status = 'in_intake' WHERE id = $1 AND status = 'registered'`, [enc]);
    await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'history_answer_saved', objectType: 'encounter', objectId: enc, detail: { questionKey: q.key, skipped: Boolean(stored.skipped), modality } });

    // Red-flag evaluation after every answer (Phase 3 supplies the rules).
    const flags = await redFlags.evaluate({ encounterId: enc, patientId: req.user.sub, answers: fresh, changedKey: q.key });
    const { answered, total, question, needsAi } = nextQuestion(fresh, after);
    res.json({
      saved: true, pruned: stale, done: !question && !needsAi, progress: { answered, total },
      ...(stored.extracted ? { suggestions: stored.extracted } : {}),
      ...(flags?.length ? { staffNotified: true } : {}), // the patient is never told what was flagged
    });
  });

  // Two failed recognitions offer tapping; a further failure alerts staff (PRD 8.5).
  router.post('/recognition-failure', async (req, res) => {
    const key = req.body?.questionKey;
    if (typeof key !== 'string' || (!getQuestion(key) && !isAiKey(key))) return bad(res, ['questionKey']);
    const { rows: [s] } = await pool.query(
      `UPDATE patient_sessions SET speech_failures = jsonb_set(speech_failures, ARRAY[$2::text], to_jsonb(COALESCE((speech_failures->>$2)::int, 0) + 1))
        WHERE id = $1 RETURNING speech_failures`, [req.pSession.id, key]);
    const failures = s.speech_failures[key];
    const alertedStaff = failures === RECOGNITION_ALERT_AFTER;
    if (alertedStaff) await helpRequest(req.user.sub, 'speech_recognition_failed', { questionKey: key, failures });
    res.json({ failures, offerTap: failures >= RECOGNITION_OFFER_TAP_AFTER, alertedStaff: failures >= RECOGNITION_ALERT_AFTER });
  });

  router.get('/review', async (req, res) => {
    res.json({ items: reviewList(await loadAnswers(req.pSession.encounter_id), langOf(req), await modeOf(req.pSession.encounter_id)) });
  });

  router.get('/history', async (req, res) => {
    res.json({ sections: structuredHistory(await loadAnswers(req.pSession.encounter_id), langOf(req), await modeOf(req.pSession.encounter_id)) });
  });

  return router;
}
