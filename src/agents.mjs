// 智能体内核：从 project/agents/*.py 1:1 移植五智能体 prompt 与编排逻辑
// 移植时修复的已知问题：① 终止判断改为"结尾匹配"（原精确匹配导致 TERMINATE 污染译例库）
// ② check_terminate 容错（非法回复默认 CONTINUE）③ 硬编码路径与 pyautogen 依赖移除
// 支持参数化：医生语言/科室、患者国家/语言/症状/既往症/文化禁忌/宗教/饮食/性格，量规可编辑
import {callModel, parseJSON, err} from './llm.mjs';
import {allDims, perfectScore, getPersona, getLevelAnchors} from './rubric.mjs';
import {getScenario} from './scenarios.mjs';
import * as msd from './msd.mjs';
import {COUNTRIES, findCountry, PERSONALITIES, LITERACIES, RELIGIONS, DIETS, TABOOS} from './pools.mjs';

// ─── 终止判断（修复版：正文 + 结尾 TERMINATE 均识别）───
function isTerminate(text) {
  if (!text) return false;
  const t = String(text).trim();
  return t.toUpperCase() === 'TERMINATE' || t.toUpperCase().endsWith('TERMINATE');
}
function stripTerminate(text) {
  return String(text || '').replace(/\s*TERMINATE\s*$/i, '').trim();
}
function splitList(text) {
  return String(text || '').split(/[,，、;；\n]+/).map(s => s.trim()).filter(Boolean);
}

// ─── 语言方向双保险：按目标语言做中文字符占比校验，不符则带纠正提示重试一次 ───
// （治"译员把方向译反/混语言"：中文译文 CJK 占比应≥30%，拉丁语言译文 CJK 占比应≤5%；
//   日文/韩文因汉字词占比天然波动，不做占比校验）
function cjkRatio(s) {
  const t = String(s || '').replace(/\s/g, '');
  if (!t.length) return 0;
  return (t.match(/[\u4e00-\u9fff]/g) || []).length / t.length;
}
function langMismatch(text, lang) {
  if (lang === '中文') return cjkRatio(text) < 0.3;
  if (lang === '日文' || lang === '韩文') return false;
  return cjkRatio(text) > 0.05;
}
async function callWithLangCheck(env, system, prompt, expectedLang, opts, signal) {
  const r = (await callModel(env, [
    {role: 'system', content: system},
    {role: 'user', content: prompt},
  ], {...opts, signal})).message;
  if (!langMismatch(r, expectedLang)) return r;
  return (await callModel(env, [
    {role: 'system', content: system},
    {role: 'user', content: `${prompt}\n\n纠正：你上一次的输出语言方向错误。本次输出必须完全使用${expectedLang}，只输出对话或译文本身，不要混用其他语言。`},
  ], {...opts, signal})).message;
}

// ─── 患者人设生成（参数面板显式值优先，缺失项由 LLM/随机补齐）───
async function makePatientInfo(env, {scenario, params}, signal) {
  params = params || {};
  const countryName = params.country || COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)].name;
  const countryInfo = findCountry(countryName);
  const language = params.language || countryInfo.language;
  const gender = params.gender || (Math.random() < 0.5 ? '女' : '男');
  const namePool = countryInfo.names[gender === '男' ? 'male' : 'female'];
  const name = (params.name || '').trim() || namePool[Math.floor(Math.random() * namePool.length)];
  const age = Number(params.age) || 20 + Math.floor(Math.random() * 41);
  const personality = params.personality || PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
  const literacy = params.healthLiteracy || '一般';
  const religion = params.religion || '无特定信仰';
  const dietary = params.diet || '无特殊要求';
  const taboos = (params.taboos || '').trim() || '无特殊禁忌';
  const disease = params.disease || '肾结石';

  // 症状/既往症：用户填了就用用户的；只对缺失部分调 LLM 生成
  const userSymptoms = splitList(params.symptoms);
  const userHistory = (params.medicalHistory || '').trim();
  let gen = {symptoms: [], medical_history: ''};
  if (!userSymptoms.length || !userHistory) {
    try {
      const r = await callModel(env, [
        {role: 'system', content: '你是一名博学的医生，了解各种疾病的基本症状和可能相关的病史。请保证输出的症状和可能病史均使用中文。输出严格按照json格式（字段：symptoms 字符串列表，medical_history 字符串），不要添加任何额外的文本。'},
        {role: 'user', content: `已知患者基本信息：姓名:${name}，年龄:${age}岁，性别:${gender}，来自${countryName}，性格:${personality}，健康素养:${literacy}，宗教信仰:${religion}，饮食习惯:${dietary}，文化禁忌:${taboos}。\n你的任务是根据选定的疾病类型【${disease}】生成${userSymptoms.length ? '相关病史（症状用户已提供，勿输出）' : '基本症状'}${userSymptoms.length || !userHistory ? '和' : ''}${userHistory ? '' : '可能相关的病史'}。症状和病史应与疾病类型相关联，并且要符合医学常识。`},
      ], {json: true, max: 600, tag: 'info', signal});
      gen = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
      if (!Array.isArray(gen.symptoms)) gen.symptoms = [];
    } catch (e) {
      if (signal?.aborted) throw e;
      gen = {symptoms: [], medical_history: ''};
    }
  }

  return {
    name, gender, age, language, country: countryName,
    cultural_background: countryName,
    personality, health_literacy: literacy, religion, dietary, taboos,
    disease_info: {
      disease_type: disease,
      symptoms: userSymptoms.length ? userSymptoms : gen.symptoms.slice(0, 6),
      medical_history: userHistory || (typeof gen.medical_history === 'string' && gen.medical_history.trim()) || '无特殊病史',
    },
  };
}

// ─── 医生/前台智能体（移植 MedicalProfessionalAgent，场景化角色人设）───
function doctorSystem(state) {
  const sc = getScenario(state.settings.scenario);
  const dl = state.settings.doctorLanguage || '中文';
  const roleText = sc.doctorRoleText
    .replace('{dept}', state.doctor.specialization)
    .replace('{name}', state.doctor.name);
  // 知识库覆盖级别的常驻约束：相关条目不能当疾病专条用
  const kbNote = !sc.msdSearch ? ''
    : state.msdLevel === 'related'
      ? '\n知识库未收录该疾病的专门条目。若提供了相关条目，那只是症状或检查资料，只可作背景参考，不得作为该疾病的诊断或治疗依据，也不要声称引用了诊疗手册。'
      : state.msdLevel === 'none'
        ? '\n知识库未收录该疾病。请基于通用医学知识回答，不要声称引用了诊疗手册，也不要编造手册内容。'
        : '';
  return `${roleText}
用患者易于理解的话语表达方式进行沟通。
请你表现得像一位真实的医务人员，直接输出你的回答或询问，而不要输出其它内容（如语气，下一步动作补充等）。
你的输出中不应该有任何特殊符号如括号，破折号，冒号等。
话轮管理（硬性要求）：你每次发言只允许做一件事——要么只提出一个问题，要么只传达一条信息或医嘱。即使有多个问题或事项，也必须分多轮逐一提出，禁止在一次输出中连续追问多个问题。
当你想终止对话时，请直接输出 'TERMINATE'。
${sc.terminateNote}
对话推进要求：像真实问诊一样层层深入——先消化患者已提供的陈述并从中提取关键信息（症状、部位、时长、诱因、既往史），下一步追问应建立在这些信息之上；不要重复询问患者已经回答过的内容，也不要跳过信息缺口直接给诊断。${kbNote}
请始终使用${dl}表达。`;
}

function doctorView(state) {
  // 医生视角：自己的原话 + 口译员译回的（医生语言）译文
  return state.log.filter(e => e.role === 'doctor' || (e.role === 'interpreter' && e.dir === 'to_doctor'))
    .map(e => ({role: e.role, content: e.content}));
}

async function doctorTurn(env, state, signal) {
  const scenario = getScenario(state.settings.scenario);
  const view = doctorView(state);
  const convText = JSON.stringify(view, null, 0);

  // 首轮自动注入 MSD 专业版资料（professional version → 医生），并留存供剧本讲解导出
  // 预约挂号等非诊疗场景关闭 MSD 检索；level 区分疾病专条 / 相关条目 / 未收录
  if (scenario.msdSearch && view.length <= 1) {
    const found = msd.search(state.patientInfo.disease_info.disease_type, 2);
    state.msdRefs = found.hits;
    state.msdLevel = found.level;
  }
  const refText = scenario.msdSearch && view.length <= 1 && state.msdRefs?.length
    ? `\n以下是来自诊疗手册（专业版）的参考资料，供诊断与解释时参考：\n${JSON.stringify(state.msdRefs)}\n`
    : '';

  const prompt = `你和口译员已有下面的对话：
${convText}
${refText}
请你根据上述对话内容，继续以${state.doctor.roleLabel}的身份回答口译员。
${view.length <= 1 ? scenario.doctorOpening : ''}
${scenario.id === 'consult' || scenario.id === 'followup' ? '给出治疗方案时请你尽可能详细地描述你的诊断和治疗建议，包括可能的药物、剂量、使用方法等。' : ''}
你应该始终使用第一人称直接跟患者对话，不要输出括号中的说明或"根据患者的症状"分析等内容。
必须确保输出的对话都是能够在现实${scenario.name}场景中口头表述的。
如果你认为对话可以结束，直接回复"TERMINATE"，否则你的输出中不应该包含任何"TERMINATE"。`;

  const dl = state.settings.doctorLanguage || '中文';
  let reply = await callWithLangCheck(env, doctorSystem(state), prompt, dl,
    {max: 900, temperature: 0.5, tag: state.settings.scenario === 'followup' ? 'doctor_follow' : 'doctor', signal}, signal);

  // 保留 SQL: 文本约定（最多一轮检索回灌）
  const m = /SQL:\s*(.+)/.exec(reply);
  if (m) {
    const kw = (/%\s*([^%']+?)\s*%/.exec(m[1]) || [null, state.patientInfo.disease_info.disease_type])[1];
    const found = msd.search(String(kw || state.patientInfo.disease_info.disease_type), 3);
    reply = await callWithLangCheck(env, doctorSystem(state),
      `${prompt}\n\n你刚才请求查询知识库「${kw}」，检索结果：\n${JSON.stringify(found.hits)}\n\n请基于检索结果生成医生回复。`, dl,
      {max: 900, temperature: 0.5, tag: 'doctor', signal}, signal);
    state.sqlQueries.push({keyword: kw, hits: found.hits.length, level: found.level});
  }

  const terminated = isTerminate(reply);
  const content = stripTerminate(reply);
  state.log.push({role: 'doctor', content});
  return {role: 'doctor', content, terminated};
}

// ─── 患者智能体（移植 PatientAgent + 新参数注入 + MSD 通俗版资料）───
function patientView(state) {
  // 模式2：医生（用户）直接用患者语言发言，患者能看到医生的话
  return state.log.filter(e => e.role === 'patient'
    || (e.role === 'interpreter' && e.dir === 'to_patient')
    || (state.settings.mode === 'm2' && e.role === 'doctor'));
}

async function patientTurn(env, state, signal) {
  const info = state.patientInfo;
  const view = patientView(state);
  const convText = JSON.stringify(view, null, 0);

  // 患者侧知识：MSD consumer version 通俗版（同一病种，不同版本对照）
  let consumerText = '';
  if (view.length <= 1) {
    const found = msd.search(info.disease_info.disease_type, 1);
    // 只有疾病专条才能当作「这个病的科普」；相关条目不能冒充
    const src = found.level === 'disease' && found.hits[0]
      ? `${found.hits[0].title}：${found.hits[0].content}`
      : `${info.disease_info.disease_type}（常见疾病科普）`;
    const plain = await msd.consumerize(env, info.disease_info.disease_type, src, signal);
    state.consumerPlain = plain;
    consumerText = `\n你事先在网上（患者版健康科普，内容通俗）查过这个病：「${plain}」\n`;
  }

  const belief = info.religion && info.religion !== '无特定信仰' ? `你的宗教信仰是${info.religion}。` : '';
  const taboo = info.taboos && info.taboos !== '无特殊禁忌' ? `你的文化禁忌：${info.taboos}。当医生的安排与你的禁忌或信仰可能冲突时，你可以自然地提出顾虑或提问。` : '';
  const diet = info.dietary && info.dietary !== '无特殊要求' ? `你的饮食习惯：${info.dietary}。` : '';

  const system = `你是一名叫 ${info.name} 的患者，来自${info.country}。
你的母语是${info.language}。
你的症状是：${info.disease_info.symptoms.join('、')}。
你的病史是：${info.disease_info.medical_history}。
${belief}${diet}${taboo}
你的性格偏向：${info.personality}；你的健康素养：${info.health_literacy}。
你目前感觉很不舒服，寻求医疗帮助。
${getScenario(state.settings.scenario).patientNote}
当被问及症状时，请使用你的母语口语化地描述。
请你表现像一位真实的患者，描述你的症状和感受。
请直接输出您的对话，而不要输出其它符号或补充说明等
请你确保你所有的输出都使用${info.language}。
请确保你的输出不要过长，便于口译员为你传达意思。
如果您对医生有多个问题，在一次输出中只提出一个问题，避免同时提出多个问题。
在医生给出诊断和治疗方案后，你应该对任何不了解的医学专业问题可以提出疑问。
只有在医生给出诊断和治疗方案，并解答了你的疑问后，你才能终止对话。
如果你没有进一步的疑问，请你说明没有疑问并感谢医生，才能结束与医生的对话。
当你想要终止对话时，请直接输出 'TERMINATE' 来结束对话。
你的输出中不应该有任何特殊符号如括号，破折号，冒号等。`;

  const prompt = `你和医生已有下面的对话：
${convText}
${consumerText}
请你根据上述对话内容，继续以患者的身份回答口译员，如果没有对话内容，请你先描述你的症状，如果你认为对话可以结束，直接回复"TERMINATE"。`;

  const reply = await callWithLangCheck(env, system, prompt, info.language,
    {max: 500, temperature: 0.6, tag: 'patient', signal}, signal);

  const terminated = isTerminate(reply);
  const content = stripTerminate(reply);
  state.log.push({role: 'patient', content});
  return {role: 'patient', content, terminated};
}

// ─── 口译员智能体（移植 InterpreterAgent + 设计稿双译员人设 + 语言可配置）───
const FEWSHOT = `original: 您好，我是张医生。请问您叫什么名字？请先坐下休息一下。; translated: Hello, I'm Dr. Zhang. May I know your name? Please have a seat and rest for a while.
original: I have been having blood in my urine without pain for a week, and I need to go to the toilet very often. ; translated: 患者一周以来出现无痛性血尿，伴有尿频症状。`;

function interpreterSystem(state) {
  const p = getPersona(state.settings.interpreterType);
  const pl = state.patientInfo.language;
  const dl = state.settings.doctorLanguage || '中文';
  const base = `你是一名具有优秀的中英文语言能力和医学知识结构的专业医疗口译员，在医院内部工作，名为 ${state.interpreter.name}，你精通${pl}和${dl}两门语言。
你的任务是在患者（使用${pl}）和医生（使用${dl}）之间提供准确、流利、自然的双向口译。
你需要将患者的非专业语言描述准确转换为医生所需的医学语言，同时将医生的专业用语转换为患者易于理解的语言。
你掌握丰富的沟通技巧，合理运用直接翻译、合并、拆分、总结式翻译等技巧，但不扭曲和增减意思。
能够注意到医患双方的情绪，缓解因语言障碍或文化差异产生的误解，促进双方的顺畅交流。
请准确传达信息，也要兼顾信息传达的效率，不要添加个人的医疗意见。
确保以第一人称翻译患者或医生的语言。翻译中不应该出现说话者说明，例如"the doctor says"，只需直接翻译内容。
你永远不应该回答患者或医生的问题，只需翻译双方的对话内容。
不要添加任何其余内容（如注意、分析、语气描述、话语发出者等）。
你不能结束对话，所以请你不要在输出中包含'TERMINATE'字样。`;
  return base + '\n' + p.personaNote.map(s => '· ' + s).join('\n');
}

async function interpreterTurn(env, state, signal, flag) {
  const view = state.log.filter(e => e.role === 'interpreter' || e.role === 'doctor' || e.role === 'patient')
    .map(e => e.dir ? {role: e.dir, content: e.content} : {role: 'from_' + e.role, content: e.content});
  const convText = JSON.stringify(view, null, 0);
  const pl = state.patientInfo.language;
  const dl = state.settings.doctorLanguage || '中文';

  // 仅在首次向患者传译时，先介绍口译员身份（设计稿：向首次使用医疗口译员的患者介绍工作方式）
  const firstToPatient = flag === 1 && !view.some(e => e.role === 'to_patient');
  const introNote = firstToPatient
    ? `\n这是你首次接触该患者：请先用一句${pl}简短介绍你自己的口译员身份（例如你会把${dl}医生的话翻译给他/她），紧跟着翻译医生的原话。除这一句身份介绍外不要添加任何其它内容。`
    : '';

  const fewshot = pl === '英文' && dl === '中文' ? `下面是口译示例：\n${FEWSHOT}\n` : '';

  const prompt = `你、患者和医生已有下面的对话：
${convText}
其中'from_patient'表示患者的原话，'to_doctor'表示你翻译给医生的话（由from_patient翻译），'from_doctor'表示医生的原话，'to_patient'表示你翻译给患者的话（由from_doctor翻译）。
请你根据上述对话内容，继续以口译员的身份翻译双方的对话并传递给对方。
在翻译'from_patient'内容时，请使用${dl}，并确保翻译后的内容准确无误并具有医学专业性。
在翻译'from_doctor'内容时，请使用${pl}，并确保翻译后的内容易于患者理解。
语言方向硬性要求：from_patient 的译文只能使用${dl}，from_doctor 的译文只能使用${pl}，严禁译反方向或混用两种语言。
${fewshot}请你保证翻译内容始终使用第一人称完整地传达双方的意图和情感。
你的输出总是最后一条对话的翻译，而不要添加任何额外的符号或分析。${introNote}`;

  const reply = await callWithLangCheck(env, interpreterSystem(state), prompt,
    flag === 1 ? pl : dl, // to_patient 用患者语言，to_doctor 用医生语言
    {max: 500, temperature: 0.3, tag: 'interpreter', signal}, signal);

  const content = reply.trim();
  const dir = flag === 1 ? 'to_patient' : 'to_doctor';
  state.log.push({role: 'interpreter', dir, content});
  return {role: 'interpreter', dir, content};
}

// 评判调用：超长或临时故障时降级重试一次（压缩输出要求）；仍失败返回 null，
// 由 judgeTurn 记 0 分继续演练，避免单句评分把整场会话打断。
async function callJudgeResilient(env, system, prompt, dims, original, translated, personaId, signal) {
  try {
    return await callModel(env, [
      {role: 'system', content: system},
      {role: 'user', content: prompt},
    ], {json: true, max: 1500, temperature: 0, tag: 'judge_' + personaId, signal});
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  try {
    const compact = `原话：${original}\n译文：${translated}\n只输出 JSON，字段：${dims.map(d => d.key).join(', ')}, comment, key_point。每个分数字段填 1-5 的整数，comment 不超过 30 字，key_point 不超过 20 字。`;
    return await callModel(env, [
      {role: 'system', content: system},
      {role: 'user', content: compact},
    ], {json: true, max: 700, temperature: 0, tag: 'judge_retry_' + personaId, signal});
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

// 单次评分：把模型回复规整成固定结构，便于多采样合并
async function scoreOnce(env, system, prompt, dims, original, translated, personaId, signal) {
  const r = await callJudgeResilient(env, system, prompt, dims, original, translated, personaId, signal);
  if (!r) {
    return {
      ok: false,
      values: Object.fromEntries(dims.map(d => [d.key, 0])),
      total: 0,
      comment: '评分服务本句未返回结果，按 0 分记录，演练继续。',
      key_point: '',
    };
  }
  let scores;
  try {
    scores = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
  } catch {
    scores = {comment: '评分解析失败', key_point: ''};
  }
  const values = {};
  let total = 0;
  for (const d of dims) {
    const v = Math.max(0, Math.min(5, Number(scores[d.key]) || 0));
    values[d.key] = v;
    total += v;
  }
  return {
    ok: true,
    values,
    total,
    comment: String(scores.comment || '').slice(0, 200),
    key_point: String(scores.key_point || '').slice(0, 100),
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 低分复核：首次低于阈值时补采两次，按维度取中位数，抑制单次异常打分。
// 只在低分时触发，正常评分仍是一次调用。
const LOW_SCORE_PERCENT = 60;
async function judgeWithConsistency(runOnce, dims, perfect) {
  const first = await runOnce();
  const firstPercent = Math.round(first.total / perfect * 100);
  if (!first.ok || firstPercent >= LOW_SCORE_PERCENT) return {...first, samples: 1};

  const extra = [await runOnce(), await runOnce()].filter(s => s.ok);
  if (!extra.length) return {...first, samples: 1};
  const all = [first, ...extra];

  const values = {};
  let total = 0;
  for (const d of dims) {
    const v = median(all.map(s => s.values[d.key]));
    values[d.key] = v;
    total += v;
  }
  // 评语取总分最接近中位总分的样本，避免评语与分数脱节
  const pick = all.reduce((best, s) => Math.abs(s.total - total) < Math.abs(best.total - total) ? s : best, all[0]);
  return {ok: true, values, total, comment: pick.comment, key_point: pick.key_point, samples: all.length};
}

// ─── 评判员智能体（移植 JudgeAgent + 可编辑双量规 + 要点讲解）───
async function judgeTurn(env, state, original, translated, signal) {
  const personaId = state.settings.interpreterType;
  const persona = getPersona(personaId);
  const dims = allDims(personaId);
  const pl = state.patientInfo.language;
  const dl = state.settings.doctorLanguage || '中文';
  const dimLines = dims.map(d => `- ${d.key}: ${d.label}（${d.group}）— 关注：${d.focus}`).join('\n');

  const system = `你是一名具备医学背景的专业医疗口译评估专家，精通${pl}和${dl}。你的任务是依据能力评估量规，客观严谨地评估医疗口译质量。
评估量规采用三档行为锚点：
${getLevelAnchors().map(a => '· ' + a).join('\n')}
各子维度如下：
${dimLines}
每个子维度按 1-5 分评分。请保持评估客观、中立、无偏见。评估对象人设：${persona.name}。
评分校准（严格执行，避免分数向高分聚集）：
先判断方向：原话为${dl}、译文为${pl} 表示"译给患者"；原话为${pl}、译文为${dl} 表示"译给医生"。
- 5 分：该维度完全达到黄金标准，且找不到任何可指出的改进点。
- 4 分：达到黄金标准，但至少有一处可具体指出的改进点（用词、语序、语气、术语层次、信息密度等）。
- 3 分：基本合格，核心信息可理解，但存在明显问题，未达到黄金标准。
- 2 分：存在影响理解或信息保真的错误（漏译关键信息、术语错误、人称混乱等）。
- 1 分：存在导致误解、角色越界或医疗风险的严重错误。
硬性约束：
1) comment 或 key_point 中指出任何问题，相关维度不得给 5 分。
2) 译给患者时，若使用患者难以理解且未作通俗解释的专业术语（例如直接说 epistaxis 而不说 nosebleed），effectiveness_trust_building 最多 3 分，并在评语中点明。
3) 译给医生时，若为求口语化而丢失医学精确性（术语、剂量、部位），accuracy_information_integrity 不得给 5 分。
4) 各维度独立评分，不要因为某维度优秀就抬高其他维度。
评语措辞要求：面向教学反馈，用建设性、具体的语气指出问题与改进方向；避免"完全错误""严重失职"等决绝生硬的定性表述，避免对译员个人的整体能力下结论，只评价当前句的表现。
注意：口译员在首次接触患者时，用患者的语言简短介绍自己的口译身份与工作方式，属于符合职业规范的行为，不应因此扣分；但介绍中不得冒充医生身份。`;

  const prompt = `请你根据下列原话及口译译文，使用JSON格式返回每个子维度的评分（1-5分）：
原话：${original}
译文：${translated}

返回JSON字段：
${dims.map(d => `- ${d.key}`).join('\n')}
- comment: 一句话总评（指出最突出的问题或亮点）
- key_point: 面向学习者的一条关键语言服务要点讲解（话术层面，30字内）

只输出JSON，不要任何额外文字。`;

  const perfect = perfectScore(personaId);
  const judged = await judgeWithConsistency(
    () => scoreOnce(env, system, prompt, dims, original, translated, personaId, signal),
    dims, perfect);

  const result = {original_words: original, translated_words: translated};
  Object.assign(result, judged.values);
  result.total = judged.total;
  result.perfect = perfect;
  result.percent = Math.round(judged.total / perfect * 100); // 百分制统一展示（维度 1-5 制不变）
  result.comment = judged.comment;
  result.key_point = judged.key_point;
  if (judged.samples > 1) result.samples = judged.samples;
  state.scores.push(result);
  return result;
}

// ─── 参考建议：用户卡住时给出当下应当说的译文 + 四角度讲解（设计稿模式3）───
async function genReference(env, state, original, targetLang, signal) {
  const r = await callModel(env, [
    {role: 'user', content: `医疗口译场景，口译员需要把下面这句话翻译成${targetLang}。
原话：${original}
请从四个角度提供参考建议，输出严格 JSON：
- reference: 参考译文（第一人称、口语自然、信息完整，符合医疗口译规范，不添加解释）
- terminology: 本句中实际出现的医学术语/关键词的规范${targetLang}表达；本句没有医学术语时输出空字符串
- idiom: 可复用的${targetLang}表达句型或更地道的说法（基于本句实际用词）；没有可提炼的句型时输出空字符串
- medical: 仅当本句涉及具体医学内容（症状、疾病、检查、用药等）时给出理解提示帮助避免误译；问候、寒暄等无医学内容时输出空字符串，不要套用通用沟通话术
- workflow: 这句话在问诊/诊疗流程中的作用与前后衔接；没有流程意义时输出空字符串
严格禁止：各角度只写与本句直接相关的内容，宁可留空也不要用泛泛的套话填充。只输出 JSON，不要额外文字。`},
  ], {json: true, max: 600, temperature: 0.3, tag: 'hint', signal});
  try {
    const t = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
    return {
      reference: String(t.reference || '').trim(),
      terminology: String(t.terminology || ''),
      idiom: String(t.idiom || ''),
      medical: String(t.medical || ''),
      workflow: String(t.workflow || ''),
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return {reference: r.message, terminology: '', idiom: '', medical: '', workflow: ''}; // 解析失败时退化为单句建议
  }
}

// ─── 个性化反馈（设计稿 #3）：逐句参考译文对照 + 基于本场表现的提升方案 ───
async function genPersonalFeedback(env, state, signal) {
  const pairs = state.pairs || [];
  if (!pairs.length) return null;
  const lines = pairs.map(p => {
    const s = state.scores[p.half - 1];
    return `第${p.half}句（原话：${p.original} → 用户译文：${p.translated}）${s ? `AI 评语：${s.comment}` : ''}`;
  }).join('\n');
  const r = await callModel(env, [
    {role: 'user', content: `以下是医疗口译演练中用户（译员）的完整译文记录：
${lines}
用户共使用参考建议 ${state.hintUsed || 0} 次。
请面向这位学生产出个性化反馈，输出严格 JSON：
- references: 数组，与上面句子一一对应，每项 {half: 句序号, reference: 该句的专业参考译文（第一人称、符合医疗口译规范）}
- plan: 数组，2-4 条个性化提升建议。必须针对本场的实际问题（对比原话与译文，找出漏译、增译、术语错误、句型生硬、人称不一致等），每项 {point: 问题点, advice: 具体改进方法, example: 改写示例（引用本场实际语句）}；不要输出与译文无关的通用建议。
只输出 JSON，不要额外文字。`},
  ], {json: true, max: 2200, temperature: 0.3, tag: 'feedback', signal});
  try {
    const t = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
    return {
      references: Array.isArray(t.references) ? t.references.slice(0, pairs.length) : [],
      plan: Array.isArray(t.plan) ? t.plan.slice(0, 4) : [],
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null; // 生成失败不阻断主流程
  }
}

// ─── 模式2 个性化反馈：逐句医生表达改进 + 提升方案 ───
async function genDoctorFeedback(env, state, signal) {
  const utterances = state.log.filter(e => e.role === 'doctor').map(e => e.content);
  if (!utterances.length) return null;
  const pl = state.patientInfo.language;
  const lines = utterances.map((u, i) => {
    const s = state.scores[i];
    return `第${i + 1}句：${u}${s ? `（评语：${s.comment}；原因：${s.key_point}）` : ''}`;
  }).join('\n');
  const r = await callModel(env, [
    {role: 'user', content: `以下是医护人员在演练中直接用${pl}与外籍患者沟通的完整发言记录：
${lines}
用户共使用参考建议 ${state.hintUsed || 0} 次。
请面向这位学员产出个性化反馈，输出严格 JSON：
- references: 数组，与上面句子一一对应，每项 {half: 句序号, reference: 针对该句的更地道${pl}表达（保持原意与医生身份）}
- plan: 数组，2-4 条个性化提升建议。必须针对本场的实际问题（用词、语法、术语通俗化、信息完整性、同理心、话轮控制等），每项 {point: 问题点, advice: 具体改进方法, example: 改写示例（引用本场实际语句）}；不要输出与本场无关的通用建议。
只输出 JSON，不要额外文字。`},
  ], {json: true, max: 2200, temperature: 0.3, tag: 'doctor_feedback', signal});
  try {
    const t = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
    return {
      references: Array.isArray(t.references) ? t.references.slice(0, utterances.length) : [],
      plan: Array.isArray(t.plan) ? t.plan.slice(0, 4) : [],
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

// ─── 剧本讲解生成（设计稿：医学知识/诊疗流程/专业术语/语言表达难点）───
async function genTeaching(env, state, signal) {
  const scenario = getScenario(state.settings.scenario);
  const dialogue = state.log.map(e => ({role: e.role, content: e.content}));
  const prompt = `以下是${scenario.name}场景中医疗多智能体生成的完整对话（疾病：${state.patientInfo.disease_info.disease_type}）：
${JSON.stringify(dialogue)}

请面向医疗口译专业学生，针对**这一场对话**产出讲解材料，输出严格 JSON：
- medicalKnowledge: 字符串。该疾病/诊疗涉及的医学知识讲解（病因、典型症状、诊断依据、治疗原则），150-250 字。
- workflow: 字符串。该剧本体现的诊疗流程分步讲解（本对话实际走到了哪几步、每步的语言服务意义），150-250 字。
- terminology: 数组。从本对话中提取 4-8 个专业术语，每项 {term: 中文术语, en: 英文表达（含患者友好说法）, explanation: 术语解释与翻译注意事项}。
- languagePoints: 数组。3-5 个语言表达难点，每项 {title: 难点标题, explanation: 难点说明（引用对话中的实际表达，给出口译处理建议）}。
只输出 JSON，不要额外文字。`;

  try {
    const r = await callModel(env, [
      {role: 'user', content: prompt},
    ], {json: true, max: 1600, temperature: 0.3, tag: 'teaching', signal});
    const t = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
    return {
      medicalKnowledge: String(t.medicalKnowledge || ''),
      workflow: String(t.workflow || ''),
      terminology: Array.isArray(t.terminology) ? t.terminology.slice(0, 8) : [],
      languagePoints: Array.isArray(t.languagePoints) ? t.languagePoints.slice(0, 5) : [],
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null; // 讲解生成失败不阻断主流程
  }
}

// ─── 模式2专用：医护英语沟通评分 + 医生参考句生成 ───
async function judgeMedStaff(env, state, utterance, signal) {
  const persona = getPersona('medstaff');
  const dims = persona.dims;
  const pl = state.patientInfo.language;
  const sc = getScenario(state.settings.scenario);
  const context = state.log.filter(e => e.role === 'doctor' || e.role === 'patient').slice(-6);
  const dimLines = dims.map(d => `- ${d.key}: ${d.label}（${d.group}）— 关注：${d.focus}`).join('\n');
  const system = `你是国际医疗沟通培训专家，评估中国医生直接用${pl}与外籍患者沟通的能力（${sc.name}场景，无译员参与）。
评估量规采用三档行为锚点：1-2 分（明显问题，影响理解或显得不专业）；3 分（基本合格但平淡）；4-5 分（准确自然、体现同理心与专业素养）。
各子维度：
${dimLines}
每个子维度按 1-5 分评分。评估对象是医生本人说出的语句，不是译文。`;
  const prompt = `对话上下文（最近几条）：
${JSON.stringify(context)}

这位医生刚说出的一句话：
${utterance}

请输出严格 JSON：
${dims.map(d => `- ${d.key}`).join('\n')}
- suggestion: 针对这句话的具体改进建议——包括改进后的${pl}表达（如原句已很好，则给一个更地道的替代表达）
- reason: 给出该建议的原因（语言/医学沟通/文化层面）
只输出 JSON，不要额外文字。`;
  const r = await callModel(env, [
    {role: 'system', content: system},
    {role: 'user', content: prompt},
  ], {json: true, max: 1200, tag: 'judge_medstaff', signal});
  let scores;
  try {
    scores = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
  } catch {
    scores = {suggestion: '评分解析失败', reason: ''};
    for (const d of dims) scores[d.key] = 0;
  }
  const result = {original_words: utterance, translated_words: utterance};
  let total = 0;
  for (const d of dims) {
    const v = Math.max(0, Math.min(5, Number(scores[d.key]) || 0));
    result[d.key] = v;
    total += v;
  }
  result.total = total;
  result.perfect = dims.length * 5;
  result.percent = Math.round(total / result.perfect * 100); // 百分制统一展示
  result.comment = String(scores.suggestion || '').slice(0, 300);
  result.key_point = String(scores.reason || '').slice(0, 200);
  state.scores.push(result);
  return result;
}

async function genM2Hint(env, state, signal) {
  const sc = getScenario(state.settings.scenario);
  const pl = state.patientInfo.language;
  const context = state.log.filter(e => e.role === 'doctor' || e.role === 'patient');
  const prompt = `场景：${sc.name}。你扮演一名中国医生，正在直接用${pl}与外籍患者沟通（无译员）。
患者背景：${JSON.stringify({country: state.patientInfo.country, disease: state.patientInfo.disease_info.disease_type})}
对话至今：${JSON.stringify(context)}

请从四个角度给出医生**当下应该说出的下一句话**的建议，输出严格 JSON：
- reference: 医生当下应当说出的${pl}（符合${state.doctor.roleLabel}身份与场景进度，自然口语）
- terminology: 本句中会出现的医学术语/关键词的规范${pl}表达；本句没有医学术语时输出空字符串
- idiom: 可复用的${pl}表达句型或更地道的说法（基于本句实际用词）；没有可提炼的句型时输出空字符串
- medical: 仅当本句涉及具体医学内容（症状、疾病、检查、用药等）时给出理解提示；问候等无医学内容时输出空字符串，不要套用通用沟通话术
- workflow: 这句话在问诊/诊疗流程中的作用与前后衔接；没有流程意义时输出空字符串
严格禁止：各角度只写与本句直接相关的内容，宁可留空也不要用泛泛的套话填充。只输出 JSON，不要额外文字。`;
  try {
    const r = await callModel(env, [{role: 'user', content: prompt}], {json: true, max: 600, temperature: 0.4, tag: 'm2_hint', signal});
    const t = typeof r.message === 'string' ? parseJSON(r.message) : r.message;
    return {
      reference: String(t.reference || '').trim(),
      terminology: String(t.terminology || ''),
      idiom: String(t.idiom || ''),
      medical: String(t.medical || ''),
      workflow: String(t.workflow || ''),
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return {reference: '', terminology: '', idiom: '', medical: '', workflow: ''};
  }
}

// ─── 管理智能体：终止判定（移植 ManagerAgent.check_terminate，容错版，终止条件随场景）───
async function managerCheck(env, state, signal) {
  const sc = getScenario(state.settings.scenario);
  const view = state.log.map(e => ({role: e.role, content: e.content}));
  const system = `你是一个医疗多智能体对话管理者，你的任务是判断对话是否可以结束。
如果对话为空，应直接输出'CONTINUE'。
如果可以结束对话，请回复 'TERMINATE'，否则回复'CONTINUE'。
本场景（${sc.name}）的结束条件：${sc.managerConditions}
只有患者/服务对象没有疑问并表示感谢或道别时你才能输出'TERMINATE'，结束对话。
请注意，回复内容必须是 'TERMINATE' 或 'CONTINUE'。`;
  const prompt = `患者、口译员和医生之间已有下面的对话：
${JSON.stringify(view)}
请你根据上述对话内容，判断是否需要继续对话，或者是否多智能体已经结束对话。`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = (await callModel(env, [
        {role: 'system', content: system},
        {role: 'user', content: prompt},
      ], {max: 10, temperature: 0, tag: 'manager', signal})).message.trim().toUpperCase();
      if (reply.includes('TERMINATE')) return true;
      if (reply.includes('CONTINUE')) return false;
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  return false; // 容错：两次异常/非法回复按继续处理，由外层 MAX_ROUNDS 兜底
}

export {makePatientInfo, doctorTurn, patientTurn, interpreterTurn, judgeTurn, managerCheck, isTerminate, splitList, genReference, genTeaching, judgeMedStaff, genM2Hint, genPersonalFeedback, genDoctorFeedback};
