import { CATEGORIES, NEGATORS } from '../../config/emergency-words.v1.js';

// Finds emergency words in what the patient typed or said (config/emergency-words.v1.js). Pure and synchronous: the same text always gives the
// same matches. It is a net for emergencies nobody wrote a rule for, so it errs towards alerting; the word list is a draft awaiting review.

const ZERO_WIDTH = new RegExp(`[${String.fromCodePoint(0x200b, 0x200c, 0x200d)}]`, 'g');
const tokens = (text) => String(text ?? '').normalize('NFC').toLowerCase().replace(/['’‘`]/g, '').replace(ZERO_WIDTH, '')
  .split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);

const compile = (term) => term.normalize('NFC').toLowerCase().replace(/['’‘`]/g, '').split(/\s+/).filter(Boolean)
  .map((w) => (w.endsWith('*') ? { prefix: w.slice(0, -1) } : { exact: w }));

const COMPILED = CATEGORIES.map((c) => ({ ...c, compiled: c.terms.map((t) => ({ term: t, words: compile(t) })) }));
const NEGATING = new Set(NEGATORS.map((n) => n.normalize('NFC').toLowerCase()));
const WINDOW = 3;

const same = (w, tok) => ('exact' in w ? tok === w.exact : tok.startsWith(w.prefix));

// Every category found in the text, with the term that matched. One entry per category.
export function scanText(text) {
  const toks = tokens(text);
  const found = [];
  for (const cat of COMPILED) {
    let hit = null;
    for (const { term, words } of cat.compiled) {
      for (let i = 0; i + words.length <= toks.length && !hit; i++) {
        if (!words.every((w, k) => same(w, toks[i + k]))) continue;
        if (cat.level === 'attention') {
          const around = [...toks.slice(Math.max(0, i - WINDOW), i), ...toks.slice(i + words.length, i + words.length + WINDOW)];
          if (around.some((t) => NEGATING.has(t))) continue;
        }
        hit = term;
      }
      if (hit) break;
    }
    if (hit) found.push({ category: cat.id, level: cat.level, reason: cat.reason, term: hit });
  }
  return found;
}

// The text the patient wrote or said: free-text answers (the reason for the visit, "something else", typed lists, questions the AI wrote) and the
// transcript of anything answered by voice. The codes of tapped options ("chest_pain") are not words the patient said, so they are not scanned.
export function textMatches(answers) {
  const out = [];
  const seen = new Set();
  for (const [key, a] of Object.entries(answers)) {
    if (!a || a.skipped) continue;
    const texts = [];
    if (a.extracted !== undefined && typeof a.value === 'string') texts.push(a.value); // only free-text answers carry `extracted`
    if (typeof a.transcript === 'string') texts.push(a.transcript);
    for (const text of texts) {
      for (const m of scanText(text)) {
        if (seen.has(m.category)) continue;
        seen.add(m.category);
        out.push({ rule: { id: `RF-TEXT-${m.category}`, version: 1, level: m.level, reason: m.reason }, triggerKeys: [key], matched: m.term });
      }
    }
  }
  return out;
}
