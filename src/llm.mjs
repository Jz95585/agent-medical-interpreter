// LLM 调用封装：OpenAI 兼容协议（OpenRouter），支持 JSON 模式与干跑
// 模式参考 zhilu-system-demo src/api.mjs 的 callModel

const err = (s, status = 400) => Object.assign(new Error(s), {status});

function parseJSON(s) {
  try {
    return JSON.parse(s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw err('模型没有返回有效结构，请重试。', 502);
  }
}

// 干跑模式的固定样例（按调用方标签区分，用于不烧 token 的链路调试）
const DRY_SAMPLES = {
  info: JSON.stringify({
    symptoms: ['无痛性血尿', '尿频尿急', '下腹部隐痛'],
    medical_history: '两年前体检发现尿潜血，未系统诊治。无手术史，无药物过敏史。',
  }),
  doctor: '您好，我是张医生。请问您叫什么名字？请先坐下休息一下。',
  doctor_follow: '您好，欢迎回来。这次复诊感觉怎么样，之前的症状有没有好转？',
  patient: 'Hello doctor, my name is Olivia Martin. I have been having blood in my urine without pain, and I need to go to the toilet very often. It is very uncomfortable.',
  patient_end: 'Thank you doctor, I have no more questions. I will follow your treatment plan. TERMINATE',
  interpreter: 'Hello, I am the interpreter. May I know your name? Please have a seat.',
  hint: 'Hello, I am the interpreter. Dr. Zhang would like to know your name. Please have a seat.',
  m2_hint: 'Hello, I am Dr. Zhang. What seems to be the problem today?',
  judge_medstaff: JSON.stringify({
    lang_accuracy: 4, terminology_use: 4, information_completeness: 4,
    explanation_confirmation: 3, empathy_comfort: 4, turn_management: 4,
    suggestion: '可以说 "I\'m Dr. Zhang. What brings you in today?" 更自然地开启问诊。',
    reason: 'What brings you in today 是门诊开场的地道问法，比直译更符合医患沟通习惯。',
  }),
  teaching: JSON.stringify({
    medicalKnowledge: '肾结石是尿液中矿物质结晶沉积形成的硬块。典型表现为肾绞痛（腰部阵发性剧烈疼痛并向腹股沟放射）、血尿、尿频尿急。诊断依靠尿常规、超声或 CT。治疗视结石大小而定：小于 6mm 多可保守排石（多饮水、止痛），较大者需体外冲击波碎石或手术。',
    workflow: '接诊问候并确认身份 → 采集主诉与现病史（疼痛部位/性质/伴随症状）→ 体格检查与开具检验检查 → 依据结果给出诊断 → 制定治疗方案（药物/手术）→ 解释医嘱并询问疑问。',
    terminology: [
      {term: '肾结石', en: 'kidney stone / renal calculus', explanation: '尿液矿物质结晶沉积；口语可说 stones in the kidney。'},
      {term: '血尿', en: 'hematuria / blood in urine', explanation: '尿中带血；对患者宜说 blood in your urine。'},
    ],
    languagePoints: [
      {title: '疼痛描述句型', explanation: 'It comes in waves（阵发性）表达肾绞痛的典型节律；radiate to（放射至）用于描述疼痛走向。'},
      {title: '安抚与赋权', explanation: '避免 don\'t worry 式虚假安慰；可用 I understand this is uncomfortable, let\'s find out what\'s causing it。'},
    ],
  }),
  manager: 'CONTINUE',
  consumer: '肾结石就是肾脏里长了小石头，可能引起腰部绞痛、血尿。',
  judge: JSON.stringify({
    accuracy_medical_knowledge: 4, accuracy_information_integrity: 4,
    technique_discourse_management: 4, technique_use_of_person: 5, technique_cultural_interpretation: 4,
    ethics_role_boundaries: 5, ethics_impartiality: 5,
    effectiveness_trust_building: 4, effectiveness_fluency: 4,
    empathy_expression: 4,
    comment: '信息完整，人称统一；术语 kidney stone 可再口语化为 stones in your kidney。',
    key_point: '症状描述保持第一人称，未添加个人意见。',
  }),
  judge_dual: JSON.stringify({
    accuracy_medical_knowledge: 4, accuracy_information_integrity: 4,
    technique_discourse_management: 4, technique_use_of_person: 5, technique_cultural_interpretation: 4,
    ethics_role_boundaries: 4, ethics_impartiality: 5,
    effectiveness_trust_building: 4, effectiveness_fluency: 4,
    empathy_expression: 5, role_balance: 4,
    comment: '护理信息转达清晰，未越界给出医疗建议。',
    key_point: '双重角色下先完成翻译，再以护士身份补充测量体温。',
  }),
  judge_pro: JSON.stringify({
    accuracy_medical_knowledge: 4, accuracy_information_integrity: 4,
    technique_discourse_management: 4, technique_use_of_person: 5, technique_cultural_interpretation: 4,
    ethics_role_boundaries: 5, ethics_impartiality: 5,
    effectiveness_trust_building: 4, effectiveness_fluency: 4,
    empathy_expression: 4, ethics_decision: 5,
    comment: '严格保持中立，遇到专业问题主动请医生解释。',
    key_point: '未代医生回答剂量问题，转请医生说明。',
  }),
};

async function callModel(env, messages, {json = false, max = 1200, temperature = 0.3, tag = '', signal} = {}) {
  if (env.DRY_RUN === '1') {
    let dry = DRY_SAMPLES[tag];
    if (!dry && tag === 'judge_professional') dry = DRY_SAMPLES.judge_pro;
    if (!dry && tag === 'judge_dual') dry = DRY_SAMPLES.judge_dual;
    return {message: dry || DRY_SAMPLES.interpreter, model: 'dry-run', usage: null};
  }
  if (!env.AMI_API_KEY) throw err('LLM 服务尚未配置，请填写 .env 中的 AMI_API_KEY。', 503);
  let r;
  try {
    r = await fetch((env.AMI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + env.AMI_API_KEY},
      body: JSON.stringify({
        model: env.AMI_MODEL || 'deepseek/deepseek-v4.1-flash',
        messages,
        stream: false,
        max_tokens: max,
        temperature,
        reasoning: {enabled: false},
        ...(json ? {response_format: {type: 'json_object'}} : {}),
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw err(e.name === 'AbortError' ? '任务已停止' : 'LLM 服务暂时未响应，请重试。', 502);
  }
  if (!r.ok) {
    const msgs = {401: 'LLM 服务认证未通过，请检查 AMI_API_KEY。', 402: 'LLM 服务额度不足。', 429: '请求过于频繁，请稍后重试。'};
    throw err(msgs[r.status] || 'LLM 服务暂时不可用（' + r.status + '）。', 502);
  }
  const payload = await r.json();
  const choice = payload.choices?.[0];
  const message = choice?.message;
  if (payload.error || choice?.error || choice?.finish_reason === 'error') throw err('LLM 未完成本次请求，请重试。', 502);
  if (choice?.finish_reason === 'length') throw err('模型输出达到长度上限，请重试。', 502);
  if (!message || !message.content) throw err('模型响应缺少有效内容。', 502);
  return {message: message.content, model: payload.model, usage: payload.usage || null};
}

export {callModel, parseJSON, err};
