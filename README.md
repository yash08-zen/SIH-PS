# PatientCase_AI

AI-powered patient case-taking software for Indian hospital OPDs (SIH 26047). Three role-separated portals (Patient, Staff, Doctor), English / Hindi / Marathi, PostgreSQL.

The product requirements and build plan are in [docs/PatientCase_AI_PRD.md](docs/PatientCase_AI_PRD.md) (Section 22 is the phase plan). Progress is tracked in [docs/PatientCase_AI_Phase_Tracker.xlsx](docs/PatientCase_AI_Phase_Tracker.xlsx).

**Rule for the whole project:** development and staging use synthetic data only. Real patient data is not used before the Phase 9 pilot.

## Layout

| Path | What it is |
|---|---|
| `server/` | Node.js (Express) API: auth, role gateway, migrations, seed, tests |
| `server/migrations/` | Versioned SQL migrations (`NNN_name.sql`), applied in order |
| `web/` | React + Vite front end: landing page and the three portal shells, design system, icon set, i18n |
| `web/src/i18n/` | `en.json`, `hi.json`, `mr.json`: every user-facing string (no hard-coded text) |
| `docs/` | PRD, tracker, and operational notes |
| `.github/workflows/ci.yml` | Lint, migration check, tests and build on every merge |

## Prerequisites

- Node.js 22 or newer
- PostgreSQL 14 or newer running locally (the database user needs permission to create databases for the tests)

## Local setup (one sitting)

1. Create the app database, for example `patientcase_dev` (pgAdmin, or `createdb patientcase_dev`).
2. Copy `.env.example` to `server/.env` and fill in `DATABASE_URL` and `TEST_ADMIN_DATABASE_URL` with your PostgreSQL password. `server/.env` is git-ignored.
3. Run:

```bash
npm run setup     # installs packages, applies migrations, seeds departments and test accounts
npm run dev       # API on http://localhost:4000, web on http://localhost:5173
```

Open http://localhost:5173. Test accounts (synthetic, from `server/.env` or the defaults in `.env.example`):

| Portal | Username | Password |
|---|---|---|
| Staff | `staff.test` | `staff-demo-pass` |
| Doctor | `doctor.test` | `doctor-demo-pass` |
| Patient | none | open `/patient` and register: the mock OTP code is shown on screen in development (see below) |

## Commands

| Command | Does |
|---|---|
| `npm run migrate` | Applies pending migrations to `DATABASE_URL` |
| `npm run seed` | Seeds departments and the test staff and doctor accounts (refuses in production) |
| `npm test` | Server tests (create a throw-away database each, so they need `TEST_ADMIN_DATABASE_URL`) and web design tests |
| `npm run lint` | ESLint |
| `npm run build` | Production build of the web app |

## How access works (Phase 0)

Staff and doctor sign in at `/api/auth/login`; the session cookie carries the role. The gateway (`/api/portal/<portal>/*`) lets a role reach only its own portal: patient to `patient`, staff to `staff`, doctor to `doctor`; anything else is `403`. The front end mirrors this and shows "no access" for the wrong portal. Multi-factor sign-in has a hook in the login route and is completed in Phase 8.

## Patient registration, identity and consent (Phase 1)

- **Registration** (`/patient`): language, then "I am new" or "I have visited before". New patients verify their mobile by OTP, enter the minimum details (by voice or touch), and receive a PatientCase ID (`PC-XXXX-XXXX`). A possible duplicate (same mobile and a similar name) must be confirmed before a new record is created; look-alikes on a different mobile go to staff review.
- **Returning patients** are found by ABHA number, Aadhaar number, mobile OTP, or PatientCase ID plus date of birth.
- **Consent** has four separate purposes (history, documents, HIS sharing, ABHA linking), each given or refused, revocable, and logged. Declining the history purpose ends the session and stores nothing clinical. The API rejects clinical writes for any purpose without live consent.
- **Staff** can register a patient on their behalf at `/staff/register`, with the same duplicate check.
- **Providers:** the OTP/SMS sender and the ABDM client are interfaces (`server/src/providers.js`). Development uses a **mock OTP provider** (the code is returned to the screen) and an **ABDM stub** that only checks identifier formats. Production refuses to start with either; Phase 8 replaces the stub.
- **Sensitive data:** mobile numbers and identifiers are stored only as HMAC hashes (lookup) and AES-256-GCM ciphertext. Aadhaar is held by reference only (hash plus last four digits). `ENCRYPTION_KEY` and `HASH_KEY` are optional in development and required in production.
- **Speech:** `web/src/speech/speech.js` wraps the browser speech APIs (English, Hindi and Marathi locales). Phase 2 hardens and benchmarks it.
- The consent wording is a draft awaiting legal review.

## Interview (Phase 2)

After consent, the patient picks a **listening mode** (Listen and Speak, Listen and Tap, Read and Tap), then answers one question per screen. The mode applies to every question, follow-ups included; changing it from the header applies from the next question.

- **Question bank and ontology:** `server/config/questions.v1.js` (47 questions, three languages, branching by `when`). The dialogue manager (`server/src/interview/dialogue.js`) can only ask what the bank lists. Pain complaints use SOCRATES; fever, cough, back pain, headache and abdominal pain each have their own follow-ups. Run `node server/scripts/export-ontology.js` to regenerate [docs/clinical-review-ontology.md](docs/clinical-review-ontology.md) for clinician and language review.
- **API** (`/api/patient/interview/*`, needs a session and history consent): `state`, `listening-mode`, `next`, `question/:key`, `answer`, `review`, `history`, `recognition-failure`; plus `POST /api/patient/help`. Answers are language-neutral values, so changing language relabels them. Skip stores "not answered", never "no". Changing an earlier answer removes answers that no longer apply.
- **Critical answers** (allergies, medicines, emergency symptoms) need on-screen and audio confirmation before they are saved. If the terminal cannot play audio, staff are asked to verify.
- **Speech failures:** two failed recognitions offer tapping; a third alerts staff (a help request).
- **Free narration:** text answers go through a deterministic mapper (`narration.js`) that reports only complaint keywords and durations that are literally in the words; input and output are stored together. A language model can be put behind the same interface; none is connected yet.
- **Red flags:** `redflags.js` is a stub called after every saved answer. Phase 3 supplies the rules and the alert screen.
- **No audio is stored.** Recognition runs in the browser and only the text is sent.
- **Benchmark:** `node web/scripts/benchmark-wer.js results.tsv`; see [docs/asr-benchmark-report.md](docs/asr-benchmark-report.md). No recordings have been measured yet.

## Red flags and triage (Phase 3)

- **Rules** (`server/config/redflag-rules.v1.js`) are data: id, version, level (`emergency` or `attention`), a reason in three languages, and a condition over the interview answers. After every saved answer the rules are checked (`server/src/alerts/rules.js`). A skipped safety question (emergency symptoms, allergy, current medicines) raises an `attention` alert; silence is never read as "no". **The rule set is a developer draft and has not been reviewed by a clinician.** Run `node server/scripts/export-redflags.js` to regenerate [docs/redflag-rules-review.md](docs/redflag-rules-review.md), the review and sign-off sheet.
- **Alerts** are stored with rule id, rule version, level and the triggering answers (in all three languages). One rule raises at most one alert per encounter (unique index). The encounter moves to `alert`, and returns to `in_intake` once staff acknowledge every open alert.
- **Real time** uses server-sent events: `GET /api/staff/alerts/stream` and `GET /api/doctor/alerts/stream`. Every (re)connect starts with a snapshot of everything open, so a reloaded or reconnected screen catches up. Help requests are pushed to staff on the same stream. The hub is in-process; a multi-server deployment needs PostgreSQL LISTEN/NOTIFY or Redis behind `server/src/alerts/hub.js` (Phase 10).
- **Staff:** `/staff/alerts` (priority alerts, acknowledge, help requests) and `/staff/queue` (alerts first, then token order). API: `GET /api/staff/alerts`, `POST /api/staff/alerts/:id/ack`, `GET /api/staff/queue`.
- **Doctor:** a banner on every doctor screen with an Open action and the acknowledged status. Routing is by department (an encounter with no department is shown to every doctor); Open leads to a placeholder until the Phase 6 workspace.
- **Patient:** sees only "Please wait. Staff will be with you shortly." The API returns a bare `staffNotified` flag, never the level, rule or any clinical wording.
- **Tokens** restart each day and are taken when the patient consents (`queue_entries`).
- **Tests:** `server/test/scenarios.js` (27 emergency scenarios, must-alert and must-not-alert) runs in CI; `server/test/alerts.test.js` measures alert delivery latency and prints it as `ALERT-LATENCY`.

## Documents (Phase 4)

After the interview the patient adds papers (`/patient`, "Add your medical papers"): file picker or camera, several in one session, each with its own status (waiting, reading, done, needs your attention), and retake, remove and reorder before continuing.

- **Upload** (`/api/patient/documents`, needs a session and the "documents" consent): the file is the raw request body. Type is decided from the first bytes (JPEG, PNG, WebP, PDF), size and page limits come from `DOC_MAX_FILES`, `DOC_MAX_MB`, `DOC_MAX_PAGES` (defaults 15, 10 MB, 10 pages; Open Question Q10). Wrong type, too large, too many pages and too many files are rejected with a clear code. `GET` lists status, `DELETE /:id` removes, `PUT /:id` retakes, `PUT /order` reorders.
- **Encrypted file store** (`server/src/documents/store.js`): originals are AES-256-GCM encrypted under `FILE_STORE_DIR` (default `server/.data`, git-ignored) and referenced by `documents.storage_ref`; no table holds file bytes. Temporary working files have a time-to-live (`purgeTemp`); the scheduled purge job arrives in Phase 8.
- **Pipeline** (`server/src/documents/pipeline.js`): a job queue with parallel workers and retry with back-off. Per file: photo-quality check (blurry, too dark, too small, cut-off edges, blank), read, classify, extract, save. A file that fails ends in `needs_attention` with a reason while the others finish; a restart re-queues waiting files.
- **Reading:** photos and scans go through Tesseract (`tesseract.js`, English, Hindi and Marathi models together) behind a replaceable engine interface (`ocr.js`); PDFs use their own text layer. **Scanned (picture-only) PDFs are not read yet**: the patient is asked for a photo instead. Tesseract downloads its language data on first use; a deployment must bundle it.
- **Extraction** (`extract.js`, `classify.js`): document type, date, diagnoses, procedures, medications (form, dose, frequency) and lab results (value, unit, range, low/high/normal/range_unavailable) in `extracted_entities`, `medications` and `lab_results`. Every field has a confidence, a `needs_review` flag and its page and position on the scan (`region`). A field is held for review when the read was poor, a part is missing, a unit was corrected, or a range looks like a lost decimal point.
- **Patient view:** status only. Extracted values, document types, confidence and flags never reach the Patient portal.
- **Tests:** `documents-unit.test.js` (rules and queue), `documents-api.test.js` (upload, limits, isolation, retry, storage), `documents-ocr.test.js` (real OCR over the synthetic set; skip with `SKIP_OCR=1`).
- **Synthetic set and benchmark:** `server/test/fixtures/synthetic-docs.js` and the generated images in `server/test/fixtures/docs/` (regenerate with `node server/scripts/make-synthetic-docs.mjs` on a machine with Nirmala UI and Ink Free fonts); run `node server/scripts/benchmark-ocr.mjs`. First results and their limits: [docs/ocr-accuracy-report.md](docs/ocr-accuracy-report.md). Real handwriting is untested.
- **Dates** are returned by PostgreSQL as plain `YYYY-MM-DD` strings (`server/src/pgTypes.js`); the default conversion shifted dates by a day on servers east of Greenwich.

## Cross-document analysis (Phase 5)

Once files are read, the doctor sees one analysis per patient (`/doctor/analysis`, a first version of the Phase 6 workspace). It is decision support, never a diagnosis, and none of it reaches the Patient portal.

- **Five results** in `analysis_results` (JSONB, one row per encounter and kind): `timeline`, `med_reconciliation`, `lab_table`, `interactions`, `consistency`. The engine (`server/src/analysis/engine.js`) is a pure function of the files' extracted data, the patient's medicine and allergy answers and the visit date, so the same input always gives the same output.
- **Normalisation** (`normalize.js`): brand and generic drug names (`server/config/drugs.v1.js`), lab test names and safe unit conversions (`labs.v1.js`), dates, names, sex. **A name that is not in a dictionary is flagged "to check" and never matched by similarity; an unknown unit is never converted.**
- **Interactions** (`interactions.v1.js`): rules between drugs or drug classes, plus conflicts with the allergies the patient reported (by drug name or class). **The drug dictionary, interaction list and lab dictionary are unreviewed drafts and the interaction list is not a recognised source.** They must be reviewed by a clinician and pharmacist, and the source chosen, before any clinical use: [docs/analysis-data-review.md](docs/analysis-data-review.md) (regenerate with `node server/scripts/export-analysis-data.js`).
- **Re-runs:** when a file is added, removed, replaced or reordered, when a file finishes being read, when a medicine or allergy answer changes, or when the doctor asks (`POST /api/doctor/encounters/:id/analysis/rerun`). Changes arriving together are merged into one run (a 100 ms pause). Each run is logged in `analysis_runs` with the time from the last upload to results stored.
- **Doctor API:** `GET /api/doctor/encounters` (patients waiting, in the doctor's department) and `GET /api/doctor/encounters/:id/analysis` (the five results, document counts, and the FHIR links). Access is audited (`analysis_viewed`, `analysis_rerun`).
- **Links (FR-B15):** `document_links` ties each file to the history sections it relates to and holds a FHIR R4 `DocumentReference` made of references only (patient, encounter, LOINC type); identifier values stay encrypted in `patient_identifiers` until Phase 8 pushes the record.
- **Wrong-patient checks** read name, age and sex from document headers; thresholds are in `server/src/analysis/config.js` and are untested on real documents.
- **Tests:** `analysis-engine.test.js` (13 synthetic multi-file cases in `test/fixtures/analysis-cases.js`, determinism, no-interpretation wording, no guessing) and `analysis-service.test.js` (storage, re-runs, links, timing, patient-portal isolation). Timing with real OCR: `node --env-file=.env scripts/benchmark-analysis.mjs`. Results and limits: [docs/analysis-report.md](docs/analysis-report.md).

## Summary and doctor workspace (Phase 6)

When the patient finishes their papers the app submits the intake (`POST /api/patient/submit`): the intake is locked, the files are analysed, a **draft summary** is saved and the case becomes **Ready**. The patient hears and sees only a confirmation, in their own language (browser speech; needs a device voice for Hindi or Marathi).

- **Summary** (`server/src/summary/generate.js`): a pure function of the interview answers and the Phase 5 analysis, in the standard order (chief complaint, history of present illness, past medical and surgical, drug and allergy, family, personal, review of systems, prior investigations). Every item has a source (the patient, by voice or touch, or a named file), text in English, Hindi and Marathi, and a status. **A skipped or unasked question is "not answered" with no text at all, never "no"**, and the completeness panel lists them. Facts from files are written as "named in the file". `findDiagnosticWording` scans summaries for wording that states a diagnosis and runs in the tests; quoted patient or file text and a doctor's own amendments are exempt.
- **Decision** (`summary/service.js`): Open case (Ready to In consultation), then Accept, Amend (per-item edits) or Reject. Every version is kept in `summary_versions` (the AI draft is version 1 and is never changed) with who and when, and what changed. Reject leads to manual documentation, then Completed. The lifecycle is in `summary/lifecycle.js` and an invalid transition returns 409.
- **Doctor workspace** (`/doctor/workspace`): queue on the left (alerts first, then token order; status chips Not started, In intake, Alert, Ready, In consultation, Completed; counters; search by name, token, patient id or complaint; filter by status and alerts), the selected patient on the right with tabs Summary, Documents, Labs, Medications, Timeline, Alerts and checks. Warning chips (out-of-range labs, interactions, allergies, record checks) jump to the right tab. A value's original scan opens beside it with the value's position highlighted and a confidence badge (`GET /api/doctor/encounters/:id/documents/:docId/file`, audited). The alert banner opens a case in one click.
- **Doctor conveniences:** language switch (English, Hindi, Marathi), large text, keyboard shortcuts (J next, K previous, 1 to 6 tabs, O open case, A accept), print and download of the confirmed summary. Pushing to HIS and ABHA is Phase 8.
- **API:** `GET /api/doctor/encounters?q=&status=&alert=1`, `GET .../:id/summary`, `POST .../:id/consult`, `POST .../:id/summary/{accept,amend,reject,manual}`. Doctor role only; the Patient portal exposes none of it.
- **Tests:** `server/test/summary.test.js` (draft order and sources, not-answered, no-diagnosis scan, lifecycle, decisions and versions, queue, scan access). Details and limits: [docs/summary-report.md](docs/summary-report.md).

## AYUSH mode (Phase 7)

An extended Ayurvedic history (FR-A14, FR-A15) is added after the standard interview when AYUSH mode is on for an encounter.

- **Switch:** on when the encounter's department is an AYUSH department; staff can switch it on or off for one patient (Staff portal, Queue, "AYUSH mode" column, or `PUT /api/staff/encounters/:id/mode` with `{ departmentId?, ayush: true | false | null }`, where `null` returns to the department's setting). `encounters.ayush_mode` and `ayush_source` record the state and who decided. **Whether the department should decide is the developers' assumption, still to confirm with the clinical team.** Nothing assigns a department to a patient yet, so in practice staff switch it per patient.
- **Content** (`server/config/ayush.v1.js`): 28 questions with the Sanskrit term beside each, in English, Hindi and Marathi, covering Prakriti, Vikriti, Satmya, Sattva, Ahara Shakti, Vyayama Shakti, Ahara-Vihara, Agni, Koshtha, Nidana and the patient's own account of Samprapti. **Sara, Samhanana, Pramana and the Samprapti assessment are not asked: the summary lists them as "to be observed by the physician" and never fills them in. Vaya is worked out from the registered age.** Options describe tendencies in plain words and never name a dosha. **This content is a developer draft that no AYUSH clinician has reviewed**; the split between asked and observed is the developers' proposal. For review and sign-off: [docs/ayush-content-review.md](docs/ayush-content-review.md) (regenerate with `node server/scripts/export-ayush.js`).
- **Dialogue:** `activeQuestions(answers, { ayush })` appends the AYUSH bank to the standard one. Listening modes, read-back, skip ("not answered", never "no") and red-flag checks work unchanged. AYUSH answers are never treated as stale because the mode is off, so switching modes loses nothing and the interview resumes at the first unanswered question.
- **Pause and resume:** after 30 questions the interview offers "Save and continue later". A patient who signs in again the same day with answers saved and nothing submitted continues the same encounter and token (consent no longer opens a second one in that case).
- **Summary and workspace:** four AYUSH sections sit between the standard sections and the investigations; the doctor queue and header show an AYUSH tag. The no-diagnosis scan covers them.
- **Tests:** `server/test/ayush.test.js` (coverage of the ten parameters, trilingual content, no dosha wording, mode switch, full walk, languages and listening modes, red flags, switching and resuming, summary).

## Integration and compliance (Phase 8)

**Everything here ran against local stand-ins: there is no ABDM sandbox and no real hospital system.**

- **FHIR and delivery** (`server/src/integration/`): when the doctor confirms (accept, amend, or manual documentation after a reject), the record is mapped to a FHIR R4 document Bundle (`fhir.js`), checked (`validate.js`, our own structural checks, **not** the ABDM profiles) and stored in `fhir_bundles`. A `deliveries` row per target (hospital system, ABHA) is sent with retry and back-off, an acknowledgement is stored, and a failure shows first on the staff "Record delivery" screen with a retry button. The hospital connector is configured with `HIS_MODE=http`, `HIS_URL`, `HIS_TOKEN` (`mock` is refused in production). The ABHA push is a stub. A purpose the patient did not consent to is never sent and the reason is audited. Details and limits: [docs/integration-report.md](docs/integration-report.md).
- **Temporary data and revocation** (`server/src/compliance/purge.js`): raw voice transcripts and expired working files are removed on submission and every 5 minutes. Revoking consent before the doctor confirms deletes that data (answers, or files and their analysis) and logs it; a confirmed record is kept; waiting deliveries are cancelled. The terms are an assumption for legal review.
- **Audit log** (`migrations/009_compliance.sql`): partitioned by month (`ensure_audit_partitions()` runs at start-up and daily) and append-only (update, delete and truncate are refused by trigger). Events: consent, access, edit, alert, sign-in, push.
- **Sign-in:** optional TOTP second factor (`/api/auth/mfa/enrol`, `/confirm`; enforced for staff and doctors with `REQUIRE_MFA=true`, the default in production), failed sign-ins limited per user and address, security headers, NUL characters refused.
- **Row-level security:** policies on 12 tables for the `pc_doctor` database role show a department only its own patients. **The running application connects as the table owner, which bypasses them**; the API enforces the same rule in code. See [docs/security-report.md](docs/security-report.md).
- **Backups:** `node --env-file=.env scripts/backup-restore-test.mjs` dumps and restores into a new database and compares every table. Point-in-time recovery is not configured: [docs/backup-and-retention.md](docs/backup-and-retention.md).
- **Compliance:** [docs/data-flow.md](docs/data-flow.md) (where voice, documents and language-model processing happen; **browser speech recognition may send audio to the browser vendor**) and [docs/compliance-checklist.md](docs/compliance-checklist.md) (DPDP topics for legal review; not legal advice).
- **Tests:** `integration.test.js`, `compliance.test.js`, `security.test.js`.

## Testing, evaluation and pilot readiness (Phase 9)

**No pilot, usability test, speech benchmark, clinician sign-off or independent review has happened.** What exists is the software side of them.

- **End to end:** `server/test/e2e.test.js` runs the whole journey through the API for every language and every listening mode (9 runs) and checks the alert, duplicate and metrics paths. The browser screens are not driven by an automated test; see [docs/test-plan.md](docs/test-plan.md).
- **Load:** `node --env-file=.env scripts/load-test.mjs [terminals] [files] [poolMax] [emergencyShare]` runs many whole journeys at once with a staff and a doctor screen listening for alerts. Up to 200 simultaneous patients finished with no errors; red-flag alerts reached both screens in about 1 s at 200. Real document reading, not the analysis, is the scaling limit. [docs/load-test-report.md](docs/load-test-report.md).
- **Success metrics:** `node --env-file=.env scripts/metrics.mjs [since] [until]` prints the PRD Section 4.3 metrics from the database. [docs/success-metrics.md](docs/success-metrics.md) shows which have a value (few) and who sets each target.
- **Acceptance:** [docs/acceptance-checklist.md](docs/acceptance-checklist.md) (Section 19 row by row, with sign-off table) and [docs/defect-register.md](docs/defect-register.md) (8 open Severity 2 items block acceptance).
- **Pilot kit (drafts, unapproved):** [docs/pilot-protocol.md](docs/pilot-protocol.md), [docs/usability-test-plan.md](docs/usability-test-plan.md), [docs/asr-data-collection.md](docs/asr-data-collection.md).
- CI also runs `npm audit --omit=dev`. CI has never run on a remote.

## Admin console, monitoring and rollout (Phase 10)

- **Admin console** (`/admin`, role `admin`, seeded as `admin.test`): create, disable and enable staff, doctor and admin accounts (a temporary password is shown once and stored only as a hash), reset a password or second factor, manage departments and their AYUSH setting, read the audit log with filters, see system health and a short reports page (`server/src/adminRoutes.js`). The console has no route that returns a patient's record. Disabling an account, resetting its password or second factor, changing a password and logging out all raise the account's `session_epoch`, which ends every session of that account at once (this also closes defect D-05).
- **Monitoring** (`server/src/ops/monitor.js`, [docs/monitoring.md](docs/monitoring.md)): six checks (database, reporting replica, document reading, reading queue, hospital system and ABHA, speech as an indirect signal) every 30 s, history in `ops_events`, one alert per change to `ALERT_WEBHOOK_URL` (or the log). `GET /api/ops/health` and `/api/ops/metrics` (Prometheus text) for external monitors with `x-ops-token` (`OPS_TOKEN`) or an admin session. **Routing the webhook to a person is the hospital's job and is not set up.**
- **Scale** (DBR-11): bounded connection pool (`PG_POOL_MAX`), statement time limit (`PG_STATEMENT_TIMEOUT_MS`), indexes on today's queue, a doctor queue capped at 300 rows, and optional read replica for reports (`REPLICA_DATABASE_URL`). `scripts/queue-benchmark.mjs` and `scripts/replica-drill.mjs` record the measurements in docs/monitoring.md. Only one API process has been tested.
- **Backups:** `scripts/backup-restore-test.mjs` now records recovery time and the data-loss window: [docs/restore-drill-report.md](docs/restore-drill-report.md). Point-in-time recovery is not configured.
- **Shared terminals:** after a patient submits, the session ends (Finish button, or after 90 s) and the screen returns to the start.
- **Training and rollout drafts (nobody trained, nothing reviewed with hospital IT):** [docs/training-guide.md](docs/training-guide.md), [docs/terminal-setup-guide.md](docs/terminal-setup-guide.md), [docs/rollout-runbook.md](docs/rollout-runbook.md) (preconditions, department-by-department plan, support path, rollback, go-live checklist).
- **Tests:** `admin.test.js` (accounts, sessions, audit view, reports, failure drills for each component, webhook).

## Overview of the patient's history (AI)

When a patient submits, an overview is written in the background, once for the doctor and once for the patient, in English, Hindi and Marathi.

- The doctor sees it at the top of the Summary tab. A patient who is still answering shows a "live" view of what has been said so far (not submitted, cannot be accepted).
- The patient sees a short "What you told us" recap on the final screen (`GET /api/patient/summary`). It holds only the patient's own answers: no files, checks, alerts or findings. This departs from the PRD's rule that the patient never sees the analysis, and needs the clinical lead's approval.
- `AI_PROVIDER=rules` (default) writes the text with fixed rules and sends nothing out. `AI_PROVIDER=gemini` (uses `GEMINI_API_KEY` and `GEMINI_MODEL`, shared with the AI interviewer) or `AI_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` (optional `AI_MODEL`, `ANTHROPIC_BASE_URL`) asks a model instead. Only de-identified facts are sent (age group, sex, answers, file findings), never name, mobile, ID or dates of birth.
- Every model text is checked: wording that states a diagnosis, or a patient recap that mentions risk or alerts, is replaced by the rule-based text and the reason is stored (`ai_narratives.fallback_reason`). Each overview says who wrote it.
- The model path is tested against a stand-in service only; it has not been run against the real API. Sending data to an external model needs hospital approval and a consent decision first.

## AI-led interview (Gemini)

With `AI_INTERVIEW_PROVIDER=gemini` and `GEMINI_API_KEY` in `server/.env`, the interview is led by the model instead of the fixed question tree.

- The patient gives the reason for the visit in their own words, then answers the emergency-signs screen. After that the model writes each next question from everything the patient has said, up to 6 questions, and stops when it judges the doctor has enough (it may not stop before 3).
- Medicines and allergies are always asked last by the system, never by the model. Questions that name a disease, give advice, repeat, have bad options or lack Hindi or Marathi are refused. A failure before the first model question falls back to the fixed tree; a later failure ends the AI part and the closing questions follow.
- The doctor sees AI-written questions marked "Asked by AI" with the reason.
- Only de-identified facts (age group, sex, the reason and the answers) are sent to Google. This needs hospital and compliance approval and a consent decision first.
- Limits to know: the fixed red-flag rules read the tree's questions, so for AI questions the model's own attention flag is what alerts staff. Have a clinician read sample interviews first: `node --env-file=.env server/scripts/export-ai-interviews.js` writes `docs/ai-interview-samples.md`. The real Gemini service has not been run here, only a stand-in.

## Speech: Bhashini / AI4Bharat (voice conversation)

The SIH 26047 statement names Bhashini / AI4Bharat for Indian-language speech recognition. With `SPEECH_PROVIDER=bhashini`, `BHASHINI_USER_ID` and `BHASHINI_API_KEY` in `server/.env` (credentials from bhashini.gov.in), the patient's spoken answer is recorded in the browser (stops when they go quiet, at most 12 seconds), sent to `POST /api/patient/speech/transcribe` as 16 kHz WAV and turned into words; prompts are spoken from `POST /api/patient/speech/synthesize`. English, Hindi and Marathi.

- Off by default. If it is off, unreachable or fails, the browser's own speech is used, so a patient always has voice.
- Audio and words are never stored or logged; the audit log keeps only the language, size and whether it worked. Both routes need a patient session and the history consent.
- With Bhashini the words arrive when the patient stops speaking, not live as with the browser.
- The request shapes follow Bhashini's pipeline API and are tested against a stand-in; they have not been run with real credentials.

## Emergency detection beyond the rules

The fixed red-flag rules only see the answers to specific questions, so there are two more nets for an emergency nobody wrote a rule for.

- **Urgent-help button:** every patient screen has a red "I need urgent help" button and the line "If you feel very unwell, tell a staff member now." One tap raises an emergency alert on the patient's case (`POST /api/patient/urgent`), or, before registration, an urgent help request. It needs no consent and nothing is blocked. The patient is told only that staff know.
- **Emergency word scan:** what the patient types or says in their own words (the reason for the visit, free-text answers, and the transcript of voice answers) is checked against a word list in English, Hindi and Marathi (`server/config/emergency-words.v1.js`). A match raises an alert that says "automatic word match, please check" and shows the exact words. Emergency terms always alert; milder ones are ignored when negated ("no bleeding").
- The word list is a **developer draft** and has not been reviewed by a clinician or a native speaker. `node server/scripts/export-redflags.js` writes it into `docs/redflag-rules-review.md` for review. The scan is a net, not a diagnosis, and a person still sees every patient.

## Interface (redesign)

Staff, doctor and admin share one app shell (`web/src/ui/Shell.jsx`): a dark-green sidebar (Navigation and More groups, help centre, the signed-in person), and a top bar with search, a light and dark switch, notifications and a settings menu (language, large text, high contrast, sign out). Each portal opens on a **Dashboard** (`web/src/portals/Dashboard.jsx`) fed by `GET /api/dashboard` (`server/src/dashboard.js`), with nothing hard-coded:

- four tiles with the last seven days as bars (hover or focus a bar for its exact value) and the change from yesterday;
- a ring chart of complaints (doctor and staff) or of recorded events (admin) over 7 or 30 days, with a legend;
- a grid of the last six days' patients by the hour they arrived (a block opens the case);
- smart insights: sentences worked out from the day's records by fixed rules (not a language model and not medical advice);
- a table of the latest cases (doctor and staff) or audit events (admin).

A doctor's figures cover their department; the admin dashboard has counts and audit events only, never a patient name. Search (Ctrl or Cmd with K) finds patients waiting today, or accounts for an admin; the bell lists open alerts, or system components needing attention for an admin. Charts are drawn with SVG, no chart library. Tests: `server/test/dashboard.test.js`.

## Database changes

Never edit an applied migration. Add the next numbered file in `server/migrations/`. `schema_migrations` records what has been applied. `language_code` is a database domain, so a language other than `en`, `hi`, `mr` is rejected by PostgreSQL itself.

## Translations

Add text only as keys in all three files in `web/src/i18n/`; a test fails if the files drift apart. Hindi and Marathi are marked `pending native-speaker and clinician review` in `meta.reviewStatus` until a reviewer signs off (see [docs/phase0-external-actions.md](docs/phase0-external-actions.md)).

## Runbook notes

- API health: `GET /api/health` returns `{ "ok": true, "database": "up" }`.
- Environments: development, staging and production are selected by `NODE_ENV` and environment variables; secrets live only in `.env` files or the host's secret store. In production the server refuses to start with a default `JWT_SECRET`, and the dev patient test session is not mounted.
