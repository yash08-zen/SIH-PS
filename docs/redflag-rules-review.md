# Red-flag rules v1: clinician review and sign-off

Generated from `server/config/redflag-rules.v1.js` and `server/test/scenarios.js` by `node server/scripts/export-redflags.js`. Do not edit by hand.

**Status:** draft: awaiting clinician review. The rules were written by the developers from the PRD examples and general emergency teaching. **No clinician has reviewed them.** Missing a real emergency is the most serious failure in the product, so please check for gaps first, then for rules that would cause alert fatigue.

## What the system does

- After every saved answer the rules are checked against everything answered so far. A matching rule raises one alert per encounter (the same rule never raises twice).
- Staff and the doctor see the alert at once, with the answers that triggered it. The patient sees only "Please wait. Staff will be with you shortly."
- **emergency** alerts sort first; **attention** alerts (a safety question left unanswered, or the worst level of pain) sort after them.
- A skipped safety question is treated as a reason for staff attention, never as "no".

## Questions for the reviewer

1. Which emergency presentations are missing (for example severe breathlessness alone, suspected sepsis, severe abdominal pain with vomiting, pregnancy-related bleeding, self-harm, child-specific signs)?
2. Is "chest pain with sweating" correct as an emergency alert on its own? Should nausea or radiation to the arm count?
3. Should back pain with leg numbness or weakness (without bladder trouble) raise an attention alert?
4. Should fever with rash, or fever with a very high temperature, alert?
5. Is a pain score of 9 or 10 the right threshold for an attention alert? Is 8 or more with sudden headache right for the "thunderclap" rule?
6. Are the must-not-alert scenarios below truly safe not to alert on?

## Second net: emergency words and the urgent-help button

**Words status (v1):** draft: awaiting clinician and language review. The rules above only see the answers to specific questions. Anything the patient types or says in their own words (the reason for the visit, every free-text answer, and the transcript of anything answered by voice) is also checked against the word list below, so an emergency nobody wrote a rule for can still raise an alert.

- A term is one or more words that must sit next to each other; `*` at the end matches any ending ("bleed*" matches "bleeding"). Hindi and Marathi are included in Devanagari and, where patients commonly type that way, in English letters.
- **emergency** terms always alert, even if negated ("no suicidal thoughts" still alerts): it is safer to over-alert. **attention** terms are ignored when a negating word (no, not, never, without, nil, denies, नहीं, नही, नाही, न, nahi, nahin, nai, nahee) is within three words.
- Each category alerts once per patient. The alert says "automatic word match, please check" and shows the exact words the patient used.
- **Urgent-help button:** every patient screen has a red "I need urgent help" button and the line "If you feel very unwell, tell a staff member now." One tap raises an emergency alert on the patient’s case (or, before registration, an urgent help request). The patient is told only that staff have been told.

**Questions for the reviewer:** which words are missing in English, Hindi and Marathi? Which would cause false alarms (for example "burns" in a history of old burns, "accident" in a past accident)? Should any attention term be an emergency, or the reverse? Are the Hindi and Marathi words natural?

| Category | Level | Terms |
|---|---|---|
| `UNCONSCIOUS` | emergency | unconscious, unresponsive, not responding, not waking, collapsed, बेहोश*, होश नहीं, बेसुध*, behosh*, बेशुद्ध*, शुद्धीवर नाही, शुद्ध हरपली, beshuddh* |
| `FAINTING` | attention | faint*, passed out, blacked out, blackout, चक्कर आकर गिर, अँधेरा छा, अंधारी |
| `SEIZURE` | emergency | seizure*, convulsion*, convulsing, shaking uncontrollably, foaming, मिर्गी का दौरा, दौरा पड़*, दौरे पड़*, झटके आ*, daura pad*, आकडी*, झटके येत*, aakdi* |
| `BREATHING_STOPPED` | emergency | cant breathe, cannot breathe, unable to breathe, not able to breathe, stopped breathing, gasping, choking, साँस नहीं, सांस नहीं, सांस रुक*, दम घुट*, saans nahi, dam ghut*, श्वास घेता येत नाही, श्वास थांबला, दम घुटत* |
| `BREATHING_DIFFICULT` | attention | difficulty breathing, trouble breathing, short of breath, shortness of breath, breathless*, साँस फूल*, सांस फूल*, सांस लेने में तकलीफ, साँस लेने में तकलीफ, दम लागत*, श्वास घेण्यास त्रास |
| `BLEEDING_HEAVY` | emergency | heavy bleeding, bleeding heavily, bleeding a lot, wont stop bleeding, bleeding wont stop, vomiting blood, vomited blood, blood vomit, खून की उल्टी, बहुत खून, खून बह रहा, खून नहीं रुक, रक्ताची उलटी, खूप रक्त, रक्तस्राव थांबत नाही, रक्त वाहत* |
| `BLEEDING` | attention | bleeding, bleeds, खून आ*, खून निकल*, रक्तस्राव*, रक्त येत*, khoon aa* |
| `POISON_OVERDOSE` | emergency | poison*, overdose*, took too many, drank phenyl, pesticide, kerosene, snake bite, snakebite, bitten by snake, जहर*, ज़हर*, साँप ने काट*, सांप ने काट*, zeher, विष*, विषबाधा, साप चावला, साप चावल* |
| `SELF_HARM` | emergency | suicide, suicidal, kill myself, end my life, want to die, wants to die, hurt myself, harm myself, cut myself, आत्महत्या*, मरना चाहत*, जान दे*, खुद को मार*, aatmahatya*, khudkushi*, मरावेसे वाटते, जीव द्यावा, स्वतःला मार* |
| `STROKE_SIGNS` | emergency | face drooping, drooping face, slurred speech, cant speak, unable to speak, one side weak*, half body, paralysis, paralysed, paralyzed, sudden weakness, मुंह टेढ़ा, मुँह टेढ़ा, बोल नहीं पा*, लकवा*, पैरालिसिस, आधा शरीर, तोंड वाकडे, बोलता येत नाही, अर्धांग*, पक्षाघात |
| `ALLERGY_SEVERE` | emergency | anaphylaxis, throat closing, throat swelling, swelling of face, swollen face, swollen lips, tongue swelling, गला बंद, गले में सूजन, चेहरे पर सूजन, होंठ सूज*, घसा बंद, चेहऱ्यावर सूज, ओठ सुज* |
| `CHEST_PAIN` | attention | chest pain, chest tightness, pain in chest, pain in my chest, heart attack, सीने में दर्द, छाती में दर्द, सीने में जकड़न, दिल का दौरा, छातीत दुखत*, छातीत वेदना, हृदयविकाराचा झटका |
| `INJURY_ACCIDENT` | attention | accident*, head injury, hit my head, fell from, burns, burnt, दुर्घटना*, एक्सीडेंट, जल गया, जल गई, सिर में चोट, अपघात*, भाजले, भाजला, डोक्याला मार |

## Rules

| Rule | Version | Level | Reason (English) | Raised when |
|---|---|---|---|---|
| `RF-EMERG-CHEST` | 1 | emergency | Reports chest pain with difficulty breathing | emergency.screen includes e_chest |
| `RF-EMERG-STROKE` | 1 | emergency | Reports one-sided weakness or trouble speaking (possible stroke) | emergency.screen includes e_stroke |
| `RF-EMERG-FAINT` | 1 | emergency | Reports fainting or loss of consciousness | emergency.screen includes e_faint |
| `RF-EMERG-BLEED` | 1 | emergency | Reports heavy bleeding | emergency.screen includes e_bleed |
| `RF-CHEST-BREATHLESS` | 1 | emergency | Chest pain with breathlessness | cc.main = chest_pain AND pain.associated includes breathlessness |
| `RF-CHEST-SWEATING` | 1 | emergency | Chest pain with sweating | cc.main = chest_pain AND pain.associated includes sweating |
| `RF-COUGH-BLOOD` | 1 | emergency | Coughing up blood | cough.blood = yes |
| `RF-BACK-BLADDER` | 1 | emergency | Back pain with trouble passing urine or stool (possible nerve compression) | back.bladder = yes |
| `RF-HEADACHE-THUNDERCLAP` | 1 | emergency | Sudden, very severe headache | cc.main = headache AND pain.onset = sudden AND pain.severity >= 8 |
| `RF-PAIN-SEVERE` | 1 | attention | Reports the worst level of pain (9 or 10 out of 10) | pain.severity >= 9 |
| `RF-SKIPPED-EMERGENCY-SCREEN` | 1 | attention | The emergency symptom question was not answered | emergency.screen was skipped |
| `RF-SKIPPED-ALLERGY` | 1 | attention | The allergy question was not answered | allergy.any was skipped |
| `RF-SKIPPED-MEDICINES` | 1 | attention | The current-medicines question was not answered | drug.current_any was skipped |

### Reason text in Hindi and Marathi (draft, pending native-speaker review)

| Rule | Hindi | Marathi |
|---|---|---|
| `RF-EMERG-CHEST` | सीने में दर्द और साँस लेने में तकलीफ़ बताई | छातीत दुखणे आणि श्वास घेण्यास त्रास सांगितला |
| `RF-EMERG-STROKE` | एक तरफ़ कमज़ोरी या बोलने में तकलीफ़ बताई (संभावित स्ट्रोक) | एका बाजूला अशक्तपणा किंवा बोलण्यास त्रास सांगितला (संभाव्य पक्षाघात) |
| `RF-EMERG-FAINT` | बेहोशी बताई | बेशुद्ध पडल्याचे सांगितले |
| `RF-EMERG-BLEED` | बहुत ज़्यादा खून बहना बताया | खूप रक्तस्राव सांगितला |
| `RF-CHEST-BREATHLESS` | सीने में दर्द के साथ साँस फूलना | छातीत दुखण्यासोबत दम लागणे |
| `RF-CHEST-SWEATING` | सीने में दर्द के साथ पसीना | छातीत दुखण्यासोबत घाम येणे |
| `RF-COUGH-BLOOD` | खाँसी में खून आना | खोकल्यातून रक्त येणे |
| `RF-BACK-BLADDER` | पीठ दर्द के साथ पेशाब या शौच में तकलीफ़ (नस दबने की संभावना) | पाठदुखीसोबत लघवी किंवा शौचास त्रास (मज्जा दबल्याची शक्यता) |
| `RF-HEADACHE-THUNDERCLAP` | अचानक बहुत तेज़ सिर दर्द | अचानक खूप तीव्र डोकेदुखी |
| `RF-PAIN-SEVERE` | सबसे ज़्यादा दर्द बताया (10 में से 9 या 10) | सर्वाधिक वेदना सांगितली (10 पैकी 9 किंवा 10) |
| `RF-SKIPPED-EMERGENCY-SCREEN` | आपातकालीन लक्षणों का सवाल अनुत्तरित रहा | आणीबाणीच्या लक्षणांचा प्रश्न अनुत्तरित राहिला |
| `RF-SKIPPED-ALLERGY` | एलर्जी का सवाल अनुत्तरित रहा | अ‍ॅलर्जीचा प्रश्न अनुत्तरित राहिला |
| `RF-SKIPPED-MEDICINES` | वर्तमान दवाओं का सवाल अनुत्तरित रहा | सध्याच्या औषधांचा प्रश्न अनुत्तरित राहिला |

## Scenarios the test suite runs on every change

### Must alert

| Scenario | Answers | Rules that must fire |
|---|---|---|
| chest pain with breathlessness | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="chest_pain", pain.associated=["breathlessness","nausea"] | RF-CHEST-BREATHLESS |
| chest pain with sweating | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="chest_pain", pain.associated=["sweating"] | RF-CHEST-SWEATING |
| emergency screen: chest pain with difficulty breathing | emergency.screen=["e_chest"], allergy.any="no", drug.current_any="no" | RF-EMERG-CHEST |
| emergency screen: stroke symptoms | emergency.screen=["e_stroke"], allergy.any="no", drug.current_any="no" | RF-EMERG-STROKE |
| emergency screen: fainting | emergency.screen=["e_faint"], allergy.any="no", drug.current_any="no" | RF-EMERG-FAINT |
| emergency screen: heavy bleeding | emergency.screen=["e_bleed"], allergy.any="no", drug.current_any="no" | RF-EMERG-BLEED |
| emergency screen: several symptoms at once | emergency.screen=["e_chest","e_faint"], allergy.any="no", drug.current_any="no" | RF-EMERG-CHEST, RF-EMERG-FAINT |
| coughing up blood | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="cough", cough.blood="yes" | RF-COUGH-BLOOD |
| back pain with trouble passing urine or stool | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="back_pain", back.bladder="yes" | RF-BACK-BLADDER |
| sudden severe headache | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="headache", pain.onset="sudden", pain.severity=9 | RF-HEADACHE-THUNDERCLAP, RF-PAIN-SEVERE |
| worst pain, gradual headache | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="headache", pain.onset="gradual", pain.severity=9 | RF-PAIN-SEVERE |
| worst pain, abdomen | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="abdominal_pain", pain.severity=10 | RF-PAIN-SEVERE |
| emergency question skipped | emergency.screen=skipped, allergy.any="no", drug.current_any="no" | RF-SKIPPED-EMERGENCY-SCREEN |
| allergy question skipped | emergency.screen=["none"], allergy.any=skipped, drug.current_any="no" | RF-SKIPPED-ALLERGY |
| current-medicines question skipped | emergency.screen=["none"], allergy.any="no", drug.current_any=skipped | RF-SKIPPED-MEDICINES |

### Must not alert

| Scenario | Answers |
|---|---|
| ordinary fever | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="fever", fever.pattern="evening", fever.chills="yes", fever.rash="no" |
| dry cough without blood | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="cough", cough.type="dry", cough.blood="no", cough.breathless="no" |
| chest pain on exertion, nothing else reported | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="chest_pain", pain.associated=["none"], pain.timing="on_activity", pain.severity=5 |
| back pain after a fall, no bladder trouble | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="back_pain", back.injury="yes", back.bladder="no", pain.severity=6 |
| gradual headache, mild | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="headache", pain.onset="gradual", pain.severity=4 |
| sudden headache, mild | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="headache", pain.onset="sudden", pain.severity=5 |
| mild stomach pain | emergency.screen=["none"], allergy.any="no", drug.current_any="no", cc.main="abdominal_pain", abd.bowel="constipation", pain.severity=3 |
| allergy and medicines answered | emergency.screen=["none"], allergy.any="yes", drug.current_any="yes", allergy.list="penicillin", drug.current_list="metformin" |
| only a non-critical question skipped | emergency.screen=["none"], allergy.any="no", drug.current_any="no", psh.any=skipped |
| long-term illness only | emergency.screen=["none"], allergy.any="no", drug.current_any="no", pmh.conditions=["diabetes","hypertension"] |
| nothing answered yet | (nothing answered) |
| emergency screen answered "none" and nothing else | emergency.screen=["none"] |

## Sign-off log

| Date | Reviewer | Role | Decision | Comments and changes made |
|---|---|---|---|---|
| | | | | |
