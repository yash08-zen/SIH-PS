import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { createBhashiniSpeech, speechFromEnv } from '../src/speech/bhashini.js';

const ALL = { history: true, documents: true, his_sharing: false, abha_linking: false };
const wav = (n = 400) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(n, 1)]);

// A stand-in for Bhashini's two calls: the ULCA configuration call and the inference call.
function fakeBhashini() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const task = body.pipelineTasks[0].taskType;
    if (url.includes('getModelsPipeline')) {
      return { ok: true, status: 200, json: async () => ({
        pipelineResponseConfig: [{ taskType: task, config: [{ serviceId: `svc-${task}-${body.pipelineTasks[0].config.language.sourceLanguage}` }] }],
        pipelineInferenceAPIEndPoint: { callbackUrl: 'https://inference.example/pipeline', inferenceApiKey: { name: 'Authorization', value: 'inference-token' } },
      }) };
    }
    if (task === 'asr') return { ok: true, status: 200, json: async () => ({ pipelineResponse: [{ taskType: 'asr', output: [{ source: ' माझे गुडघे दुखतात ' }] }] }) };
    return { ok: true, status: 200, json: async () => ({ pipelineResponse: [{ taskType: 'tts', audio: [{ audioContent: wav(50).toString('base64') }] }] }) };
  };
  return { calls, fetchImpl };
}

test('the Bhashini client asks for the model first, then sends audio or text with the inference key it was given', async () => {
  const f = fakeBhashini();
  const b = createBhashiniSpeech({ userId: 'u1', apiKey: 'ulca-key', fetchImpl: f.fetchImpl });
  assert.equal(await b.asr(wav(), 'mr'), 'माझे गुडघे दुखतात');
  const [conf, inference] = f.calls;
  assert.equal(conf.headers.userID, 'u1');
  assert.equal(conf.headers.ulcaApiKey, 'ulca-key');
  assert.equal(conf.body.pipelineTasks[0].config.language.sourceLanguage, 'mr');
  assert.equal(inference.url, 'https://inference.example/pipeline');
  assert.equal(inference.headers.Authorization, 'inference-token');
  assert.equal(inference.headers.ulcaApiKey, undefined, 'the ULCA key never goes to the inference endpoint');
  assert.deepEqual([inference.body.pipelineTasks[0].config.serviceId, inference.body.pipelineTasks[0].config.audioFormat, inference.body.pipelineTasks[0].config.samplingRate], ['svc-asr-mr', 'wav', 16000]);
  assert.ok(inference.body.inputData.audio[0].audioContent.length > 100);

  const audio = await b.tts('तुम्हाला कुठे दुखते?', 'mr');
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
  const tts = f.calls.at(-1).body.pipelineTasks[0];
  assert.deepEqual([tts.taskType, tts.config.serviceId, tts.config.gender], ['tts', 'svc-tts-mr', 'female']);
  assert.equal(f.calls.at(-1).body.inputData.input[0].source, 'तुम्हाला कुठे दुखते?');

  await b.asr(wav(), 'mr');
  assert.equal(f.calls.filter((c) => c.url.includes('getModelsPipeline')).length, 2, 'the model for a task and language is looked up once (asr, tts), then reused');
});

test('a failing or empty Bhashini answer is an error, never a made-up transcript; credentials are required', async () => {
  const down = createBhashiniSpeech({ userId: 'u', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await assert.rejects(down.asr(wav(), 'hi'), /503/);
  const noModel = createBhashiniSpeech({ userId: 'u', apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  await assert.rejects(noModel.tts('x', 'hi'), /no tts model/);
  assert.throws(() => createBhashiniSpeech({}), /BHASHINI_USER_ID/);
  const quiet = { warn() {} };
  assert.equal(speechFromEnv({}, quiet), null);
  assert.equal(speechFromEnv({ SPEECH_PROVIDER: 'bhashini' }, quiet), null, 'no credentials: the browser keeps speech');
  assert.equal(speechFromEnv({ SPEECH_PROVIDER: 'bhashini', BHASHINI_USER_ID: 'u', BHASHINI_API_KEY: 'k' }, quiet).name, 'bhashini');
});

let t, speech, fx;
before(async () => {
  fx = fakeBhashini();
  speech = createBhashiniSpeech({ userId: 'u1', apiKey: 'ulca-key', fetchImpl: fx.fetchImpl });
  t = await startTestApp({ speechProvider: speech });
});
after(async () => { await t.close(); });

async function patient(language = 'mr') {
  const reg = await t.registerPatient({ fullName: 'Speech Patient', mobile: `87${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`, language, age: 40, sex: 'male' });
  await t.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language } });
  return reg.cookie;
}
const send = (cookie, path, body, query = '') => t.send('POST', `/api/patient/speech${path}${query}`, body, { cookie });

test('status says which engine is in use', async () => {
  const cookie = await patient();
  const r = await t.call('GET', '/api/patient/speech/status', { cookie });
  assert.deepEqual(r.body, { enabled: true, provider: 'bhashini', recognition: true, synthesis: true });
  const plain = await startTestApp();
  try {
    const reg = await plain.registerPatient({ fullName: 'No Speech', mobile: '8700000001', language: 'en', age: 30, sex: 'male' });
    await plain.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language: 'en' } });
    assert.equal((await plain.call('GET', '/api/patient/speech/status', { cookie: reg.cookie })).body.enabled, false);
    assert.equal((await plain.send('POST', '/api/patient/speech/transcribe', wav(), { cookie: reg.cookie })).status, 503);
  } finally { await plain.close(); }
});

test('audio is turned into words in the patient\'s language, and neither audio nor words are stored or logged', async () => {
  const cookie = await patient('mr');
  fx.calls.length = 0;
  const r = await send(cookie, '/transcribe', wav());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { transcript: 'माझे गुडघे दुखतात', confidence: null, alternatives: ['माझे गुडघे दुखतात'] });
  assert.equal(fx.calls.find((c) => !c.url.includes('getModelsPipeline')).body.pipelineTasks[0].config.language.sourceLanguage, 'mr');
  const { rows } = await t.db.pool.query("SELECT detail FROM audit_logs WHERE action = 'speech_transcribed'");
  assert.deepEqual(Object.keys(rows[0].detail).sort(), ['bytes', 'heard', 'lang', 'provider']);
  assert.equal(JSON.stringify(rows).includes('गुडघे'), false, 'the words are not in the audit log');
});

test('what is not audio, too much audio, and a missing session are refused', async () => {
  const cookie = await patient('hi');
  assert.equal((await send(cookie, '/transcribe', Buffer.from('not a wav file at all'.repeat(20)))).status, 400);
  assert.equal((await send(cookie, '/transcribe', Buffer.alloc(0))).status, 400);
  assert.equal((await send(cookie, '/transcribe', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(1_600_000)]))).status, 413);
  assert.equal((await t.send('POST', '/api/patient/speech/transcribe', wav(), {})).status, 401);
  assert.equal((await t.call('GET', '/api/patient/speech/status')).status, 401);
});

test('text is spoken back as audio, in the right language, within limits', async () => {
  const cookie = await patient('mr');
  fx.calls.length = 0;
  const speak = (body) => fetch(`${t.base}/api/patient/speech/synthesize`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const ok = await speak({ text: 'तुम्हाला कुठे दुखते?' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /audio\/wav/);
  assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  assert.equal(fx.calls.at(-1).body.pipelineTasks[0].config.language.sourceLanguage, 'mr');
  const bad = await t.call('POST', '/api/patient/speech/synthesize', { cookie, body: { text: '' } });
  assert.equal(bad.status, 400);
  assert.equal((await t.call('POST', '/api/patient/speech/synthesize', { cookie, body: { text: 'x'.repeat(701) } })).status, 400);
  const en = await speak({ text: 'Where does it hurt?', lang: 'en' });
  assert.equal(en.status, 200);
  assert.equal(fx.calls.at(-1).body.pipelineTasks[0].config.language.sourceLanguage, 'en');
});

test('when Bhashini fails the answer is a plain 502 so the screen falls back to the browser, and the failure is logged without the text', async () => {
  const broken = await startTestApp({ speechProvider: { name: 'bhashini', asr: async () => { throw new Error('Bhashini answered 503'); }, tts: async () => { throw new Error('Bhashini answered 503'); } } });
  try {
    const reg = await broken.registerPatient({ fullName: 'Broken Speech', mobile: '8700000002', language: 'en', age: 30, sex: 'male' });
    await broken.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language: 'en' } });
    assert.equal((await broken.send('POST', '/api/patient/speech/transcribe', wav(), { cookie: reg.cookie })).status, 502);
    assert.equal((await broken.call('POST', '/api/patient/speech/synthesize', { cookie: reg.cookie, body: { text: 'My secret words' } })).status, 502);
    const { rows } = await broken.db.pool.query("SELECT detail FROM audit_logs WHERE action = 'speech_synthesized'");
    assert.equal(rows[0].detail.ok, false);
    assert.equal(JSON.stringify(rows).includes('secret'), false);
  } finally { await broken.close(); }
});
