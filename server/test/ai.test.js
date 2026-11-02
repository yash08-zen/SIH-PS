import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { png } from './doc-helpers.js';
import { createAnthropicProvider, createGeminiProvider, createRulesProvider, parseJsonReply, providerFromEnv } from '../src/ai/providers.js';

const ALL = { history: true, documents: true, his_sharing: true, abha_linking: true };
const CONFIRM = { visual: true, audio: true };
let t, doctor, n = 0;
const calls = [];
let reply = null; // what the stand-in model service answers next
const q = (sql, p) => t.db.pool.query(sql, p).then((r) => r.rows);

// A stand-in for the Anthropic Messages API, so the model path is exercised without a key or a network.
const fakeFetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const r = typeof reply === 'function' ? reply(calls.at(-1)) : reply;
  if (r?.status) return { ok: false, status: r.status, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: r }] }) };
};
const goodReply = (c) => JSON.stringify(c.body.system.includes('patient for') || c.body.system.includes('recap for a patient')
  ? { en: 'You told us you have had a fever for one to three days.', hi: 'आपने बताया कि आपको एक से तीन दिन से बुखार है।', mr: 'तुम्ही सांगितले की तुम्हाला एक ते तीन दिवसांपासून ताप आहे.' }
  : { en: 'Fever for one to three days. A lab report dated in February lists a low hemoglobin value.', hi: 'एक से तीन दिन से बुखार। फरवरी की जाँच रिपोर्ट में हीमोग्लोबिन कम दर्ज है।', mr: 'एक ते तीन दिवस ताप. फेब्रुवारीच्या तपासणी अहवालात हिमोग्लोबिन कमी नोंदवले आहे.' });

before(async () => {
  t = await startTestApp({ aiProvider: createAnthropicProvider({ apiKey: 'test-key', model: 'claude-test-model', fetchImpl: fakeFetch }) });
  doctor = await t.login('doctor');
});
after(async () => { await t.close(); });

async function patient({ name = 'Overview Patient', submit = true, files = true, language = 'en' } = {}) {
  const mobile = `86${String(100000 + n++).padStart(8, '0')}`;
  const reg = await t.registerPatient({ fullName: name, mobile, age: 47, sex: 'female', language });
  const consent = await t.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language } });
  const enc = consent.body.encounterId;
  const a = (k, v) => t.call('POST', '/api/patient/interview/answer', { cookie: reg.cookie, body: { questionKey: k, value: v, modality: 'tap', confirmation: CONFIRM } });
  await a('cc.reason', 'test visit'); await a('emergency.screen', ['none']); await a('cc.main', 'fever'); await a('cc.duration', 'd1_3');
  if (files) await t.send('POST', '/api/patient/documents', png('en-lab-printed'), { cookie: reg.cookie, name: 'lab.png' });
  await t.settle();
  if (submit) await t.call('POST', '/api/patient/submit', { cookie: reg.cookie });
  await t.settle();
  return { enc, cookie: reg.cookie, mobile, name };
}
const doctorView = (enc) => t.call('GET', `/api/doctor/encounters/${enc}/summary`, { cookie: doctor }).then((r) => r.body);
const patientView = (cookie) => t.call('GET', '/api/patient/summary', { cookie }).then((r) => r.body);

test('after the patient submits, the model writes an overview for the doctor and one for the patient', async () => {
  reply = goodReply; calls.length = 0;
  const p = await patient();
  assert.equal(calls.length, 2, 'one call for each audience');
  const d = await doctorView(p.enc);
  assert.equal(d.narrative.status, 'ready');
  assert.equal(d.narrative.provider, 'anthropic');
  assert.equal(d.narrative.model, 'claude-test-model');
  assert.equal(d.narrative.fellBack, false);
  assert.match(d.narrative.text.en, /hemoglobin/);
  assert.deepEqual(Object.keys(d.narrative.text).sort(), ['en', 'hi', 'mr']);
  const pv = await patientView(p.cookie);
  assert.equal(pv.status, 'ready');
  assert.equal(pv.writtenBy, 'ai');
  assert.equal(pv.language, 'en');
  assert.match(pv.text, /You told us/);
  assert.equal(/hemoglobin|lab/i.test(pv.text), false, 'the patient\'s recap holds nothing from the files');
});

test('what is sent to the model has no name, number or identifier, and the patient\'s call never sees the files or the checks', async () => {
  reply = goodReply; calls.length = 0;
  const p = await patient({ name: 'Unmistakable Surname' });
  const all = JSON.stringify(calls);
  for (const secret of ['Unmistakable', 'Surname', p.mobile, p.enc]) assert.equal(all.includes(secret), false, `${secret} must not leave the platform`);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].body.model, 'claude-test-model');
  const byAudience = Object.fromEntries(calls.map((c) => { const f = JSON.parse(c.body.messages[0].content); return [f.audience, f]; }));
  assert.deepEqual(byAudience.patient.person, { ageGroup: 'adult 40 to 64', sex: 'female' }, 'an age group, not a birth date');
  for (const k of ['files', 'labs', 'medicines', 'interactionsFlagged', 'allergyConflicts', 'recordChecks']) assert.equal(k in byAudience.patient, false, `patient call has no ${k}`);
  assert.ok(byAudience.doctor.files.length === 1 && byAudience.doctor.labs.length > 0, 'the doctor\'s call has the file findings');
  assert.ok(byAudience.patient.answered.some((a) => a.answer === 'Fever'));
  assert.match(calls[0].body.system, /Do not diagnose/);
});

test('wording that states a diagnosis, a patient recap that mentions risk, a failing service and a garbled reply are all replaced by the rule-based text', async () => {
  const cases = [
    ['diagnosis', () => JSON.stringify({ en: 'The picture is consistent with typhoid.', hi: 'ठीक है', mr: 'ठीक' }), /diagnosis/],
    ['risk to the patient', (c) => JSON.stringify(c.body.system.includes('recap for a patient') ? { en: 'You told us about a fever. There is a risk of harm.', hi: 'बुखार', mr: 'ताप' } : { en: 'Fever.', hi: 'बुखार', mr: 'ताप' }), /risk|diagnosis/],
    ['service error', () => ({ status: 503 }), /503/],
    ['not JSON', () => 'Sorry, I cannot help with that.', /JSON/],
    ['a language missing', () => JSON.stringify({ en: 'Fever.' }), /no hi text/],
  ];
  for (const [name, r, why] of cases) {
    reply = r;
    const p = await patient({ name: `Fallback ${name}` });
    const d = await doctorView(p.enc);
    const only = name === 'risk to the patient' ? " AND audience = 'patient'" : '';
    const rows = await q(`SELECT audience, provider, fallback_reason FROM ai_narratives WHERE encounter_id = $1${only} ORDER BY audience`, [p.enc]);
    assert.ok(rows.length && rows.every((x) => x.provider === 'rules-v1' && x.fallback_reason), `${name}: replaced by the rules text`);
    assert.match(rows.map((x) => x.fallback_reason).join(' '), why, name);
    if (!only) assert.equal(d.narrative.fellBack, true);
    assert.ok(d.narrative.text.en.length > 3, `${name}: the doctor still gets an overview`);
    assert.ok((await patientView(p.cookie)).text, `${name}: and so does the patient`);
  }
});

test('the rule-based writer needs no model: it restates what was recorded, the patient\'s recap holds only the patient\'s own words', async () => {
  const rules = await startTestApp();
  try {
    const reg = await rules.registerPatient({ fullName: 'Rules Patient', mobile: '8500000001', age: 30, sex: 'male', language: 'hi' });
    const consent = await rules.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language: 'hi' } });
    const a = (k, v) => rules.call('POST', '/api/patient/interview/answer', { cookie: reg.cookie, body: { questionKey: k, value: v, modality: 'tap', confirmation: CONFIRM } });
    await a('cc.reason', 'test visit'); await a('emergency.screen', ['none']); await a('cc.main', 'cough'); await a('cc.duration', 'w1_4');
    await rules.send('POST', '/api/patient/documents', png('en-lab-printed'), { cookie: reg.cookie, name: 'lab.png' });
    await rules.settle();
    assert.deepEqual(await rules.call('GET', '/api/patient/summary', { cookie: reg.cookie }).then((r) => r.body), { submitted: false });
    await rules.call('POST', '/api/patient/submit', { cookie: reg.cookie });
    await rules.settle();
    const pv = (await rules.call('GET', '/api/patient/summary', { cookie: reg.cookie })).body;
    assert.equal(pv.writtenBy, 'rules');
    assert.equal(pv.language, 'hi');
    assert.match(pv.text, /खाँसी/, 'in the patient\'s language');
    assert.equal(/Hemoglobin|हीमोग्लोबिन|10\.2/.test(pv.text), false);
    const dv = (await rules.call('GET', `/api/doctor/encounters/${consent.body.encounterId}/summary`, { cookie: await rules.login('doctor') })).body;
    assert.equal(dv.narrative.provider, 'rules-v1');
    assert.match(dv.narrative.text.en, /Prior investigations summary/);
    assert.match(dv.narrative.text.en, /Hemoglobin/, 'the doctor\'s overview includes the files');
  } finally { await rules.close(); }
});

test('a doctor opens a patient who is still answering and sees what has been said so far, marked live', async () => {
  const p = await patient({ name: 'Still Answering', submit: false, files: false });
  const d = await doctorView(p.enc);
  assert.equal(d.live, true);
  assert.equal(d.submitted, false);
  assert.equal(d.summary.kind, 'live');
  const cc = d.summary.content.sections[0].items.find((i) => i.id === 'cc.main');
  assert.equal(cc.text.en, 'Fever');
  assert.ok(d.summary.content.completeness.notAnswered.length > 0, 'the rest is listed as not answered');
  assert.equal(d.narrative, null, 'no overview until the patient has submitted');
  assert.equal((await t.call('POST', `/api/doctor/encounters/${p.enc}/consult`, { cookie: doctor })).status, 409, 'cannot be opened for a decision yet');
  assert.equal((await t.call('POST', `/api/doctor/encounters/${p.enc}/summary/accept`, { cookie: doctor })).status, 409);
  assert.equal((await q('SELECT count(*)::int n FROM summaries WHERE encounter_id = $1', [p.enc]))[0].n, 0, 'nothing is saved by looking');
  // the same patient submits, and the doctor then sees the real draft and the overview
  await t.call('POST', '/api/patient/submit', { cookie: p.cookie });
  await t.settle();
  const after = await doctorView(p.enc);
  assert.equal(after.live, undefined);
  assert.equal(after.summary.kind, 'ai_draft');
  assert.equal(after.narrative.status, 'ready');
});

test('the patient\'s recap is for that patient only and needs a session', async () => {
  const a = await patient({ name: 'Recap A' }), b = await patient({ name: 'Recap B' });
  assert.equal((await t.call('GET', '/api/patient/summary')).status, 401);
  assert.equal((await t.call('GET', '/api/patient/summary', { cookie: doctor })).status, 401);
  const ta = (await patientView(a.cookie)).text, tb = (await patientView(b.cookie)).text;
  assert.ok(ta && tb);
  const body = await t.call('GET', '/api/patient/summary', { cookie: a.cookie });
  assert.deepEqual(Object.keys(body.body).sort(), ['language', 'status', 'submitted', 'text', 'writtenBy'], 'nothing else is exposed');
});

test('the reply parser accepts a fenced or wrapped reply and refuses an incomplete one', () => {
  const ok = parseJsonReply('Here you go:\n```json\n{"en":"a","hi":"b","mr":"c"}\n```');
  assert.deepEqual(ok, { en: 'a', hi: 'b', mr: 'c' });
  assert.throws(() => parseJsonReply('{"en":"a","hi":"b"}'), /no mr text/);
  assert.throws(() => parseJsonReply('nothing'), /JSON/);
  assert.throws(() => createAnthropicProvider({}), /ANTHROPIC_API_KEY/);
  assert.equal(createRulesProvider().name, 'rules-v1');
});

test('the Gemini writer sends the key in a header, the facts and the prompt, retries once when busy, and reads the JSON reply', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (seen.length === 1) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"en":"Fever.","hi":"बुखार।","mr":"ताप."}' }] } }] }) };
  };
  const g = createGeminiProvider({ apiKey: 'g-key', model: 'gemini-test', fetchImpl, retryMs: 1 });
  const out = await g.narrate({ audience: 'doctor', facts: { answered: [{ question: 'Q', answer: 'Fever' }] } });
  assert.deepEqual(out, { en: 'Fever.', hi: 'बुखार।', mr: 'ताप.' });
  assert.equal(seen.length, 2, 'one retry after 429');
  assert.match(seen[1].url, /models\/gemini-test:generateContent$/);
  assert.equal(seen[1].headers['x-goog-api-key'], 'g-key');
  assert.match(seen[1].body.systemInstruction.parts[0].text, /Do not diagnose/);
  assert.equal(JSON.stringify(seen[1].body).includes('g-key'), false, 'the key is only in the header');
  assert.equal(g.name, 'gemini');
  const quiet = { warn() {} };
  assert.equal(providerFromEnv({ AI_PROVIDER: 'gemini' }, quiet).name, 'rules-v1', 'no key: rules, not a crash');
  assert.equal(providerFromEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }, quiet).name, 'gemini');
  assert.equal(providerFromEnv({}, quiet).name, 'rules-v1');
});
