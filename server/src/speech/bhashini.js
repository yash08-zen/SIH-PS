// Speech recognition and speech output through Bhashini (the national language platform, which serves the AI4Bharat models), as the SIH 26047
// statement names. A pipeline call needs two steps: ask the ULCA service which model and which inference key to use for a task and language
// (cached, it changes rarely), then send the audio or text to the inference endpoint it names. The request shapes follow Bhashini's documented
// pipeline API; the endpoint addresses are settings, so a hospital-hosted deployment can point them elsewhere.
export const BHASHINI_CONFIG_URL = 'https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline';
export const BHASHINI_INFERENCE_URL = 'https://dhruva-api.bhashini.gov.in/services/inference/pipeline';
const DEFAULT_PIPELINE = '64392f96daac500b55c543cd';
const LANG_CODE = { en: 'en', hi: 'hi', mr: 'mr' };
const CACHE_MS = 60 * 60 * 1000;

export function createBhashiniSpeech({ userId, apiKey, fetchImpl = fetch, configUrl = BHASHINI_CONFIG_URL, inferenceUrl = BHASHINI_INFERENCE_URL, pipelineId = DEFAULT_PIPELINE, timeoutMs = 20_000, now = Date.now }) {
  if (!userId || !apiKey) throw new Error('BHASHINI_USER_ID and BHASHINI_API_KEY are required when SPEECH_PROVIDER=bhashini');
  const cache = new Map();

  async function post(url, headers, body) {
    const res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Bhashini answered ${res.status}`);
    return res.json();
  }

  // The model (serviceId), the inference address and its key for one task and language.
  async function pipeline(taskType, lang) {
    const code = LANG_CODE[lang] ?? 'en';
    const key = `${taskType}:${code}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const conf = await post(configUrl, { userID: userId, ulcaApiKey: apiKey }, {
      pipelineTasks: [{ taskType, config: { language: { sourceLanguage: code } } }], pipelineRequestConfig: { pipelineId },
    });
    const serviceId = conf.pipelineResponseConfig?.[0]?.config?.[0]?.serviceId;
    const auth = conf.pipelineInferenceAPIEndPoint?.inferenceApiKey;
    if (!serviceId || !auth?.value) throw new Error(`Bhashini has no ${taskType} model for ${code}`);
    const value = { code, serviceId, url: conf.pipelineInferenceAPIEndPoint.callbackUrl || inferenceUrl, header: { [auth.name || 'Authorization']: auth.value } };
    cache.set(key, { at: now(), value });
    return value;
  }

  return {
    name: 'bhashini',
    // WAV audio (16 kHz, mono) -> the words spoken.
    async asr(wav, lang) {
      const p = await pipeline('asr', lang);
      const out = await post(p.url, p.header, {
        pipelineTasks: [{ taskType: 'asr', config: { language: { sourceLanguage: p.code }, serviceId: p.serviceId, audioFormat: 'wav', samplingRate: 16000 } }],
        inputData: { audio: [{ audioContent: Buffer.from(wav).toString('base64') }] },
      });
      return String(out.pipelineResponse?.[0]?.output?.[0]?.source ?? '').trim();
    },
    // Text -> WAV audio.
    async tts(text, lang) {
      const p = await pipeline('tts', lang);
      const out = await post(p.url, p.header, {
        pipelineTasks: [{ taskType: 'tts', config: { language: { sourceLanguage: p.code }, serviceId: p.serviceId, gender: 'female', samplingRate: 8000 } }],
        inputData: { input: [{ source: text }] },
      });
      const audio = out.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
      if (!audio) throw new Error('Bhashini returned no audio');
      return Buffer.from(audio, 'base64');
    },
  };
}

// null when speech stays in the browser (the default), or when the credentials are missing.
export function speechFromEnv(env = process.env, log = console) {
  if ((env.SPEECH_PROVIDER ?? 'browser') !== 'bhashini') return null;
  if (!env.BHASHINI_USER_ID || !env.BHASHINI_API_KEY) { log.warn('SPEECH_PROVIDER=bhashini but BHASHINI_USER_ID or BHASHINI_API_KEY is empty: speech stays in the browser'); return null; }
  return createBhashiniSpeech({ userId: env.BHASHINI_USER_ID, apiKey: env.BHASHINI_API_KEY, configUrl: env.BHASHINI_CONFIG_URL || undefined, inferenceUrl: env.BHASHINI_INFERENCE_URL || undefined });
}
