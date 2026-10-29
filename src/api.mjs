// API 路由层
// 模式1（自动全流程）：POST /api/auto —— SSE 流式返回每个智能体的产出与评分
// 模式3（用户扮演译员）：POST /api/drill/start + /api/drill/step —— 逐句交互
// 模式2（用户扮演医生）：设计稿规划中，返回 501
// 量规编辑：GET /api/rubric · POST /api/rubric/save · POST /api/rubric/reset
import {err} from './llm.mjs';
import {makePatientInfo, doctorTurn, patientTurn, interpreterTurn, judgeTurn, managerCheck, isTerminate, splitList, genReference, genTeaching, judgeMedStaff, genM2Hint} from './agents.mjs';
import {listScenarios, getScenario} from './scenarios.mjs';
import {listPersonas, allDims, getPersona, getStore, savePersona, resetStore} from './rubric.mjs';
import {buildScriptDocx} from './docx.mjs';
import {COUNTRIES, LANGUAGES, RELIGIONS, DIETS, TABOOS, PERSONALITIES, LITERACIES, GENDERS, DEPARTMENTS, DOCTOR_LANGUAGES, DISEASE_EXAMPLES} from './pools.mjs';

const sessions = new Map(); // drill/m2 会话：sessionId → {state, pending}

// 公网部署时清理被放弃的会话（2 小时无活动即释放）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - (v.touched || 0) > 2 * 3600e3) { sessions.delete(k); console.error('[sweep] expired session:', k); }
  }
}, 600e3).unref();
function touch(sess) { sess.touched = Date.now(); }
const archive = new Map();  // 已完成演练的导出档案：exportId → record（保留最近 30 份）

function archiveRecord(kind, state, extra) {
  const exportId = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  if (archive.size >= 30) archive.delete(archive.keys().next().value);
  archive.set(exportId, {kind, state, extra});
  return exportId;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {'Content-Type': 'application/json; charset=utf-8'},
});

// SSE 流式响应：每条事件 data: {...}\n\n
function sse(handler, signal) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        await handler(send, signal);
      } catch (e) {
        send({type: 'error', error: e.message || '执行失败'});
      }
      send({type: 'end'});
      controller.close();
    },
  }), {
    headers: {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
  });
}

function newSessionId() {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function makeState(settings) {
  const sc = getScenario(settings.scenario);
  return {
    settings,
    doctor: {
      name: sc.doctorName || '张医生',
      roleLabel: sc.id === 'appointment' ? '前台接待员' : '医生',
      specialization: sc.department
        ? (settings.params && settings.params.department) || '泌尿外科'
        : '国际门诊前台',
    },
    interpreter: {name: '王译员'},
    log: [],          // {role:'doctor'|'patient'|'interpreter', dir?:'to_patient'|'to_doctor', content}
    scores: [],       // judge 结果
    humanScores: [],
    hintUsed: 0,
    sqlQueries: [],
    round: 0,
    done: false,
  };
}

async function persist(kind, state, extra = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'output');
  fs.mkdirSync(dir, {recursive: true});
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(dir, `${state.settings.scenario}_${state.settings.interpreterType}_${kind}_${ts}.json`);
  const record = {
    settings: state.settings,
    patientInfo: state.patientInfo,
    doctor: state.doctor,
    log: state.log,
    scores: state.scores,
    humanScores: state.humanScores || [],
    hintUsed: state.hintUsed || 0,
    msdRefs: state.msdRefs || [],
    consumerPlain: state.consumerPlain || '',
    teaching: state.teaching || null,
    sqlQueries: state.sqlQueries,
    rounds: state.round,
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  return path.basename(file);
}

function scoreReport(state) {
  const dims = allDims(state.settings.interpreterType);
  const n = state.scores.length || 1;
  const avg = {};
  for (const d of dims) avg[d.key] = +(state.scores.reduce((s, r) => s + (r[d.key] || 0), 0) / n).toFixed(2);
  const report = {
    utterances: state.scores.length,
    totalAvg: state.scores.length ? +(Object.values(avg).reduce((a, b) => a + b, 0) / dims.length).toFixed(2) : null,
    perDim: dims.map(d => ({...d, avg: avg[d.key]})),
    comments: state.scores.map(r => r.comment).filter(Boolean),
    keyPoints: state.scores.map(r => r.key_point).filter(Boolean),
  };
  if (state.humanScores?.length) {
    report.human = {
      count: state.humanScores.length,
      avg: +(state.humanScores.reduce((s, h) => s + h.score, 0) / state.humanScores.length).toFixed(2),
      items: state.humanScores,
    };
  }
  return report;
}

// 从对话日志提取逐句对照（原话 ↔ 译文），供人工评分使用
function buildPairs(state) {
  const pairs = [];
  let half = 0;
  let lastOriginal = '';
  for (const e of state.log) {
    if (e.role === 'doctor' || e.role === 'patient') lastOriginal = e.content;
    else if (e.role === 'interpreter') {
      half += 1;
      pairs.push({
        half,
        round: Math.ceil(half / 2),
        dir: e.dir,
        original: lastOriginal,
        translated: e.content,
      });
    }
  }
  return pairs;
}

// ─── 模式1：自动全流程（SSE）───
async function runAuto(env, body, send, signal) {
  const settings = {
    mode: 'auto',
    scenario: body.scenario || 'consult',
    interpreterType: listPersonas().some(p => p.id === body.interpreterType) ? body.interpreterType : 'professional',
    params: body.params || {},
    maxRounds: Math.min(6, Math.max(1, Number(body.maxRounds) || 4)),
    doctorLanguage: (body.params && body.params.doctorLanguage) || '中文',
  };
  const state = makeState(settings);

  send({type: 'status', label: '生成患者人设（信息生成器）'});
  state.patientInfo = await makePatientInfo(env, {scenario: settings.scenario, params: settings.params}, signal);
  send({type: 'info', patientInfo: state.patientInfo});
  send({type: 'status', label: `开始演练：${settings.scenario} · ${settings.doctorLanguage}医生 ↔ ${state.patientInfo.language}患者`});

  let stopped = null;
  while (state.round < settings.maxRounds) {
    const terminate = await managerCheck(env, state, signal);
    if (terminate || state.done) break;

    state.round += 1;
    send({type: 'round', round: state.round});

    // 医生 → 口译（医→患）→ 评分
    const doctor = await doctorTurn(env, state, signal);
    send({type: 'message', round: state.round, speaker: 'doctor', lang: settings.doctorLanguage, text: doctor.content});
    if (doctor.terminated) { stopped = 'doctor'; break; }

    const interp1 = await interpreterTurn(env, state, signal, 1);
    send({type: 'message', round: state.round, speaker: 'interpreter', dir: 'to_patient', lang: state.patientInfo.language, text: interp1.content});

    const score1 = await judgeTurn(env, state, doctor.content, interp1.content, signal);
    send({type: 'score', round: state.round, for: 'to_patient', score: score1});
    if (isTerminate(interp1.content)) { stopped = 'interpreter'; break; }

    // 患者 → 口译（患→医）→ 评分
    const patient = await patientTurn(env, state, signal);
    send({type: 'message', round: state.round, speaker: 'patient', lang: state.patientInfo.language, text: patient.content});
    if (patient.terminated) { stopped = 'patient'; break; }

    const interp2 = await interpreterTurn(env, state, signal, 2);
    send({type: 'message', round: state.round, speaker: 'interpreter', dir: 'to_doctor', lang: settings.doctorLanguage, text: interp2.content});

    const score2 = await judgeTurn(env, state, patient.content, interp2.content, signal);
    send({type: 'score', round: state.round, for: 'to_doctor', score: score2});
    if (isTerminate(interp2.content)) { stopped = 'interpreter'; break; }
  }

  const report = scoreReport(state);
  state.teaching = await genTeaching(env, state, signal);
  const file = await persist('auto', state, {stopped, report}).catch(() => null);
  const exportId = archiveRecord('auto', state, {stopped, report});
  send({type: 'done', stopped: stopped || 'max_rounds', rounds: state.round, report, saved: file, exportId});
}

// ─── 模式3：用户扮演译员 ───
async function drillStart(env, body) {
  const settings = {
    mode: 'drill',
    scenario: body.scenario || 'consult',
    interpreterType: listPersonas().some(p => p.id === body.interpreterType) ? body.interpreterType : 'professional',
    scoringMode: ['ai', 'human', 'dual'].includes(body.scoringMode) ? body.scoringMode : 'ai',
    params: body.params || {},
    doctorLanguage: (body.params && body.params.doctorLanguage) || '中文',
    maxRounds: Math.min(20, Math.max(1, Number(body.maxRounds) || 20)),
  };
  const state = makeState(settings);
  state.humanScores = [];
  state.hintUsed = 0;
  state.patientInfo = await makePatientInfo(env, {scenario: settings.scenario, params: settings.params}, undefined);
  const doctor = await doctorTurn(env, state, undefined);

  const id = newSessionId();
  sessions.set(id, {state, pending: {original: doctor.content, target: 'to_patient', round: 1}, half: 0, touched: Date.now()});
  console.error('[drill] session created:', id, 'total:', sessions.size);
  const sc = getScenario(settings.scenario);
  const pl = state.patientInfo.language;
  return json({
    sessionId: id,
    settings: {
      ...settings,
      personaName: getPersona(settings.interpreterType).name,
      doctorLanguage: settings.doctorLanguage,
      patientLanguage: pl,
      perfect: allDims(settings.interpreterType).length * 5,
    },
    patientInfo: state.patientInfo,
    first: {speaker: 'doctor', lang: settings.doctorLanguage, text: doctor.content, round: 1},
    hints: sc.keyPoints,
    dims: allDims(settings.interpreterType),
  });
}

async function drillStep(env, body) {
  const sess = sessions.get(body.sessionId);
  if (!sess) throw err('会话不存在或已过期，请重新开始演练。', 404);
  touch(sess);
  const {state, pending} = sess;
  const translation = String(body.translation || '').trim();
  if (!translation) throw err('请输入译文。');

  sess.half += 1;

  // 1) AI 评分（人工评分模式下跳过以节省 token；人工分在结束后统一提交）
  let score = null;
  if (state.settings.scoringMode !== 'human') {
    score = await judgeTurn(env, state, pending.original, translation, undefined);
  }
  state.log.push({role: 'interpreter', dir: pending.target, content: translation});
  const result = {score, half: sess.half};

  // 2) 推进到下一话轮
  let next = null;
  if (pending.target === 'to_patient') {
    // 译文交给患者 → 患者回应
    const patient = await patientTurn(env, state, undefined);
    if (patient.terminated) {
      state.done = true;
      result.finished = {reason: 'patient_terminate', text: patient.content};
    } else {
      next = {speaker: 'patient', lang: state.patientInfo.language, text: patient.content, round: pending.round};
      sess.pending = {original: patient.content, target: 'to_doctor', round: pending.round};
    }
  } else {
    // 译文交给医生 → 医生回应
    const doctor = await doctorTurn(env, state, undefined);
    if (doctor.terminated) {
      state.done = true;
      result.finished = {reason: 'doctor_terminate', text: doctor.content};
    } else {
      next = {speaker: 'doctor', lang: state.settings.doctorLanguage, text: doctor.content, round: pending.round + 1};
      sess.pending = {original: doctor.content, target: 'to_patient', round: pending.round + 1};
    }
  }

  // 3) 最大轮数兜底（与模式1同源的保护）
  if (!state.done && sess.half >= state.settings.maxRounds * 2) {
    state.done = true;
    result.finished = {reason: 'max_rounds', text: ''};
  }

  if (state.done) {
    state.pairs = buildPairs(state);
    state.round = Math.ceil(sess.half / 2);
    state.teaching = await genTeaching(env, state, undefined);
    result.pairs = state.pairs;
    result.report = scoreReport(state);
    result.saved = await persist('drill', state, {report: result.report, pairs: state.pairs}).catch(() => null);
    result.exportId = archiveRecord('drill', state, {report: result.report, pairs: state.pairs});
    sessions.delete(body.sessionId);
  } else {
    const sc = getScenario(state.settings.scenario);
    const kps = sc.keyPoints;
    result.hint = kps.length ? kps[(pending.round - 1) % kps.length] : null;
  }
  return json({next, ...result});
}

// 参考建议：用户卡住时给出当下应当说的译文（设计稿模式3）
async function drillHint(env, body) {
  const sess = sessions.get(body.sessionId);
  if (!sess) throw err('会话不存在或已过期，请重新开始演练。', 404);
  touch(sess);
  const {state, pending} = sess;
  const targetLang = pending.target === 'to_patient' ? state.patientInfo.language : state.settings.doctorLanguage;
  state.hintUsed += 1;
  const reference = await genReference(env, state, pending.original, targetLang, undefined);
  return json({reference, targetLang});
}

// 结束后的人工评分：逐句 1-5 分 + 评语，写入档案并重算报告
async function drillFinishScore(env, body) {
  const item = archive.get(body.exportId);
  if (!item) throw err('导出记录不存在或已过期，无法提交人工评分。', 404);
  const {state, extra} = item;
  const pairs = extra.pairs || state.pairs || [];
  const incoming = Array.isArray(body.scores) ? body.scores : [];
  state.humanScores = incoming
    .filter(h => h && Number(h.score) >= 1 && Number(h.score) <= 5)
    .map(h => {
      const p = pairs.find(x => x.half === Number(h.half)) || {};
      return {
        half: Number(h.half) || 0,
        dir: p.dir || '',
        original_words: p.original || '',
        translated_words: p.translated || '',
        score: Math.max(1, Math.min(5, Number(h.score))),
        comment: String(h.comment || '').slice(0, 200),
      };
    });
  extra.report = scoreReport(state);
  const saved = await persist('drill', state, extra).catch(() => null);
  return json({ok: true, report: extra.report, saved});
}

// ─── 模式2：用户扮演医生（与患者智能体直接对话，无译员）───
async function m2Start(env, body) {
  const settings = {
    mode: 'm2',
    scenario: body.scenario || 'consult',
    params: body.params || {},
    maxRounds: Math.min(20, Math.max(1, Number(body.maxRounds) || 12)),
  };
  const state = makeState(settings);
  state.doctor = {name: '用户（医生）', roleLabel: '医生', specialization: (settings.params && settings.params.department) || '泌尿外科'};
  state.patientInfo = await makePatientInfo(env, {scenario: settings.scenario, params: settings.params}, undefined);
  const pl = state.patientInfo.language;
  settings.doctorLanguage = pl; // 模式2中医生直接使用患者语言沟通
  const sc = getScenario(settings.scenario);

  const id = newSessionId();
  sessions.set(id, {state, half: 0, touched: Date.now()});
  console.error('[m2] session created:', id, 'total:', sessions.size);
  return json({
    sessionId: id,
    settings: {...settings, patientLanguage: pl, doctorLanguage: '中文（你的母语）', perfect: allDims('medstaff').length * 5},
    patientInfo: state.patientInfo,
    userStarts: true,
    openingGuide: sc.doctorOpening,
    hints: sc.keyPoints,
    dims: allDims('medstaff'),
  });
}

async function m2Turn(env, body) {
  const sess = sessions.get(body.sessionId);
  if (!sess) throw err('会话不存在或已过期，请重新开始演练。', 404);
  touch(sess);
  const {state} = sess;
  const utterance = String(body.utterance || '').trim();
  if (!utterance) throw err('请输入你的话。');
  if (state.done) throw err('演练已结束。');

  sess.half += 1;
  state.log.push({role: 'doctor', content: utterance});
  const score = await judgeMedStaff(env, state, utterance, undefined);
  const result = {score, half: sess.half};

  const patient = await patientTurn(env, state, undefined);
  if (patient.terminated) {
    state.done = true;
    result.finished = {reason: 'patient_terminate', text: patient.content};
  } else {
    result.next = {speaker: 'patient', lang: state.patientInfo.language, text: patient.content, round: sess.half};
  }

  if (!state.done && sess.half >= state.settings.maxRounds) {
    state.done = true;
    result.finished = {reason: 'max_rounds', text: ''};
  }

  if (state.done) {
    state.round = sess.half;
    state.teaching = await genTeaching(env, state, undefined);
    result.report = scoreReport(state);
    result.saved = await persist('m2', state, {report: result.report}).catch(() => null);
    result.exportId = archiveRecord('m2', state, {report: result.report});
    sessions.delete(body.sessionId);
  }
  return json(result);
}

async function m2Hint(env, body) {
  const sess = sessions.get(body.sessionId);
  if (!sess) throw err('会话不存在或已过期，请重新开始演练。', 404);
  touch(sess);
  if (sess.state.done) throw err('演练已结束。');
  sess.state.hintUsed += 1;
  const reference = await genM2Hint(env, sess.state, undefined);
  return json({reference, targetLang: sess.state.patientInfo.language});
}

async function m2Finish(env, body) {
  const sess = sessions.get(body.sessionId);
  if (!sess) throw err('会话不存在或已过期，请重新开始演练。', 404);
  touch(sess);
  const {state} = sess;
  if (state.done) throw err('演练已结束。');
  state.done = true;
  state.round = sess.half;
  state.teaching = await genTeaching(env, state, undefined);
  const report = scoreReport(state);
  const saved = await persist('m2', state, {report}).catch(() => null);
  const exportId = archiveRecord('m2', state, {report});
  sessions.delete(body.sessionId);
  return json({ok: true, report, saved, exportId});
}

// ─── 路由入口 ───
async function apiFetch(request, env) {
  try {
    return await route(request, env);
  } catch (e) {
    return json({error: e.message || '执行失败'}, e.status || 500);
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const routeName = `${request.method} ${url.pathname}`;

  if (routeName === 'GET /api/config') {
    return json({
      model: env.AMI_MODEL || null,
      dryRun: env.DRY_RUN === '1',
      scenarios: listScenarios(),
      interpreterTypes: listPersonas(),
      paramOptions: {
        diseaseExamples: DISEASE_EXAMPLES,
        countries: COUNTRIES.map(c => ({name: c.name, language: c.language})),
        languages: LANGUAGES,
        personalities: PERSONALITIES,
        healthLiteracies: LITERACIES,
        religions: RELIGIONS,
        diets: DIETS,
        taboos: TABOOS,
        genders: GENDERS,
        departments: DEPARTMENTS,
        doctorLanguages: DOCTOR_LANGUAGES,
      },
    });
  }

  if (routeName === 'GET /api/rubric') {
    return json(getStore());
  }

  if (routeName === 'POST /api/rubric/save') {
    const body = await request.json().catch(() => ({}));
    const saved = savePersona(body.persona, {personaNote: body.personaNote, dims: body.dims});
    return json({ok: true, saved});
  }

  if (routeName === 'POST /api/rubric/reset') {
    resetStore();
    return json({ok: true});
  }

  if (routeName === 'POST /api/auto') {
    const body = await request.json().catch(() => ({}));
    return sse((send, signal) => runAuto(env, body, send, signal), request.signal);
  }

  if (routeName === 'POST /api/drill/start') {
    const body = await request.json().catch(() => ({}));
    return drillStart(env, body);
  }

  if (routeName === 'POST /api/drill/step') {
    const body = await request.json().catch(() => ({}));
    return drillStep(env, body);
  }

  if (routeName === 'POST /api/drill/hint') {
    const body = await request.json().catch(() => ({}));
    return drillHint(env, body);
  }

  if (routeName === 'POST /api/drill/finish-score') {
    const body = await request.json().catch(() => ({}));
    return drillFinishScore(env, body);
  }

  if (routeName === 'POST /api/m2/start') {
    const body = await request.json().catch(() => ({}));
    return m2Start(env, body);
  }
  if (routeName === 'POST /api/m2/turn') {
    const body = await request.json().catch(() => ({}));
    return m2Turn(env, body);
  }
  if (routeName === 'POST /api/m2/hint') {
    const body = await request.json().catch(() => ({}));
    return m2Hint(env, body);
  }
  if (routeName === 'POST /api/m2/finish') {
    const body = await request.json().catch(() => ({}));
    return m2Finish(env, body);
  }

  if (routeName.startsWith('GET /api/export/')) {
    const exportId = url.pathname.split('/').pop();
    const item = archive.get(exportId);
    if (!item) throw err('导出记录不存在或已过期，请重新演练后再导出。', 404);
    const {state, extra} = item;
    const record = {
      settings: state.settings,
      patientInfo: state.patientInfo,
      doctor: state.doctor,
      log: state.log,
      scores: state.scores,
      humanScores: state.humanScores || [],
      hintUsed: state.hintUsed || 0,
      msdRefs: state.msdRefs || [],
      consumerPlain: state.consumerPlain || '',
      teaching: state.teaching || null,
      rounds: state.round,
      ...extra,
    };
    const buf = buildScriptDocx(record);
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="AMI_script_${state.settings.scenario}_${ts}.docx"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (url.pathname.startsWith('/api/doctor/')) {
    return json({error: '模式2（用户扮演医生）暂未开放，将在 M4 实现。'}, 501);
  }

  return json({error: 'Not found'}, 404);
}

export {apiFetch};
