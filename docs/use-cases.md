# PatientCase_AI: Use Case Descriptions

These describe what the built system does. Items marked *(stand-in)* work against a simulated external system in the prototype (OTP, ABDM, HIS).

**Actors:** Patient · Staff (registration desk, nurse) · Doctor · Admin · External systems (Bhashini speech, AI model, HIS, ABDM)

| ID | Use case | Primary actor |
|---|---|---|
| UC-01 | Register and give consent | Patient |
| UC-02 | Staff registers a patient | Staff |
| UC-03 | Take history by voice or touch | Patient |
| UC-04 | Raise an emergency alert (red flag) | System, Staff |
| UC-05 | Upload and digitize medical documents | Patient |
| UC-06 | Submit history and read the recap | Patient |
| UC-07 | Monitor the queue, alerts and help requests | Staff |
| UC-08 | Review a patient before and after submission | Doctor |
| UC-09 | Accept, amend or reject the summary | Doctor |
| UC-10 | Review cross-document analysis | Doctor |
| UC-11 | Deliver the record to the HIS and ABHA | System, Staff |
| UC-12 | Manage users, departments and audit | Admin |
| UC-13 | Take an AYUSH (Dashavidha) history | Patient, Staff |

---

## UC-01 Register and give consent
**Actor:** Patient. **Goal:** get a patient record and decide what the hospital may do with their data.
**Preconditions:** a terminal or phone with a browser.
**Main flow**
1. The patient chooses English, Hindi or Marathi (prompts can be read aloud).
2. They enter a mobile number and a one-time code *(OTP is a stand-in)*.
3. The system looks for an existing record by mobile; if none, the patient enters name, age and sex.
4. The patient answers four separate consent questions: history, documents, sharing with the hospital system, ABHA linking. Each is spoken aloud and answered yes or no.
5. The system creates the record and an encounter, and shows a patient case ID.

**Alternate flows:** a duplicate is detected, so the patient is asked to confirm instead of creating a second record. The patient may link or create an ABHA ID *(stand-in)*. A patient who refuses "history" consent cannot start the interview.
**Postconditions:** patient, consents and encounter exist; every step is audited.
**Rules:** consent can be revoked at any time; each purpose is checked on every route and before any outbound delivery.

## UC-02 Staff registers a patient
**Actor:** Staff. **Goal:** register someone who cannot or will not self-register.
**Main flow:** staff enter the patient's details, pick the department, optionally set AYUSH mode, and hand over the terminal; the patient then gives consent (UC-01 step 4).
**Alternate flows:** staff change the interview mode later from the queue.
**Postconditions:** the patient appears in the department queue as "registered".

## UC-03 Take history by voice or touch
**Actor:** Patient. **Supporting:** Bhashini speech, AI interviewer.
**Preconditions:** consent for "history" given.
**Main flow**
1. The patient picks a listening mode with large icons: Listen and Speak, Listen and Tap, or Read and Tap.
2. The first question asks the reason for the visit in the patient's own words, spoken or typed. The system reads it for a complaint and how long it has lasted, and does not ask what it already knows.
3. An emergency-signs screen follows, confirmed on screen and by audio.
4. The system asks follow-up questions, one at a time, written from what the patient has said (up to 6 with the AI interviewer, otherwise from the fixed branching tree). Each can be answered by speaking or tapping.
5. Medicines and allergies are always asked last, each confirmed on screen and by audio.
6. The patient reviews all answers and may correct any of them.

**Alternate flows:** speech not recognised twice → tapping is offered; a third time → staff are alerted. Microphone blocked → clear message, tap instead. A question skipped is recorded as "not answered", never "no". The AI model fails or writes an unacceptable question → the fixed tree takes over. Bhashini unavailable → the browser's own speech is used.
**Postconditions:** answers stored with how they were given; AI-written questions stored with the model's reason.
**Rules:** the system refuses any question that states a diagnosis, gives advice, repeats, or lacks Hindi or Marathi.

## UC-04 Raise an emergency alert (red flag)
**Actor:** System (triggers), Staff (responds).
**Trigger:** an answer matches a red-flag rule (for example chest pain with breathlessness), or the AI interviewer asks for attention.
**Main flow:** the system raises an alert with a level and a reason in three languages; staff and the doctor's queue see it in real time; staff acknowledge it.
**Postconditions:** acknowledgement is audited. The patient is told only that staff have been notified, never why.

## UC-05 Upload and digitize medical documents
**Actor:** Patient. **Preconditions:** consent for "documents".
**Main flow**
1. The patient photographs or uploads prescriptions, lab reports or discharge summaries (several files, reorderable).
2. The system checks quality and asks for a retake if a file is unreadable.
3. In the background it reads the text (OCR, English and Devanagari), classifies the document, and extracts dates, medicines, doses and lab values.
4. The patient sees only the status of each file, never what was found.

**Alternate flows:** wrong type or too large → rejected with a plain message. The patient deletes a file before submitting.
**Postconditions:** extracted facts are stored with their source file; cross-document analysis is rebuilt (UC-10).

## UC-06 Submit history and read the recap
**Actor:** Patient.
**Main flow:** the patient taps submit; the interview locks; the system generates the doctor's summary and, in the background, an overview for the doctor and a recap for the patient. The final screen shows "What you told us" in the patient's language, labelled as written automatically (by rules or by an AI model), and says the doctor will go through it. The session then ends.
**Rules:** the recap holds only what the patient said, with no findings, flags or checks. It is never a diagnosis.

## UC-07 Monitor the queue, alerts and help requests
**Actor:** Staff.
**Main flow:** staff see the queue by department, live alerts, and help requests (patient pressed help, speech failed repeatedly, audio unavailable); they acknowledge each; they change a patient's mode if needed.
**Postconditions:** each acknowledgement is recorded with the staff member and time.

## UC-08 Review a patient before and after submission
**Actor:** Doctor. **Preconditions:** the patient is in the doctor's department.
**Main flow**
1. The doctor opens the workspace and sees their department's queue with status chips (alert, ready, in intake, in consultation) and can search with Ctrl/Cmd+K.
2. Selecting a patient who is still answering shows a **live view**: what has been said so far, marked "not submitted"; nothing is saved by looking.
3. Selecting a submitted patient shows the draft summary with a source on every item, a completeness list of what was not answered, the uploaded files, and an overview card saying who wrote it.

**Alternate flows:** a patient from another department is not visible.

## UC-09 Accept, amend or reject the summary
**Actor:** Doctor.
**Main flow:** the doctor opens the case for consultation, then accepts the draft, amends individual lines, or rejects it and writes a manual note. They may print or download the final summary.
**Postconditions:** every version is kept; the decision and the doctor are audited; the case moves to completed.
**Rules:** nothing is accepted automatically; a live (unsubmitted) case cannot be accepted.

## UC-10 Review cross-document analysis
**Actor:** Doctor.
**Main flow:** the doctor views a timeline of events from files and answers, medicine reconciliation (said versus documented), a lab table with high and low flags, drug interaction and allergy-conflict checks, and consistency checks. They can re-run the analysis.
**Rules:** results are facts with sources; there is no diagnosis. The interaction list is a curated starter set that needs pharmacist review.

## UC-11 Deliver the record to the HIS and ABHA
**Actor:** System; Staff for retries.
**Main flow:** after completion the system builds FHIR bundles for each purpose the patient consented to and sends them to the HIS and ABHA *(stand-ins)*.
**Alternate flows:** a failure is retried with back-off, ends in a visible "failed" state, and staff can retry it. A purpose without consent is never sent, and the record says why.

## UC-12 Manage users, departments and audit
**Actor:** Admin.
**Main flow:** the admin creates and edits users and departments, disables or enables accounts, resets passwords and second factors, reads the searchable audit log, and views metrics and operations status (health checks, alerts).
**Rules:** a reset signs the user out everywhere; the audit log is append-only.

## UC-13 Take an AYUSH (Dashavidha) history
**Actor:** Patient (answers), Staff (sets the mode).
**Main flow:** with AYUSH mode on, an extended set of questions follows the standard path (Prakriti, Vikriti, Agni, Koshtha, Ahara-Vihara, Nidana, Samprapti and others); some items are marked for the physician to observe. The summary shows AYUSH sections beside the standard ones.
**Rules:** switching modes loses no answers. The AYUSH content is a developer draft that needs clinician review.
