// Emergency words, version 1: the words and phrases that raise an alert when the patient types or says them in their own words
// (the reason for the visit and every free-text answer). The structured red-flag rules (redflag-rules.v1.js) only see the answers to
// specific questions; this list is the second net for an emergency nobody wrote a rule for.
//
// STATUS: DRAFT. Written by the developers. It has NOT been reviewed by a clinician or a native speaker of Hindi or Marathi.
// Please check for missing words, wrong words, and phrases likely to cause false alarms (docs/redflag-rules-review.md lists them).
//
// How a term is matched (server/src/alerts/textscan.js): the text is lower-cased and split into words. A term is one or more words that must
// appear next to each other. A term ending in * matches any word that starts that way ("bleed*" matches "bleeding"). Words in Roman letters
// (Hindi or Marathi typed in English letters) are included because many patients type that way.
//
// Levels: emergency (shown first to staff) and attention. For attention terms, a negating word within three words ("no bleeding",
// "bleeding nahi") means the term is ignored. Emergency terms ignore negation on purpose: it is safer to over-alert than to miss one.

export const WORDS_VERSION = 1;
export const WORDS_STATUS = 'draft: awaiting clinician and language review';

export const NEGATORS = ['no', 'not', 'never', 'without', 'nil', 'denies', 'नहीं', 'नही', 'नाही', 'न', 'nahi', 'nahin', 'nai', 'nahee'];

export const CATEGORIES = [
  {
    id: 'UNCONSCIOUS', level: 'emergency',
    reason: ['Words suggest the patient is unconscious or not responding (automatic word match, please check)', 'शब्दों से लगता है कि मरीज़ बेहोश है या जवाब नहीं दे रहा (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांवरून रुग्ण बेशुद्ध आहे किंवा प्रतिसाद देत नाही असे वाटते (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['unconscious', 'unresponsive', 'not responding', 'not waking', 'collapsed', 'बेहोश*', 'होश नहीं', 'बेसुध*', 'behosh*', 'बेशुद्ध*', 'शुद्धीवर नाही', 'शुद्ध हरपली', 'beshuddh*'],
  },
  {
    id: 'FAINTING', level: 'attention',
    reason: ['Words mention fainting or blacking out (automatic word match, please check)', 'शब्दों में बेहोश होने या आँखों के आगे अँधेरा छाने का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये चक्कर येऊन पडणे किंवा अंधारी येण्याचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['faint*', 'passed out', 'blacked out', 'blackout', 'चक्कर आकर गिर', 'अँधेरा छा', 'अंधारी'],
  },
  {
    id: 'SEIZURE', level: 'emergency',
    reason: ['Words mention a seizure or convulsions (automatic word match, please check)', 'शब्दों में दौरे या झटकों का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये झटके किंवा आकडीचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['seizure*', 'convulsion*', 'convulsing', 'shaking uncontrollably', 'foaming', 'मिर्गी का दौरा', 'दौरा पड़*', 'दौरे पड़*', 'झटके आ*', 'daura pad*', 'आकडी*', 'झटके येत*', 'aakdi*'],
  },
  {
    id: 'BREATHING_STOPPED', level: 'emergency',
    reason: ['Words say the patient cannot breathe or is choking (automatic word match, please check)', 'शब्दों के अनुसार मरीज़ साँस नहीं ले पा रहा या दम घुट रहा है (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांनुसार रुग्णाला श्वास घेता येत नाही किंवा दम घुटतोय (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['cant breathe', 'cannot breathe', 'unable to breathe', 'not able to breathe', 'stopped breathing', 'gasping', 'choking', 'साँस नहीं', 'सांस नहीं', 'सांस रुक*', 'दम घुट*', 'saans nahi', 'dam ghut*', 'श्वास घेता येत नाही', 'श्वास थांबला', 'दम घुटत*'],
  },
  {
    id: 'BREATHING_DIFFICULT', level: 'attention',
    reason: ['Words mention difficulty breathing (automatic word match, please check)', 'शब्दों में साँस लेने में तकलीफ़ का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये श्वास घेण्यास त्रासाचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['difficulty breathing', 'trouble breathing', 'short of breath', 'shortness of breath', 'breathless*', 'साँस फूल*', 'सांस फूल*', 'सांस लेने में तकलीफ', 'साँस लेने में तकलीफ', 'दम लागत*', 'श्वास घेण्यास त्रास'],
  },
  {
    id: 'BLEEDING_HEAVY', level: 'emergency',
    reason: ['Words mention heavy bleeding or vomiting blood (automatic word match, please check)', 'शब्दों में बहुत खून बहने या खून की उल्टी का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये खूप रक्तस्राव किंवा रक्ताच्या उलटीचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['heavy bleeding', 'bleeding heavily', 'bleeding a lot', 'wont stop bleeding', 'bleeding wont stop', 'vomiting blood', 'vomited blood', 'blood vomit', 'खून की उल्टी', 'बहुत खून', 'खून बह रहा', 'खून नहीं रुक', 'रक्ताची उलटी', 'खूप रक्त', 'रक्तस्राव थांबत नाही', 'रक्त वाहत*'],
  },
  {
    id: 'BLEEDING', level: 'attention',
    reason: ['Words mention bleeding (automatic word match, please check)', 'शब्दों में खून बहने का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये रक्तस्रावाचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['bleeding', 'bleeds', 'खून आ*', 'खून निकल*', 'रक्तस्राव*', 'रक्त येत*', 'khoon aa*'],
  },
  {
    id: 'POISON_OVERDOSE', level: 'emergency',
    reason: ['Words mention poison, an overdose or a snake bite (automatic word match, please check)', 'शब्दों में ज़हर, ओवरडोज़ या साँप के काटने का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये विष, ओव्हरडोस किंवा सर्पदंशाचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['poison*', 'overdose*', 'took too many', 'drank phenyl', 'pesticide', 'kerosene', 'snake bite', 'snakebite', 'bitten by snake', 'जहर*', 'ज़हर*', 'साँप ने काट*', 'सांप ने काट*', 'zeher', 'विष*', 'विषबाधा', 'साप चावला', 'साप चावल*'],
  },
  {
    id: 'SELF_HARM', level: 'emergency',
    reason: ['Words mention suicide or hurting oneself (automatic word match, please check)', 'शब्दों में आत्महत्या या खुद को नुकसान पहुँचाने का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये आत्महत्या किंवा स्वतःला इजा करण्याचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['suicide', 'suicidal', 'kill myself', 'end my life', 'want to die', 'wants to die', 'hurt myself', 'harm myself', 'cut myself', 'आत्महत्या*', 'मरना चाहत*', 'जान दे*', 'खुद को मार*', 'aatmahatya*', 'khudkushi*', 'मरावेसे वाटते', 'जीव द्यावा', 'स्वतःला मार*'],
  },
  {
    id: 'STROKE_SIGNS', level: 'emergency',
    reason: ['Words mention signs that may be a stroke (automatic word match, please check)', 'शब्दों में स्ट्रोक जैसे लक्षणों का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये स्ट्रोकसारख्या लक्षणांचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['face drooping', 'drooping face', 'slurred speech', 'cant speak', 'unable to speak', 'one side weak*', 'half body', 'paralysis', 'paralysed', 'paralyzed', 'sudden weakness', 'मुंह टेढ़ा', 'मुँह टेढ़ा', 'बोल नहीं पा*', 'लकवा*', 'पैरालिसिस', 'आधा शरीर', 'तोंड वाकडे', 'बोलता येत नाही', 'अर्धांग*', 'पक्षाघात'],
  },
  {
    id: 'ALLERGY_SEVERE', level: 'emergency',
    reason: ['Words mention a severe allergic reaction (automatic word match, please check)', 'शब्दों में गंभीर एलर्जी का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये तीव्र अ‍ॅलर्जीचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['anaphylaxis', 'throat closing', 'throat swelling', 'swelling of face', 'swollen face', 'swollen lips', 'tongue swelling', 'गला बंद', 'गले में सूजन', 'चेहरे पर सूजन', 'होंठ सूज*', 'घसा बंद', 'चेहऱ्यावर सूज', 'ओठ सुज*'],
  },
  {
    id: 'CHEST_PAIN', level: 'attention',
    reason: ['Words mention chest pain or a heart attack (automatic word match, please check)', 'शब्दों में सीने के दर्द या दिल के दौरे का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये छातीतील दुखणे किंवा हृदयविकाराचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['chest pain', 'chest tightness', 'pain in chest', 'pain in my chest', 'heart attack', 'सीने में दर्द', 'छाती में दर्द', 'सीने में जकड़न', 'दिल का दौरा', 'छातीत दुखत*', 'छातीत वेदना', 'हृदयविकाराचा झटका'],
  },
  {
    id: 'INJURY_ACCIDENT', level: 'attention',
    reason: ['Words mention an accident, a head injury or a burn (automatic word match, please check)', 'शब्दों में दुर्घटना, सिर की चोट या जलने का ज़िक्र (स्वचालित शब्द-मिलान, कृपया जाँचें)', 'शब्दांमध्ये अपघात, डोक्याला मार किंवा भाजण्याचा उल्लेख (स्वयंचलित शब्द-जुळवणी, कृपया तपासा)'],
    terms: ['accident*', 'head injury', 'hit my head', 'fell from', 'burns', 'burnt', 'दुर्घटना*', 'एक्सीडेंट', 'जल गया', 'जल गई', 'सिर में चोट', 'अपघात*', 'भाजले', 'भाजला', 'डोक्याला मार'],
  },
];
