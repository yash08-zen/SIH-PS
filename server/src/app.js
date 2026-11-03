import './pgTypes.js';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createPatientRouter } from './patientRoutes.js';
import { createStaffRouter } from './staffRoutes.js';
import { createDoctorRouter } from './doctorRoutes.js';
import { createAlertHub } from './alerts/hub.js';
import { createHelp } from './alerts/help.js';
import { createAlertService, createRedFlagEvaluator } from './alerts/service.js';
import { createRuleNarrationMapper } from './interview/narration.js';
import { interviewerFromEnv } from './ai/interviewer.js';
import { speechFromEnv } from './speech/bhashini.js';
import { createDocuments } from './documents/index.js';
import { createAnalysisService } from './analysis/service.js';
import { createSummaryService } from './summary/service.js';
import { createAiAnalyst } from './ai/service.js';
import { providerFromEnv } from './ai/providers.js';
import { createIntegration } from './integration/service.js';
import { createHisConnector } from './integration/connectors.js';
import { createPurger } from './compliance/purge.js';
import { createAdminRouter } from './adminRoutes.js';
import { createDashboardRouter } from './dashboard.js';
import { createMonitor, createWebhookNotifier } from './ops/monitor.js';
import { createMockOtpProvider, createStubAbdmProvider } from './providers.js';
import { audit } from './patients.js';
import { newSecret, otpauthUri, verifyCode } from './totp.js';
import { createLoginLimiter, rejectNul, securityHeaders } from './security.js';

export const PORTALS = ['patient', 'staff', 'doctor', 'admin'];
// Each role reaches exactly one portal (FR-P4).
export const ROLE_PORTAL = { patient: 'patient', staff: 'staff', doctor: 'doctor', admin: 'admin' };

const COOKIE = 'pc_session';
const SESSION_HOURS = 8;

function readCookie(req, name) {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function createApp({ pool, jwtSecret, crypto, otp = createMockOtpProvider(), abdm = createStubAbdmProvider(), exposeDevCode = false,
  redFlags, narration = createRuleNarrationMapper(), documents, analysisDelayMs, requireMfa = false, aiProvider, aiInterviewer, speechProvider, integration, loginLimiter = createLoginLimiter(), reportPool = pool, notifier, opsToken = process.env.OPS_TOKEN, monitorIntervalMs = 30_000 }) {
  const app = express();
  const docs = documents ?? createDocuments({ pool, crypto });
  // Cross-document analysis (Phase 5): rebuilt whenever a file finishes, is added, removed, replaced or reordered, or a medicine or allergy answer changes.
  const analysis = createAnalysisService({ pool, ...(analysisDelayMs != null ? { delayMs: analysisDelayMs } : {}) });
  docs.pipeline.onDone((encounterId) => analysis.schedule(encounterId, 'document_processed'));
  docs.pipeline.recover().catch(() => {}); // files that were waiting when the server last stopped go back in the queue
  // The overview of a patient's history, written after submission (rule-based unless an AI model is switched on with AI_PROVIDER).
  const ai = createAiAnalyst({ pool, provider: aiProvider ?? providerFromEnv() });
  // The AI interviewer (Gemini) writes the questions after the reason for the visit; null keeps the fixed question tree.
  const interviewer = aiInterviewer === undefined ? interviewerFromEnv() : aiInterviewer;
  // Speech recognition and output through Bhashini / AI4Bharat when SPEECH_PROVIDER=bhashini; null keeps speech in the browser.
  const speech = speechProvider === undefined ? speechFromEnv() : speechProvider;
  app.locals.ai = ai;
  const summary = createSummaryService({ pool, analysis, ai });
  const integ = integration ?? createIntegration({ pool, crypto, his: createHisConnector(), abdm });
  const purger = createPurger({ pool, store: docs.store, analysis, integration: integ });
  app.locals.integration = integ;
  app.locals.purger = purger;
  app.locals.docs = docs;
  app.locals.summary = summary;
  app.locals.analysis = analysis;
  const hub = createAlertHub();
  const help = createHelp({ pool, hub });
  const service = createAlertService({ pool, hub });
  const evaluator = redFlags ?? createRedFlagEvaluator(service); // tests may inject a spy
  app.locals.alerts = { hub, service, help };
  app.disable('x-powered-by');
  app.use(securityHeaders({ isProd: process.env.NODE_ENV === 'production' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(rejectNul());

  const issue = (res, claims) => {
    const token = jwt.sign(claims, jwtSecret, { expiresIn: `${SESSION_HOURS}h` });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_HOURS * 3600_000 });
  };

  // A staff, doctor or admin token is honoured only while the account exists, is not disabled and still carries the account's current session
  // epoch: disabling, a password or second-factor reset, and logging out all raise the epoch and so end every session of that user.
  const authenticate = async (req, _res, next) => {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const token = bearer ?? readCookie(req, COOKIE);
    if (token) {
      try {
        req.user = jwt.verify(token, jwtSecret);
      } catch {
        req.user = null;
      }
      if (req.user && req.user.role !== 'patient') {
        const { rows: [u] } = await pool.query('SELECT disabled_at, session_epoch FROM users WHERE id = $1', [req.user.sub]);
        if (!u || u.disabled_at || (req.user.ep ?? 0) !== u.session_epoch) req.user = null;
      }
    }
    next();
  };
  app.use(authenticate);

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, database: 'up' });
    } catch {
      res.status(503).json({ ok: false, database: 'down' });
    }
  });

  // Staff and doctor sign in with credentials, and with a second factor once they have enrolled one (FR-P4). The portal is derived from the
  // role, never from the request. Failed attempts are limited per user and address, and every sign-in outcome is audited (FR-D10).
  app.post('/api/auth/login', async (req, res) => {
    const { username: typed, password, code } = req.body ?? {};
    if (typeof typed !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username_and_password_required' });
    }
    // Usernames are always stored in lower case (adminRoutes USERNAME), so a capital added by a phone keyboard or a stray space still signs in.
    const username = typed.trim().toLowerCase();
    const key = `${req.ip}|${username}`;
    if (loginLimiter.blocked(key)) return res.status(429).json({ error: 'too_many_attempts' });
    const { rows } = await pool.query('SELECT id, role, full_name, password_hash, mfa_secret, mfa_enabled, session_epoch, disabled_at FROM users WHERE username = $1', [username]);
    const user = rows[0];
    const ok = user && !user.disabled_at && bcrypt.compareSync(password, user.password_hash);
    if (!ok || !ROLE_PORTAL[user.role]) {
      loginLimiter.fail(key);
      await audit(pool, { actorType: 'anonymous', action: 'login_failed', detail: { reason: 'invalid_credentials' } });
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    if (user.mfa_enabled) {
      if (!code) return res.status(401).json({ error: 'mfa_required', mfaRequired: true });
      if (!verifyCode(crypto.decrypt(user.mfa_secret), code)) {
        loginLimiter.fail(key);
        await audit(pool, { actorType: user.role, actorId: user.id, userId: user.id, action: 'login_failed', detail: { reason: 'bad_second_factor' } });
        return res.status(401).json({ error: 'invalid_credentials' });
      }
    }
    loginLimiter.reset(key);
    issue(res, { sub: user.id, role: user.role, name: user.full_name, mfa: Boolean(user.mfa_enabled), ep: user.session_epoch });
    await audit(pool, { actorType: user.role, actorId: user.id, userId: user.id, action: 'login_success', detail: { mfa: Boolean(user.mfa_enabled) } });
    res.json({ role: user.role, portal: ROLE_PORTAL[user.role], name: user.full_name, mfaEnabled: Boolean(user.mfa_enabled), mfaEnrolmentRequired: requireMfa && !user.mfa_enabled });
  });

  // Enrol an authenticator app: a secret is stored (encrypted) and switched on only when the user proves they can generate a code.
  const staffOrDoctor = (req, res, next) => (req.user && ['staff', 'doctor', 'admin'].includes(req.user.role) ? next() : res.status(req.user ? 403 : 401).json({ error: req.user ? 'wrong_portal' : 'not_signed_in' }));
  app.post('/api/auth/mfa/enrol', staffOrDoctor, async (req, res) => {
    const secret = newSecret();
    const { rows: [u] } = await pool.query('SELECT username, mfa_enabled FROM users WHERE id = $1', [req.user.sub]);
    if (u.mfa_enabled) return res.status(409).json({ error: 'already_enrolled' });
    await pool.query('UPDATE users SET mfa_secret = $2 WHERE id = $1', [req.user.sub, crypto.encrypt(secret)]);
    res.json({ secret, uri: otpauthUri(secret, u.username) });
  });
  app.post('/api/auth/mfa/confirm', staffOrDoctor, async (req, res) => {
    const { rows: [u] } = await pool.query('SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1', [req.user.sub]);
    if (!u.mfa_secret || u.mfa_enabled) return res.status(409).json({ error: 'not_enrolling' });
    if (!verifyCode(crypto.decrypt(u.mfa_secret), req.body?.code)) return res.status(400).json({ error: 'invalid_code' });
    const { rows: [e] } = await pool.query('UPDATE users SET mfa_enabled = true WHERE id = $1 RETURNING session_epoch', [req.user.sub]);
    issue(res, { sub: req.user.sub, role: req.user.role, name: req.user.name, mfa: true, ep: e.session_epoch });
    await audit(pool, { actorType: req.user.role, actorId: req.user.sub, userId: req.user.sub, action: 'mfa_enrolled' });
    res.json({ mfaEnabled: true });
  });

  // A signed-in staff, doctor or admin changes their own password; every session, this one included, is then ended and a new one issued.
  app.post('/api/auth/password', staffOrDoctor, async (req, res) => {
    const { current, next: fresh } = req.body ?? {};
    if (typeof current !== 'string' || typeof fresh !== 'string' || fresh.length < 10 || fresh.length > 100) return res.status(400).json({ error: 'invalid_input', fields: ['next'] });
    const { rows: [u] } = await pool.query('SELECT password_hash, mfa_enabled FROM users WHERE id = $1', [req.user.sub]);
    if (!bcrypt.compareSync(current, u.password_hash)) return res.status(401).json({ error: 'invalid_credentials' });
    const { rows: [e] } = await pool.query('UPDATE users SET password_hash = $2, session_epoch = session_epoch + 1 WHERE id = $1 RETURNING session_epoch', [req.user.sub, bcrypt.hashSync(fresh, 10)]);
    issue(res, { sub: req.user.sub, role: req.user.role, name: req.user.name, mfa: Boolean(u.mfa_enabled), ep: e.session_epoch });
    await audit(pool, { actorType: req.user.role, actorId: req.user.sub, userId: req.user.sub, action: 'password_changed' });
    res.json({ changed: true });
  });

  // When multi-factor is required, a staff or doctor session without it can do nothing but enrol.
  const mfaGate = (req, res, next) => (requireMfa && req.user && ['staff', 'doctor', 'admin'].includes(req.user.role) && !req.user.mfa ? res.status(403).json({ error: 'mfa_required' }) : next());

  // Patient identity (OTP, registration, lookup) and consent live in their own routers; they issue the patient session.
  app.use('/api/patient', createPatientRouter({ pool, jwtSecret, crypto, otp, abdm, issueSession: issue, exposeDevCode, redFlags: evaluator, narration, help, docs, analysis, summary, purger, ai, interviewer, speech }));
  app.use('/api/staff', mfaGate, createStaffRouter({ pool, crypto, abdm, hub, service, help, integration: integ }));
  app.use('/api/doctor', mfaGate, createDoctorRouter({ pool, hub, service, help, analysis, summary, store: docs.store, integration: integ }));

  // Admin console (Phase 10): accounts, departments, the audit log, reports and system health.
  const notify = notifier ?? createWebhookNotifier({ url: process.env.ALERT_WEBHOOK_URL });
  const monitor = createMonitor({ pool, reportPool, docs, notifier: notify, intervalMs: monitorIntervalMs });
  app.locals.monitor = monitor;
  app.use('/api/admin', mfaGate, createAdminRouter({ pool, reportPool, monitor }));
  app.use('/api/dashboard', mfaGate, createDashboardRouter({ pool, reportPool, monitor }));

  // Health for the hospital's monitoring: a token (OPS_TOKEN) or an admin session. 503 when any component is down.
  const opsAuth = (req, res, next) => ((opsToken && req.headers['x-ops-token'] === opsToken) || req.user?.role === 'admin' ? next() : res.status(req.user ? 403 : 401).json({ error: req.user ? 'wrong_portal' : 'not_signed_in' }));
  app.get('/api/ops/health', opsAuth, async (_req, res) => { await monitor.check(); const snap = monitor.snapshot(); res.status(snap.status === 'down' ? 503 : 200).json(snap); });
  app.get('/api/ops/metrics', opsAuth, async (_req, res) => { await monitor.check(); res.type('text/plain').send(monitor.prometheus()); });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.user) await audit(pool, { actorType: req.user.role, actorId: req.user.sub, userId: ['staff', 'doctor', 'admin'].includes(req.user.role) ? req.user.sub : null, action: 'logout' });
    // signing out ends every session of a staff, doctor or admin account, so a copied token stops working too
    if (req.user && req.user.role !== 'patient') await pool.query('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1', [req.user.sub]);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_signed_in' });
    res.json({ role: req.user.role, portal: ROLE_PORTAL[req.user.role] ?? null, name: req.user.name });
  });

  // Gateway: a signed-in user may use /api/portal/<x>/* only when x is the portal of their role.
  app.use('/api/portal/:portal', (req, res, next) => {
    const { portal } = req.params;
    if (!PORTALS.includes(portal)) return res.status(404).json({ error: 'unknown_portal' });
    if (!req.user) return res.status(401).json({ error: 'not_signed_in' });
    if (ROLE_PORTAL[req.user.role] !== portal) return res.status(403).json({ error: 'wrong_portal' });
    next();
  });

  app.get('/api/portal/:portal/ping', (req, res) => {
    res.json({ portal: req.params.portal, role: req.user.role, name: req.user.name });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' }); // upload over the size limit
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_input' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
