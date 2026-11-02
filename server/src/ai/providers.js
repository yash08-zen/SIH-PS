import { LANG_KEYS } from '../summary/generate.js';

// The model that writes the overview of a patient's history (doctor and patient). A provider is { name, model, narrate({ audience, facts, content }) }
// and returns { en, hi, mr }. Two exist:
//   rules-v1   deterministic, runs inside the platform, needs nothing. Restates the recorded answers as short paragraphs. The default.
//   anthropic  a Claude model through the Anthropic Messages API. Off unless AI_PROVIDER=anthropic and ANTHROPIC_API_KEY are set.
// Choosing `anthropic` sends de-identified facts (no name, contact number or identifiers; age and sex only) outside the platform to the model
// provider. That is a decision for the hospital and its compliance reviewer (docs/data-flow.md); nothing is sent unless it is switched on.

const IDX = { en: 0, hi: 1, mr: 2 };
const clean = (s) => String(s ?? '').replace(/\?+$/, '').trim();

const NOT_ANSWERED = ['Not answered', 'उत्तर नहीं दिया', 'उत्तर दिले नाही'];
const LEAD = {
  doctor: ['Overview for the doctor', 'डॉक्टर के लिए सार', 'डॉक्टरांसाठी सार'],
  patient: ['What you told us', 'आपने हमें क्या बताया', 'तुम्ही आम्हाला काय सांगितले'],
};
const QUESTIONS_UNANSWERED = ['{n} question(s) were not answered.', '{n} प्रश्नों का उत्तर नहीं मिला।', '{n} प्रश्नांची उत्तरे मिळाली नाहीत.'];

export function createRulesProvider() {
  return {
    name: 'rules-v1', model: null,
    async narrate({ audience, content }) {
      const out = {};
      for (const l of LANG_KEYS) {
        const i = IDX[l];
        const paragraphs = [];
        for (const section of content.sections) {
          // the patient's recap is only what the patient said: no file findings, medicines read from files, or checks
          if (audience === 'patient' && section.id === 'investigations') continue;
          const lines = section.items
            .filter((it) => it.status === 'answered' && it.text && (audience === 'doctor' || it.source.type === 'patient'))
            .map((it) => `${it.label ? `${clean(it.label[i])}: ` : ''}${it.text[l]}`);
          if (lines.length) paragraphs.push(`${section.title[i]}: ${lines.join('; ')}.`);
        }
        const missing = content.completeness?.notAnswered?.length ?? 0;
        if (audience === 'doctor' && missing) paragraphs.push(`${NOT_ANSWERED[i]}: ${QUESTIONS_UNANSWERED[i].replace('{n}', missing)}`);
        out[l] = paragraphs.join('\n');
      }
      return out;
    },
  };
}

const SYSTEM = {
  doctor: `You help a doctor in an Indian hospital outpatient department read a patient's history before the consultation. You are given structured facts that an intake system recorded: what the patient answered, what their uploaded files contain, and checks the system ran.
Write a concise overview of 4 to 7 sentences in each of English, Hindi (Devanagari script) and Marathi (Devanagari script).
Rules you must follow:
- Use only the facts given. Never add, assume or guess anything.
- Do not diagnose. Do not suggest causes, tests, treatments or what the condition might be. Do not use words such as likely, probably, suggests, consistent with, suspected or indicates.
- A question listed under notAnswered was not answered; never write that the patient said no to it.
- Name files by their type and date. State out-of-range lab values with their direction of change only as recorded.
- Mention flagged interactions, allergy conflicts and record checks as items for the doctor to verify, in neutral words.
- Medicine and test names stay in English letters.
Reply with only a JSON object: {"en": "...", "hi": "...", "mr": "..."}`,
  patient: `You write a short, kind recap for a patient of what they told a hospital's intake system, so they can check that it is right.
Write 3 to 5 short sentences in each of English, Hindi (Devanagari script) and Marathi (Devanagari script), in very simple words for someone with little schooling.
Rules you must follow:
- Use only the facts given. Say "you told us ...".
- Do not diagnose or say what the illness might be. Give no advice about treatment, medicines or what to do. Do not mention results, alerts, risk, priority or urgency.
- Something not answered was simply not answered; never write that the patient said no to it.
- End by saying the doctor will go through it with them and that they can correct anything.
Reply with only a JSON object: {"en": "...", "hi": "...", "mr": "..."}`,
};

// Pulls the JSON object out of a model reply, tolerating a code fence or a sentence around it.
export function parseJsonReply(text) {
  const t = String(text ?? '');
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the model did not return JSON');
  const o = JSON.parse(t.slice(start, end + 1));
  for (const l of LANG_KEYS) if (typeof o[l] !== 'string' || !o[l].trim()) throw new Error(`the reply has no ${l} text`);
  return Object.fromEntries(LANG_KEYS.map((l) => [l, o[l].trim().slice(0, 4000)]));
}

export function createAnthropicProvider({ apiKey, model = 'claude-sonnet-5-5', baseUrl = 'https://api.anthropic.com', fetchImpl = fetch, timeoutMs = 45_000, maxTokens = 2000 }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  return {
    name: 'anthropic', model,
    async narrate({ audience, facts }) {
      const res = await fetchImpl(`${baseUrl}/v1/messages`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM[audience], messages: [{ role: 'user', content: JSON.stringify(facts) }] }),
      });
      if (!res.ok) throw new Error(`the model service answered ${res.status}`);
      const body = await res.json();
      return parseJsonReply((body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    },
  };
}

// Google Gemini (generateContent with a JSON reply). Same prompts and checks as the Anthropic writer; shares GEMINI_API_KEY with the interviewer.
export function createGeminiProvider({ apiKey, model = 'gemini-3.6-flash', baseUrl = 'https://generativelanguage.googleapis.com', fetchImpl = fetch, timeoutMs = 45_000, retryMs = 3000 }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required when AI_PROVIDER=gemini');
  return {
    name: 'gemini', model,
    async narrate({ audience, facts }) {
      const call = () => fetchImpl(`${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM[audience] }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(facts) }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 6000, thinkingConfig: { thinkingLevel: 'low' } },
        }),
      });
      let res = await call();
      if ([429, 503].includes(res.status)) { await new Promise((r) => setTimeout(r, retryMs)); res = await call(); }
      if (!res.ok) throw new Error(`the model service answered ${res.status}`);
      const body = await res.json();
      return parseJsonReply((body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''));
    },
  };
}

export function providerFromEnv(env = process.env, log = console) {
  const which = env.AI_PROVIDER ?? 'rules';
  if (which === 'anthropic') return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL || undefined, baseUrl: env.ANTHROPIC_BASE_URL || undefined });
  if (which === 'gemini') {
    if (!env.GEMINI_API_KEY) { log.warn('AI_PROVIDER=gemini but GEMINI_API_KEY is empty: the overview is written by rules'); return createRulesProvider(); }
    return createGeminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL || undefined });
  }
  return createRulesProvider();
}

export const LEAD_LABELS = LEAD;
