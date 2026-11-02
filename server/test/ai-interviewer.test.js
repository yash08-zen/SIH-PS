import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { MIN_FOLLOWUPS, SYSTEM, checkQuestion, createGeminiInterviewer, interviewerFromEnv, parseReply } from '../src/ai/interviewer.js';
import { AI_FOLLOWUPS, AI_TOTAL } from '../src/interview/dialogue.js';
import { MAX_QUESTIONS } from '../config/questions.v1.js';

// A model reply in the shape the system prompt asks for.
const reply = (over = {}) => ({
  done: false, complaint: 'other', attention: false, attentionReason: '', rationale: 'Where the pain is helps the doctor.',
  question: {
    type: 'single', en: 'Where in the knee is the pain?', hi: 'घुटने में दर्द कहाँ है?', mr: 'गुडघ्यात दुखणे कुठे आहे?',
    options: [
      { value: 'front', en: 'Front', hi: 'आगे', mr: 'पुढे' },
      { value: 'back', en: 'Back', hi: 'पीछे', mr: 'मागे' },
    ],
  },
  ...over,
});

test('a well-formed question is accepted in the question bank shape, in all three languages', () => {
  const r = checkQuestion(reply());
  assert.equal(r.ok, true);
  assert.equal(r.question.type, 'single');
  assert.deepEqual(r.question.text, ['Where in the knee is the pain?', 'घुटने में दर्द कहाँ है?', 'गुडघ्यात दुखणे कुठे आहे?']);
  assert.deepEqual(r.question.options.map((o) => o.value), ['front', 'back']);
  assert.equal(r.question.ai, true);
  assert.equal(r.question.rationale, 'Where the pain is helps the doctor.');
});

test('the system decides, not the model: unsafe or malformed questions are refused', () => {
  const q = reply().question;
  const refused = (question, asked) => checkQuestion(reply({ question }), asked);
  assert.equal(refused({ ...q, en: 'You may have arthritis. Does it hurt?' }).ok, false, 'names a possible disease');
  assert.equal(refused({ ...q, en: 'You should take a painkiller. Is it better?' }).ok, false, 'gives advice');
  assert.equal(refused({ ...q, hi: 'Where in the knee?' }).ok, false, 'Hindi not in Devanagari');
  assert.equal(refused({ ...q, mr: '' }).ok, false, 'Marathi missing');
  assert.equal(refused({ ...q, type: 'essay' }).ok, false, 'unknown type');
  assert.equal(refused({ ...q, options: [q.options[0]] }).ok, false, 'one option is not a choice');
  assert.equal(refused({ ...q, options: [q.options[0], { ...q.options[1], value: 'Front Side!' }] }).ok, false, 'option value');
  assert.equal(refused(q, ['Where in the knee is the pain?']).ok, false, 'repeats an earlier question');
  assert.equal(checkQuestion(null).ok, false);
});

test('yes/no answers use the standard labels, several-answer questions always offer "none of these", numbers are a 0 to 10 score', () => {
  const yn = checkQuestion(reply({ question: { type: 'yes_no', en: 'Is the knee swollen?', hi: 'क्या घुटना सूजा है?', mr: 'गुडघा सुजला आहे का?' } }));
  assert.deepEqual(yn.question.options.map((o) => o.value), ['yes', 'no']);
  const multi = checkQuestion(reply({ question: { ...reply().question, type: 'multi' } }));
  assert.deepEqual(multi.question.options.map((o) => o.value), ['front', 'back', 'none']);
  const num = checkQuestion(reply({ question: { type: 'number', en: 'How bad is the pain from 0 to 10?', hi: 'दर्द 0 से 10 में कितना है?', mr: 'दुखणे 0 ते 10 मध्ये किती आहे?' } }));
  assert.deepEqual([num.question.min, num.question.max], [0, 10]);
});

test('"done", the closest complaint and a request for staff attention are passed on', () => {
  assert.deepEqual(checkQuestion({ done: true, complaint: 'cough' }), { ok: true, done: true, complaint: 'cough', attention: null });
  assert.equal(checkQuestion(reply({ attention: true, attentionReason: 'Sudden severe pain after a fall' })).attention, 'Sudden severe pain after a fall');
  assert.equal(checkQuestion(reply({ complaint: 'broken_leg' })).complaint, null, 'only a known complaint is kept');
});

test('the Gemini client sends the key in a header, only the facts it is given, and reads a JSON reply', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(reply()) + '\n```' }] } }] }) };
  };
  const g = createGeminiInterviewer({ apiKey: 'test-key', model: 'gemini-test', fetchImpl });
  const out = await g.next({ reasonForVisit: 'knee pain', person: { ageGroup: 'adult 40 to 64', sex: 'female' }, alreadyAsked: [], remaining: 6 });
  assert.equal(out.question.en, 'Where in the knee is the pain?');
  assert.match(sent.url, /\/v1beta\/models\/gemini-test:generateContent$/);
  assert.equal(sent.init.headers['x-goog-api-key'], 'test-key');
  assert.ok(!sent.url.includes('test-key'), 'the key is not in the address');
  assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(JSON.parse(sent.body.contents[0].parts[0].text), { reasonForVisit: 'knee pain', person: { ageGroup: 'adult 40 to 64', sex: 'female' }, alreadyAsked: [], remaining: 6 });
  await assert.rejects(createGeminiInterviewer({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) }).next({}), /429/);
  assert.throws(() => parseReply('no json here'));
});

test('the AI interviewer is off unless switched on and given a key', () => {
  const quiet = { warn() {} };
  assert.equal(interviewerFromEnv({}, quiet), null);
  assert.equal(interviewerFromEnv({ AI_INTERVIEW_PROVIDER: 'gemini' }, quiet), null);
  assert.equal(interviewerFromEnv({ AI_INTERVIEW_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' }, quiet).name, 'gemini');
});

// ---------- the interview through the API, with a fake model ----------
const ALL = { history: true, documents: true, his_sharing: false, abha_linking: false };
const CONFIRM = { visual: true, audio: true };

// A fake model that asks about the knee, follows up on the answer it got, and records what it was sent.
function fakeModel({ questions = 9, fail = false } = {}) {
  const calls = [];
  return {
    calls, name: 'gemini', model: 'fake-gemini',
    async next(facts) {
      calls.push(facts);
      if (fail) throw new Error('the model service answered 503');
      const k = calls.length;
      if (k > questions) return { done: true };
      const last = facts.alreadyAsked.at(-1);
      return reply({
        complaint: 'other',
        rationale: `follow-up ${k}`,
        question: { ...reply().question, en: `Question ${k} after "${last?.answer}"?`, hi: `सवाल ${k}?`, mr: `प्रश्न ${k}?` },
      });
    },
  };
}

async function interview(t, mobile) {
  const reg = await t.registerPatient({ fullName: 'AI Interview Test', mobile, language: 'en', age: 47, sex: 'female' });
  await t.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL, language: 'en' } });
  const patient = (method, path, body) => t.call(method, `/api/patient${path}`, { cookie: reg.cookie, body });
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const next = (await patient('GET', '/interview/next')).body;
    if (next.done) break;
    seen.push(next.question);
    const q = next.question;
    const value = q.key === 'cc.reason' ? 'my knee hurts when I climb stairs' : q.type === 'yes_no' ? 'no' : q.type === 'single' ? q.options[0].value
      : q.type === 'multi' ? [q.options.at(-1).value] : q.type === 'number' ? 3 : 'some text';
    const r = await patient('POST', '/interview/answer', { questionKey: q.key, value, modality: 'tap', confirmation: CONFIRM });
    assert.equal(r.status, 200, `${q.key}: ${JSON.stringify(r.body)}`);
  }
  return { seen, patient, reg };
}

let t, model;
before(async () => { model = fakeModel(); t = await startTestApp({ aiInterviewer: model }); });
after(async () => { await t.close(); });

test('with the AI interviewer: reason, emergency signs, then questions written from the answers, medicines and allergies last, twelve at most', async () => {
  const { seen, patient } = await interview(t, '9811100001');
  const keys = seen.map((q) => q.key);
  assert.deepEqual(keys.slice(0, 2), ['cc.reason', 'emergency.screen']);
  const ai = keys.filter((k) => k.startsWith('ai.'));
  assert.equal(ai.length, AI_FOLLOWUPS, 'the model was allowed to use its whole budget');
  assert.deepEqual(keys.slice(2, 2 + ai.length), ai, 'its questions come straight after the reason and emergency signs');
  assert.deepEqual(keys.slice(2 + ai.length), ['drug.current_any', 'allergy.any'], 'medicines and allergies are always asked, last');
  assert.ok(keys.length <= AI_TOTAL, `${keys.length} questions`);
  assert.ok(seen.slice(2, 2 + ai.length).every((q) => q.askedBy === 'ai'));
  // each question follows on from the previous answer
  assert.match(seen[3].text, /after "Front"/);

  // the model only ever saw de-identified facts
  const sent = JSON.stringify(model.calls);
  assert.ok(!sent.includes('AI Interview Test') && !sent.includes('9811100001'), 'no name or mobile number sent');
  assert.equal(model.calls[0].reasonForVisit, 'my knee hurts when I climb stairs');
  assert.equal(model.calls[0].person.ageGroup, 'adult 40 to 64');

  // the review shows the AI questions with their answers
  const review = (await patient('GET', '/interview/review')).body.items;
  assert.ok(review.some((i) => i.key === 'ai.1' && i.answer === 'Front'));
});

test('the doctor sees which questions the AI asked, and why', async () => {
  const { patient } = await interview(t, '9811100002');
  assert.equal((await patient('POST', '/submit')).status, 200);
  await t.settle();
  const { rows: [v] } = await t.db.pool.query(
    `SELECT v.content FROM summary_versions v JOIN summaries s ON s.id = v.summary_id JOIN encounters e ON e.id = s.encounter_id
       JOIN patients p ON p.id = e.patient_id ORDER BY v.created_at DESC LIMIT 1`);
  const items = v.content.sections.flatMap((s) => s.items);
  const ai = items.filter((i) => i.askedBy === 'ai');
  assert.ok(ai.length >= 1);
  assert.ok(ai.every((i) => i.rationale && i.label[0].startsWith('Question')));
});

test('when the model fails before its first question, the interview carries on with the fixed question tree', async () => {
  const failing = await startTestApp({ aiInterviewer: fakeModel({ fail: true }) });
  try {
    const { seen } = await interview(failing, '9811100003');
    const keys = seen.map((q) => q.key);
    assert.ok(!keys.some((k) => k.startsWith('ai.')));
    assert.ok(keys.includes('cc.main'), 'the closest-complaint question of the tree was asked');
    assert.ok(keys.length <= MAX_QUESTIONS);
    const { rows: [e] } = await failing.db.pool.query("SELECT interview_engine FROM encounters ORDER BY started_at DESC LIMIT 1");
    assert.equal(e.interview_engine, 'rules');
  } finally { await failing.close(); }
});

test('when the model says it has enough, the interview ends early', async () => {
  const brief = await startTestApp({ aiInterviewer: fakeModel({ questions: 2 }) });
  try {
    const { seen } = await interview(brief, '9811100004');
    // it said "done" after 2, but the minimum is 3: it is asked again, and as it still says done the interview ends after the minimum is met
    assert.equal(seen.filter((q) => q.key.startsWith('ai.')).length, 2);
    assert.deepEqual(seen.slice(-2).map((q) => q.key), ['drug.current_any', 'allergy.any'], 'the closing questions still follow');
  } finally { await brief.close(); }
});

test('the model cannot say it has enough before the minimum: an early "done" is asked again once, and the model is told how many are still needed', async () => {
  const calls = [];
  const early = { name: 'gemini', model: 'fake', async next(facts) {
    calls.push(facts);
    // says done at once; when pressed, writes a question
    if (calls.length === 1) return { done: true };
    return reply({ complaint: 'other', rationale: 'asked after being told the minimum', question: { ...reply().question, en: `Asked ${calls.length}?`, hi: 'सवाल?', mr: 'प्रश्न?' } });
  } };
  const app = await startTestApp({ aiInterviewer: early });
  try {
    const { seen } = await interview(app, '9811100005');
    assert.equal(calls[0].minimumStillNeeded, MIN_FOLLOWUPS);
    assert.equal(calls[1].minimumStillNeeded, MIN_FOLLOWUPS, 'the same request, asked again');
    assert.ok(seen.some((q) => q.key === 'ai.1'), 'the second try produced a question');
  } finally { await app.close(); }
});

test('the prompt tells the model to follow the patient, not a list, and never to ask the safety questions the system asks last', () => {
  assert.match(SYSTEM, /There is no fixed list/);
  assert.match(SYSTEM, /asked separately by the system, at the end/);
  assert.match(SYSTEM, /minimumStillNeeded/);
});

test('when the model fails part-way, the AI part ends and medicines and allergies are still asked', async () => {
  let n = 0;
  const flaky = { name: 'gemini', model: 'fake', async next() {
    if (++n > 2) throw new Error('the model service answered 503');
    return reply({ question: { ...reply().question, en: `Flaky ${n}?`, hi: 'सवाल?', mr: 'प्रश्न?' } });
  } };
  const app = await startTestApp({ aiInterviewer: flaky });
  try {
    const { seen } = await interview(app, '9811100006');
    const keys = seen.map((q) => q.key);
    assert.deepEqual(keys, ['cc.reason', 'emergency.screen', 'ai.1', 'ai.2', 'drug.current_any', 'allergy.any']);
  } finally { await app.close(); }
});
