# PatientCase_AI: Product Requirements Document (v2, as built)

**Project:** PatientCase_AI, AI-assisted patient case-taking for Indian hospital outpatient departments (Smart India Hackathon problem statement 26047)
**Document status:** describes the system as it exists in the repository `main` branch (commit `c8be846` and later). It replaces nothing: the original planning PRD stays in [PatientCase_AI_PRD.md](PatientCase_AI_PRD.md) and the phase tracker in [PatientCase_AI_Phase_Tracker.xlsx](PatientCase_AI_Phase_Tracker.xlsx). Where this document and the original differ, this one says what was built and the section "Differences from the original PRD" says why.
**Rule for the whole project:** development and staging use synthetic data only. No real patient data is used before an approved pilot.

---

## Contents
1. Summary
2. Problem and goals
3. Users, roles and portals
4. Patient journey
5. Functional requirements (what is built)
6. AI components: what each one does and does not do
7. Safety rules that hold everywhere
8. Languages, voice and accessibility
9. Data design
10. API surface
11. Architecture and configuration
12. Security, privacy and compliance
13. Non-functional requirements and test status
14. Differences from the original PRD
15. Known limitations and open items
16. Success metrics and pilot
17. Roadmap
18. Glossary

---

## 1. Summary

PatientCase_AI lets a patient give their own history on a hospital terminal or phone before they see a doctor, in English, Hindi or Marathi, by tapping or speaking. It asks follow-up questions that fit what the patient said, reads uploaded medical files (prescriptions, lab reports), cross-checks everything, and hands the doctor a source-referenced draft summary plus an overview. The doctor decides: accept, amend or reject. The system never diagnoses and never recommends treatment.

Four role-separated portals share one API and one PostgreSQL database:

| Portal | Who | Purpose |
|---|---|---|
| Patient | the patient (self-registered or registered by staff) | consent, interview, file upload, submit, recap |
| Staff | registration desk / nurse | register patients, queue, alerts, help requests, delivery status |
| Doctor | consulting doctor | dashboard, queue by department, summary, analysis, alerts |
| Admin | hospital administrator | users, departments, audit log, metrics, operations status |

Technology: Node.js (Express 5) API, React 19 + Vite 6 front end, PostgreSQL 18, npm workspaces monorepo (`server/`, `web/`), twelve versioned SQL migrations.

## 2. Problem and goals

**Problem.** In Indian OPDs a doctor has a few minutes per patient. History is taken verbally, in a noisy room, often in a language the software does not support, and prior records (paper prescriptions, lab printouts) are not read before the consultation. Important details (medicines, allergies, red-flag symptoms, out-of-range labs) are missed or found late.

**Goals**
1. Capture a structured, source-referenced history in the patient's language before the consultation.
2. Make the interview adapt to what each patient says, rather than a fixed questionnaire.
3. Read and cross-check uploaded files against what the patient said.
4. Alert staff early when an answer suggests the patient needs attention.
5. Give the doctor a concise draft and overview they can verify in seconds and decide on.
6. Keep every action auditable and every patient decision (consent) enforceable.

**Non-goals**
- Diagnosis, treatment suggestions, prescriptions or triage decisions made by software.
- Replacing the doctor's own history taking or examination.
- Storing real patient data before an approved pilot.

## 3. Users, roles and portals

Authentication is by role-specific login: patients by mobile OTP (a mock OTP provider in development; production refuses to start with it), staff / doctor / admin by username and password with optional TOTP second factor. Sessions are cookie JWTs with a server-side `session_epoch` so a password or MFA reset signs the user out everywhere. A role gateway blocks one portal's API from another role. Doctors see only patients of their own department.

| Role | Can | Cannot |
|---|---|---|
| Patient | register, consent per purpose, answer interview, upload files, submit, read their own recap, request help | see alerts, flags, analysis or any other patient's data |
| Staff | register patients, set AYUSH mode, view queue, acknowledge alerts and help requests, retry failed deliveries | see clinical analysis or decide on summaries |
| Doctor | see queue and alerts for their department, read summary, analysis and files, open a consultation, accept / amend / reject / write a manual note | see other departments, change users |
| Admin | manage users and departments, reset passwords / MFA, read the audit log, metrics and operations status | read clinical content as a doctor |

## 4. Patient journey

1. **Start:** choose language (English, Hindi, Marathi). Register (name, mobile, age, sex) or look up an existing record by mobile. A duplicate check prevents two records for one person. Optional ABHA (Ayushman Bharat Health Account) create or link, as a stand-in integration.
2. **Consent:** four separate purposes, each yes or no and revocable: history, documents, sharing with the hospital information system (HIS), ABHA linking. Nothing is collected without the matching consent.
3. **Interview:**
   1. The reason for the visit, in the patient's own words, typed or spoken.
   2. The emergency-signs screen (confirmed on screen and by audio).
   3. Follow-up questions: written one at a time by the AI interviewer when it is on, or taken from the fixed branching tree when it is off or has failed. Every path is capped (12 questions with the AI interviewer, 10 with the tree).
   4. Medicines and allergies, always last, always asked, confirmed on screen and by audio.
   5. The patient can review and change any answer before submitting.
4. **Files (optional):** upload photos or PDFs of prescriptions and lab reports; quality is checked, text read by OCR, the file classified and facts extracted.
5. **Submit:** the interview is locked, the summary is generated, staff and doctor are notified.
6. **Recap:** the patient sees "What you told us" in their language, with a label saying whether rules or an AI model wrote it, and that the doctor will go through everything with them. The session ends after the confirmation (or after 90 seconds on a shared terminal).

If the patient taps "help" or speech recognition fails repeatedly, staff receive a help request.

## 5. Functional requirements (what is built)

Status key: **Built** = implemented and covered by automated tests; **Built, needs approval** = implemented but depends on a human or external decision before real use; **Stand-in** = implemented against a simulated external system.

### 5.1 Registration, identity and consent
| ID | Requirement | Status |
|---|---|---|
| R1 | Self-registration by mobile with OTP; staff can register on the patient's behalf | Built (mock OTP) |
| R2 | Duplicate detection and look-up by mobile | Built |
| R3 | Identifiers encrypted at rest; mobile stored as a keyed hash for lookup | Built |
| R4 | Per-purpose consent (history, documents, HIS sharing, ABHA linking), revocable, enforced on every route and on outbound delivery | Built |
| R5 | ABHA create / link | Stand-in (`ABDM_MODE=stub`) |

### 5.2 Interview
| ID | Requirement | Status |
|---|---|---|
| I1 | Reason-first interview: the reason is read for a complaint and duration; what it names is filled in as "derived" and not asked, and can be changed on review | Built |
| I2 | Fixed branching question bank (ontology v1) in three languages; each answer picks the next question; questions phrased around the complaint ("About your cough: …"); no path asks more than 10 questions; every path is checked by a test | Built |
| I3 | AI interviewer (Gemini): writes each next question from the answers so far (section 6.1) | Built, needs approval |
| I4 | Question types: yes/no, single choice, multiple choice (always with "none of these"), 0 to 10 score, free text | Built |
| I5 | Skipping is recorded as "not answered", never as "no" | Built |
| I6 | Review and correct any answer; changing an earlier answer removes only the questions that are no longer on the path (AI questions and their answers are kept) | Built |
| I7 | Critical questions (emergency signs, medicines, allergies) need on-screen and audio confirmation; if audio is unavailable staff are told | Built |
| I8 | Listening modes: listen and speak, listen and tap, read and tap | Built |
| I9 | AYUSH mode adds AYUSH history questions after the standard path, set per department or by staff | Built, content needs review |

### 5.3 Red flags and alerts
| ID | Requirement | Status |
|---|---|---|
| A1 | Versioned red-flag rules evaluated after every answer (emergency signs, pain onset and severity, coughing blood, bladder trouble, and others); each rule has a level and a reason in three languages | Built, needs clinician sign-off |
| A2 | Alerts reach staff and the doctor's queue in real time (server-sent events); acknowledgement is recorded | Built |
| A3 | The patient is told only "staff have been notified", never why | Built |
| A4 | The AI interviewer can request attention; this becomes a help request | Built |
| A5 | Help requests (patient help button, repeated speech failure, audio unavailable) | Built |
| A6 | Urgent-help button on every patient screen: one tap raises an emergency alert on the patient's case, or an urgent help request before registration; needs no consent | Built |
| A7 | Emergency word scan of free text and voice transcripts in English, Hindi and Marathi (emergency terms always alert; milder terms ignored when negated); alerts say "automatic word match, please check" | Built, word list needs clinician and language review |

### 5.4 Documents
| ID | Requirement | Status |
|---|---|---|
| D1 | Upload several files per session (images, PDF), ordered, deletable | Built |
| D2 | Quality check (blur, size, readability) with plain-language feedback | Built |
| D3 | OCR (Tesseract) for English and Devanagari; extraction of dates, medicines, doses, lab values | Built |
| D4 | Rule-based classification (prescription, lab report, discharge summary and others) with confidence | Built |
| D5 | Background processing queue with retry; files stored encrypted | Built |
| D6 | Accuracy measured against synthetic documents | Built (report in `docs/ocr-accuracy-report.md`) |

### 5.5 Cross-document analysis
| ID | Requirement | Status |
|---|---|---|
| X1 | Timeline of events from all files and answers | Built |
| X2 | Medicine reconciliation (what the patient said vs what the files show) | Built |
| X3 | Lab table with reference ranges and high / low flags | Built |
| X4 | Drug interaction and allergy conflict checks from a curated list | Built, list needs pharmacist review |
| X5 | Consistency checks between answers and files | Built |
| X6 | Rebuilt automatically when medicine, allergy or file data changes; doctor can re-run | Built |

### 5.6 Summary and doctor workspace
| ID | Requirement | Status |
|---|---|---|
| S1 | Draft summary in a standard section order, in all three languages, with a source (patient answer, file, system) on every item | Built |
| S2 | "Not answered" items are listed in a completeness indicator, never rendered as "no" | Built |
| S3 | A scan refuses diagnostic wording in generated text | Built |
| S4 | Lifecycle: draft, ready, in consultation, completed, rejected; doctor can accept, amend line by line, reject (with a manual note), print and download | Built |
| S5 | **Live view:** for a patient still answering, the doctor sees what has been said so far, marked "live, not submitted"; nothing is saved by looking and the case cannot be accepted yet | Built |
| S6 | **Overview card** on the Summary tab (section 6.2), with a label of who wrote it | Built |
| S7 | Doctor queue by department with status chips (alert, ready, in intake, in consultation), search with Ctrl/Cmd+K, keyboard shortcuts | Built |
| S8 | Every version of a summary is kept | Built |

### 5.7 Dashboard
A role-aware dashboard from one endpoint: tiles with 7-day bars (patients, ready cases, alerts, completed), a donut by complaint, a rolling six-day patient grid by arrival hour, rule-based "smart insights" in plain words, recent cases and recent audit events. Charts are inline SVG with no chart library. Themes: light, dark, high contrast, large text.

### 5.8 Integration (HIS and ABHA)
Completed cases are delivered as FHIR bundles to a HIS stand-in with retry and back-off, a visible failed state, and a manual retry by staff. A purpose without consent is never sent, and the record says why. Real HIS and ABDM connections are not made (Stand-in).

### 5.9 Admin and operations
User management (create, edit, disable, enable, reset password, reset MFA), departments, searchable append-only audit log, metrics, operations status with health checks and alerts, backup and retention notes, a restore drill and rollout runbook (documents).

## 6. AI components: what each one does and does not do

There are three kinds of intelligence in the product. Only the first two use an AI model, and each is off by default.

### 6.1 AI interviewer (Gemini), `AI_INTERVIEW_PROVIDER=gemini`
- **Does:** after the reason and the emergency screen, writes the next question, one at a time, from everything the patient has said (up to 6 questions); chooses answer options; says when it has enough (not before 3); picks the closest complaint type; may flag attention with a reason in English.
- **The system decides, not the model.** A proposed question is refused if it is malformed, repeats an earlier question, lacks Hindi or Marathi in Devanagari, has bad options, names a disease, gives advice or states a cause. Any refusal or failure before the first question hands over to the fixed tree; a failure later ends the AI part and the closing questions follow.
- **Always by the system, never by the model:** emergency signs, medicines and allergies.
- **Resilience:** one retry after a short wait on a busy or rate-limited reply; low "thinking" setting so each question returns in about 2.5 seconds; 20 second limit.
- **Privacy:** only a de-identified facts object is sent: reason in the patient's words, age group, sex, questions asked and answers. No name, mobile, identifier or date of birth.
- **Record:** each AI question is stored with its answer, the model's reason and the provider and model name; the doctor sees "Asked by AI" and why.

### 6.2 Overview writer, `AI_PROVIDER=rules | gemini | anthropic`
- **Does:** after the patient submits, writes two short overviews in three languages in the background: one for the doctor (history, file findings, flagged checks) and one for the patient (only what they said).
- **Default `rules`:** fixed rules restate the recorded answers; nothing leaves the platform. `gemini` (shares `GEMINI_API_KEY` and `GEMINI_MODEL`) and `anthropic` (Claude, `ANTHROPIC_API_KEY`) send de-identified facts to an outside model.
- **Checks on any model text:** diagnostic wording anywhere, or risk / alert wording in a patient recap, causes the text to be replaced by the rules text, with the reason stored. Each overview says who wrote it.
- **The patient's recap never contains** file findings, labs, interactions, flags or alerts.

### 6.3 Rule-based analysis (no AI model)
Red flags, OCR, classification, extraction, the timeline, medicine reconciliation, lab flags, interaction and allergy checks, consistency checks and the summary generator are deterministic and versioned. They are the part of the system that can be reviewed line by line by a clinician.

## 7. Safety rules that hold everywhere

1. No diagnosis and no treatment advice, in any generated text; enforced by scans and by prompt rules.
2. "Not answered" is never "no".
3. Every summary item names its source.
4. The doctor accepts, amends or rejects; nothing is auto-accepted.
5. The patient is never told what was flagged.
6. Consent is checked per purpose on every route and before every outbound delivery.
7. Emergency, medicine and allergy questions are always asked and need dual confirmation.
8. Any AI failure degrades to rules; the interview and the summary still complete.
9. Every significant action is written to an append-only, partitioned audit log.

## 8. Languages, voice and accessibility

- **Languages:** English, Hindi, Marathi for the UI (flat JSON keys with a parity test), questions, summaries and recaps. Hindi and Marathi wording is a developer draft pending native-speaker and clinician review.
- **Speech engine:** `SPEECH_PROVIDER=bhashini` routes recognition and speech output through Bhashini / AI4Bharat (the models the statement names) via `/api/patient/speech/*`; the default is the browser's own speech, which is also the automatic fallback if Bhashini is off or fails. Audio and words are never stored or logged. Needs ULCA credentials; tested against a stand-in only.
- **Voice output (browser):** browser speech synthesis. The app picks a voice per language: Marathi uses a Marathi voice if installed, otherwise a Hindi voice (read a little slower); network voices are preferred; a newer prompt cancels an older one.
- **Voice input (browser):** browser speech recognition with live words while speaking, all recognizer guesses tried, spoken numbers (words, Devanagari digits, "double nine") filling number fields, close-but-not-exact answers accepted only when one option is clearly meant, specific messages for a blocked or missing microphone, no network, or no speech. Two failures offer tapping; a third alerts staff.
- **Icon set** with a text label on every control; audio cue on every selection; large touch targets; a kiosk-style patient terminal with "Start again".
- **Display:** light, dark, high contrast, large text; keyboard shortcuts for the doctor; responsive down to phone width.

## 9. Data design

PostgreSQL, twelve migrations applied in order and checked by a schema test.

| Migration | Adds |
|---|---|
| 001 schema v1 | departments, users, patients, patient_identifiers, consents, encounters, interview_responses, documents, extracted_entities, lab_results, medications, analysis_results, alerts, queue_entries, summaries, summary_versions, audit_logs |
| 002 registration and consent | patient_sessions, otp_challenges, help_requests, keyed hash of identifiers |
| 003 interview | speech-failure counter on patient sessions |
| 004 alerts and queue | alert and queue changes, row-level security role for doctors (not used by the running app) |
| 005 documents | document pipeline fields |
| 006 analysis | analysis_runs, document_links, upload time on documents |
| 007 summary | summary lifecycle fields |
| 008 AYUSH | AYUSH mode on encounters |
| 009 compliance | partitioned append-only audit_logs, fhir_bundles, deliveries, MFA flag on users, retention and purge |
| 010 admin and ops | ops_events for the monitor |
| 011 AI overview | `ai_narratives` (per encounter and audience: provider, model, status, text, fallback reason, input hash) |
| 012 AI interview | per-encounter interview engine, pending AI question, AI-done flag |

Principles: identifiers encrypted at rest, mobile as a keyed hash, interview answers as JSON beside their modality, confidence and confirmation, AI questions stored inside the answer so the path can be rebuilt from answers alone, summaries versioned, audit log never updated.

## 10. API surface

All routes are under `/api`. Roles are enforced by the gateway; patient routes also require an active session and the matching consent.

- **Auth** (`/auth`): `login`, `logout`, `me`, `password`, `mfa/enrol`, `mfa/confirm`.
- **Speech** (`/patient/speech`): `status`, `transcribe` (WAV in, words out), `synthesize` (text in, WAV out).
- **Patient** (`/patient`): `register`, `otp/send`, `otp/verify`, `lookup`, `consent`, `consent/revoke`, `me`, `help`, `submit`, `summary` (recap), `responses/:questionKey`, `abha/create`, `abha/link`.
- **Interview** (`/patient/interview`): `state`, `next`, `answer`, `question/:key`, `review`, `history`, `listening-mode`, `recognition-failure`.
- **Documents** (`/patient/documents`): list, upload, update, delete, reorder.
- **Staff** (`/staff`): `patients`, `queue`, `departments`, `encounters/:id/mode`, `alerts`, `alerts/stream`, `alerts/:id/ack`, `help-requests`, `help-requests/:id/ack`, `deliveries`, `deliveries/:id/retry`.
- **Doctor** (`/doctor`): `encounters`, `encounters/:id/summary`, `…/analysis`, `…/analysis/rerun`, `…/consult`, `…/summary/accept`, `…/amend`, `…/reject`, `…/manual`, `…/documents/:docId/file`, `alerts`, `alerts/stream`.
- **Admin** (`/admin`): users (create, edit, disable, enable, reset password, reset MFA), departments, `audit`, `audit/actions`, `metrics`, `ops`.
- **Shared:** `dashboard`, `dashboard/search`, `health`.

## 11. Architecture and configuration

```
Browser (React) ── /api ──> Express API ──> PostgreSQL
                              │  ├─ interview engine (tree or AI interviewer)
                              │  ├─ red-flag evaluator ─> alerts hub (SSE)
                              │  ├─ document pipeline (queue, OCR, classify, extract)
                              │  ├─ analysis engine ─> summary generator ─> overview writer
                              │  └─ integration (FHIR to HIS stand-in), monitor, purge
                              └─ optional outbound: Gemini or Anthropic (de-identified facts only)
```

Key environment variables (see `.env.example`; real values live in the ignored `server/.env`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `HASH_KEY` | database and cryptography |
| `OTP_PROVIDER`, `ABDM_MODE`, `HIS_MODE` | external stand-ins (dev only; production refuses mocks) |
| `AI_INTERVIEW_PROVIDER` (`rules` or `gemini`), `GEMINI_API_KEY`, `GEMINI_MODEL` | AI interviewer; default model `gemini-3.6-flash` |
| `AI_PROVIDER` (`rules`, `gemini`, `anthropic`), `ANTHROPIC_API_KEY`, `AI_MODEL`, `ANTHROPIC_BASE_URL` | overview writer |
| `SPEECH_PROVIDER` (`browser` or `bhashini`), `BHASHINI_USER_ID`, `BHASHINI_API_KEY`, `BHASHINI_CONFIG_URL`, `BHASHINI_INFERENCE_URL` | speech recognition and output |
| `SEED_*_PASSWORD` | demo account passwords (dev and staging only) |

Demo accounts after `npm run seed`: `staff.test`, `doctor.test`, `admin.test`.

## 12. Security, privacy and compliance

- **Authentication and sessions:** role-specific login, bcrypt passwords, cookie JWT, `session_epoch` revocation, login rate limiting, optional TOTP, MFA reset by admin.
- **Input hardening:** NUL-byte rejection, validated question keys and answers, constrained answers (a patient can only answer a question on their own path), file size and type limits.
- **Privacy by design:** minimal data to outside models (de-identified, no free identifiers), AI off by default, consent per purpose, retention and purge jobs, encrypted files.
- **Auditability:** append-only partitioned audit log of logins, answers, alerts, AI calls (provider, model, success, fallback reason), summary decisions, deliveries and admin actions.
- **Legal and regulatory:** the product is designed toward India's DPDP Act 2023, ABDM and ICMR AI guidance. A compliance checklist exists (`docs/compliance-checklist.md`); legal review, a DPIA and hospital approval are not done.
- **External model use:** sending any patient-derived text to Google or Anthropic requires hospital and compliance approval and a consent decision. No separate consent purpose for it exists yet.

## 13. Non-functional requirements and test status

| Area | Target | State |
|---|---|---|
| Automated tests | all green on every change | 237 server tests, 37 web tests passing; lint and production build clean |
| Question paths | every answer path within the cap | verified by exhaustive test for the fixed tree |
| Security | route matrix, isolation between patients, role separation | tested; an independent security review is not done |
| Performance | documented load test | report in `docs/load-test-report.md` (synthetic) |
| AI interviewer | latency under about 3 s per question | measured about 2.5 s on `gemini-3-flash-preview` / `gemini-3.6-flash` |
| Availability | health endpoint, monitor with alerts, restore drill | built; production SLOs not set |
| Accessibility | low-literacy, multilingual, high contrast | built; no formal usability test with real patients yet |

CI (`.github/workflows/ci.yml`) runs lint, migration check, tests and build on every merge.

## 14. Differences from the original PRD

| Original | Built | Why |
|---|---|---|
| The patient never sees any analysis (FR-P5, FR-C6) | The patient sees a short recap of only their own answers, labelled as automatic | requested by the product owner; contains no findings, flags or checks; needs clinical lead approval |
| Interview from a fixed ontology | Fixed branching tree is the fallback; the AI interviewer writes follow-ups when on | requested: questions should follow the patient, not a stored list |
| 10 questions at most | 10 with the tree, 12 with the AI interviewer (6 written by the model) | room for medicines and allergies after the model's questions |
| Medicines and allergies near the end | Always last, after the AI follow-ups | lets the model concentrate on the complaint |
| Doctor sees a summary only after submission | Doctor can open a patient mid-interview in a live view | fixes "nothing shows when I select a patient" |
| Analysis by rules | Rules for analysis; optional model for the overview text and for question writing | no model decides anything clinical |
| Four portals as separate apps | One front end with a role gateway and a shared design system | simpler deployment |

## 15. Known limitations and open items

**Needs a human or external decision before real use**
- Clinician sign-off on red-flag rules, question content, AYUSH content and the summary format.
- Native-speaker review of Hindi and Marathi wording (UI, questions, voice prompts). AI-written Marathi is unchecked.
- Hospital and compliance approval, and a consent purpose, for sending data to an outside model.
- Real OTP, ABDM and HIS integrations (all stand-ins today); production secrets and hosting.
- Independent security review, legal review and a data protection impact assessment.
- Usability test and pilot with real users; staff training.

**Technical limitations**
- The fixed red-flag rules read the tree's question keys. For AI-written questions the emergency word scan, the urgent-help button and (when on) the model's own attention flag raise alerts, so a clinician must review sample AI interviews first (`node --env-file=.env server/scripts/export-ai-interviews.js` writes `docs/ai-interview-samples.md`).
- The Gemini paths were tested against stand-ins and short live calls; the full path has not been run at volume. The free Gemini tier allows about 20 requests per day per model, which covers only a few patients; real use needs a paid key.
- Marathi speech depends on the device's voices; without a Marathi or Hindi voice installed the browser reads Devanagari with an English voice and sounds wrong.
- The AI interviewer can vary between patients, which makes testing and sign-off harder.
- Question and interaction lists are curated starter sets, not complete clinical content.
- Row-level security exists in the database but the running application does not use that role.

## 16. Success metrics and pilot

Defined in `docs/success-metrics.md` and `docs/pilot-protocol.md`, to be measured in a pilot: percentage of patients completing the interview unaided, time added to the registration desk, doctor time to read the summary, accuracy of extracted medicines and labs against the documents, number of items a doctor amends or rejects, red-flag alert precision and recall as judged by clinicians, patient understanding of the recap, and share of AI questions refused by the checks.

## 17. Roadmap

1. Clinician and language review using the exported sample interviews; adjust prompts and rules.
2. Deterministic safety net for AI-written answers (keyword and answer-pattern red flags independent of the model).
3. A consent purpose for external model processing and an admin setting to disable it per department.
4. Paid model quota or a hospital-hosted model; compare Gemini and Claude on the same interviews.
5. Real HIS, ABDM and SMS OTP integrations; production hosting, backups and monitoring.
6. Pilot in one department with synthetic-then-supervised real use, then wider rollout and training.

## 18. Glossary

- **OPD:** outpatient department.
- **HIS:** hospital information system.
- **ABHA / ABDM:** Ayushman Bharat Health Account / Digital Mission.
- **AYUSH:** Ayurveda, Yoga, Unani, Siddha, Homeopathy.
- **FHIR:** a standard format for exchanging health records.
- **OCR:** reading text from an image.
- **Derived answer:** an answer filled in from the patient's own words, not asked.
- **Live view:** the doctor's view of an interview that has not been submitted.
- **Fallback:** the rule-based text or fixed question tree used when an AI model fails or is refused.
