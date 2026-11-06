// AMI 演练台前端：模式1（SSE 自动演练）+ 模式3（逐句扮演译员）+ 量规编辑
'use strict';

const $ = (sel) => document.querySelector(sel);
const LANG_TTS = {'中文': 'zh-CN', '英文': 'en-US', '日文': 'ja-JP', '法语': 'fr-FR', '西班牙语': 'es-ES', '韩文': 'ko-KR'};
const state = {
  config: null,
  mode: 'auto',
  persona: 'professional',
  sessionId: null,
  pending: null,      // {original, round} 等待用户翻译的原话
  drillLangs: null,   // {doctorLanguage, patientLanguage}
  drillScoring: 'ai',
  aiTotals: [],       // 每句 AI 综合得分（百分制，与 pairs 按序对应）
  lastPairs: null,
  running: false,
  rubricPersona: 'professional',
  rubricDraft: null,  // {levelAnchors[], professional:{personaNote,dims}, dual:{...}}
};

// ─── 初始化 ───
async function init() {
  const cfg = await fetch('/api/config').then(r => r.json());
  state.config = cfg;
  $('#modelBadge').textContent = '模型：' + (cfg.dryRun ? '干跑' : (cfg.model || '未配置'));
  $('#dryBadge').hidden = !cfg.dryRun;
  const p = cfg.paramOptions;

  // 场景
  const sc = $('#scenario');
  for (const s of cfg.scenarios) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name + (s.implemented ? '' : '（待实装）');
    opt.disabled = !s.implemented;
    sc.appendChild(opt);
  }
  sc.onchange = () => {
    const cur = cfg.scenarios.find(x => x.id === sc.value);
    $('#scenarioDesc').textContent = cur?.description || '';
    applyRoleUI(cur);
  };
  sc.onchange();

  // 下拉池
  $('#department').innerHTML = p.departments.map(d => `<option>${d}</option>`).join('');
  $('#doctorLanguage').innerHTML = p.doctorLanguages.map(d => `<option>${d}</option>`).join('');
  $('#country').innerHTML = p.countries.map(c => `<option>${c.name}</option>`).join('');
  $('#language').innerHTML = p.languages.map(l => `<option>${l}</option>`).join('');
  $('#gender').innerHTML = p.genders.map(g => `<option>${g}</option>`).join('');
  $('#personality').innerHTML = p.personalities.map(g => `<option>${g}</option>`).join('');
  $('#literacy').innerHTML = p.healthLiteracies.map(g => `<option>${g}</option>`).join('');
  $('#religion').innerHTML = p.religions.map(g => `<option>${g}</option>`).join('');
  $('#diet').innerHTML = p.diets.map(g => `<option>${g}</option>`).join('');
  $('#tabooList').innerHTML = p.taboos.map(g => `<option value="${g}">`).join('');
  $('#diseaseList').innerHTML = p.diseaseExamples.map(d => `<option value="${d}">`).join('');

  // 国家 → 语言联动
  $('#country').onchange = () => {
    const c = p.countries.find(x => x.name === $('#country').value);
    if (c && p.languages.includes(c.language)) $('#language').value = c.language;
  };

  // 标准病人预设：一键填充患者参数
  $('#presetSelect').innerHTML = '<option value="">— 选择后自动填充以下参数 —</option>' +
    p.presets.map((x, i) => `<option value="${i}">${x.label}</option>`).join('');
  $('#presetSelect').onchange = () => {
    const x = p.presets[Number($('#presetSelect').value)];
    if (!x) return;
    $('#disease').value = x.disease;
    $('#country').value = x.country;
    $('#language').value = x.language;
    $('#gender').value = x.gender;
    $('#page').value = x.age;
    $('#personality').value = x.personality;
    $('#literacy').value = x.healthLiteracy;
    $('#religion').value = x.religion;
    $('#diet').value = x.diet;
    $('#taboos').value = x.taboos;
    $('#symptoms').value = x.symptoms;
    $('#history').value = x.history;
    setStatus('已载入标准病人预设：' + x.label);
  };

  $('#randomBtn').onclick = randomPatient;

  // 朗读设置
  if ('speechSynthesis' in window) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
    $('#voiceZh').onchange = () => { state.ttsVoices.zh = $('#voiceZh').value; localStorage.setItem('ami_voice_zh', state.ttsVoices.zh); };
    $('#voiceEn').onchange = () => { state.ttsVoices.en = $('#voiceEn').value; localStorage.setItem('ami_voice_en', state.ttsVoices.en); };
    $('#testZh').onclick = () => speak('您好，我是医疗口译智能体的中文朗读测试，请留意这条语音是否有情感色彩。', '中文');
    $('#testEn').onclick = () => speak('Hello, this is the English voice test of the medical interpreter demo. I have been having a terrible headache since this morning.', '英文');
  }
  $('#personaSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.segBtn');
    if (!btn) return;
    document.querySelectorAll('#personaSeg .segBtn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.persona = btn.dataset.persona;
    $('#personaLabel').textContent = cfg.interpreterTypes.find(t => t.id === state.persona)?.name || '';
  });
  document.querySelectorAll('.modeTab').forEach(tab => {
    tab.onclick = () => {
      if (tab.disabled) return;
      document.querySelectorAll('.modeTab').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      state.mode = tab.dataset.mode;
      $('#roundsField').style.display = state.mode === 'auto' ? '' : 'none';
      $('#scoringField').style.display = state.mode === 'drill' ? '' : 'none';
      resetStage();
    };
  });
  $('#submitBtn').onclick = submitTranslation;
  $('#speechBtn').onclick = () => speechInput('#speechBtn', '#translationInput');
  $('#speechBtnM2').onclick = () => speechInput('#speechBtnM2', '#utteranceInput');
  $('#hintBtn').onclick = askHint;
  $('#submitBtnM2').onclick = submitM2;
  $('#hintBtnM2').onclick = askHintM2;
  $('#finishBtnM2').onclick = finishM2;

  // 右栏标签页
  document.querySelectorAll('.pTab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.pTab').forEach(b => b.classList.remove('active'));
      tab.classList.add('active');
      $('#scoresView').hidden = tab.dataset.ptab !== 'scores';
      $('#rubricView').hidden = tab.dataset.ptab !== 'rubric';
      if (tab.dataset.ptab === 'rubric') loadRubric();
    };
  });
  $('#rubricPersonaSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('.segBtn');
    if (!btn) return;
    document.querySelectorAll('#rubricPersonaSeg .segBtn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.rubricPersona = btn.dataset.rpersona;
    renderRubric();
  });
  $('#addDim').onclick = () => {
    state.rubricDraft[state.rubricPersona].dims.push({key: '', group: '通用', label: '', focus: ''});
    renderDims();
  };
  $('#saveRubric').onclick = saveRubric;
  $('#resetRubric').onclick = async () => {
    if (!confirm('恢复默认量规？当前编辑将丢失。')) return;
    await fetch('/api/rubric/reset', {method: 'POST'});
    await loadRubric();
    rubricStatus('已恢复默认。');
  };

  // 量规后台化：RUBRIC_PUBLIC=0 时隐藏编辑页，不预载量规（译员人设说明随之隐藏）
  const rubricTab = document.querySelector('.pTab[data-ptab="rubric"]');
  if (rubricTab) rubricTab.hidden = !cfg.rubricPublic;
  if (cfg.rubricPublic) {
    await loadRubric(); // 预加载，供 personaNote 展示
    showPersonaNote();
  } else {
    document.querySelectorAll('#rubricPersonaSeg .segBtn').forEach(b => b.disabled = true);
    $('#addDim').disabled = $('#saveRubric').disabled = $('#resetRubric').disabled = true;
  }

  // 视口尺寸变化时重判历史淡出遮罩是否需要启用
  window.addEventListener('resize', updateChatMask);
}

function showPersonaNote() {
  const rub = state.rubricDraft;
  if (!rub) return;
  const persona = rub[state.persona];
  $('#personaNote').innerHTML = persona.personaNote.map(s => '· ' + s).join('<br>') +
    `<br>共 ${persona.dims.length} 个评估维度（每维 1-5 分）。综合得分按 100 分制折算：<b>维度场均分 ÷ 5 × 100</b>`;
}

// ─── 患者随机生成 ───
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomPatient() {
  const p = state.config.paramOptions;
  const country = pick(p.countries);
  $('#country').value = country.name;
  $('#language').value = country.language;
  const gender = pick(p.genders);
  $('#gender').value = gender;
  // 姓名按国家语言组近似：直接留空让后端按国家池取，只有英文国家给出常见名
  $('#pname').value = '';
  $('#page').value = String(20 + Math.floor(Math.random() * 41));
  $('#personality').value = pick(p.personalities);
  $('#literacy').value = pick(p.healthLiteracies);
  $('#religion').value = pick(p.religions);
  $('#diet').value = pick(p.diets);
  $('#taboos').value = Math.random() < 0.5 ? '' : pick(p.taboos);
  $('#symptoms').value = '';
  $('#history').value = '';
  setStatus('已随机生成患者设定（症状/既往症将按疾病由 AI 生成），可手动微调后开始。');
}

function collectParams() {
  return {
    disease: $('#disease').value.trim() || '肾结石',
    country: $('#country').value,
    language: $('#language').value,
    name: $('#pname').value.trim(),
    age: $('#page').value ? Number($('#page').value) : '',
    gender: $('#gender').value,
    personality: $('#personality').value,
    healthLiteracy: $('#literacy').value,
    religion: $('#religion').value,
    diet: $('#diet').value,
    taboos: $('#taboos').value.trim(),
    symptoms: $('#symptoms').value.trim(),
    medicalHistory: $('#history').value.trim(),
    department: $('#department').value,
    doctorLanguage: $('#doctorLanguage').value,
  };
}

// ─── 通用 UI ───
function clearCols() {
  $('#chatCol').innerHTML = '';
  $('#scoreList').innerHTML = '<p class="empty">暂无评分。开始演练后，每句口译都会在此逐维度打分。</p>';
  $('#report').hidden = true;
  $('#refBox').hidden = true;
  $('#refBoxM2').hidden = true;
  $('#inputBoxM2').hidden = true;
  state.aiTotals = [];
  state.lastPairs = null;
  state.sessionId = null;
  const cur = state.config?.scenarios.find(x => x.id === $('#scenario').value);
  applyRoleUI(cur);
  $('#doctorLangLabel').textContent = $('#doctorLanguage').value;
  $('#patientLangLabel').textContent = $('#language').value;
  $('#langPair').textContent = `${$('#doctorLanguage').value} ↔ ${$('#language').value}`;
}

function resetStage() {
  clearCols();
  state.sessionId = null;
  state.pending = null;
  $('#inputBox').hidden = true;
  $('#statusLine').textContent = '';
  $('#startBtn').disabled = false;
}

// 逐字流式输出：总时长 300ms~1.4s 自适应长度；元素被清场移除后自动停止
function typeWriter(el, text) {
  const dur = Math.min(1400, Math.max(300, text.length * 30));
  const step = Math.max(1, Math.ceil(text.length / (dur / 16)));
  let i = 0;
  const timer = setInterval(() => {
    if (!el.isConnected) { clearInterval(timer); return; }
    i = Math.min(text.length, i + step);
    el.textContent = text.slice(0, i);
    $('#chatCol').scrollTop = 1e9;
    if (i >= text.length) clearInterval(timer);
  }, 16);
}

// 历史话轮淡出：仅当内容超出可视区（可滚动）时启用顶部渐隐遮罩，避免首条消息被误淡
function updateChatMask() {
  const el = $('#chatCol');
  el.classList.toggle('fading', el.scrollHeight > el.clientHeight + 120);
}

// 竖排时间线消息：colId 仅用于推断角色（doctorCol/patientCol/interpCol），所有消息按发言顺序流入同一列
const MSG_AVATARS = {doctor: 'av_doctor.svg', patient: 'av_patient.svg', interpreter: 'av_interpreter.svg'};
function msgRole(colId) {
  return colId === '#doctorCol' ? 'doctor' : colId === '#patientCol' ? 'patient' : 'interpreter';
}
function bubble(colId, tagText, text, extraClass = '', lang = '') {
  const role = msgRole(colId);
  const div = document.createElement('div');
  div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '');
  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = MSG_AVATARS[role];
  img.alt = role;
  const main = document.createElement('div');
  main.className = 'msgMain';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = tagText;
  const body = document.createElement('span');
  main.append(tag, body);
  div.append(img, main);
  if (lang) {
    const btn = document.createElement('button');
    btn.className = 'speakBtn';
    btn.textContent = '🔊';
    btn.title = '朗读本条';
    btn.onclick = (e) => { e.stopPropagation(); speak(text, lang, role, role === 'patient' ? $('#gender').value : ''); };
    main.appendChild(btn);
  }
  $('#chatCol').appendChild(div);
  $('#chatCol').scrollTop = 1e9;
  typeWriter(body, text);
  updateChatMask();
  return div;
}

// 文本转语音：浏览器 speechSynthesis（Edge 可调用微软在线自然语音，效果远超本地 SAPI）
// 音色选择持久化在 localStorage；自动优选带 Online/Natural/Neural 的自然音色
state.ttsVoices = {
  zh: localStorage.getItem('ami_voice_zh') || '',
  en: localStorage.getItem('ami_voice_en') || '',
};

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const zh = voices.filter(v => /^zh/i.test(v.lang));
  const en = voices.filter(v => /^en/i.test(v.lang));
  const mark = (n) => /online|natural|neural/i.test(n) ? ' ★' : '';
  const zhSel = $('#voiceZh'), enSel = $('#voiceEn');
  zhSel.innerHTML = zh.length ? zh.map(v => `<option value="${v.name}">${v.name}${mark(v.name)}</option>`).join('') : '<option value="">（无中文语音）</option>';
  enSel.innerHTML = en.length ? en.map(v => `<option value="${v.name}">${v.name}${mark(v.name)}</option>`).join('') : '<option value="">（无英文语音）</option>';
  if (state.ttsVoices.zh && zh.some(v => v.name === state.ttsVoices.zh)) zhSel.value = state.ttsVoices.zh;
  if (state.ttsVoices.en && en.some(v => v.name === state.ttsVoices.en)) enSel.value = state.ttsVoices.en;
  $('#voiceHint').textContent = en.length
    ? (en.some(v => /online|natural|neural/i.test(v.name)) ? '已检测到在线自然音色（★），选中它朗读效果最好。' : '提示：在 Edge 中打开本页可使用微软在线自然音色（★）。')
    : '未检测到英文语音：请改用 Edge 打开本页，或在 Windows 设置 → 时间和语言 → 语音 中添加英文语音包。';
}

function pickVoice(langName) {
  const voices = speechSynthesis.getVoices();
  const zh = langName === '中文';
  const list = voices.filter(v => v.lang.toLowerCase().startsWith(zh ? 'zh' : 'en'));
  if (!list.length) return null;
  const saved = zh ? state.ttsVoices.zh : state.ttsVoices.en;
  return list.find(v => v.name === saved)
    || list.find(v => /online|natural|neural/i.test(v.name))
    || (zh ? list.find(v => /xiaoxiao|晓晓/i.test(v.name)) : null)
    || list[0];
}

// ─── TTS 速效优化：分句停顿 + 角色韵律 + 医疗数字/单位口语化 ───
const NUM_EN = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const NUM_TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
function numToEn(n) {
  if (n < 20) return NUM_EN[n];
  if (n < 100) { const t = Math.floor(n / 10), r = n % 10; return NUM_TENS[t] + (r ? '-' + NUM_EN[r] : ''); }
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return NUM_EN[h] + ' hundred' + (r ? ' ' + numToEn(r) : ''); }
  if (n <= 9999) { const k = Math.floor(n / 1000), r = n % 1000; return numToEn(k) + ' thousand' + (r ? (r < 100 ? ' and ' : ' ') + numToEn(r) : ''); }
  return String(n);
}
// 医疗缩写展开（朗读层做，不动对话文本）
const UNIT_EN = {mg: 'milligrams', ml: 'milliliters', μg: 'micrograms', mcg: 'micrograms', mmHg: 'millimeters of mercury', bpm: 'beats per minute', IU: 'international units', '°C': 'degrees Celsius'};
const UNIT_ZH = {mg: '毫克', ml: '毫升', μg: '微克', mcg: '微克', mmHg: '毫米汞柱', bpm: '每分钟心跳', IU: '国际单位', '°C': '摄氏度'};
function normalizeSpeech(text, isZh) {
  const units = isZh ? UNIT_ZH : UNIT_EN;
  let t = text.replace(/(\d+(?:\.\d+)?)\s*(mg|ml|μg|mcg|mmHg|bpm|IU|°C)\b/gi, (m, num, unit) => {
    const key = Object.keys(units).find(k => k.toLowerCase() === unit.toLowerCase());
    if (!key) return m;
    const n = isZh ? num : (/^\d+$/.test(num) && Number(num) <= 9999 ? numToEn(Number(num)) : num);
    return n + ' ' + units[key];
  });
  if (!isZh) {
    t = t.replace(/(\d+)\.(\d+)/g, (m, a, b) => `${numToEn(Number(a))} point ${b.split('').map(d => NUM_EN[+d]).join(' ')}`);
    t = t.replace(/(\d+)/g, m => Number(m) <= 9999 ? numToEn(Number(m)) : m);
  }
  return t;
}

// 按句级标点切分（保留标点），句间由播放器插入自然停顿——避免长文本一口气匀速念完的机械感
function splitClauses(text) {
  return text.match(/\S[^。！？；!?;]*[。！？；!?;]?/g) || [text];
}

let speakToken = 0, speakTimer = null, speakAudio = null, speakAbort = null;

// 朗读：中/英/日/韩优先走服务端 CosyVoice2（情感自然）；法/西或服务失败回退浏览器合成
async function speak(text, lang, role, gender) {
  if (!('speechSynthesis' in window)) { setStatus('当前浏览器不支持语音合成'); return; }
  speechSynthesis.cancel();
  clearTimeout(speakTimer);
  speakToken++;
  const token = speakToken;
  if (['中文', '英文', '英语', '日文', '韩文'].includes(lang)) {
    try {
      if (speakAudio) { speakAudio.pause(); speakAudio = null; }
      if (speakAbort) speakAbort.abort();
      speakAbort = new AbortController();
      const resp = await fetch('/api/tts', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text, lang, role, gender}),
        signal: speakAbort.signal,
      });
      if (!resp.ok) throw new Error(await respError(resp));
      const blob = await resp.blob();
      if (token !== speakToken) return; // 已被新的朗读打断
      speakAudio = new Audio(URL.createObjectURL(blob));
      await speakAudio.play();
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (token !== speakToken) return;
      setStatus('服务端朗读失败，回退浏览器合成：' + e.message);
    }
  }
  browserSpeak(text, lang, role);
}

// 浏览器合成回退：分句停顿 + 角色韵律 + 数字口语化
function browserSpeak(text, lang, role) {
  const token = speakToken;
  const isZh = lang === '中文';
  const voice = pickVoice(lang);
  const personality = $('#personality')?.value || '平和';
  let rate = 0.95, pitch = 1;
  if (role === 'doctor') { rate = 0.9; pitch = 0.95; }
  else if (role === 'patient') {
    rate = personality === '急躁' ? 1.08 : personality === '焦虑' ? 1.02 : 0.98;
    pitch = personality === '焦虑' ? 1.1 : personality === '开朗' ? 1.05 : 1;
  }
  const parts = splitClauses(normalizeSpeech(text, isZh));
  let i = 0;
  const next = () => {
    if (token !== speakToken || i >= parts.length) return;
    const u = new SpeechSynthesisUtterance(parts[i++]);
    u.lang = voice?.lang || LANG_TTS[lang] || (isZh ? 'zh-CN' : 'en-US');
    if (voice) u.voice = voice;
    u.rate = rate;
    u.pitch = pitch;
    u.onend = () => { speakTimer = setTimeout(next, isZh ? 180 : 140); };
    speechSynthesis.speak(u);
  };
  next();
}

function setStatus(text) { $('#statusLine').textContent = text; }

// 非 200 响应统一提取错误信息（服务端错误为 JSON {error}）
async function respError(resp) {
  try { const d = await resp.json(); if (d.error) return d.error; } catch { /* 非 JSON */ }
  return `HTTP ${resp.status}`;
}

function roleLabel() {
  const cur = state.config?.scenarios.find(x => x.id === $('#scenario').value);
  return cur?.roleLabel || '医生';
}

// 角色随场景联动：列头标签、设定组标题、科室显隐、头像（模块顶层，clearCols 与场景切换共用）
function applyRoleUI(cur) {
  const rl = cur?.roleLabel || '医生';
  $('#doctorRoleLabel').textContent = rl;
  $('#doctorSummary').textContent = rl + '设定';
  $('#departmentField').style.display = cur?.department === false ? 'none' : '';
  $('#doctorAvatar').src = rl === '前台护士' ? 'av_receptionist.svg' : 'av_doctor.svg';
}
function dirLabel(dir) {
  const rl = roleLabel();
  const short = rl === '前台护士' ? '前台' : rl;
  return dir === 'to_patient' ? `${short}→患` : `患→${short}`;
}

// ─── 模式1：自动演练（SSE）───
async function startAuto() {
  clearCols();
  const body = {
    scenario: $('#scenario').value,
    interpreterType: state.persona,
    params: collectParams(),
    maxRounds: Number($('#maxRounds').value) || 4,
  };
  const resp = await fetch('/api/auto', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(await respError(resp));  // 非 200 直接报错，避免静默失败
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      handleAutoEvent(JSON.parse(line.slice(6)));
    }
  }
}

function handleAutoEvent(ev) {
  switch (ev.type) {
    case 'status': setStatus(ev.label); break;
    case 'info':
      setStatus(`患者：${ev.patientInfo.name}（${ev.patientInfo.age}岁 · ${ev.patientInfo.country} · ${ev.patientInfo.personality}）`);
      $('#patientLangLabel').textContent = ev.patientInfo.language;
      $('#langPair').textContent = `${ev.patientInfo ? $('#doctorLanguage').value : '中文'} ↔ ${ev.patientInfo.language}`;
      break;
    case 'round': break;
    case 'message': {
      if (ev.speaker === 'doctor') bubble('#doctorCol', `${roleLabel()} · 第${ev.round}轮`, ev.text, '', ev.lang);
      else if (ev.speaker === 'patient') bubble('#patientCol', `患者 · 第${ev.round}轮`, ev.text, '', ev.lang);
      else bubble('#interpCol', ev.dir === 'to_patient' ? `译给患者（${ev.lang}）` : `译给${roleLabel()}（${ev.lang}）`, ev.text, '', ev.lang);
      break;
    }
    case 'score': addScoreCard(ev.score, `第${ev.round}轮 · ${dirLabel(ev.for)}`); break;
    case 'done': {
      const who = ev.stopped === 'doctor' ? roleLabel() : ev.stopped === 'patient' ? '患者' : ev.stopped === 'interpreter' ? '译员' : '';
      setStatus(`演练结束（${who ? who + '终止' : '达到最大轮数'}，共 ${ev.rounds} 轮${ev.saved ? '，已存档 ' + ev.saved : ''}）`);
      renderReport(ev.report);
      showExport(ev.exportId);
      $('#startBtn').disabled = false;
      break;
    }
    case 'error': setStatus('出错：' + ev.error); $('#startBtn').disabled = false; break;
  }
}

// ─── 模式3：扮演译员 ───
async function startDrill() {
  clearCols();
  const scoringMode = $('#scoringMode').value;
  state.drillScoring = scoringMode;
  const resp = await fetch('/api/drill/start', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({scenario: $('#scenario').value, interpreterType: state.persona, scoringMode, params: collectParams()}),
  });
  const data = await resp.json();
  if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }
  state.sessionId = data.sessionId;
  state.drillLangs = {doctorLanguage: data.settings.doctorLanguage, patientLanguage: data.settings.patientLanguage};
  $('#doctorLangLabel').textContent = data.settings.doctorLanguage;
  $('#patientLangLabel').textContent = data.settings.patientLanguage;
  $('#langPair').textContent = `${data.settings.doctorLanguage} ↔ ${data.settings.patientLanguage}`;
  bubble('#doctorCol', `${roleLabel()} · 第${data.first.round}轮`, data.first.text, '', data.first.lang);
  state.pending = {original: data.first.text, round: data.first.round};
  state.pendingTarget = 'to_patient';
  $('#inputHint').textContent = `请将医生的话译成${data.settings.patientLanguage}（参考要点：${data.hints[0]?.title || ''}）`;
  $('#inputBox').hidden = false;
  $('#translationInput').value = '';
  setStatus(`患者：${data.patientInfo.name}（${data.patientInfo.age}岁 · ${data.patientInfo.country}）· 你以【${data.settings.personaName}】身份开始口译，满分 100`);
}

async function submitTranslation() {
  const text = $('#translationInput').value.trim();
  if (!text || !state.sessionId || state.running) return;
  state.running = true;
  $('#submitBtn').disabled = true;
  const dirText = state.pendingTarget === 'to_patient'
    ? `译给患者（${state.drillLangs.patientLanguage}）`
    : `译给${roleLabel()}（${state.drillLangs.doctorLanguage}）`;
  bubble('#interpCol', '我的译文 · ' + dirText, text, 'scored');

  try {
    const resp = await fetch('/api/drill/step', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId, translation: text}),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }

    if (data.score) {
      addScoreCard(data.score, `第${state.pending.round}轮 · 我的译文`);
      state.aiTotals.push(data.score.percent ?? Math.round(data.score.total / data.score.perfect * 100));
    } else {
      state.aiTotals.push(null);
    }
    if (data.finished) {
      const who = data.finished.reason === 'patient_terminate' ? '患者' : data.finished.reason === 'doctor_terminate' ? '医生' : '达到轮数上限';
      setStatus(`演练结束：${who}终止了对话。`);
      state.lastPairs = data.pairs || [];
      renderReport(data.report);
      renderFeedback(data.feedback);
      showExport(data.exportId);
      state.sessionId = null;
      $('#inputBox').hidden = true;
      $('#startBtn').disabled = false;
      return;
    }
    if (data.next) {
      const col = data.next.speaker === 'doctor' ? '#doctorCol' : '#patientCol';
      bubble(col, `${data.next.speaker === 'doctor' ? roleLabel() : '患者'} · 第${data.next.round}轮`, data.next.text, '', data.next.lang);
      state.pending = {original: data.next.text, round: data.next.round};
      state.pendingTarget = data.next.speaker === 'doctor' ? 'to_patient' : 'to_doctor';
      const target = data.next.speaker === 'doctor' ? state.drillLangs.patientLanguage : state.drillLangs.doctorLanguage;
      $('#inputHint').textContent = `请将${data.next.speaker === 'doctor' ? roleLabel() : '患者'}的话译成${target}` +
        (data.hint ? `（参考要点：${data.hint.title} — ${data.hint.zh}）` : '');
    }
    $('#translationInput').value = '';
  } finally {
    state.running = false;
    $('#submitBtn').disabled = false;
  }
}

// ─── 评分与报告 ───
function scoreClass(ratio) { return ratio >= .8 ? 'good' : ratio >= .6 ? 'mid' : 'low'; }

function addScoreCard(score, label) {
  const list = $('#scoreList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const card = document.createElement('div');
  card.className = 'scoreCard';
  card.innerHTML = `
    <div class="head"><span>${label}</span>
      <span class="total ${scoreClass(score.percent / 100)}">${score.percent} / 100</span></div>
    <div class="comment"></div>
    <div class="kp"></div>`;
  card.querySelector('.comment').textContent = score.comment || '';
  card.querySelector('.kp').textContent = score.key_point ? '要点：' + score.key_point : '';
  list.prepend(card);
  const bubbles = document.querySelectorAll('#chatCol .msg.interpreter');
  if (bubbles.length) bubbles[bubbles.length - 1].classList.add('scored');
}

// 个性化反馈（#3）：逐句参考译文对照 + 提升方案
function renderFeedback(fb) {
  const box = $('#feedbackBox');
  if (!fb || (!fb.references?.length && !fb.plan?.length)) { box.hidden = true; return; }
  const refs = (fb.references || []).map(r => {
    const p = (state.lastPairs || []).find(x => x.half === r.half);
    if (!p) return '';
    return `<div class="fbRef"><b>第${r.half}句</b>　原话：${p.original}<br>我的译文：${p.translated}<br><span class="refLine">参考译文：${r.reference}</span></div>`;
  }).join('');
  const plan = (fb.plan || []).map(x =>
    `<li><b>${x.point}</b>：${x.advice}${x.example ? `<br><span class="refLine">示例：${x.example}</span>` : ''}</li>`).join('');
  box.innerHTML = `<h4>逐句参考译文对照</h4>${refs}<h4>个性化提升方案</h4><ul>${plan || '<li>—</li>'}</ul>`;
  box.hidden = false;
}

function renderReport(report) {
  if (!report) return;
  $('#report').hidden = false;
  $('#feedbackBox').hidden = true;
  $('#exportRow').innerHTML = '';
  if (report.totalAvg == null) {
    // 人工评分模式：无 AI 逐维数据
    $('#reportTotal').innerHTML = `人工评分综合 <span style="color:var(--green)">${report.human?.percent ?? '—'}</span> / 100 · 共 ${report.human?.count ?? 0} 句已评分`;
    $('#reportDims').innerHTML = '';
  } else {
    $('#reportTotal').innerHTML = `AI 综合得分 <span style="color:var(--green)">${report.overall}</span> / 100` +
      `（= 维度场均 ${report.totalAvg} ÷ 5 × 100）· 共 ${report.utterances} 句译文，各维度 1-5 分制`;
    $('#reportDims').innerHTML = report.perDim.map(d => `
      <div class="dimRow">
        <div class="name"><span>${d.group} · ${d.label}</span><span>${d.avg}</span></div>
        <div class="dimBar"><i style="width:${(d.avg / 5) * 100}%"></i></div>
      </div>`).join('');
  }
  if (report.human) {
    state.humanCmp = report.human.items.map(h => {
      const ai = state.aiTotals[h.half - 1];
      return `<li>第${h.round}轮 · ${dirLabel(h.dir)} · 人评 ${h.score}/5${ai ? ` · AI 折算 ${ai}/100` : ''}${h.comment ? ` · ${h.comment}` : ''}</li>`;
    }).join('');
  } else state.humanCmp = '';
  renderHumanScoring(report);
  $('#reportKeys').innerHTML = report.keyPoints.map(k => `<li>${k}</li>`).join('') || '<li>—</li>';
  $('#reportComments').innerHTML = state.humanCmp + ((report.comments || []).map(c => `<li>${c}</li>`).join('') || '<li>—</li>');
}

// 人工评分表单（结束后逐句打分，双轨/人工模式可用）
function renderHumanScoring(report) {
  const box = $('#humanBox');
  if (state.mode !== 'drill' || !state.lastPairs?.length) { box.hidden = true; return; }
  box.hidden = false;
  $('#humanRows').innerHTML = state.lastPairs.map(p => {
    const ai = state.aiTotals[p.half - 1];
    return `
    <div class="humanRow" data-half="${p.half}">
      <div class="pairHead"><span>第${p.round}轮 · ${dirLabel(p.dir)}</span><span>${ai ? `AI ${ai}/100` : 'AI 未评分'}</span></div>
      <div class="pairText">原话：${p.original}</div>
      <div class="pairText">译文：${p.translated}</div>
      <div class="pairCtrl">
        <select class="hs">
          <option value="">未评</option>
          <option value="1">1 差</option><option value="2">2 弱</option>
          <option value="3">3 合格</option><option value="4">4 良好</option><option value="5">5 优秀</option>
        </select>
        <input class="cm" placeholder="评语（可选）">
      </div>
    </div>`;
  }).join('');
  $('#submitHuman').onclick = submitHumanScores;
}

async function submitHumanScores() {
  const scores = [...document.querySelectorAll('#humanRows .humanRow')].map(row => ({
    half: Number(row.dataset.half),
    score: Number(row.querySelector('.hs').value) || 0,
    comment: row.querySelector('.cm').value.trim(),
  })).filter(h => h.score >= 1);
  if (!scores.length) { $('#humanStatus').textContent = '请至少为一句话评分。'; return; }
  $('#submitHuman').disabled = true;
  const resp = await fetch('/api/drill/finish-score', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({exportId: state.lastExportId, scores}),
  });
  const data = await resp.json();
  $('#submitHuman').disabled = false;
  if (!resp.ok) { $('#humanStatus').textContent = '提交失败：' + (data.error || resp.status); return; }
  $('#humanStatus').textContent = `已提交 ${data.report.human?.count || 0} 句人工评分，综合 ${data.report.human?.percent ?? '—'} / 100（维度场均 ${data.report.human?.avg} / 5），已计入报告与 docx 导出。`;
  $('#humanBox').hidden = true;
}

// 参考建议渲染：主参考译文 + 术语/句型/医学/流程四角度
function renderHint(box, data, tip) {
  const a = data.angles || {};
  const rows = [['术语', a.terminology], ['句型', a.idiom], ['医学', a.medical], ['流程', a.workflow]]
    .filter(x => x[1])
    .map(([k, v]) => `<div class="angleRow"><b>${k}</b>${v}</div>`).join('');
  box.innerHTML = `<span class="tag">参考建议（${data.targetLang}，${tip}）</span>` +
    `<div class="angleMain">${data.reference}</div>` + rows;
  box.hidden = false;
}

// ─── 参考建议（卡住时给出当下应当说的译文）───
async function askHint() {
  if (!state.sessionId) return;
  $('#hintBtn').disabled = true;
  try {
    const resp = await fetch('/api/drill/hint', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId}),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }
    renderHint($('#refBox'), data, '正式口译中应先尝试自己翻译');
  } finally {
    $('#hintBtn').disabled = false;
  }
}

// ─── 模式2：我扮演医生（与患者智能体直接对话，无译员）───
async function startM2() {
  clearCols();
  const resp = await fetch('/api/m2/start', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({scenario: $('#scenario').value, params: collectParams()}),
  });
  const data = await resp.json();
  if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }
  state.sessionId = data.sessionId;
  state.drillLangs = {doctorLanguage: '中文', patientLanguage: data.settings.patientLanguage};
  state.m2Half = 0;
  $('#patientLangLabel').textContent = data.settings.patientLanguage;
  $('#doctorLangLabel').textContent = '中文';
  $('#langPair').textContent = `中文 ↔ ${data.settings.patientLanguage}`;
  setStatus(`患者：${data.patientInfo.name}（${data.patientInfo.age}岁 · ${data.patientInfo.country} · ${data.patientInfo.personality}）· 评分量规【医护英语沟通】满分 100`);
  $('#inputHintM2').textContent = `请你以医生身份先开口（${data.settings.patientLanguage}）：${data.openingGuide}`;
  $('#inputBoxM2').hidden = false;
  $('#utteranceInput').value = '';
}

async function submitM2() {
  const text = $('#utteranceInput').value.trim();
  if (!text || !state.sessionId || state.running) return;
  state.running = true;
  $('#submitBtnM2').disabled = true;
  state.m2Half += 1;
  bubble('#doctorCol', `我（医生） · 第${state.m2Half}句`, text, 'scored');
  try {
    const resp = await fetch('/api/m2/turn', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId, utterance: text}),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }
    if (data.score) { addScoreCard(data.score, `第${data.half}句 · 我的表达`); state.aiTotals.push(data.score.percent ?? Math.round(data.score.total / data.score.perfect * 100)); }
    if (data.finished) {
      const who = data.finished.reason === 'patient_terminate' ? '患者终止' : '达到句数上限';
      setStatus(`演练结束（${who}）`);
      renderReport(data.report);
      showExport(data.exportId);
      state.sessionId = null;
      $('#inputBoxM2').hidden = true;
      $('#startBtn').disabled = false;
      return;
    }
    if (data.next) bubble('#patientCol', `患者 · 第${data.next.round}轮`, data.next.text, '', data.next.lang);
    $('#utteranceInput').value = '';
    $('#inputHintM2').textContent = '继续以医生身份回应（卡住可点参考建议）。';
  } finally {
    state.running = false;
    $('#submitBtnM2').disabled = false;
  }
}

async function askHintM2() {
  if (!state.sessionId) return;
  $('#hintBtnM2').disabled = true;
  try {
    const resp = await fetch('/api/m2/hint', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId}),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }
    renderHint($('#refBoxM2'), data, '建议先自己尝试再参考');
  } finally {
    $('#hintBtnM2').disabled = false;
  }
}

async function finishM2() {
  if (!state.sessionId) return;
  $('#finishBtnM2').disabled = true;
  try {
    const resp = await fetch('/api/m2/finish', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId}),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus('出错：' + (data.error || resp.status)); return; }
    setStatus('演练结束（你主动结束）。');
    renderReport(data.report);
    showExport(data.exportId);
    state.sessionId = null;
    $('#inputBoxM2').hidden = true;
    $('#startBtn').disabled = false;
  } finally {
    $('#finishBtnM2').disabled = false;
  }
}

// ─── 剧本导出（docx）───
function showExport(exportId) {
  if (!exportId) return;
  state.lastExportId = exportId;
  $('#exportRow').innerHTML = `<a href="/api/export/${exportId}" download>⬇ 下载剧本（docx）</a>`;
}

// ─── 量规编辑 ───
async function loadRubric() {
  state.rubricDraft = await fetch('/api/rubric').then(r => r.json());
  renderRubric();
}

function renderRubric() {
  const rub = state.rubricDraft;
  const persona = rub[state.rubricPersona];
  $('#anchor0').value = rub.levelAnchors[0] || '';
  $('#anchor1').value = rub.levelAnchors[1] || '';
  $('#anchor2').value = rub.levelAnchors[2] || '';
  $('#personaNotes').value = persona.personaNote.join('\n');
  renderDims();
}

function renderDims() {
  const dims = state.rubricDraft[state.rubricPersona].dims;
  $('#dimRows').innerHTML = '';
  dims.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'dimEdit';
    row.innerHTML = `
      <div class="dimEditHead">
        <input class="dKey" placeholder="key" title="评分 JSON 字段名">
        <input class="dGroup" placeholder="维度组">
        <button class="delDim ghost" title="删除该维度">✕</button>
      </div>
      <input class="dLabel" placeholder="维度名称">
      <input class="dFocus" placeholder="评分关注点">`;
    row.querySelector('.dKey').value = d.key;
    row.querySelector('.dGroup').value = d.group;
    row.querySelector('.dLabel').value = d.label;
    row.querySelector('.dFocus').value = d.focus;
    row.querySelector('.delDim').onclick = () => {
      state.rubricDraft[state.rubricPersona].dims.splice(i, 1);
      renderDims();
    };
    $('#dimRows').appendChild(row);
  });
}

function collectRubric() {
  const dims = [...document.querySelectorAll('#dimRows .dimEdit')].map(row => ({
    key: row.querySelector('.dKey').value.trim(),
    group: row.querySelector('.dGroup').value.trim(),
    label: row.querySelector('.dLabel').value.trim(),
    focus: row.querySelector('.dFocus').value.trim(),
  }));
  return {
    persona: state.rubricPersona,
    personaNote: $('#personaNotes').value.split('\n').map(s => s.trim()).filter(Boolean),
    dims,
  };
}

async function saveRubric() {
  const body = collectRubric();
  const resp = await fetch('/api/rubric/save', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) { rubricStatus('保存失败：' + (data.error || resp.status)); return; }
  state.rubricDraft = await fetch('/api/rubric').then(r => r.json());
  renderRubric();
  showPersonaNote();
  rubricStatus('已保存，后续演练按新量规评分。');
}

function rubricStatus(text) { $('#rubricStatus').textContent = text; }

// ─── 语音输入：MediaRecorder 录音 → 服务端 SenseVoice 转写（#12，替代不可靠的 Web Speech API）───
let recState = null; // {recorder, stream, chunks}
async function speechInput(btnId, inputSel) {
  const btn = $(btnId);
  // 录音中：再次点击 → 停止并识别
  if (recState) {
    recState.recorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    setStatus('当前浏览器不支持录音，请直接键入。'); return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: true});
  } catch (e) {
    setStatus('无法访问麦克风：' + e.message); return;
  }
  const chunks = [];
  const recorder = new MediaRecorder(stream);
  recState = {recorder, stream, chunks};
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    recState = null;
    btn.textContent = '🎤 语音';
    btn.disabled = true;
    const blob = new Blob(chunks, {type: recorder.mimeType || 'audio/webm'});
    try {
      const fd = new FormData();
      fd.append('file', blob, 'rec.webm');
      const resp = await fetch('/api/asr', {method: 'POST', body: fd});
      const data = await resp.json();
      if (!resp.ok) { setStatus('语音识别失败：' + (data.error || resp.status)); return; }
      if (!data.text) { setStatus('没有识别到内容，请再试一次。'); return; }
      $(inputSel).value = ($(inputSel).value ? $(inputSel).value + ' ' : '') + data.text;
      setStatus('语音已转入，请核对后提交。');
    } finally {
      btn.disabled = false;
    }
  };
  recorder.start();
  btn.textContent = '⏹ 停止';
  setStatus('录音中…说完后点「停止」。');
}

// ─── 启动 ───
$('#startBtn').onclick = () => {
  resetStage();
  $('#startBtn').disabled = true;
  setStatus(state.mode === 'auto' ? '多智能体演练进行中…' : state.mode === 'drill' ? '生成患者与医生开场…' : '生成患者设定…');
  (state.mode === 'auto' ? startAuto() : state.mode === 'drill' ? startDrill() : startM2()).catch(e => {
    setStatus('出错：' + e.message);
    $('#startBtn').disabled = false;
  });
};

init().catch(e => { $('#modelBadge').textContent = '初始化失败：' + e.message; });
