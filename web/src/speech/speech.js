// Speech adapter. Screens speak a prompt and listen for an answer through this one interface. When the server has Bhashini / AI4Bharat
// speech switched on (SPEECH_PROVIDER=bhashini, as the SIH 26047 statement names) the audio goes there; if it is off, unreachable or fails,
// the browser's own speech takes over, so a patient is never left without voice.
import { recordUtterance } from './recorder.js';

export const LOCALES = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };

// How long a single listen may run before it is stopped, so a missed "end of speech" never leaves the microphone open.
const MAX_LISTEN_MS = 12_000;
// Browser error codes, folded into the few cases the screens explain differently.
const ERRORS = { 'no-speech': 'no-speech', aborted: 'no-speech', 'not-allowed': 'denied', 'service-not-allowed': 'denied', 'audio-capture': 'no-mic', network: 'network' };

// Languages whose own voice may be missing from the device, and the voice to read their (Devanagari) text with instead. A Marathi text read by an
// English voice sounds garbled; the Hindi voice reads the same script correctly and is close enough to understand.
const FALLBACK_VOICE = { mr: ['mr-IN', 'hi-IN'], hi: ['hi-IN'], en: ['en-IN', 'en-GB', 'en-US'] };

// The best installed voice for the language, or null. Better voices first: a network ("Google", "Natural") voice over a basic local one.
export function pickVoice(voices, lang) {
  const list = Array.from(voices ?? []);
  for (const code of FALLBACK_VOICE[lang] ?? FALLBACK_VOICE.en) {
    const base = code.slice(0, 2);
    const match = list.filter((v) => (v.lang ?? '').replace('_', '-').toLowerCase() === code.toLowerCase())
      .concat(list.filter((v) => (v.lang ?? '').toLowerCase().startsWith(base) && !(v.lang ?? '').toLowerCase().startsWith(code.toLowerCase().slice(0, 5))));
    const best = match.find((v) => /google|natural|neural|online/i.test(v.name ?? '')) ?? match[0];
    if (best) return best;
  }
  return null;
}

// Voices load late in some browsers: wait briefly for them the first time.
function voicesOf(synth) {
  const now = synth.getVoices?.() ?? [];
  if (now.length || !synth.addEventListener) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => { synth.removeEventListener?.('voiceschanged', done); resolve(synth.getVoices?.() ?? []); };
    synth.addEventListener('voiceschanged', done);
    setTimeout(done, 700);
  });
}

export function createBrowserSpeech(env = globalThis) {
  const synth = env.speechSynthesis;
  const Recognition = env.SpeechRecognition ?? env.webkitSpeechRecognition;
  const Utterance = env.SpeechSynthesisUtterance;

  let latest = 0;
  return {
    canSpeak: Boolean(synth && Utterance),
    canListen: Boolean(Recognition),

    async speak(text, lang, { rate = 1 } = {}) {
      if (!synth || !Utterance) return false;
      synth.cancel();
      const turn = ++latest;
      const voice = pickVoice(await voicesOf(synth), lang);
      if (turn !== latest) return false; // a newer prompt (or a listen) took over while the voices were loading
      return new Promise((resolve) => {
        const u = new Utterance(text);
        u.lang = voice?.lang || LOCALES[lang] || LOCALES.en; // the voice's own language, so a Hindi voice reading Marathi is not asked for mr-IN
        if (voice) u.voice = voice;
        u.rate = lang === 'mr' && voice && !/^mr/i.test(voice.lang) ? Math.min(rate, 0.9) : rate; // a little slower when borrowing the Hindi voice
        u.onend = () => resolve(true);
        u.onerror = () => resolve(false);
        synth.speak(u);
      });
    },

    stopSpeaking() { latest++; synth?.cancel(); },

    // Resolves { transcript, confidence, alternatives }: the best guess plus the recognizer's other guesses, best first.
    // `onInterim(text)` receives the words while the patient is still speaking, so the screen can show them live.
    // Rejects with Error('unsupported' | 'no-speech' | 'denied' | 'no-mic' | 'network' | 'error').
    listen(lang, { onInterim } = {}) {
      if (!Recognition) return Promise.reject(new Error('unsupported'));
      // The prompt being read aloud would otherwise be picked up by the microphone as the patient's answer.
      latest++;
      synth?.cancel();
      return new Promise((resolve, reject) => {
        const r = new Recognition();
        r.lang = LOCALES[lang] ?? LOCALES.en;
        r.interimResults = Boolean(onInterim);
        r.continuous = false;
        r.maxAlternatives = 5;
        let settled = false;
        const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
        const timer = setTimeout(() => { try { r.stop(); } catch { /* already stopped */ } }, MAX_LISTEN_MS);

        r.onresult = (e) => {
          const results = Array.from(e.results ?? []);
          const final = results.find((res) => res.isFinal !== false);
          if (!final) {
            onInterim?.(results.map((res) => res[0]?.transcript ?? '').join(' ').trim());
            return;
          }
          const alternatives = Array.from(final).map((a) => a?.transcript?.trim()).filter(Boolean);
          if (!alternatives.length) return finish(reject, new Error('no-speech'));
          finish(resolve, { transcript: alternatives[0], confidence: final[0].confidence ?? null, alternatives });
        };
        r.onnomatch = () => finish(reject, new Error('no-speech'));
        r.onerror = (e) => finish(reject, new Error(ERRORS[e.error] ?? 'error'));
        r.onend = () => finish(reject, new Error('no-speech'));
        try { r.start(); } catch { finish(reject, new Error('error')); }
      });
    },
  };
}

const FAILED_STATUS_RETRY_MS = 30_000;

// The browser's speech, with the server's Bhashini speech in front of it when it is on. `fetchImpl` and `record` can be replaced (tests).
export function createSpeech(env = globalThis, { fetchImpl = env.fetch?.bind(env), record = (o) => recordUtterance({ env, ...o }) } = {}) {
  const browser = createBrowserSpeech(env);
  let state = null;      // { enabled, recognition, synthesis } once the server has said
  let checkedAt = -Infinity;
  let playing = null;    // the audio element speaking now
  let turn = 0;
  const cache = new Map();

  // Asks the server whether Bhashini speech is on. Needs a patient session, so a 401 (not signed in yet) is asked again later.
  async function prepare() {
    if (state || !fetchImpl || Date.now() - checkedAt < FAILED_STATUS_RETRY_MS) return Boolean(state?.enabled);
    checkedAt = Date.now();
    try {
      const r = await fetchImpl('/api/patient/speech/status', { credentials: 'same-origin' });
      if (r.ok) { state = await r.json(); checkedAt = -Infinity; }
    } catch { /* offline: the browser's speech is used */ }
    return Boolean(state?.enabled);
  }

  async function fetchAudio(text, lang) {
    const key = `${lang}|${text}`;
    if (cache.has(key)) return cache.get(key);
    const r = await fetchImpl('/api/patient/speech/synthesize', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang }) });
    if (!r.ok) throw new Error('speech unavailable');
    const url = URL.createObjectURL(await r.blob());
    if (cache.size >= 40) { URL.revokeObjectURL(cache.get(cache.keys().next().value)); cache.delete(cache.keys().next().value); }
    cache.set(key, url);
    return url;
  }

  function play(url, rate) {
    return new Promise((resolve) => {
      const a = new env.Audio(url);
      a.playbackRate = rate;
      playing = a;
      a.onended = () => resolve(true);
      a.onerror = () => resolve(false);
      a.play().catch(() => resolve(false));
    });
  }

  return {
    prepare,
    get provider() { return state?.enabled ? 'bhashini' : 'browser'; },
    get canSpeak() { return browser.canSpeak || Boolean(state?.synthesis); },
    get canListen() { return browser.canListen || Boolean(state?.recognition && env.navigator?.mediaDevices?.getUserMedia); },

    async speak(text, lang, opts = {}) {
      const mine = ++turn;
      if (await prepare() && state.synthesis && env.Audio) {
        try {
          browser.stopSpeaking();
          const url = await fetchAudio(text, lang);
          if (mine !== turn) return false; // a newer prompt took over while the audio was being fetched
          return await play(url, opts.rate ?? 1);
        } catch { /* fall back to the browser's voice */ }
      }
      return mine === turn ? browser.speak(text, lang, opts) : false;
    },

    stopSpeaking() {
      turn++;
      if (playing) { playing.pause(); playing = null; }
      browser.stopSpeaking();
    },

    // Same result and the same errors as the browser's listen. With Bhashini the words arrive when the patient stops speaking, not live.
    async listen(lang, opts = {}) {
      turn++;
      if (playing) { playing.pause(); playing = null; }
      if (await prepare() && state.recognition) {
        let wav;
        try { wav = await record(); } catch (err) {
          if (['denied', 'no-mic', 'no-speech'].includes(err.message)) throw err;
          if (!browser.canListen) throw new Error('error');
        }
        if (wav) {
          try {
            const r = await fetchImpl(`/api/patient/speech/transcribe?lang=${encodeURIComponent(lang)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'audio/wav' }, body: wav });
            if (r.ok) return r.json();
            if (r.status === 422) throw new Error('no-speech');
          } catch (err) { if (err.message === 'no-speech') throw err; }
          if (!browser.canListen) throw new Error('network');
        }
      }
      return browser.listen(lang, opts);
    },
  };
}

// Short tone on every selection, so the choice is confirmed without reading (PRD 8.3).
export function audioCue(env = globalThis) {
  const Ctx = env.AudioContext ?? env.webkitAudioContext;
  if (!Ctx) return false;
  try {
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
    osc.onended = () => ctx.close();
    return true;
  } catch {
    return false;
  }
}

export const speech = createSpeech();
