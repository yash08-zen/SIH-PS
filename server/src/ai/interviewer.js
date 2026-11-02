import { diagnosticHits } from '../summary/generate.js';

// The AI interviewer: after the reason for the visit and the emergency screen, a model writes each further question from what the
// patient has said so far; medicines and allergies are asked last by the system. The model only proposes; checkQuestion decides. A
// question that is malformed, not in all three languages, repeats an earlier one, or states a diagnosis or gives advice is never shown.
// If the model fails before its first question the interview uses the fixed question tree (interview/routes.js); if it fails later the
// AI part ends and the closing questions follow. Only de-identified facts are sent: the reason, the answers, age group and sex.
//
// Provider: Google Gemini (generateContent with a JSON reply). Off unless AI_INTERVIEW_PROVIDER=gemini and GEMINI_API_KEY are set.

export const MIN_FOLLOWUPS = 3; // the model may not say it has enough before this many of its own questions
export const COMPLAINT_VALUES = ['chest_pain', 'fever', 'back_pain', 'cough', 'abdominal_pain', 'headache', 'other'];
const TYPES = ['yes_no', 'single', 'multi', 'number', 'text'];
const VALUE = /^[a-z0-9_]{1,40}$/;
const DEVANAGARI = /[ऀ-ॿ]/;
// Advice or diagnosis in a question ("you may have…", "you should take…") is not allowed, whatever diagnosticHits does not catch.
const ADVICE = /\b(you (may|might|probably|likely) have|you should|take (this|these|a) (medicine|tablet)|diagnos|it (is|could be|might be) (a|an)\b)/i;
const NONE = { value: 'none', label: ['None of these', 'इनमें से कोई नहीं', 'यापैकी काही नाही'] };
const YES_NO = [{ value: 'yes', label: ['Yes', 'हाँ', 'होय'] }, { value: 'no', label: ['No', 'नहीं', 'नाही'] }];

export const SYSTEM = `You interview a patient for a hospital outpatient department in India, before they see the doctor, like a careful nurse taking a history.
You are given what the patient said so far: the reason for the visit in their own words, and the questions already asked with the answers.
You write the ONE next question, every time, from what this patient actually said. There is no fixed list: follow this patient's story.
Good follow-ups cover, as the story needs: where, since when, how it started, how bad, what makes it better or worse, what came with it,
whether it has happened before, and how it affects daily life. Pick the most useful gap in what the doctor would otherwise not know.
Use the patient's own words and details from earlier answers. Never ask something the answers already tell you.

Rules you must follow:
- Ask only questions. Never diagnose, never name a possible disease or cause, never give advice, tests or treatment.
- Emergency signs, current medicines and allergies are asked separately by the system, at the end. Never ask about them.
- Do not repeat or rephrase a question that was already asked.
- Very simple words, for someone with little schooling. One short sentence.
- Prefer answer choices: "yes_no", "single" (choose one) or "multi" (choose several) with 2 to 6 short options.
  Use "number" only for a 0 to 10 score, and "text" only when choices cannot work.
- Option values are short English snake_case words (for example "since_yesterday").
- Give every text in English, Hindi (Devanagari script) and Marathi (Devanagari script).
- "minimumStillNeeded" is how many more questions you must ask before you may stop. While it is above 0, never set "done".
- Set "done": true (with no question) when the doctor already has enough to understand the problem, or when "remaining" is 0.
- Set "attention": true if an answer suggests staff should look at the patient soon (for example severe or sudden symptoms,
  trouble breathing, fainting, bleeding, confusion); say why in "attentionReason" (English). Do not alarm the patient in the question itself.
- "complaint" is the closest of: ${COMPLAINT_VALUES.join(', ')}.

Reply with only this JSON object:
{"done": false, "complaint": "...", "attention": false, "attentionReason": "",
 "rationale": "why this question helps the doctor, in English",
 "question": {"type": "single", "en": "...", "hi": "...", "mr": "...", "options": [{"value": "...", "en": "...", "hi": "...", "mr": "..."}], "min": 0, "max": 10}}`;

// Pulls the JSON object out of a model reply, tolerating a code fence or a sentence around it.
export function parseReply(text) {
  const t = String(text ?? '');
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the model did not return JSON');
  return JSON.parse(t.slice(start, end + 1));
}

const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const same = (a, b) => clean(a).toLowerCase().replace(/[^a-z0-9 ]/g, '') === clean(b).toLowerCase().replace(/[^a-z0-9 ]/g, '');

// Decides whether a model's proposal may be shown. Returns { ok: true, done } or { ok: true, question } (in the question bank's shape),
// or { ok: false, reason }. `asked` is the English text of every question already asked.
export function checkQuestion(reply, asked = []) {
  if (!reply || typeof reply !== 'object') return { ok: false, reason: 'no reply' };
  const complaint = COMPLAINT_VALUES.includes(reply.complaint) ? reply.complaint : null;
  const attention = reply.attention === true ? clean(reply.attentionReason).slice(0, 300) || 'flagged by the AI interviewer' : null;
  if (reply.done === true) return { ok: true, done: true, complaint, attention };
  const q = reply.question;
  if (!q || !TYPES.includes(q.type)) return { ok: false, reason: 'question type' };
  const text = [q.en, q.hi, q.mr].map(clean);
  if (text.some((s) => !s || s.length > 200)) return { ok: false, reason: 'question text missing or too long' };
  if (!DEVANAGARI.test(text[1]) || !DEVANAGARI.test(text[2])) return { ok: false, reason: 'Hindi or Marathi not in Devanagari' };
  if (asked.some((a) => same(a, text[0]))) return { ok: false, reason: 'repeats an earlier question' };

  let options;
  if (q.type === 'yes_no') options = YES_NO;
  if (q.type === 'single' || q.type === 'multi') {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 8) return { ok: false, reason: 'options' };
    options = q.options.map((o) => ({ value: String(o?.value ?? '').toLowerCase(), label: [o?.en, o?.hi, o?.mr].map(clean) }));
    if (options.some((o) => !VALUE.test(o.value) || o.label.some((l) => !l || l.length > 80))) return { ok: false, reason: 'option values or labels' };
    if (new Set(options.map((o) => o.value)).size !== options.length) return { ok: false, reason: 'duplicate options' };
    if (q.type === 'multi' && !options.some((o) => o.value === 'none')) options.push(NONE);
  }
  const all = [...text, ...(options ?? []).flatMap((o) => o.label)].join('\n');
  const hits = diagnosticHits(all);
  if (hits.length) return { ok: false, reason: `states a diagnosis (${hits[0]})` };
  if (ADVICE.test(text[0]) || (options ?? []).some((o) => ADVICE.test(o.label[0]))) return { ok: false, reason: 'gives advice or names a cause' };

  const question = { section: 'hpi', type: q.type, text, ai: true, rationale: clean(reply.rationale).slice(0, 300) };
  if (options) question.options = options;
  if (q.type === 'number') Object.assign(question, { min: 0, max: 10, scale: true });
  return { ok: true, done: false, complaint, attention, question };
}

// The facts sent to the model: no name, contact number, identifier or address. Age as a band.
export function interviewFacts({ reason, asked, ageGroup, sex, remaining, minimumStillNeeded = 0 }) {
  return { reasonForVisit: reason, person: { ageGroup, sex }, alreadyAsked: asked, remaining, minimumStillNeeded };
}

export function createGeminiInterviewer({ apiKey, model = 'gemini-3.6-flash', fetchImpl = fetch, timeoutMs = 20000, retryMs = 3000, baseUrl = 'https://generativelanguage.googleapis.com' }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required when AI_INTERVIEW_PROVIDER=gemini');
  return {
    name: 'gemini', model,
    async next(facts) {
      // a busy or rate-limited service (503, 429) is tried once more after a short wait
      const call = () => fetchImpl(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(facts) }] }],
          // low thinking: the model's own reasoning otherwise uses up the output budget and makes each question slow
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: 'low' } },
        }),
      });
      let res = await call();
      if ([429, 503].includes(res.status)) { await new Promise((r) => setTimeout(r, retryMs)); res = await call(); }
      if (!res.ok) throw new Error(`the model service answered ${res.status}`);
      const body = await res.json();
      return parseReply((body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''));
    },
  };
}

// null when the AI interviewer is off or not configured, so the fixed question tree is used.
export function interviewerFromEnv(env = process.env, log = console) {
  if ((env.AI_INTERVIEW_PROVIDER ?? 'rules') !== 'gemini') return null;
  if (!env.GEMINI_API_KEY) { log.warn('AI_INTERVIEW_PROVIDER=gemini but GEMINI_API_KEY is empty: using the fixed question tree'); return null; }
  return createGeminiInterviewer({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || undefined });
}
