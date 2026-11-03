// Records one spoken answer from the microphone and returns it as 16 kHz mono WAV, the format the speech service takes (server/src/speech).
// Recording stops by itself after the patient has spoken and gone quiet, or at the longest time allowed, so the microphone is never left open.

export const TARGET_RATE = 16_000;

// Mean-averages samples down to a lower rate (a simple low-pass, enough for speech recognition).
export function downsample(samples, fromRate, toRate = TARGET_RATE) {
  if (toRate >= fromRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio), to = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    out[i] = sum / Math.max(1, to - from);
  }
  return out;
}

// 16-bit PCM WAV, mono.
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export const rms = (chunk) => {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / Math.max(1, chunk.length));
};

// Decides, chunk by chunk, when the patient has finished: speech means a level well above the room's own noise (measured from the first
// moments), and the end is a stretch of quiet after speech. Pure, so it can be tested without a microphone.
export function createEndpointer({ sampleRate, silenceMs = 1300, startTimeoutMs = 6000, maxMs = 12_000, calibrateMs = 300, minLevel = 0.015, ratio = 3 } = {}) {
  let elapsed = 0, floor = 0, calibrated = 0, spoke = false, quiet = 0;
  return {
    // Returns null while recording should go on, else 'end' (spoke and went quiet), 'timeout' (the longest time) or 'nothing' (never spoke).
    push(chunk) {
      const ms = (chunk.length / sampleRate) * 1000;
      elapsed += ms;
      const level = rms(chunk);
      if (calibrated < calibrateMs) { floor = Math.max(floor, level); calibrated += ms; return null; }
      const loud = level > Math.max(minLevel, floor * ratio);
      if (loud) { spoke = true; quiet = 0; } else if (spoke) quiet += ms;
      if (spoke && quiet >= silenceMs) return 'end';
      if (!spoke && elapsed >= startTimeoutMs) return 'nothing';
      if (elapsed >= maxMs) return spoke ? 'timeout' : 'nothing';
      return null;
    },
    get spoke() { return spoke; },
  };
}

const fail = (code) => Object.assign(new Error(code), { code });

// Rejects with Error('denied' | 'no-mic' | 'no-speech' | 'error'), the same codes the browser recognizer uses.
export async function recordUtterance({ env = globalThis, ...opts } = {}) {
  const Ctx = env.AudioContext ?? env.webkitAudioContext;
  if (!env.navigator?.mediaDevices?.getUserMedia || !Ctx) throw fail('error');
  let stream;
  try {
    stream = await env.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw fail(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : err?.name === 'NotFoundError' ? 'no-mic' : 'error');
  }
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const end = createEndpointer({ sampleRate: ctx.sampleRate, ...opts });
  const chunks = [];
  const finish = (result) => {
    node.onaudioprocess = null;
    try { source.disconnect(); node.disconnect(); } catch { /* already disconnected */ }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close?.();
    return result;
  };
  return new Promise((resolve, reject) => {
    node.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(chunk);
      const verdict = end.push(chunk);
      if (!verdict) return;
      finish();
      if (verdict === 'nothing') return reject(fail('no-speech'));
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      resolve(encodeWav(downsample(all, ctx.sampleRate), TARGET_RATE));
    };
    source.connect(node);
    node.connect(ctx.destination); // a processor node only runs while connected
  });
}
