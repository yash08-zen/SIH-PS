import { randomInt } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  ageYears, audit, findDuplicates, LANGS, maskName, normalizeMobile, PURPOSES, stripRestricted,
} from './patients.js';
import { addIdentifier, checkIdentifiers, createPatient, validateRegistration } from './registration.js';
import { createInterviewRouter } from './interview/routes.js';
import { addToQueue } from './alerts/service.js';
import { createDocumentsRouter } from './documents/routes.js';
import { createSpeechRouter } from './speech/routes.js';

export const OTP_MAX_ATTEMPTS = 3;
export const OTP_MAX_SENDS = 3; // per mobile per 15 minutes
const OTP_TTL_SECONDS = 300;

export function createPatientRouter({ pool, jwtSecret, crypto, otp, abdm, issueSession, exposeDevCode, redFlags, narration, help, docs, analysis, summary, purger, ai, interviewer, speech = null }) {
  const router = express.Router();

  // FR-P5: nothing leaves the Patient portal API with analysis results, abnormal flags or alert levels.
  router.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => json(stripRestricted(body));
    next();
  });

  const bad = (res, fields) => res.status(400).json({ error: 'invalid_input', fields });
  const helpRequest = (patientId, reason, detail) => help.create(patientId, reason, detail);

  async function startSession(res, patient, language) {
    const { rows } = await pool.query(
      'INSERT INTO patient_sessions (patient_id, language) VALUES ($1, $2) RETURNING id', [patient.id, language]);
    await audit(pool, { actorType: 'patient', actorId: patient.id, action: 'patient_session_started', objectType: 'patient_session', objectId: rows[0].id });
    issueSession(res, { sub: patient.id, role: 'patient', sid: rows[0].id, name: patient.full_name });
    return { patientcaseId: patient.patientcase_id, fullName: patient.full_name, language, sessionState: 'consent_pending' };
  }

  // ---- OTP ----
  router.post('/otp/send', async (req, res) => {
    const mobile = normalizeMobile(req.body?.mobile);
    if (!mobile) return bad(res, ['mobile']);
    const mobileHash = crypto.hash(mobile);
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int AS n FROM otp_challenges WHERE mobile_hash = $1 AND created_at > now() - interval '15 minutes'`, [mobileHash]);
    if (n >= OTP_MAX_SENDS) {
      await helpRequest(null, 'otp_too_many_requests', { mobileLast4: mobile.slice(-4) });
      return res.status(429).json({ error: 'too_many_requests', helpRequired: true });
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { rows } = await pool.query(
      `INSERT INTO otp_challenges (mobile_hash, code_hash, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second') RETURNING id`,
      [mobileHash, crypto.hash(code), OTP_TTL_SECONDS]);
    await otp.send(mobile, `Your PatientCase_AI code is ${code}. It is valid for 5 minutes.`);
    res.json({ challengeId: rows[0].id, expiresInSeconds: OTP_TTL_SECONDS, ...(exposeDevCode ? { devCode: code } : {}) });
  });

  router.post('/otp/verify', async (req, res) => {
    const { challengeId, code } = req.body ?? {};
    if (typeof challengeId !== 'string' || !/^[0-9a-f-]{36}$/.test(challengeId) || typeof code !== 'string') return bad(res, ['challengeId', 'code']);
    const { rows: [c] } = await pool.query('SELECT * FROM otp_challenges WHERE id = $1', [challengeId]);
    if (!c || c.consumed_at || c.expires_at < new Date()) return res.status(400).json({ error: 'challenge_expired' });
    if (c.locked_at) return res.status(423).json({ error: 'locked', helpRequired: true });
    if (c.verified_at) return res.status(400).json({ error: 'challenge_expired' });
    if (crypto.hash(code.trim()) !== c.code_hash) {
      const attempts = c.attempts + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await pool.query('UPDATE otp_challenges SET attempts = $2, locked_at = now() WHERE id = $1', [c.id, attempts]);
        await helpRequest(null, 'otp_failed', { challengeId: c.id });
        return res.status(423).json({ error: 'locked', helpRequired: true });
      }
      await pool.query('UPDATE otp_challenges SET attempts = $2 WHERE id = $1', [c.id, attempts]);
      return res.status(401).json({ error: 'invalid_code', attemptsLeft: OTP_MAX_ATTEMPTS - attempts });
    }
    await pool.query('UPDATE otp_challenges SET verified_at = now() WHERE id = $1', [c.id]);
    const verificationToken = jwt.sign({ typ: 'otp', cid: c.id, mh: c.mobile_hash }, jwtSecret, { expiresIn: '15m' });
    res.json({ verified: true, verificationToken });
  });

  // Returns the verified challenge for a token, or null. A challenge can be used once (consumed).
  async function verifiedChallenge(token) {
    try {
      const claims = jwt.verify(token, jwtSecret);
      if (claims.typ !== 'otp') return null;
      const { rows: [c] } = await pool.query('SELECT * FROM otp_challenges WHERE id = $1', [claims.cid]);
      return c && c.verified_at && !c.consumed_at ? c : null;
    } catch {
      return null;
    }
  }
  const consume = (id) => pool.query('UPDATE otp_challenges SET consumed_at = now() WHERE id = $1', [id]);

  // ---- Self-registration (FR-R1 to R7) ----
  router.post('/register', async (req, res) => {
    const body = req.body ?? {};
    const challenge = await verifiedChallenge(body.verificationToken);
    if (!challenge) return res.status(401).json({ error: 'mobile_not_verified' });
    const { errors, value } = validateRegistration(body);
    const ids = await checkIdentifiers(body, abdm);
    if (errors.length || ids.errors.length) return bad(res, [...errors, ...ids.errors]);
    if (crypto.hash(value.mobile) !== challenge.mobile_hash) return res.status(400).json({ error: 'mobile_mismatch' });

    const candidates = await findDuplicates(pool, { fullName: value.fullName, dob: value.born.dob, mobileHash: challenge.mobile_hash });
    const shown = candidates.filter((c) => c.viaMobile);
    const decision = body.duplicateDecision;
    if (shown.length && !decision) {
      return res.status(409).json({
        error: 'possible_duplicate',
        candidates: shown.map((c) => ({ patientId: c.id, maskedName: maskName(c.full_name), ageYears: ageYears(c.date_of_birth), patientcaseIdEnd: c.patientcase_id.slice(-4), match: c.kind })),
      });
    }
    if (decision?.confirmExistingId) {
      const existing = shown.find((c) => c.id === decision.confirmExistingId);
      if (!existing) return bad(res, ['duplicateDecision']);
      await consume(challenge.id);
      const out = await startSession(res, { id: existing.id, patientcase_id: existing.patientcase_id, full_name: existing.full_name }, value.language);
      return res.json({ existing: true, ...out });
    }
    const patient = await createPatient(pool, crypto, { value, abhaId: ids.abhaId, aadhaar: ids.aadhaar, channel: 'self' });
    // A name-and-age look-alike (different mobile), or an override of a shown match, goes to staff for review.
    const toReview = candidates.filter((c) => !c.viaMobile || decision?.createNew);
    if (toReview.length) await helpRequest(patient.id, 'possible_duplicate_review', { candidateIds: toReview.map((c) => c.id) });
    await consume(challenge.id);
    const out = await startSession(res, patient, value.language);
    res.status(201).json({ existing: false, ...out });
  });

  // ---- Returning-patient lookup (FR-R9, FR-D1) ----
  router.post('/lookup', async (req, res) => {
    const { method, language } = req.body ?? {};
    if (!LANGS.includes(language)) return bad(res, ['language']);
    const find = async (sql, params) => (await pool.query(sql, params)).rows;
    let matches = [];

    if (method === 'patientcase_id') {
      // The ID alone is not enough to sign in: the date of birth must match too.
      const { patientcaseId, dateOfBirth } = req.body;
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateOfBirth ?? ''))) {
        // An age-only registration stores 1 January of the birth year (dob_estimated), so only the year has to match.
        matches = await find(
          `SELECT * FROM patients WHERE patientcase_id = $1
              AND (date_of_birth = $2::date OR (dob_estimated AND extract(year FROM date_of_birth) = extract(year FROM $2::date)))`,
          [String(patientcaseId ?? '').toUpperCase().trim(), dateOfBirth]);
      }
    } else if (method === 'abha' || method === 'aadhaar') {
      const raw = String(req.body[method === 'abha' ? 'abhaId' : 'aadhaar'] ?? '').replace(/\D/g, '');
      const ok = method === 'abha' ? await abdm.verifyAbha(raw) : await abdm.verifyAadhaar(raw);
      if (!ok.verified) return bad(res, [method === 'abha' ? 'abhaId' : 'aadhaar']);
      matches = await find(
        `SELECT p.* FROM patients p JOIN patient_identifiers i ON i.patient_id = p.id WHERE i.type = $1 AND i.value_hash = $2`,
        [method === 'abha' ? 'abha' : 'aadhaar_ref', crypto.hash(raw)]);
    } else if (method === 'mobile_otp') {
      const challenge = await verifiedChallenge(req.body.verificationToken);
      if (!challenge) return res.status(401).json({ error: 'mobile_not_verified' });
      matches = await find('SELECT * FROM patients WHERE mobile_hash = $1', [challenge.mobile_hash]);
      if (matches.length > 1 && !req.body.patientId) {
        return res.json({ choose: matches.map((p) => ({ patientId: p.id, maskedName: maskName(p.full_name), ageYears: ageYears(p.date_of_birth) })) });
      }
      if (req.body.patientId) matches = matches.filter((p) => p.id === req.body.patientId);
      if (matches.length === 1) await consume(challenge.id);
    } else {
      return bad(res, ['method']);
    }

    if (matches.length !== 1) return res.status(404).json({ error: 'not_found' });
    const out = await startSession(res, matches[0], language);
    res.json({ existing: true, ...out });
  });

  // ---- Everything below needs a patient session ----
  async function requireSession(req, res, next) {
    if (req.user?.role !== 'patient' || !req.user.sid) return res.status(401).json({ error: 'not_signed_in' });
    const { rows: [s] } = await pool.query('SELECT * FROM patient_sessions WHERE id = $1', [req.user.sid]);
    if (!s || ['closed', 'revoked', 'purged'].includes(s.state)) return res.status(403).json({ error: 'session_closed' });
    req.pSession = s;
    next();
  }

  // No clinical data may be written for a purpose without live consent (FR-D2, FR-D3).
  const requirePurpose = (purpose) => async (req, res, next) => {
    const s = req.pSession;
    if (s.state === 'active' && s.consent_id) {
      const { rows: [c] } = await pool.query('SELECT scope, revoked_at FROM consents WHERE id = $1', [s.consent_id]);
      if (c && !c.revoked_at && c.scope?.[purpose] === true) return next();
    }
    res.status(403).json({ error: 'consent_required', purpose });
  };

  router.get('/me', requireSession, async (req, res) => {
    const { rows: [p] } = await pool.query('SELECT patientcase_id, full_name FROM patients WHERE id = $1', [req.user.sub]);
    let scope = null;
    if (req.pSession.consent_id) scope = (await pool.query('SELECT scope FROM consents WHERE id = $1', [req.pSession.consent_id])).rows[0].scope;
    res.json({ patientcaseId: p.patientcase_id, fullName: p.full_name, language: req.pSession.language, sessionState: req.pSession.state, consent: scope });
  });

  router.post('/consent', requireSession, async (req, res) => {
    const s = req.pSession;
    if (s.state !== 'consent_pending') return res.status(409).json({ error: 'consent_already_recorded' });
    const given = req.body?.purposes;
    if (!given || PURPOSES.some((p) => typeof given[p] !== 'boolean')) return bad(res, PURPOSES.map((p) => `purposes.${p}`));
    const language = LANGS.includes(req.body.language) ? req.body.language : s.language;
    const scope = Object.fromEntries(PURPOSES.map((p) => [p, given[p]]));

    // History is the core purpose. Without it the session ends and nothing clinical is stored (PRD 12.4).
    if (!scope.history) {
      await pool.query(`UPDATE patient_sessions SET state = 'closed', closed_at = now() WHERE id = $1`, [s.id]);
      await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'consent_declined', objectType: 'patient_session', objectId: s.id, detail: scope });
      return res.json({ closed: true, sessionState: 'closed' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [c] } = await client.query('INSERT INTO consents (patient_id, scope, language) VALUES ($1, $2, $3) RETURNING id', [req.user.sub, scope, language]);
      // A patient who paused (answers saved, nothing submitted yet) and comes back today continues the same encounter and keeps the same token.
      const { rows: [open] } = await client.query(
        `SELECT e.id FROM encounters e WHERE e.patient_id = $1 AND e.submitted_at IS NULL AND e.status NOT IN ('completed', 'rejected')
            AND e.started_at >= date_trunc('day', now()) AND EXISTS (SELECT 1 FROM interview_responses r WHERE r.encounter_id = e.id)
          ORDER BY e.started_at DESC LIMIT 1`, [req.user.sub]);
      let e = open;
      if (!e) {
        ({ rows: [e] } = await client.query('INSERT INTO encounters (patient_id) VALUES ($1) RETURNING id', [req.user.sub]));
        await addToQueue(client, e.id); // token number and queue position (FR-T1)
      }
      await client.query(`UPDATE patient_sessions SET state = 'active', consent_id = $2, encounter_id = $3 WHERE id = $1`, [s.id, c.id, e.id]);
      await audit(client, { actorType: 'patient', actorId: req.user.sub, action: 'consent_given', objectType: 'consent', objectId: c.id, detail: scope });
      await client.query('COMMIT');
      res.status(201).json({ closed: false, sessionState: 'active', consent: scope, encounterId: e.id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  router.post('/consent/revoke', requireSession, async (req, res) => {
    const s = req.pSession;
    if (!s.consent_id) return res.status(409).json({ error: 'no_consent' });
    const wanted = req.body?.purposes === 'all' ? PURPOSES : req.body?.purposes;
    if (!Array.isArray(wanted) || !wanted.length || wanted.some((p) => !PURPOSES.includes(p))) return bad(res, ['purposes']);
    const { rows: [c] } = await pool.query('SELECT scope FROM consents WHERE id = $1', [s.consent_id]);
    const scope = { ...c.scope };
    for (const p of wanted) scope[p] = false;
    const none = PURPOSES.every((p) => scope[p] === false);
    await pool.query('UPDATE consents SET scope = $2, revoked_at = CASE WHEN $3 THEN now() ELSE revoked_at END WHERE id = $1', [s.consent_id, scope, none]);
    if (scope.history === false) await pool.query(`UPDATE patient_sessions SET state = 'revoked', closed_at = now() WHERE id = $1`, [s.id]);
    for (const p of wanted) {
      await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'consent_revoked', objectType: 'consent', objectId: s.consent_id, detail: { purpose: p } });
    }
    // stop processing and remove data according to the consent terms (PRD Section 14)
    const removed = s.encounter_id ? await purger.onRevoked(s.encounter_id, wanted) : {};
    res.json({ consent: scope, sessionState: scope.history === false ? 'revoked' : s.state, ...(Object.keys(removed).length ? { removed: Object.keys(removed) } : {}) });
  });

  // ---- Call for help: available on every patient screen (FR-A18). The staff screen arrives in Phase 3. ----
  // Works before sign-in too (language and registration screens), so a patient who is stuck can always reach staff.
  router.post('/help', async (req, res) => {
    const patientId = req.user?.role === 'patient' && req.user.sid ? req.user.sub : null;
    await helpRequest(patientId, 'help_button', { screen: String(req.body?.screen ?? '').slice(0, 60) });
    if (patientId) await audit(pool, { actorType: 'patient', actorId: patientId, action: 'help_requested', objectType: 'patient_session', objectId: req.user.sid });
    res.status(201).json({ requested: true });
  });

  // The urgent-help button, on every patient screen. With a live session it raises an emergency alert on the patient's case at once; without one
  // (before registration) staff still get an urgent help request. It needs no consent: asking for help is never blocked.
  router.post('/urgent', async (req, res) => {
    let patientId = null, encounterId = null;
    if (req.user?.role === 'patient' && req.user.sid) {
      const { rows: [s] } = await pool.query('SELECT state, encounter_id FROM patient_sessions WHERE id = $1', [req.user.sid]);
      if (s && !['closed', 'revoked', 'purged'].includes(s.state)) { patientId = req.user.sub; encounterId = s.encounter_id; }
    }
    if (encounterId) await redFlags.urgent(encounterId);
    await helpRequest(patientId, 'urgent_help', { screen: String(req.body?.screen ?? '').slice(0, 60), alert: Boolean(encounterId) });
    if (patientId) await audit(pool, { actorType: 'patient', actorId: patientId, action: 'urgent_help_pressed', objectType: 'patient_session', objectId: req.user.sid, detail: { alert: Boolean(encounterId) } });
    res.status(201).json({ notified: true }); // nothing about alerts goes back to the patient (FR-P5)
  });

  // ---- Interview (Phase 2): every route needs a live session and history consent ----
  router.use('/interview', requireSession, requirePurpose('history'), createInterviewRouter({ pool, redFlags, narration, help, analysis, interviewer }));

  // ---- Consent-guarded writes ----
  router.put('/responses/:questionKey', requireSession, requirePurpose('history'), async (req, res) => {
    const { answer, modality, confidence } = req.body ?? {};
    if (answer === undefined || !['voice', 'tap'].includes(modality)) return bad(res, ['answer', 'modality']);
    await pool.query(
      `INSERT INTO interview_responses (encounter_id, question_key, answer, modality, confidence)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (encounter_id, question_key) DO UPDATE SET answer = $3, modality = $4, confidence = $5, confirmed = false`,
      [req.pSession.encounter_id, req.params.questionKey.slice(0, 80), JSON.stringify(answer), modality, confidence ?? null]);
    await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'history_answer_saved', objectType: 'encounter', objectId: req.pSession.encounter_id });
    res.json({ saved: true });
  });

  // ---- Documents (Phase 4): needs a live session and the "documents" consent ----
  router.use('/speech', requireSession, requirePurpose('history'), createSpeechRouter({ pool, speech }));
  router.use('/documents', requireSession, requirePurpose('documents'), createDocumentsRouter({ pool, store: docs.store, pipeline: docs.pipeline, limits: docs.limits, analysis }));
  // The patient's own recap, written after they submit: only what they said, in their language, with no checks, flags or findings (the doctor's
  // overview, which has those, is never sent here). It says who wrote it so the patient is never led to think a person did.
  router.get('/summary', requireSession, requirePurpose('history'), async (req, res) => {
    const { rows: [e] } = await pool.query('SELECT submitted_at FROM encounters WHERE id = $1', [req.pSession.encounter_id]);
    if (!e.submitted_at) return res.json({ submitted: false });
    const n = await ai.get(req.pSession.encounter_id, 'patient');
    if (!n || n.status !== 'ready') return res.json({ submitted: true, status: 'pending' });
    res.json({ submitted: true, status: 'ready', text: n.text[req.pSession.language] ?? n.text.en, language: n.text[req.pSession.language] ? req.pSession.language : 'en', writtenBy: n.provider === 'rules-v1' ? 'rules' : 'ai' });
  });

  // ---- Submission (Phase 6): locks the intake, analyses the files, saves the draft summary and marks the case Ready ----
  router.post('/submit', requireSession, requirePurpose('history'), async (req, res) => {
    const { first } = await summary.submit(req.pSession.encounter_id);
    await purger.afterSubmission(req.pSession.encounter_id); // temporary data goes as soon as the intake is submitted (FR-D7)
    if (first) await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'intake_submitted', objectType: 'encounter', objectId: req.pSession.encounter_id });
    res.json({ submitted: true }); // the patient is told nothing about the content (FR-P5)
  });

  // ---- Optional ABHA creation or linking (FR-R7) ----
  router.post('/abha/link', requireSession, async (req, res) => {
    const id = String(req.body?.abhaId ?? '').replace(/\D/g, '');
    if (!(await abdm.verifyAbha(id)).verified) return bad(res, ['abhaId']);
    await addIdentifier(pool, crypto, req.user.sub, 'abha', id);
    await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'abha_linked', objectType: 'patient', objectId: req.user.sub });
    res.json({ linked: true });
  });
  router.post('/abha/create', requireSession, async (req, res) => {
    const { abhaId } = await abdm.createAbha();
    await addIdentifier(pool, crypto, req.user.sub, 'abha', abhaId);
    await audit(pool, { actorType: 'patient', actorId: req.user.sub, action: 'abha_created', objectType: 'patient', objectId: req.user.sub });
    res.status(201).json({ created: true, abhaId });
  });

  return router;
}
