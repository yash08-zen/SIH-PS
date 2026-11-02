import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { fixture, png } from './doc-helpers.js';
import { SECTIONS } from '../config/questions.v1.js';
import { findDiagnosticWording, generateSummary } from '../src/summary/generate.js';
import { STATUSES, TRANSITIONS, canMove } from '../src/summary/lifecycle.js';

const ALL = { history: true, documents: true, his_sharing: true, abha_linking: true };
const CONFIRM = { visual: true, audio: true };
const STANDARD = [...SECTIONS.map(([id]) => id), 'investigations'];
let t, doctor, n = 0;
const q = (sql, params) => t.db.pool.query(sql, params).then((r) => r.rows);
before(async () => { t = await startTestApp(); doctor = await t.login('doctor'); });
after(async () => { await t.close(); });

async function patient(name, { complaint = 'fever', duration = 'd1_3', files = [], skip = [] } = {}) {
  const reg = await t.registerPatient({ fullName: name, mobile: `94000${String(10000 + n++)}`, age: 45 });
  const consent = await t.call('POST', '/api/patient/consent', { cookie: reg.cookie, body: { purposes: ALL } });
  const cookie = reg.cookie, enc = consent.body.encounterId;
  const answer = (questionKey, value, extra = {}) => t.call('POST', '/api/patient/interview/answer', { cookie, body: { questionKey, value, modality: 'tap', confirmation: CONFIRM, ...extra } });
  await answer('cc.reason', 'test visit'); await answer('emergency.screen', ['none']);
  await answer('cc.main', complaint);
  await answer('cc.duration', duration);
  for (const k of skip) await answer(k, undefined, { skipped: true });
  for (const [i, f] of files.entries()) await t.send('POST', '/api/patient/documents', f, { cookie, name: `file${i}.png` });
  await t.settle();
  return { cookie, enc, answer, submit: () => t.call('POST', '/api/patient/submit', { cookie }) };
}
const get = (path) => t.call('GET', `/api/doctor${path}`, { cookie: doctor });
const post = (path, body) => t.call('POST', `/api/doctor${path}`, { cookie: doctor, body });
const items = (content) => content.sections.flatMap((s) => s.items);

// Definition of Done 1: a draft summary in the standard order, three languages, a source on every item, and the files included.
test('submission produces a draft in the standard section order with a source on every item and the files listed', async () => {
  const p = await patient('Asha Verma', { files: [png('en-rx-printed'), png('en-lab-printed')] });
  assert.equal((await q('SELECT status FROM encounters WHERE id = $1', [p.enc]))[0].status, 'in_intake');
  const sub = await p.submit();
  assert.deepEqual(sub.body, { submitted: true }, 'the patient is told nothing about the content');
  assert.equal((await q('SELECT status FROM encounters WHERE id = $1', [p.enc]))[0].status, 'ready', 'a saved draft makes the case Ready');
  const r = await get(`/encounters/${p.enc}/summary`);
  assert.equal(r.status, 200);
  const c = r.body.summary.content;
  assert.deepEqual(c.sections.map((s) => s.id), STANDARD);
  for (const s of c.sections) assert.equal(s.title.length, 3);
  for (const it of items(c)) {
    assert.ok(it.source?.type, `${it.id} has a source`);
    if (it.status === 'answered') for (const l of ['en', 'hi', 'mr']) assert.ok(it.text[l], `${it.id} in ${l}`);
  }
  assert.equal(c.files.included.length, 2);
  const inv = c.sections.find((s) => s.id === 'investigations').items;
  assert.ok(inv.some((i) => i.source.type === 'file' && /prescription|Prescription/.test(i.text.en)));
  assert.ok(inv.some((i) => i.id.startsWith('lab:')), 'an out-of-range lab appears with its file as source');
  assert.ok(c.sections.find((s) => s.id === 'drug_allergy').items.some((i) => i.id === 'med:metformin'));
  const cc = c.sections[0].items.find((i) => i.id === 'cc.main');
  assert.equal(cc.text.en, 'Fever');
  assert.notEqual(cc.text.hi, cc.text.en);
  assert.equal(r.body.summary.kind, 'ai_draft');
  assert.deepEqual(r.body.diagnosticWording, []);
});

// Definition of Done 3: not answered is never "no", and the completeness indicator lists it.
test('unanswered and skipped questions appear as not answered, never as no', async () => {
  const p = await patient('Bina Das');
  // follow the interview's own path (it depends on the answers) until the medicines question, skipping one question on the way
  let skippedOne = false;
  for (let i = 0; i < 12; i++) {
    const { question } = (await t.call('GET', '/api/patient/interview/next', { cookie: p.cookie })).body;
    if (question.key === 'drug.current_any') break;
    const first = question.type === 'yes_no' ? 'no' : question.type === 'number' ? 3 : question.type === 'multi' ? [question.options.at(-1).value] : question.type === 'text' ? 'some words' : question.options[0].value;
    if (!skippedOne && question.section === 'hpi') { skippedOne = true; await p.answer(question.key, undefined, { skipped: true }); } else await p.answer(question.key, first);
  }
  await p.answer('drug.current_any', undefined, { skipped: true });
  await p.submit();
  const { summary } = (await get(`/encounters/${p.enc}/summary`)).body;
  const all = items(summary.content);
  const skipped = all.find((i) => i.id === 'drug.current_any');
  assert.equal(skipped.status, 'not_answered');
  assert.equal(skipped.text, null, 'no text at all, so it can never read as "No"');
  const answeredNo = await p.answer('allergy.any', 'no');
  assert.equal(answeredNo.status, 200);
  const cmp = summary.content.completeness;
  assert.ok(cmp.notAnswered.some((x) => x.id === 'drug.current_any'));
  assert.ok(cmp.notAnswered.every((x) => x.label.length === 3));
  assert.ok(cmp.answered + cmp.notAnswered.length === cmp.total);
  assert.ok(cmp.answered >= 2);
});

// Definition of Done 2 (automated half): no diagnostic wording in generated summaries.
test('the no-diagnosis check finds diagnostic wording and ignores quoted text', () => {
  const item = (text, quoted = []) => ({ id: 'x', status: 'answered', text: { en: text, hi: text, mr: text }, quoted, source: { type: 'patient' } });
  const doc = (...its) => ({ sections: [{ id: 's', items: its }] });
  assert.equal(findDiagnosticWording(doc(item('The findings are consistent with pneumonia.'))).length > 0, true);
  assert.equal(findDiagnosticWording(doc(item('Likely cause is infection'))).length > 0, true);
  assert.equal(findDiagnosticWording(doc(item('Diagnosis: asthma'))).length > 0, true);
  assert.equal(findDiagnosticWording(doc(item('निदान: अस्थमा'))).length > 0, true);
  assert.equal(findDiagnosticWording(doc(item('Conditions named in the file: suspected asthma.', ['suspected asthma']))).length, 0, 'quoted from the file');
  assert.equal(findDiagnosticWording(doc(item('Fever for 1 to 3 days'))).length, 0);
  const amended = item('Doctor wrote: likely viral');
  amended.edited = true;
  assert.equal(findDiagnosticWording(doc(amended)).length, 0, "a doctor's own words are not the generator's");
});

test('summaries built from every question and every kind of file contain no diagnostic wording in any language', async () => {
  const { QUESTIONS } = await import('../config/questions.v1.js');
  const answers = {};
  for (const q of QUESTIONS) {
    const o = q.options?.[0]?.value;
    answers[q.key] = q.type === 'yes_no' ? { value: 'yes' } : q.type === 'single' ? { value: o } : q.type === 'multi' ? { value: [o] } : q.type === 'number' ? { value: 3 } : { value: 'felt unwell since the morning' };
  }
  const { CASES } = await import('./fixtures/analysis-cases.js');
  const { analyze } = await import('../src/analysis/engine.js');
  for (const c of CASES) {
    const content = generateSummary({ answers, analysis: analyze(c.input), documents: c.input.documents.map((d) => ({ id: d.id, name: d.name, status: d.status })) });
    assert.deepEqual(findDiagnosticWording(content), [], c.id);
    assert.deepEqual(content.sections.map((s) => s.id), STANDARD);
  }
});

// Definition of Done 5 and 9: decisions, versions, the lifecycle.
test('case status transitions follow the lifecycle and an invalid transition is refused', async () => {
  assert.deepEqual(STATUSES.sort(), ['alert', 'completed', 'in_consultation', 'in_intake', 'ready', 'registered', 'rejected']);
  assert.equal(canMove('ready', 'in_consultation'), true);
  assert.equal(canMove('ready', 'completed'), false);
  assert.equal(canMove('rejected', 'completed'), true);
  assert.equal(canMove('completed', 'ready'), false);
  assert.deepEqual(TRANSITIONS.completed, []);

  const p = await patient('Chitra Rao');
  assert.equal((await post(`/encounters/${p.enc}/consult`)).status, 409, 'cannot open before intake is submitted');
  await p.submit();
  assert.equal((await post(`/encounters/${p.enc}/summary/accept`)).status, 409, 'cannot accept before consultation starts');
  assert.equal((await post(`/encounters/${p.enc}/consult`)).status, 200);
  assert.equal((await post(`/encounters/${p.enc}/consult`)).status, 409, 'cannot open twice');
  assert.equal((await post(`/encounters/${p.enc}/summary/manual`, { note: 'x' })).status, 409, 'manual documentation only follows a rejection');
  assert.equal((await post(`/encounters/${p.enc}/summary/accept`)).status, 200);
  assert.equal((await post(`/encounters/${p.enc}/summary/accept`)).status, 409, 'cannot decide twice');
  assert.equal((await post(`/encounters/${p.enc}/summary/reject`)).status, 409);
  assert.equal((await q('SELECT status FROM encounters WHERE id = $1', [p.enc]))[0].status, 'completed');
});

test('accept, amend and reject each record who and when, and the AI draft is kept', async () => {
  // accept
  const a = await patient('Dev Kulkarni');
  await a.submit();
  await post(`/encounters/${a.enc}/consult`);
  await post(`/encounters/${a.enc}/summary/accept`);
  let r = (await get(`/encounters/${a.enc}/summary`)).body;
  assert.deepEqual(r.versions.map((v) => v.kind), ['ai_draft', 'accept']);
  assert.ok(r.versions[1].by, 'who');
  assert.ok(r.versions[1].at, 'when');
  assert.equal(r.summary.decision, 'accepted');
  assert.equal(r.summary.state, 'confirmed');
  assert.equal(r.versions[0].by, null, 'the AI draft has no human author');

  // amend
  const b = await patient('Esha Menon');
  await b.submit();
  await post(`/encounters/${b.enc}/consult`);
  const before = (await get(`/encounters/${b.enc}/summary`)).body.summary.content;
  const original = items(before).find((i) => i.id === 'cc.duration').text.en;
  assert.equal((await post(`/encounters/${b.enc}/summary/amend`, { edits: [] })).status, 400);
  assert.equal((await post(`/encounters/${b.enc}/summary/amend`, { edits: [{ id: 'cc.duration', text: '  ' }] })).status, 400);
  assert.equal((await post(`/encounters/${b.enc}/summary/amend`, { edits: [{ id: 'cc.duration', text: 'About two days, started with chills' }] })).status, 200);
  r = (await get(`/encounters/${b.enc}/summary`)).body;
  assert.deepEqual(r.versions.map((v) => v.kind), ['ai_draft', 'amend']);
  assert.deepEqual(r.versions[1].changed, ['cc.duration'], 'what changed is listed');
  const now = items(r.summary.content).find((i) => i.id === 'cc.duration');
  assert.equal(now.text.hi, 'About two days, started with chills');
  assert.equal(now.edited, true);
  assert.equal(r.summary.decision, 'amended');
  const draft = (await q(`SELECT content FROM summary_versions v JOIN summaries s ON s.id = v.summary_id WHERE s.encounter_id = $1 AND v.version = 1`, [b.enc]))[0].content;
  assert.equal(items(draft).find((i) => i.id === 'cc.duration').text.en, original, 'the AI draft is preserved unchanged');

  // reject, then manual documentation
  const c = await patient('Farid Khan');
  await c.submit();
  await post(`/encounters/${c.enc}/consult`);
  assert.equal((await post(`/encounters/${c.enc}/summary/reject`)).status, 200);
  assert.equal((await q('SELECT status FROM encounters WHERE id = $1', [c.enc]))[0].status, 'rejected');
  assert.equal((await post(`/encounters/${c.enc}/summary/manual`, {})).status, 400);
  assert.equal((await post(`/encounters/${c.enc}/summary/manual`, { note: 'History taken in person: fever for two days.' })).status, 200);
  r = (await get(`/encounters/${c.enc}/summary`)).body;
  assert.deepEqual(r.versions.map((v) => v.kind), ['ai_draft', 'reject', 'manual']);
  assert.equal(r.summary.decision, 'rejected');
  assert.equal(r.summary.note, 'History taken in person: fever for two days.');
  assert.equal((await q('SELECT status FROM encounters WHERE id = $1', [c.enc]))[0].status, 'completed');
  const actions = (await q(`SELECT action FROM audit_logs WHERE object_id = $1 AND action LIKE 'summary_%' OR object_id = $1 AND action = 'case_opened' ORDER BY at`, [c.enc])).map((x) => x.action);
  for (const a2 of ['summary_generated', 'case_opened', 'summary_reject', 'summary_manual']) assert.ok(actions.includes(a2), a2);
});

// Definition of Done 6: queue ordering, chips, counters, banner data, search and filter.
test('the queue puts alerts first, shows status chips and counters, and can be searched and filtered', async () => {
  const quiet = await patient('Quiet Person', { complaint: 'cough', duration: 'w1_4', files: [png('en-lab-printed')] });
  const urgent = await patient('Urgent Person', { complaint: 'chest_pain', duration: 'lt1d' });
  for (const [k, v] of [['hpi.progress', 'worse'], ['pain.site', 'centre of chest'], ['pain.onset', 'sudden'], ['pain.character', 'pressure'], ['pain.radiation', 'no'], ['pain.associated', ['breathlessness']]]) await urgent.answer(k, v);
  const done = await patient('Finished Person');
  await done.submit(); await post(`/encounters/${done.enc}/consult`); await post(`/encounters/${done.enc}/summary/accept`);
  await quiet.submit();

  const mine = new Set(['Quiet Person', 'Urgent Person', 'Finished Person']);
  const all = (await get('/encounters')).body;
  const names = all.items.map((i) => i.name).filter((x) => mine.has(x));
  assert.equal(names[0], 'Urgent Person', 'an open alert sorts first');
  assert.equal(names.at(-1), 'Finished Person', 'completed cases sort last');
  const u = all.items.find((i) => i.name === 'Urgent Person');
  assert.equal(u.chip, 'alert');
  assert.ok(u.openAlerts > 0);
  assert.equal(all.items.find((i) => i.name === 'Quiet Person').chip, 'ready');
  assert.equal(all.items.find((i) => i.name === 'Finished Person').chip, 'completed');
  assert.ok(all.counters.alerts >= 1 && all.counters.ready >= 1 && all.counters.completed >= 1);
  assert.equal(all.items.find((i) => i.name === 'Quiet Person').warnings.labs > 0, true, 'abnormal labs show as a warning chip');

  const by = async (qs) => (await get(`/encounters?${qs}`)).body.items.map((i) => i.name).filter((x) => mine.has(x) || qs.includes('nobody'));
  assert.deepEqual(await by('q=urgent'), ['Urgent Person']);
  assert.deepEqual(await by('q=chest'), ['Urgent Person'], 'search by complaint');
  assert.ok((await get(`/encounters?q=${u.token}`)).body.items.some((i) => i.name === 'Urgent Person'), 'search by token');
  assert.deepEqual(await by('status=ready'), ['Quiet Person']);
  assert.deepEqual(await by('status=completed'), ['Finished Person']);
  assert.ok((await by('alert=1')).includes('Urgent Person') && !(await by('alert=1')).includes('Quiet Person'));
  assert.deepEqual(await by('q=nobody-by-this-name'), []);
  // patients and staff cannot read the queue or the summary
  assert.equal((await t.call('GET', '/api/doctor/encounters', { cookie: quiet.cookie })).status, 403);
  assert.equal((await t.call('GET', `/api/doctor/encounters/${quiet.enc}/summary`, { cookie: quiet.cookie })).status, 403);
  assert.equal((await t.call('GET', `/api/doctor/encounters/${quiet.enc}/summary`, { cookie: await t.login('staff') })).status, 403);
});

test('the original scan is served to the doctor only, and the analysis carries its position and confidence', async () => {
  const buf = fixture('en-lab-printed.png');
  const p = await patient('Gita Nair', { files: [buf] });
  await p.submit();
  const a = (await get(`/encounters/${p.enc}/analysis`)).body;
  const point = a.results.lab_table.tests[0].points[0];
  assert.ok(point.confidence > 0 && point.confidence <= 1);
  for (const k of ['page', 'x0', 'y0', 'x1', 'y1']) assert.equal(typeof point.region[k], 'number');
  const res = await fetch(`${t.base}/api/doctor/encounters/${p.enc}/documents/${point.documentId}/file`, { headers: { cookie: doctor } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(buf), 'the exact original');
  const denied = await fetch(`${t.base}/api/doctor/encounters/${p.enc}/documents/${point.documentId}/file`, { headers: { cookie: p.cookie } });
  assert.equal(denied.status, 403);
});

test('submitting twice is harmless and the patient cannot reach any summary data', async () => {
  const p = await patient('Hari Om');
  await p.submit();
  assert.equal((await p.submit()).status, 200);
  assert.equal((await q('SELECT count(*)::int n FROM summary_versions v JOIN summaries s ON s.id = v.summary_id WHERE s.encounter_id = $1', [p.enc]))[0].n, 1);
  assert.equal((await t.call('POST', '/api/patient/submit')).status, 401);
  const blocked = await t.send('POST', '/api/patient/documents', png('en-rx-printed'), { cookie: p.cookie });
  assert.equal(blocked.status, 409, 'files cannot be added after submission');
  for (const path of ['/api/patient/interview/review', '/api/patient/documents']) {
    assert.equal(/summary|diagnos|interactions|reconciliation/i.test(JSON.stringify((await t.call('GET', path, { cookie: p.cookie })).body)), false, path);
  }
});
