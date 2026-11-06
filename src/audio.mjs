// 语音服务：硅基流动 TTS（CosyVoice2 情感合成）/ ASR（SenseVoice 识别）转发
// Key 来自 .env 的 SILICONFLOW_API_KEY；费用自动由代金券/余额抵扣
import {err} from './llm.mjs';

const BASE = 'https://api.siliconflow.cn/v1';
// CosyVoice2 语种覆盖：中/英/日/韩（法/西等由前端回退浏览器合成）
const TTS_LANGS = new Set(['中文', '英文', '英语', '日文', '韩文']);
// 预置音色：医生沉稳男声；患者按性别分配；译员温柔女声
const VOICES = {
  doctor: 'FunAudioLLM/CosyVoice2-0.5B:alex',
  patient_f: 'FunAudioLLM/CosyVoice2-0.5B:anna',
  patient_m: 'FunAudioLLM/CosyVoice2-0.5B:benjamin',
  interpreter: 'FunAudioLLM/CosyVoice2-0.5B:claire',
};

function requireKey(env) {
  if (!env.SILICONFLOW_API_KEY) throw err('语音服务未配置：请在 .env 中填写 SILICONFLOW_API_KEY（硅基流动）。', 503);
  return env.SILICONFLOW_API_KEY;
}

// 文本转语音：返回 mp3 Buffer
async function tts(env, {text, lang, role, gender}) {
  const key = requireKey(env);
  const langName = lang === '英语' ? '英文' : lang;
  if (!TTS_LANGS.has(langName)) throw err(`CosyVoice2 暂不支持${lang || '该语言'}，前端将回退浏览器合成。`, 400);
  if (!text || !String(text).trim()) throw err('朗读内容为空。');
  const voice = role === 'patient'
    ? (gender === '男' ? VOICES.patient_m : VOICES.patient_f)
    : (VOICES[role] || VOICES.interpreter);
  let r;
  try {
    r = await fetch(BASE + '/audio/speech', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
      body: JSON.stringify({
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        input: String(text).slice(0, 2000),
        voice,
        response_format: 'mp3',
        stream: false,
        speed: role === 'doctor' ? 0.95 : 1, // 医生沉稳稍慢，与前端韵律策略一致
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw err('语音合成服务暂时未响应，请稍后重试。', 502);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw err('语音合成失败（' + r.status + '）' + (t ? '：' + t.slice(0, 200) : ''), 502);
  }
  return Buffer.from(await r.arrayBuffer());
}

// 语音转文字：formData 中的 file 转发 SenseVoice
async function asr(env, formData) {
  const key = requireKey(env);
  const file = formData.get('file');
  if (!file || typeof file === 'string') throw err('缺少录音文件。');
  const fd = new FormData();
  fd.append('file', file, file.name || 'audio.webm');
  fd.append('model', 'FunAudioLLM/SenseVoiceSmall');
  let r;
  try {
    r = await fetch(BASE + '/audio/transcriptions', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + key},
      body: fd,
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw err('语音识别服务暂时未响应，请稍后重试。', 502);
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw err('语音识别失败（' + r.status + '）' + (t ? '：' + t.slice(0, 200) : ''), 502);
  }
  const data = await r.json();
  // SenseVoice 会输出情感符号（如 😊），剥离后返回纯文本
  return String(data.text || '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
}

export {tts, asr};
