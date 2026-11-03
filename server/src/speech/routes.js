import express from 'express';
import { audit, LANGS } from '../patients.js';

export const MAX_AUDIO_BYTES = 1_500_000; // about 45 seconds of 16 kHz mono WAV; an answer is at most 12 seconds
export const MAX_TEXT = 700;

// Mounted under /api/patient/speech behind the session and the history consent. The audio and the words are never stored or logged: the
// audit entry holds only the language, the size and whether it worked. A failure answers 502 so the screen falls back to the browser's own speech.
export function createSpeechRouter({ pool, speech }) {
  const router = express.Router();
  const langOf = (req, fallback) => (LANGS.includes(req.query.lang) ? req.query.lang : fallback);
  const record = (req, action, detail) => audit(pool, { actorType: 'patient', actorId: req.user.sub, action, objectType: 'encounter', objectId: req.pSession.encounter_id, detail: { provider: speech?.name ?? null, ...detail } });

  router.get('/status', (_req, res) => res.json({ enabled: Boolean(speech), provider: speech?.name ?? 'browser', recognition: Boolean(speech?.asr), synthesis: Boolean(speech?.tts) }));

  router.post('/transcribe', express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
    if (!speech?.asr) return res.status(503).json({ error: 'speech_unavailable' });
    const wav = req.body;
    if (!Buffer.isBuffer(wav) || wav.length < 100 || wav.subarray(0, 4).toString('latin1') !== 'RIFF') return res.status(400).json({ error: 'invalid_audio' });
    const lang = langOf(req, req.pSession.language);
    try {
      const transcript = await speech.asr(wav, lang);
      await record(req, 'speech_transcribed', { lang, bytes: wav.length, heard: Boolean(transcript) });
      if (!transcript) return res.status(422).json({ error: 'no_speech' });
      res.json({ transcript, confidence: null, alternatives: [transcript] });
    } catch (err) {
      await record(req, 'speech_transcribed', { lang, bytes: wav.length, ok: false, reason: String(err.message).slice(0, 120) });
      res.status(502).json({ error: 'speech_unavailable' });
    }
  });

  router.post('/synthesize', async (req, res) => {
    if (!speech?.tts) return res.status(503).json({ error: 'speech_unavailable' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > MAX_TEXT) return res.status(400).json({ error: 'invalid_input', fields: ['text'] });
    const lang = LANGS.includes(req.body.lang) ? req.body.lang : req.pSession.language;
    try {
      const wav = await speech.tts(text, lang);
      await record(req, 'speech_synthesized', { lang, chars: text.length });
      res.type('audio/wav').send(wav);
    } catch (err) {
      await record(req, 'speech_synthesized', { lang, chars: text.length, ok: false, reason: String(err.message).slice(0, 120) });
      res.status(502).json({ error: 'speech_unavailable' });
    }
  });

  return router;
}
