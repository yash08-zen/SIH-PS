import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeech } from '../src/speech/speech.js';
import { createEndpointer, downsample, encodeWav } from '../src/speech/recorder.js';

// ---------- Bhashini speech through the server, with the browser as the fallback ----------
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, blob: async () => new Blob(['RIFFxxxx']) });
const noBrowser = { navigator: { mediaDevices: { getUserMedia() {} } } };
class FakeAudio { constructor(url) { this.url = url; FakeAudio.last = this; } play() { setTimeout(() => this.onended?.(), 0); return Promise.resolve(); } pause() { this.paused = true; } }
globalThis.URL.createObjectURL ??= () => 'blob:fake';

test('the WAV encoder writes a 16 kHz mono 16-bit file and the downsampler averages down to the target rate', () => {
  const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000));
  const tag = (at) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(at + i)));
  assert.deepEqual([tag(0), tag(8), tag(12), tag(36)], ['RIFF', 'WAVE', 'fmt ', 'data']);
  assert.deepEqual([wav.getUint16(20, true), wav.getUint16(22, true), wav.getUint32(24, true), wav.getUint16(34, true)], [1, 1, 16000, 16]);
  assert.equal(wav.byteLength, 44 + 8);
  assert.equal(wav.getInt16(46, true), 32767);
  assert.equal(wav.getInt16(48, true), -32768);
  const down = downsample(new Float32Array([1, 3, 5, 7, 9, 11]), 48000, 16000);
  assert.deepEqual(Array.from(down), [3, 9]);
});

test('recording ends when the patient has spoken and gone quiet, gives up if nobody speaks, and adapts to a noisy room', () => {
  const rate = 16000, chunk = (level, ms = 100) => new Float32Array((rate * ms) / 1000).fill(level);
  const e = createEndpointer({ sampleRate: rate });
  const verdicts = [];
  for (let i = 0; i < 3; i++) verdicts.push(e.push(chunk(0.002)));     // the room's own noise, measured first
  for (let i = 0; i < 10; i++) verdicts.push(e.push(chunk(0.2)));      // speech
  for (let i = 0; i < 20; i++) verdicts.push(e.push(chunk(0.002)));    // quiet
  assert.equal(verdicts.find(Boolean), 'end');
  assert.equal(e.spoke, true);

  const silent = createEndpointer({ sampleRate: rate, startTimeoutMs: 2000 });
  let verdict = null;
  for (let i = 0; i < 30 && !verdict; i++) verdict = silent.push(chunk(0.001));
  assert.equal(verdict, 'nothing');

  const noisy = createEndpointer({ sampleRate: rate });
  for (let i = 0; i < 3; i++) noisy.push(chunk(0.05)); // a loud ward
  assert.equal(noisy.push(chunk(0.06)), null);
  assert.equal(noisy.spoke, false, 'steady ward noise is not speech');
  noisy.push(chunk(0.4));
  assert.equal(noisy.spoke, true);
});

test('with Bhashini on, listen records, sends the WAV to the server and returns its transcript', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/status')) return json({ enabled: true, provider: 'bhashini', recognition: true, synthesis: true });
    return json({ transcript: 'माझे गुडघे दुखतात', confidence: null, alternatives: ['माझे गुडघे दुखतात'] });
  };
  const s = createSpeech(noBrowser, { fetchImpl, record: async () => new ArrayBuffer(300) });
  assert.equal(s.canListen, false, 'not known to be on until the server has said');
  assert.deepEqual(await s.listen('mr'), { transcript: 'माझे गुडघे दुखतात', confidence: null, alternatives: ['माझे गुडघे दुखतात'] });
  assert.equal(s.provider, 'bhashini');
  assert.equal(s.canListen, true);
  const sent = calls.find((c) => c.url.includes('/transcribe'));
  assert.match(sent.url, /lang=mr/);
  assert.equal(sent.init.headers['content-type'], 'audio/wav');
});

test('listen falls back to the browser recognizer when the server fails, and says "no speech" when none was heard', async () => {
  class Recognition { start() { this.onresult({ results: [[{ transcript: 'browser words', confidence: 0.9 }]] }); } }
  const failing = async (url) => (url.endsWith('/status') ? json({ enabled: true, recognition: true }) : json({ error: 'speech_unavailable' }, 502));
  const s = createSpeech({ ...noBrowser, webkitSpeechRecognition: Recognition }, { fetchImpl: failing, record: async () => new ArrayBuffer(300) });
  assert.equal((await s.listen('en')).transcript, 'browser words');

  const quiet = async (url) => (url.endsWith('/status') ? json({ enabled: true, recognition: true }) : json({ error: 'no_speech' }, 422));
  const q = createSpeech({ ...noBrowser, webkitSpeechRecognition: Recognition }, { fetchImpl: quiet, record: async () => new ArrayBuffer(300) });
  await assert.rejects(q.listen('en'), /no-speech/);

  const denied = createSpeech(noBrowser, { fetchImpl: failing, record: async () => { throw new Error('denied'); } });
  await assert.rejects(denied.listen('en'), /denied/);
  const none = createSpeech(noBrowser, { fetchImpl: failing, record: async () => new ArrayBuffer(300) });
  await assert.rejects(none.listen('en'), /network/, 'no browser recognizer to fall back to');
});

test('with Bhashini on, speak plays the server audio (and remembers it); when the server fails the browser voice speaks', async () => {
  let synth = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/status')) return json({ enabled: true, provider: 'bhashini', synthesis: true });
    synth++;
    return json({}, 200);
  };
  const s = createSpeech({ Audio: FakeAudio, navigator: {} }, { fetchImpl });
  assert.equal(await s.speak('तुम्हाला कुठे दुखते?', 'mr', { rate: 0.8 }), true);
  assert.equal(FakeAudio.last.playbackRate, 0.8);
  await s.speak('तुम्हाला कुठे दुखते?', 'mr');
  assert.equal(synth, 1, 'the same prompt is fetched once');
  assert.equal(s.canSpeak, true, 'the server voice counts when the browser has none');

  const spoken = [];
  class Utterance { constructor(text) { this.text = text; } }
  const broken = async (url) => (url.endsWith('/status') ? json({ enabled: true, synthesis: true }) : json({ error: 'speech_unavailable' }, 502));
  const env = { Audio: FakeAudio, SpeechSynthesisUtterance: Utterance, speechSynthesis: { cancel() {}, getVoices: () => [], speak(u) { spoken.push(u.text); u.onend(); } } };
  assert.equal(await createSpeech(env, { fetchImpl: broken }).speak('hello', 'en'), true);
  assert.deepEqual(spoken, ['hello']);
});

test('when the server has Bhashini off, speech stays entirely in the browser', async () => {
  const fetchImpl = async () => json({ enabled: false, provider: 'browser' });
  const spoken = [];
  class Utterance { constructor(text) { this.text = text; } }
  const env = { SpeechSynthesisUtterance: Utterance, speechSynthesis: { cancel() {}, getVoices: () => [], speak(u) { spoken.push(u.text); u.onend(); } } };
  const s = createSpeech(env, { fetchImpl });
  assert.equal(await s.speak('नमस्ते', 'hi'), true);
  assert.equal(s.provider, 'browser');
  assert.deepEqual(spoken, ['नमस्ते']);
});
