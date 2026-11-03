import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocuments } from '../src/documents/index.js';
import { createDocumentReader } from '../src/documents/ocr.js';
import { fakeEngine } from './doc-helpers.js';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { createApp } from '../src/app.js';
import { createCrypto } from '../src/crypto.js';
import { createMockOtpProvider, createStubAbdmProvider } from '../src/providers.js';
import { createIntegration } from '../src/integration/service.js';
import { createHisConnector } from '../src/integration/connectors.js';
import { seed } from '../src/seed.js';

export const adminUrl = process.env.TEST_ADMIN_DATABASE_URL;

export function withDatabase(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

// Creates a fresh, empty database for a test file and drops it afterwards.
export async function createTestDatabase({ migrated = true, poolMax = 10 } = {}) {
  if (!adminUrl) throw new Error('TEST_ADMIN_DATABASE_URL is not set (see .env.example)');
  const name = `pc_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = withDatabase(adminUrl, name);
  if (migrated) await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  return {
    url,
    pool,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const PASSWORDS = { staff: 'staff-test-pw', doctor: 'doctor-test-pw', admin: 'admin-test-pw' };

// A migrated, seeded database plus a running app on a random port.
export async function startTestApp({ redFlags, ocrEngine, limits, docWorkers = 3, his, requireMfa = false, loginLimiter, maxAttempts = 3, poolMax = 10, notifier, reportPool, monitorIntervalMs = 3_600_000, aiProvider, aiInterviewer = null, speechProvider = null } = {}) {
  const db = await createTestDatabase({ poolMax });
  await seed(db.url, { staffPassword: PASSWORDS.staff, doctorPassword: PASSWORDS.doctor, adminPassword: PASSWORDS.admin });
  const crypto = createCrypto({ encryptionKey: Buffer.alloc(32, 1), hashKey: Buffer.alloc(32, 2) });
  const otp = createMockOtpProvider();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pc-docs-'));
  const docs = createDocuments({
    pool: db.pool, crypto, dir, reader: createDocumentReader({ engine: ocrEngine ?? fakeEngine() }), workers: docWorkers, baseDelayMs: 10,
    limits: { maxFiles: 15, maxBytes: 10 * 1024 * 1024, maxPages: 10, ...limits },
  });
  const abdm = createStubAbdmProvider();
  const integration = createIntegration({ pool: db.pool, crypto, his: his ?? createHisConnector(), abdm, baseDelayMs: 20, maxAttempts, log: { error() {} } });
  const app = createApp({ pool: db.pool, jwtSecret: 'test-secret', crypto, otp, abdm, integration, requireMfa, aiInterviewer, speechProvider, ...(aiProvider ? { aiProvider } : {}), ...(loginLimiter ? { loginLimiter } : {}), ...(notifier ? { notifier } : {}), ...(reportPool ? { reportPool } : {}), monitorIntervalMs, exposeDevCode: true, documents: docs, analysisDelayMs: 5, ...(redFlags ? { redFlags } : {}) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, cookie } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, cookie: res.headers.getSetCookie()[0]?.split(';')[0] ?? cookie };
  };

  const verifyMobile = async (mobile) => {
    const sent = await call('POST', '/api/patient/otp/send', { body: { mobile } });
    const ok = await call('POST', '/api/patient/otp/verify', { body: { challengeId: sent.body.challengeId, code: sent.body.devCode } });
    return ok.body.verificationToken;
  };

  const form = (over = {}) => ({
    fullName: 'Rakesh Kumar', age: 58, sex: 'male', mobile: '9876543210', language: 'en', registrationConsent: true, ...over,
  });

  // Registers a patient through the public flow and returns the signed-in session cookie.
  const registerPatient = async (over = {}) => {
    const verificationToken = await verifyMobile(over.mobile ?? '9876543210');
    return call('POST', '/api/patient/register', { body: { ...form(over), verificationToken } });
  };

  const login = async (role) => {
    const r = await call('POST', '/api/auth/login', { body: { username: `${role}.test`, password: PASSWORDS[role] } });
    return r.cookie;
  };

  // Answers the interview along the patient's real path (the given answers, else a plain default) until the question `stopAt` is next.
  const walkTo = async (cookie, stopAt = null, given = {}) => {
    const CONFIRM = { visual: true, audio: true };
    for (let i = 0; i < 20; i++) {
      const { body } = await call('GET', '/api/patient/interview/next', { cookie });
      if (body.done || body.question.key === stopAt) return body;
      const q = body.question;
      const value = q.key in given ? given[q.key] : q.key === 'cc.reason' ? 'test visit' : q.key === 'cc.main' ? 'fever' : q.type === 'yes_no' ? 'no'
        : q.type === 'single' ? q.options[0].value : q.type === 'multi' ? [(q.options.find((o) => o.value === 'none') ?? q.options[0]).value] : q.type === 'number' ? 3 : 'a note';
      await call('POST', '/api/patient/interview/answer', { cookie, body: { questionKey: q.key, value, modality: 'tap', confirmation: CONFIRM } });
    }
    throw new Error('walkTo did not reach ' + stopAt);
  };

  // Raw file upload (the Patient portal sends the file as the request body).
  const send = async (method, path, buffer, { cookie, name = 'scan' } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...(cookie ? { cookie } : {}) }, body: buffer,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    db, base, call, send, otp, form, verifyMobile, registerPatient, login, walkTo, docs, dir, analysis: app.locals.analysis, integration, crypto, monitor: app.locals.monitor, app, ai: app.locals.ai,
    // waits for every file to be read and for the analysis that follows it
    async settle() { await docs.pipeline.idle(); await app.locals.analysis.idle(); await docs.pipeline.idle(); await app.locals.ai.idle(); },
    async close() { server.close(); await docs.pipeline.idle(); await app.locals.analysis.idle(); await app.locals.ai.idle(); await db.drop(); await rm(dir, { recursive: true, force: true }); },
  };
}
