import { BRANCH_LIMIT, CLOSING, CLOSING_MAX, MAX_QUESTIONS, OPENING, QUESTIONS, ROOT, SECTIONS, UNITS, YES_NO_LABELS } from '../../config/questions.v1.js';
import { AYUSH_QUESTIONS, AYUSH_SECTIONS } from '../../config/ayush.v1.js';

const IDX = { en: 0, hi: 1, mr: 2 };
const byKey = new Map([...QUESTIONS, ...AYUSH_QUESTIONS].map((q) => [q.key, q]));
export const getQuestion = (key) => byKey.get(key);

// answers: { [questionKey]: { value } | { skipped: true } }. A skipped question has no value, so it never satisfies a condition:
// "not answered" is never treated as "no" (FR-A10).
function holds(when, values) {
  if (when.all) return when.all.every((w) => holds(w, values));
  if (when.any) return when.any.some((w) => holds(w, values));
  const v = values[when.key];
  if (v === undefined) return false;
  if ('eq' in when) return v === when.eq;
  if ('in' in when) return when.in.includes(v);
  if ('includes' in when) return Array.isArray(v) && v.includes(when.includes);
  return false;
}

const valuesOf = (answers) => Object.fromEntries(Object.entries(answers).filter(([, a]) => a && !a.skipped).map(([k, a]) => [k, a.value]));
const OPENING_SET = new Set(OPENING);
const CLOSING_SET = new Set(['drug.current_any', 'drug.current_list', 'allergy.any', 'allergy.list']);

// The question after `q`, from its `next` rule and the answers so far (see questions.v1.js).
function follow(q, values) {
  const { next } = q;
  if (!Array.isArray(next)) return next ?? null;
  for (const rule of next) {
    if (!Array.isArray(rule)) return rule;
    if (holds(rule[0], values)) return rule[1];
  }
  return null;
}

// The patient's path through the branching interview: from the reason for the visit, each answer picks the next question.
// It stops at the first question not yet answered (what comes after depends on that answer). Answers read from the patient's own
// words (`derived`) were never asked, so they leave room for more questions about the reason; the questions about the reason are
// capped so that what is actually asked, including the closing medicines and allergies, never exceeds MAX_QUESTIONS.
function path(answers) {
  const values = valuesOf(answers);
  const out = [];
  const seen = new Set();
  let key = ROOT;
  let opened = 0; // opening questions the patient was actually asked
  let branch = 0;
  while (key && !seen.has(key)) {
    if (!OPENING_SET.has(key) && !CLOSING_SET.has(key) && branch++ >= Math.min(BRANCH_LIMIT, MAX_QUESTIONS - CLOSING_MAX - opened)) key = CLOSING;
    if (OPENING_SET.has(key) && !answers[key]?.derived) opened++;
    seen.add(key);
    const q = byKey.get(key);
    out.push(q);
    if (!answers[key]) return { questions: out, done: false };
    key = follow(q, values);
  }
  return { questions: out, done: true };
}

// The AI interview (ai/interviewer.js): the reason, the emergency screen, then questions written by the model from the answers so far,
// until the model says it has enough or AI_FOLLOWUPS are asked; medicines and allergies always come last (safety questions, always asked).
// An AI question is stored with its answer (answer.question), so the path can be rebuilt from the answers alone; `pending` is the AI
// question waiting for an answer. Readers that pass no engine state (summaries, metrics) get the path as recorded: the AI part is closed.
export const isAiKey = (key) => key.startsWith('ai.');
export const AI_FIXED = ['cc.reason', 'emergency.screen'];
export const AI_TOTAL = 12; // most questions asked in an AI interview, closing questions included
export const AI_FOLLOWUPS = AI_TOTAL - AI_FIXED.length - CLOSING_MAX; // most questions the model may write
const aiQuestionOf = (key, answer) => (answer?.question ? { ...answer.question, key } : null);
const aiKeys = (answers) => Object.keys(answers).filter(isAiKey).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));

function aiPath(answers, ai) {
  const values = valuesOf(answers);
  const out = [];
  for (const key of AI_FIXED) {
    out.push(byKey.get(key));
    if (!answers[key]) return { questions: out, done: false };
  }
  for (const key of aiKeys(answers)) out.push(aiQuestionOf(key, answers[key]));
  if (ai && !ai.done && aiKeys(answers).length < AI_FOLLOWUPS) {
    return ai.pending ? { questions: [...out, ai.pending], done: false } : { questions: out, done: false, needsAi: true };
  }
  for (let key = CLOSING; key; key = follow(byKey.get(key), values)) {
    out.push(byKey.get(key));
    if (!answers[key]) return { questions: out, done: false };
  }
  return { questions: out, done: true };
}
// The engine for these answers: AI when the encounter runs it, or when it already holds AI answers (summaries pass no engine).
const usesAi = (answers, opts) => opts?.engine === 'ai' || (opts?.engine !== 'rules' && aiKeys(answers).length > 0);
const route = (answers, opts) => (usesAi(answers, opts) ? aiPath(answers, opts?.ai) : path(answers));

// Answers read from the reason in the patient's own words: the complaint when exactly one is named, and how long when a duration is
// said. They are stored as `derived` (the patient can change them on the review screen) and are never guessed: no match, no answer.
export function deriveFromReason(extracted) {
  const out = {};
  const complaint = QUESTIONS.find((x) => x.key === 'cc.main').options.find((o) => o.value === extracted?.complaints?.[0]);
  if (extracted?.complaints?.length === 1 && complaint) out['cc.main'] = complaint.value;
  if (extracted?.duration?.key) out['cc.duration'] = extracted.duration.key;
  return out;
}

// What the patient came for, in their language, for phrasing the questions after it: the complaint they named or chose, or for
// "something else" their own words (shortened). null before the reason is known.
const ABOUT = [(x) => (x.startsWith('“') ? `About ${x}: ` : `About your ${x}: `), (x) => `${x} के बारे में: `, (x) => `${x} बद्दल: `];
function subjectOf(answers, i) {
  const main = answers['cc.main'];
  const reason = answers['cc.reason'];
  if (main && !main.skipped && main.value !== 'other') {
    const label = QUESTIONS.find((x) => x.key === 'cc.main').options.find((o) => o.value === main.value).label[i];
    return i === 0 ? label.toLowerCase() : label;
  }
  if (reason && !reason.skipped && typeof reason.value === 'string') {
    const words = reason.value.trim().replace(/\s+/g, ' ');
    return `“${words.length > 40 ? `${words.slice(0, 38).trim()}…` : words}”`;
  }
  return null;
}
// Questions about the complaint itself are phrased around it; the safety questions and the reason itself stay as written.
const PHRASED = (q) => !q.ai && ['chief_complaint', 'hpi'].includes(q.section) && !['cc.reason', 'cc.main', 'emergency.screen'].includes(q.key);

// The questions on the patient's path so far (answered, plus the one to answer next). AYUSH questions (Phase 7) follow a finished
// path and are asked only in AYUSH mode, by their own conditions. Answers already given are kept either way.
// opts: { ayush, engine: 'ai' | 'rules', ai: { pending, done } } (engine and ai come from the encounter; see interview/routes.js).
export function activeQuestions(answers, opts = {}) {
  const { questions, done } = route(answers, opts);
  if (!opts.ayush) return questions;
  const values = valuesOf(answers);
  // AYUSH questions are asked once the main path is finished; AYUSH answers already given always stay in the record.
  return [...questions, ...AYUSH_QUESTIONS.filter((q) => (done || answers[q.key]) && (!q.when || holds(q.when, values)))];
}

// `needsAi`: the AI interview has room for another question but the model has not written it yet (the route asks it, then calls again).
export function nextQuestion(answers, opts) {
  const active = activeQuestions(answers, opts);
  const answered = active.filter((q) => answers[q.key] && !answers[q.key].derived).length; // only what the patient was asked
  const next = active.find((q) => !answers[q.key]);
  // The rest of the path depends on answers not given yet, so the total is the most it can be (shown as "of about").
  const ayushCount = opts?.ayush ? AYUSH_QUESTIONS.length : 0;
  const needsAi = !next && usesAi(answers, opts) && Boolean(aiPath(answers, opts?.ai).needsAi);
  return { question: next ?? null, answered, total: next || needsAi ? Math.max(active.length, (usesAi(answers, opts) ? AI_TOTAL : MAX_QUESTIONS) + ayushCount) : answered, needsAi };
}

// The question with this key on the encounter's path: a bank question, the pending AI question, or an AI question already answered.
export function findQuestion(key, answers, opts) {
  return activeQuestions(answers, opts).find((q) => q.key === key) ?? null;
}

// Answers whose question is no longer on the path (an earlier answer was changed) are stale.
// AYUSH answers are never stale just because AYUSH mode is off, or the main path is not finished, so switching modes loses nothing.
// Answers read from the reason are kept while the reason stands: they are filled in ahead of the path reaching them.
// AI questions keep their answers: what the model asked stays part of the record even when an earlier answer is changed.
export function staleKeys(answers, opts) {
  const live = new Set(route(answers, opts).questions.map((q) => q.key));
  const values = valuesOf(answers);
  for (const q of AYUSH_QUESTIONS) if (!q.when || holds(q.when, values)) live.add(q.key);
  return Object.keys(answers).filter((k) => !live.has(k) && !isAiKey(k) && !(answers[k].derived && answers['cc.reason']));
}

export function validateAnswer(q, value) {
  switch (q.type) {
    case 'yes_no': return value === 'yes' || value === 'no';
    case 'single': return q.options.some((o) => o.value === value);
    case 'multi': {
      if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length) return false;
      if (!value.every((v) => q.options.some((o) => o.value === v))) return false;
      return !(value.includes('none') && value.length > 1); // "none of these" excludes everything else
    }
    case 'number': return typeof value === 'number' && Number.isFinite(value) && value >= (q.min ?? 0) && value <= (q.max ?? 120);
    case 'text': return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
    default: return false;
  }
}

// The question as the patient sees it. With the answers so far, a question about the complaint names it: "About your cough: …".
export function presentQuestion(q, lang, answers = {}) {
  const i = IDX[lang] ?? 0;
  const subject = PHRASED(q) ? subjectOf(answers, i) : null;
  const base = { key: q.key, section: q.section, type: q.type, text: subject ? ABOUT[i](subject) + q.text[i] : q.text[i], critical: Boolean(q.critical), followUp: Boolean(q.when) || (!q.key.startsWith('ayush.') && !OPENING_SET.has(q.key) && !CLOSING_SET.has(q.key)),
    ...(q.ai ? { askedBy: 'ai' } : {}) };
  if (q.options) base.options = q.options.map((o) => ({ value: o.value, label: o.label[i] }));
  if (q.type === 'number') Object.assign(base, { min: q.min ?? 0, max: q.max ?? 120, scale: Boolean(q.scale) });
  return base;
}

export function displayAnswer(q, answer, lang) {
  const i = IDX[lang] ?? 0;
  if (!answer || answer.skipped) return null;
  const { value } = answer;
  if (q.type === 'yes_no') return YES_NO_LABELS[value][i];
  if (q.type === 'single') return q.options.find((o) => o.value === value).label[i];
  if (q.type === 'multi') return value.map((v) => q.options.find((o) => o.value === v).label[i]).join(', ');
  if (q.type === 'number') return `${value}${UNITS[q.key] ? ` ${UNITS[q.key][i]}` : ''}`;
  return value;
}

// Answers as a reviewable list, in ontology order, only for reachable questions.
export function reviewList(answers, lang, opts) {
  const i = IDX[lang] ?? 0;
  return activeQuestions(answers, opts).filter((q) => answers[q.key]).map((q) => ({
    key: q.key, section: q.section, question: q.text[i], critical: Boolean(q.critical),
    skipped: Boolean(answers[q.key].skipped), answer: displayAnswer(q, answers[q.key], lang),
  }));
}

// The standard physician-readable structure (FR-A13). "not answered" (skipped or never asked) stays distinct from "no".
export function structuredHistory(answers, lang, opts) {
  const i = IDX[lang] ?? 0;
  const active = activeQuestions(answers, opts);
  return (opts?.ayush ? [...SECTIONS, ...AYUSH_SECTIONS] : SECTIONS).map(([id, title]) => ({
    section: id,
    title: title[i],
    items: active.filter((q) => q.section === id).map((q) => {
      const a = answers[q.key];
      return {
        key: q.key, question: q.text[i],
        status: !a ? 'not_asked' : a.skipped ? 'not_answered' : 'answered',
        answer: displayAnswer(q, a, lang),
        ...(a?.extracted ? { extracted: a.extracted } : {}),
      };
    }),
  }));
}
