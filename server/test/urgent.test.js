import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { scanText } from '../src/alerts/textscan.js';
import { CATEGORIES } from '../config/emergency-words.v1.js';

const ALL = { history: true, documents: true, his_sharing: false, abha_linking: false };
const CONFIRM = { visual: true, audio: true };
const ids = (text) => scanText(text).map((m) => m.category).sort();

test('emergency words are found in English, Hindi, Marathi and Hindi typed in English letters', () => {
  assert.deepEqual(ids('my father is unconscious and not responding'), ['UNCONSCIOUS']);
  assert.deepEqual(ids('He has had a seizure'), ['SEIZURE']);
  assert.deepEqual(ids("she can't breathe"), ['BREATHING_STOPPED']);
  assert.deepEqual(ids('vomiting blood since morning'), ['BLEEDING_HEAVY']);
  assert.deepEqual(ids('he drank poison'), ['POISON_OVERDOSE']);
  assert.deepEqual(ids('I want to die'), ['SELF_HARM']);
  assert.deepEqual(ids('face drooping and slurred speech'), ['STROKE_SIGNS']);
  assert.deepEqual(ids('मेरे पिताजी बेहोश हो गए'), ['UNCONSCIOUS']);
  assert.deepEqual(ids('बहुत खून बह रहा है'), ['BLEEDING_HEAVY']);
  assert.deepEqual(ids('उसे ज़हर पी लिया'), ['POISON_OVERDOSE']);
  assert.deepEqual(ids('माझी आई बेशुद्ध पडली आहे'), ['UNCONSCIOUS']);
  assert.deepEqual(ids('त्याला आकडी आली'), ['SEIZURE']);
  assert.deepEqual(ids('मला आत्महत्या करावीशी वाटते'), ['SELF_HARM']);
  assert.deepEqual(ids('papa behosh ho gaye'), ['UNCONSCIOUS']);
  assert.deepEqual(ids('doctor saheb saans nahi aa rahi'), ['BREATHING_STOPPED']);
});

test('a milder mention alerts for attention, unless it is negated; emergency words are never ignored', () => {
  assert.deepEqual(scanText('chest pain since morning').map((m) => [m.category, m.level]), [['CHEST_PAIN', 'attention']]);
  assert.deepEqual(ids('no chest pain'), [], 'English negation before the word');
  assert.deepEqual(ids('there is no bleeding'), []);
  assert.deepEqual(ids('खून नहीं आ रहा'), [], 'Hindi negation after the word');
  assert.deepEqual(ids('bleeding nahi hai'), [], 'Roman Hindi');
  assert.deepEqual(ids('रक्तस्राव नाही'), [], 'Marathi');
  assert.deepEqual(ids('bleeding from the gums for two days'), ['BLEEDING']);
  assert.deepEqual(ids('no suicidal thoughts'), ['SELF_HARM'], 'emergency words ignore negation on purpose: safer to over-alert');
});

test('ordinary words do not alert', () => {
  for (const text of ['my knee hurts when I climb stairs', 'it fits well', 'I had a blood test last month', 'fever for two days', 'fit and healthy', 'मेरे घुटने में दर्द है', 'ताप आहे', '', null, 12]) {
    assert.deepEqual(ids(text), [], String(text));
  }
});

test('every category has a reason in three languages and at least one term', () => {
  for (const c of CATEGORIES) {
    assert.equal(c.reason.length, 3, c.id);
    assert.ok(c.reason.every((r) => r.length > 10), c.id);
    assert.ok(c.terms.length > 0, c.id);
    assert.ok(['emergency', 'attention'].includes(c.level), c.id);
  }
});

let t, staff, n = 0;
before(async () => { t = await startTestApp(); staff = await t.login('staff'); });
after(async () => { await t.close(); });

async function patient(language = 'en') {
  const reg = await t.registerPatient({ fullName: 'Urgent Test', mobile: `88${String(200000 + n++).padStart(8, '0')}`, language, age: 50, sex: 'male' });
  const consent = await t.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language } });
  const answer = (questionKey, value) => t.call('POST', '/api/patient/interview/answer', { cookie: reg.cookie, body: { questionKey, value, modality: 'tap', confirmation: CONFIRM } });
  return { cookie: reg.cookie, enc: consent.body.encounterId, answer };
}
const alerts = async (enc) => (await t.call('GET', '/api/staff/alerts', { cookie: staff })).body.alerts.filter((a) => a.encounterId === enc);

test('words in the reason for the visit raise an alert that staff see, with what the patient said', async () => {
  const p = await patient();
  const r = await p.answer('cc.reason', 'my father is unconscious since an hour');
  assert.equal(r.status, 200);
  assert.equal(r.body.staffNotified, true);
  const a = (await alerts(p.enc)).find((x) => x.ruleId === 'RF-TEXT-UNCONSCIOUS');
  assert.ok(a, 'the alert exists');
  assert.equal(a.level, 'emergency');
  assert.match(a.reason[0], /automatic word match/);
  assert.equal(a.reason.length, 3);
  assert.equal(a.triggers[0].key, 'cc.reason');
  assert.equal(a.triggers[0].answer[0], 'my father is unconscious since an hour');
  // the patient is never told what was found
  assert.deepEqual(Object.keys(r.body).sort(), ['done', 'progress', 'pruned', 'saved', 'staffNotified', 'suggestions']);
  // answering again does not raise it twice
  await p.answer('cc.reason', 'my father is unconscious since two hours');
  assert.equal((await alerts(p.enc)).filter((x) => x.ruleId === 'RF-TEXT-UNCONSCIOUS').length, 1);
});

test('a typed answer to a later question is scanned too, and Hindi and Marathi work end to end', async () => {
  const p = await patient('hi');
  await p.answer('cc.reason', 'test visit');
  assert.equal((await alerts(p.enc)).length, 0, 'an ordinary reason raises nothing');
  await p.answer('emergency.screen', ['none']);
  const main = await p.answer('cc.main', 'other');
  assert.equal(main.status, 200, JSON.stringify(main.body));
  await p.answer('cc.duration', 'd1_3');
  const text = await p.answer('cc.other_text', 'उसे सांप ने काट लिया है');
  assert.equal(text.status, 200, JSON.stringify(text.body));
  const a = (await alerts(p.enc)).find((x) => x.ruleId === 'RF-TEXT-POISON_OVERDOSE');
  assert.ok(a);
  assert.equal(a.triggers[0].key, 'cc.other_text');
  const m = await patient('mr');
  await m.answer('cc.reason', 'माझा भाऊ बेशुद्ध आहे');
  assert.ok((await alerts(m.enc)).some((x) => x.ruleId === 'RF-TEXT-UNCONSCIOUS'));
});

test('the urgent button raises an emergency alert on the patient\'s case, once, and tells staff', async () => {
  const p = await patient();
  const r = await t.call('POST', '/api/patient/urgent', { cookie: p.cookie, body: { screen: 'interview' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { notified: true }, 'the patient is told only that staff know');
  const found = (await alerts(p.enc)).filter((x) => x.ruleId === 'RF-URGENT-BUTTON');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'emergency');
  assert.equal(found[0].triggers.length, 0);
  assert.equal(found[0].reason.length, 3);
  await t.call('POST', '/api/patient/urgent', { cookie: p.cookie, body: {} });
  assert.equal((await alerts(p.enc)).filter((x) => x.ruleId === 'RF-URGENT-BUTTON').length, 1, 'not raised twice');
  const help = (await t.call('GET', '/api/staff/help-requests', { cookie: staff })).body.helpRequests;
  assert.ok(JSON.stringify(help).includes('urgent_help'), 'also shown with the help requests');
});

test('the urgent button works with no session and before consent: staff still get a request, and nothing is blocked', async () => {
  const anon = await t.call('POST', '/api/patient/urgent', { body: { screen: 'language' } });
  assert.equal(anon.status, 201);
  assert.deepEqual(anon.body, { notified: true });
  const reg = await t.registerPatient({ fullName: 'Before Consent', mobile: '8800999991', language: 'en', age: 33, sex: 'female' });
  const early = await t.call('POST', '/api/patient/urgent', { cookie: reg.cookie, body: { screen: 'consent' } });
  assert.equal(early.status, 201);
  assert.equal(early.body.notified, true);
  const help = JSON.stringify((await t.call('GET', '/api/staff/help-requests', { cookie: staff })).body);
  assert.ok(help.includes('urgent_help'));
});

test('what was spoken is scanned even when the answer was a tapped option, but the option codes themselves are not', async () => {
  const p = await patient();
  await p.answer('cc.reason', 'test visit');
  const spoken = await t.call('POST', '/api/patient/interview/answer', { cookie: p.cookie, body: { questionKey: 'emergency.screen', value: ['none'], modality: 'voice', transcript: 'nothing like that but papa behosh hain', confirmation: CONFIRM } });
  assert.equal(spoken.status, 200);
  assert.ok((await alerts(p.enc)).some((x) => x.ruleId === 'RF-TEXT-UNCONSCIOUS'), 'the words said aloud raise the alert');
  const q = await patient();
  await q.answer('cc.reason', 'test visit'); await q.answer('emergency.screen', ['none']);
  await q.answer('cc.main', 'chest_pain'); // the option code "chest_pain" is not words the patient said
  assert.equal((await alerts(q.enc)).filter((x) => x.ruleId.startsWith('RF-TEXT-')).length, 0);
});
