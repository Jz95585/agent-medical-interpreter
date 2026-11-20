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
  transcript: [],     // {role, dir, text} 三种模式共用的演练记录快照，供 AI 答疑上下文
  askTarget: null,    // {role, dir, text, translated, tag} 气泡 ❓ 定位的针对句
  askBusy: false,
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
    reloadPromptsIfActive();
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

  // 疾病 → 推荐科室联动：两级匹配——本地字典精确命中（快、零成本）→ 未收录时 AI 兜底。
  // input 只做本地匹配（避免逐字调 LLM）；change（失焦/回车/选中候选）才触发 AI 匹配。
  let deptReqSeq = 0; // 防竞态：连续输入时只采纳最后一次请求的结果
  const syncDepartment = (notifyMissing, silent = false) => {
    const disease = $('#disease').value.trim();
    if (!disease) return;
    const dept = p.diseaseDepartments?.[disease];
    if (dept) {
      if ($('#department').value !== dept) {
        $('#department').value = dept;
        if (!silent) setStatus('已按疾病「' + disease + '」推荐科室：' + dept + '（可手动调整）');
      }
      clearAlert();
      return;
    }
    if (!notifyMissing) return; // input 阶段未命中：静默等 change 再走 AI 匹配
    const token = ++deptReqSeq;
    setStatus('正在通过 AI 匹配疾病「' + disease + '」的科室…');
    fetch('/api/dept?disease=' + encodeURIComponent(disease))
      .then(r => r.json())
      .then(data => {
        if (token !== deptReqSeq) return; // 已被更新的输入取代，丢弃过期结果
        if (data.department) {
          $('#department').value = data.department;
          setStatus('已通过 AI 匹配疾病「' + disease + '」的科室：' + data.department + '（可手动调整）');
          clearAlert();
        } else {
          const msg = '疾病「' + disease + '」暂无法匹配合适的科室，请手动选择「医生设定」里的科室。';
          setStatus(msg);
          showAlert(msg, 'warn');
        }
      })
      .catch(() => {
        if (token !== deptReqSeq) return;
        const msg = '科室匹配服务暂时不可用，请手动选择科室。';
        setStatus(msg);
        showAlert(msg, 'warn');
      });
  };
  // input 只做本地字典切换；change（失焦/回车/选中候选）才触发 AI 兜底匹配
  $('#disease').addEventListener('input', () => syncDepartment(false));
  $('#disease').addEventListener('change', () => syncDepartment(true));
  // 初始渲染也同步一次：默认疾病「肾结石」→ 泌尿外科，不再停在科室表第一项（静默，不弹提示）
  syncDepartment(false, true);

  // 标准病人预设：一键填充患者参数
  $('#presetSelect').innerHTML = '<option value="">— 选择后自动填充以下参数 —</option>' +
    p.presets.map((x, i) => `<option value="${i}">${x.label}</option>`).join('');
  $('#presetSelect').onchange = () => {
    const x = p.presets[Number($('#presetSelect').value)];
    if (!x) return;
    $('#disease').value = x.disease;
    if (x.department) $('#department').value = x.department;
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
    reloadPromptsIfActive();
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
  $('#askSend').onclick = sendAsk;
  $('#askClear').onclick = () => {
    $('#askLog').innerHTML = '<p class="empty">还没有提问。可直接输入，或点击对话气泡上的 ❓ 针对某一句提问。</p>';
    state.askTarget = null;
  };
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
      $('#askView').hidden = tab.dataset.ptab !== 'ask';
      $('#rubricView').hidden = tab.dataset.ptab !== 'rubric';
      $('#promptsView').hidden = tab.dataset.ptab !== 'prompts';
      if (tab.dataset.ptab === 'rubric') loadRubric();
      if (tab.dataset.ptab === 'prompts') loadPrompts();
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

  // 量规后台化：RUBRIC_PUBLIC=0 时隐藏量规编辑页与提示词页，不预载量规
  const rubricTab = document.querySelector('.pTab[data-ptab="rubric"]');
  if (rubricTab) rubricTab.hidden = !cfg.rubricPublic;
  const promptsTab = document.querySelector('.pTab[data-ptab="prompts"]');
  if (promptsTab) promptsTab.hidden = !cfg.rubricPublic;
  if (cfg.rubricPublic) {
    await loadRubric(); // 预加载，供 personaNote 展示
    showPersonaNote();
  } else {
    document.querySelectorAll('#rubricPersonaSeg .segBtn').forEach(b => b.disabled = true);
    $('#addDim').disabled = $('#saveRubric').disabled = $('#resetRubric').disabled = true;
  }

  // 视口尺寸变化时重判历史淡出遮罩是否需要启用
  window.addEventListener('resize', updateChatMask);

  // 自动播放开关（localStorage 记忆，默认手动模式）
  state.autoSpeak = localStorage.getItem('ami_autospeak') === '1';
  const asBtn = $('#autoSpeakBtn');
  const renderAutoSpeak = () => {
    asBtn.textContent = state.autoSpeak ? '🔊 自动播放：开' : '🔊 自动播放：关';
    asBtn.classList.toggle('on', state.autoSpeak);
  };
  renderAutoSpeak();
  asBtn.onclick = () => {
    state.autoSpeak = !state.autoSpeak;
    localStorage.setItem('ami_autospeak', state.autoSpeak ? '1' : '0');
    if (!state.autoSpeak) { speakQueueGen++; stopSpeakAll(); } // 关闭即停止当前朗读并清空队列
    renderAutoSpeak();
  };
}

function showPersonaNote() {
  const rub = state.rubricDraft;
  if (!rub) return;
  const persona = rub[state.persona];
  $('#personaNote').innerHTML = persona.personaNote.map(s => '· ' + s).join('<br>') +
    `<br>共 ${persona.dims.length} 个评估维度（每维 1-5 分）。综合得分按 100 分制折算：<b>维度场均分 ÷ 5 × 100</b>`;
}

function reloadPromptsIfActive() {
  const tab = document.querySelector('.pTab[data-ptab="prompts"]');
  if (tab && !tab.hidden && tab.classList.contains('active')) loadPrompts();
}

// 提示词只读展示：按当前场景+译员类型拉取各智能体实际运行的系统提示词
async function loadPrompts() {
  try {
    const qs = new URLSearchParams({
      scenario: $('#scenario').value,
      interpreterType: state.persona,
    });
    const resp = await fetch('/api/prompts?' + qs);
    const data = await resp.json();
    if (!resp.ok) { $('#promptBody').innerHTML = '<p class="empty">' + (data.error || resp.status) + '</p>'; return; }
    const sec = (title, body) => `<div class="promptSec"><h4>${title}</h4><pre>${body}</pre></div>`;
    $('#promptBody').innerHTML =
      `<p class="desc">场景：${data.scenarioName} · 译员类型：${data.interpreterType}</p>` +
      sec('医生/前台 · 系统提示词（含终止条件）', data.doctorSystem) +
      sec('患者 · 系统提示词', data.patientSystem) +
      sec('译员 · 系统提示词', data.interpreterSystem) +
      sec('评判员 · 系统提示词（评分量规）', data.judgeSystem) +
      sec('管理者 · 系统提示词（终止判定）', data.managerSystem);
  } catch (e) {
    $('#promptBody').innerHTML = '<p class="empty">加载失败：' + e.message + '</p>';
  }
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
  speakQueueGen++; // 清场停止自动播放队列与当前朗读
  stopSpeakAll();
  clearAlert();
  // 注意：这里不能动 stopBtn 的可见性——startAuto 等启动函数清场时按钮刚被 startBtn 处理器打开，
  // 在此隐藏会导致"中止演练"按钮全程不可见（由 resetStage/事件处理器统一管理）
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
  $('#stopBtn').hidden = true; // 模式切换/重开时隐藏，模式1 开始后由 startBtn 处理器打开
  state.sessionId = null;
  state.pending = null;
  state.transcript = []; // 新演练重置答疑上下文快照
  state.askTarget = null;
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
const MSG_AVATARS = {doctor: 'av_doctor.svg', patient: 'av_patient.svg', interpreter: 'av_interpreter.svg', receptionist: 'av_receptionist.svg'};
function msgRole(colId) {
  return colId === '#doctorCol' ? 'doctor' : colId === '#patientCol' ? 'patient' : 'interpreter';
}
function bubble(colId, tagText, text, extraClass = '', lang = '', dir = '', roleOverride = '') {
  const role = roleOverride || msgRole(colId);
  // 答疑上下文快照：三种模式的所有演练话轮统一收进来
  state.transcript.push({role, dir, text});
  const div = document.createElement('div');
  // dir：译员消息的翻译方向——to_patient 与医生同侧（左），to_doctor 与患者同侧（右）
  div.className = 'msg ' + role + (extraClass ? ' ' + extraClass : '') + (dir ? ' dir-' + dir : '');
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
  // ❓ 针对本句提问：切到 AI 答疑页并带入该句上下文
  const askBtn = document.createElement('button');
  askBtn.className = 'speakBtn askBtn';
  askBtn.textContent = '❓';
  askBtn.title = '就这句向 AI 答疑提问';
  askBtn.onclick = (e) => {
    e.stopPropagation();
    state.askTarget = {role, dir, text, tag: tagText};
    $('#askInput').value = `关于这句（${tagText}）「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」，为什么要这样处理？`;
    document.querySelector('.pTab[data-ptab="ask"]').click();
    $('#askInput').focus();
  };
  main.appendChild(askBtn);
  if (lang) {
    const btn = document.createElement('button');
    btn.className = 'speakBtn';
    btn.textContent = '🔊';
    btn.title = '朗读本条';
    btn.onclick = (e) => {
      e.stopPropagation();
      speakQueueGen++; // 手动播放打断自动播放队列
      stopSpeakAll();
      speak(text, lang, role, role === 'patient' ? $('#gender').value : '');
    };
    main.appendChild(btn);
  }
  $('#chatCol').appendChild(div);
  $('#chatCol').scrollTop = 1e9;
  typeWriter(body, text);
  updateChatMask();
  if (lang && state.autoSpeak && shouldAutoRead(role)) enqueueSpeak(text, lang, role, role === 'patient' ? $('#gender').value : '');
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
let speakQueue = Promise.resolve(), speakQueueGen = 0; // 自动播放队列；手动播放/清场时代数+1 使挂起任务失效

// 停止当前所有朗读
function stopSpeakAll() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  clearTimeout(speakTimer);
  if (speakAudio) { speakAudio.pause(); speakAudio = null; }
}

// 自动播放：消息入队，播完一条再下一条；手动播放或关闭开关会让队列代数过期而跳过
function enqueueSpeak(text, lang, role, gender) {
  const gen = speakQueueGen;
  speakQueue = speakQueue.then(async () => {
    if (!state.autoSpeak || gen !== speakQueueGen) return;
    await speak(text, lang, role, gender);
  }).catch(() => {});
}

// 自动播放资格：模式1 三个角色全读；模式3 读医患原话（译员是用户自己）；模式2 只读患者
function shouldAutoRead(role) {
  if (role === 'patient') return true;
  if (role === 'interpreter') return state.mode === 'auto';
  if (role === 'doctor') return state.mode !== 'm2';
  return false;
}

// 立即朗读（手动点击或队列内部调用），返回播放完成的 Promise；可被下一次 speak 打断
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
      const audio = new Audio(URL.createObjectURL(blob));
      speakAudio = audio;
      await audio.play();
      await new Promise(res => { audio.onended = res; audio.onerror = res; });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (token !== speakToken) return;
      setStatus('服务端朗读失败，回退浏览器合成：' + e.message);
    }
  }
  await browserSpeak(text, lang, role);
}

// 浏览器合成回退：角色韵律 + 数字口语化；返回朗读完成的 Promise
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
  const normalized = normalizeSpeech(text, isZh);
  const speakOne = (t) => new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(t);
    u.lang = voice?.lang || LANG_TTS[lang] || (isZh ? 'zh-CN' : 'en-US');
    if (voice) u.voice = voice;
    u.rate = rate;
    u.pitch = pitch;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
  // 在线自然音色自带气口与语调，整句合成避免与人工分句停顿叠加造成异常断句；
  // 本地机械引擎（如 SAPI）才需要分句 + 气口改善听感
  const natural = voice && /online|natural|neural/i.test(voice.name);
  if (natural) return speakOne(normalized);
  const parts = splitClauses(normalized);
  return (async () => {
    let i = 0;
    while (i < parts.length) {
      if (token !== speakToken) return;
      await speakOne(parts[i++]);
      if (i < parts.length) await new Promise(r => { speakTimer = setTimeout(r, isZh ? 180 : 140); });
    }
  })();
}

function setStatus(text) { $('#statusLine').textContent = text; }

// 对话区底部告警：出错时确保用户能立刻看到，而不是只落在左侧小字里
function showAlert(text, kind = 'error') {
  const el = $('#alertBox');
  el.textContent = text;
  el.className = 'alertBox' + (kind === 'warn' ? ' warn' : '');
  el.hidden = false;
  el.scrollIntoView({block: 'nearest'});
}
function clearAlert() {
  const el = $('#alertBox');
  el.hidden = true;
  el.textContent = '';
}

// 把模型/服务错误翻译成对用户有指导意义的话
function friendlyError(msg) {
  if (/长度上限/.test(msg)) return '模型输出超出长度上限，本场演练已中断。请重试；若反复出现，可缩短疾病或症状描述后再试。';
  return msg;
}

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
  state.autoRunId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const body = {
    runId: state.autoRunId,
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
  let sawDone = false;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'done') sawDone = true;
      handleAutoEvent(ev);
    }
  }
  // 流结束但没收到 done：服务端异常断开（如进程重启），复位界面避免卡在"运行中"
  if (!sawDone) {
    setStatus('连接中断：演练流未正常结束，请重试。');
    showAlert('连接中断：演练流未正常结束，请重试；若反复出现请联系开发者查看服务端日志。');
    $('#startBtn').disabled = false;
    $('#stopBtn').hidden = true;
    $('#stopBtn').disabled = false;
  }
}

function handleAutoEvent(ev) {
  try {
    switch (ev.type) {
    case 'status': setStatus(ev.label); break;
    case 'info':
      setStatus(`患者：${ev.patientInfo.name}（${ev.patientInfo.age}岁 · ${ev.patientInfo.country} · ${ev.patientInfo.personality}）`);
      $('#patientLangLabel').textContent = ev.patientInfo.language;
      $('#langPair').textContent = `${ev.patientInfo ? $('#doctorLanguage').value : '中文'} ↔ ${ev.patientInfo.language}`;
      break;
    case 'round': break;
    case 'message': {
      const rnd = ev.round ? `第${ev.round}轮` : '诊前接入';
      if (ev.speaker === 'doctor') bubble('#doctorCol', `${roleLabel()} · ${rnd}`, ev.text, '', ev.lang);
      else if (ev.speaker === 'patient') bubble('#patientCol', `患者 · ${rnd}`, ev.text, '', ev.lang);
      else if (ev.speaker === 'receptionist') bubble('#doctorCol', '前台 · 诊前接入', ev.text, '', ev.lang, '', 'receptionist');
      else bubble('#interpCol', ev.dir === 'to_patient' ? `译给患者（${ev.lang}）` : `译给${roleLabel()}（${ev.lang}）`, ev.text, '', ev.lang, ev.dir);
      break;
    }
    case 'score': addScoreCard(ev.score, `${ev.round ? '第' + ev.round + '轮' : '诊前接入'} · ${dirLabel(ev.for)}`, lastMsg('.msg.interpreter')); break;
    case 'done': {
      $('#stopBtn').hidden = true;
      $('#stopBtn').disabled = false;
      if (ev.stopped === 'user_abort') {
        setStatus(`已中止演练（保留 ${ev.rounds} 轮进度），报告与剧本已生成${ev.saved ? '，已存档 ' + ev.saved : ''}`);
      } else if (ev.stopped === 'error') {
        setStatus(`演练中断，已保存前 ${ev.rounds} 轮进度${ev.saved ? '（' + ev.saved + '）' : ''}`);
      } else {
        const who = ev.stopped === 'doctor' ? roleLabel() : ev.stopped === 'patient' ? '患者' : ev.stopped === 'interpreter' ? '译员' : '';
        setStatus(`演练结束（${who ? who + '终止' : '达到最大轮数'}，共 ${ev.rounds} 轮${ev.saved ? '，已存档 ' + ev.saved : ''}）`);
      }
      renderReport(ev.report);
      showExport(ev.exportId);
      $('#startBtn').disabled = false;
      break;
    }
    case 'error': {
      const m = friendlyError(ev.error);
      setStatus('出错：' + m);
      showAlert('出错：' + m);
      $('#startBtn').disabled = false;
      $('#stopBtn').hidden = true;
      $('#stopBtn').disabled = false;
      break;
    }
  }
  } catch (e) {
    // 单个事件处理失败不应中断整条演练流：记录事件内容便于定位，其余事件继续消费
    console.error('[ami] 演练事件处理异常:', ev?.type, e, ev);
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
  if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }
  state.sessionId = data.sessionId;
  state.drillLangs = {doctorLanguage: data.settings.doctorLanguage, patientLanguage: data.settings.patientLanguage};
  $('#doctorLangLabel').textContent = data.settings.doctorLanguage;
  $('#patientLangLabel').textContent = data.settings.patientLanguage;
  $('#langPair').textContent = `${data.settings.doctorLanguage} ↔ ${data.settings.patientLanguage}`;
  // 诊前接入：路径①先展示前台引荐词（要翻译），路径②直接领开场任务
  if (data.first) bubble('#doctorCol', '前台 · 诊前接入', data.first.text, '', data.first.lang, '', 'receptionist');
  state.pending = {original: data.intakeTask, round: 0};
  state.pendingTarget = 'to_patient';
  $('#inputHint').textContent = data.intakeHint;
  $('#inputBox').hidden = false;
  $('#translationInput').value = '';
  setStatus(`患者：${data.patientInfo.name}（${data.patientInfo.age}岁 · ${data.patientInfo.country}）· 诊前接入：请先完成开场（${data.intake.path === 'reception' ? '前台引荐' : '译员迎候'}路径）`);
}

async function submitTranslation() {
  const text = $('#translationInput').value.trim();
  if (!text || !state.sessionId || state.running) return;
  state.running = true;
  $('#submitBtn').disabled = true;
  const dirText = state.pendingTarget === 'to_patient'
    ? `译给患者（${state.drillLangs.patientLanguage}）`
    : `译给${roleLabel()}（${state.drillLangs.doctorLanguage}）`;
  bubble('#interpCol', '我的译文 · ' + dirText, text, 'scored', '', state.pendingTarget);

  try {
    const resp = await fetch('/api/drill/step', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId, translation: text}),
    });
    const data = await resp.json();
    if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }

    if (data.score) {
      addScoreCard(data.score, `${state.pending.round ? '第' + state.pending.round + '轮' : '诊前接入'} · 我的译文`, lastMsg('.msg.interpreter'));
      state.aiTotals.push(data.score.percent ?? Math.round(data.score.total / data.score.perfect * 100));
    } else {
      state.aiTotals.push(null);
    }
    if (data.finished) {
      const who = data.finished.reason === 'patient_terminate' ? '患者' : data.finished.reason === 'doctor_terminate' ? '医生' : '达到轮数上限';
      setStatus(`演练结束：${who}终止了对话。`);
      state.lastPairs = data.pairs || [];
      renderReport(data.report);
      renderFeedback(data.feedback, state.lastPairs, 'drill');
      showExport(data.exportId);
      state.sessionId = null;
      $('#inputBox').hidden = true;
      $('#startBtn').disabled = false;
      return;
    }
    if (data.reply) {
      // 诊前接入中患者的应答（与医生开场同批返回时，先画患者气泡）
      bubble('#patientCol', `患者 · 诊前接入`, data.reply.text, '', data.reply.lang);
    }
    if (data.next) {
      if (data.next.speaker === 'task') {
        // 诊前接入任务卡（如原则阐述）：不进气泡，直接更新待办与输入提示
        state.pending = {original: data.next.text, round: data.next.round};
        state.pendingTarget = 'to_patient';
        $('#inputHint').textContent = data.next.hint || '';
      } else {
        const rnd = data.next.round ? `第${data.next.round}轮` : '诊前接入';
        const col = data.next.speaker === 'doctor' ? '#doctorCol' : '#patientCol';
        bubble(col, `${data.next.speaker === 'doctor' ? roleLabel() : '患者'} · ${rnd}`, data.next.text, '', data.next.lang);
        state.pending = {original: data.next.text, round: data.next.round};
        state.pendingTarget = data.next.speaker === 'doctor' ? 'to_patient' : 'to_doctor';
        const target = data.next.speaker === 'doctor' ? state.drillLangs.patientLanguage : state.drillLangs.doctorLanguage;
        $('#inputHint').textContent = `请将${data.next.speaker === 'doctor' ? roleLabel() : '患者'}的话译成${target}` +
          (data.hint ? `（参考要点：${data.hint.title} — ${data.hint.zh}）` : '');
      }
    }
    $('#translationInput').value = '';
  } finally {
    state.running = false;
    $('#submitBtn').disabled = false;
  }
}

// ─── 评分与报告 ───
function scoreClass(ratio) { return ratio >= .8 ? 'good' : ratio >= .6 ? 'mid' : 'low'; }

function lastMsg(selector) {
  const list = document.querySelectorAll('#chatCol ' + selector);
  return list.length ? list[list.length - 1] : null;
}

// 点击评分卡定位到对应对话并短暂高亮，方便对照「第 N 轮」找原句
function focusMessage(el) {
  if (!el) return;
  document.querySelectorAll('#chatCol .msg.highlight').forEach(x => x.classList.remove('highlight'));
  el.classList.add('highlight');
  el.scrollIntoView({behavior: 'smooth', block: 'center'});
  setTimeout(() => el.classList.remove('highlight'), 2600);
}

function addScoreCard(score, label, target) {
  const list = $('#scoreList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const card = document.createElement('div');
  card.className = 'scoreCard' + (target ? ' clickable' : '');
  card.innerHTML = `
    <div class="head"><span>${label}</span>
      <span class="total ${scoreClass(score.percent / 100)}">${score.percent} / 100</span></div>
    <div class="comment"></div>
    <div class="rev"></div>
    <div class="polish"></div>
    <div class="kp"></div>`;
  card.querySelector('.comment').textContent = score.comment || '';
  // 针对性修改意见：与总评重复时不再重复展示（模式2 的 comment 即修改意见）
  const rev = score.revision && score.revision !== score.comment ? score.revision : '';
  card.querySelector('.rev').textContent = rev ? '修改意见：' + rev : '';
  card.querySelector('.polish').textContent = score.polish ? '润色建议：' + score.polish : '';
  card.querySelector('.kp').textContent = score.key_point ? '要点：' + score.key_point : '';
  if (target) {
    card.title = '点击定位到对应对话';
    card.onclick = () => focusMessage(target);
  }
  list.prepend(card);
  const targetEl = target || lastMsg('.msg.interpreter');
  if (targetEl) targetEl.classList.add('scored');
}

// 个性化反馈（#3）：逐句对照 + 提升方案；kind 区分模式3 译文与模式2 医生表达
function renderFeedback(fb, pairs, kind = 'drill') {
  const box = $('#feedbackBox');
  if (!fb || (!fb.references?.length && !fb.plan?.length)) { box.hidden = true; return; }
  const list = pairs || [];
  const refs = (fb.references || []).map(r => {
    const p = list.find(x => x.half === r.half);
    if (!p) return '';
    if (kind === 'm2') {
      return `<div class="fbRef"><b>第${r.half}句</b>　我的表达：${p.text}<br><span class="refLine">参考表达：${r.reference}</span>` +
        (r.polish ? `<br><span class="refLine">润色版：${r.polish}</span>` : '') + `</div>`;
    }
    return `<div class="fbRef"><b>第${r.half}句</b>　原话：${p.original}<br>我的译文：${p.translated}<br><span class="refLine">参考译文：${r.reference}</span>` +
      (r.polish ? `<br><span class="refLine">润色版：${r.polish}</span>` : '') + `</div>`;
  }).join('');
  const plan = (fb.plan || []).map(x =>
    `<li><b>${x.point}</b>：${x.advice}${x.example ? `<br><span class="refLine">示例：${x.example}</span>` : ''}</li>`).join('');
  const title = kind === 'm2' ? '逐句表达对照' : '逐句参考译文对照';
  box.innerHTML = `<h4>${title}</h4>${refs}<h4>个性化提升方案</h4><ul>${plan || '<li>—</li>'}</ul>`;
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
    if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }
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
  if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }
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
    if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }
    if (data.score) { addScoreCard(data.score, `第${data.half}句 · 我的表达`, lastMsg('.msg.doctor')); state.aiTotals.push(data.score.percent ?? Math.round(data.score.total / data.score.perfect * 100)); }
    if (data.finished) {
      const who = data.finished.reason === 'patient_terminate' ? '患者终止' : '达到句数上限';
      setStatus(`演练结束（${who}）`);
      state.lastPairs = data.utterances || [];
      renderReport(data.report);
      renderFeedback(data.feedback, state.lastPairs, 'm2');
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
    if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }
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
    if (!resp.ok) { const m = friendlyError(data.error || ('HTTP ' + resp.status)); setStatus('出错：' + m); showAlert('出错：' + m); return; }
    setStatus('演练结束（你主动结束）。');
    state.lastPairs = data.utterances || [];
    renderReport(data.report);
    renderFeedback(data.feedback, state.lastPairs, 'm2');
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

// ─── AI 答疑：就演练内容提问（可针对某一句），联动 MSD 知识库 ───
function appendAskMsg(kind, text, sources) {
  const log = $('#askLog');
  log.querySelector('.empty')?.remove();
  const div = document.createElement('div');
  div.className = 'askMsg ' + kind;
  const who = document.createElement('div');
  who.className = 'askWho';
  who.textContent = kind === 'user' ? '我' : 'AI 助教';
  const body = document.createElement('div');
  body.className = 'askBody';
  body.textContent = text;
  div.append(who, body);
  if (kind === 'ai') {
    if (sources?.length) {
      const src = document.createElement('div');
      src.className = 'askSrc';
      src.textContent = '来源：' + sources.map(s =>
        `[${s.n}] 《${s.title}》${s.topic}${s.subTopic ? '·' + s.subTopic : ''}（${s.source}）`).join('；');
      div.appendChild(src);
    } else {
      const src = document.createElement('div');
      src.className = 'askSrc none';
      src.textContent = '本次回答未引用外部资料';
      div.appendChild(src);
    }
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function sendAsk() {
  const q = $('#askInput').value.trim();
  if (!q || state.askBusy) return;
  appendAskMsg('user', q);
  $('#askInput').value = '';
  state.askBusy = true;
  $('#askSend').disabled = true;
  const target = state.askTarget;
  state.askTarget = null; // 针对句只作用于本次提问
  try {
    const resp = await fetch('/api/ask', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        question: q,
        transcript: state.transcript,
        target,
        disease: $('#disease').value.trim(),
        doctorLanguage: $('#doctorLanguage').value,
        patientLanguage: $('#language').value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { appendAskMsg('ai', '提问失败：' + (data.error || resp.status)); return; }
    appendAskMsg('ai', data.answer || '（AI 未返回内容）', data.sources);
  } catch (e) {
    appendAskMsg('ai', '提问失败：' + friendlyError(e.message));
  } finally {
    state.askBusy = false;
    $('#askSend').disabled = false;
  }
}

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
    // 手机端最常见的"不支持"其实是非 HTTPS：浏览器直接禁用麦克风 API，需说清原因
    if (!window.isSecureContext) {
      setStatus('麦克风需要 HTTPS 访问：当前是 HTTP 连接，浏览器已禁用录音。请改用 https 地址，或临时使用输入法自带的语音键。');
    } else {
      setStatus('当前浏览器不支持录音，请直接键入或使用输入法语音键。');
    }
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: true});
  } catch (e) {
    if (e.name === 'NotAllowedError') setStatus('麦克风权限被拒绝：请在浏览器站点设置中允许麦克风，刷新后重试。');
    else if (e.name === 'NotFoundError') setStatus('未检测到麦克风设备。');
    else setStatus('无法访问麦克风：' + (e.message || e.name));
    return;
  }
  const chunks = [];
  // iOS Safari 只产出 audio/mp4（AAC），Android/桌面为 audio/webm——按浏览器能力选型，避免 iPhone 录音被按 webm 解析失败
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
  let recorder;
  try {
    recorder = mime ? new MediaRecorder(stream, {mimeType: mime}) : new MediaRecorder(stream);
  } catch {
    recorder = new MediaRecorder(stream); // 部分旧机型不接受 mimeType 参数，退回默认
  }
  recState = {recorder, stream, chunks};
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    recState = null;
    btn.textContent = '🎤 语音';
    btn.disabled = true;
    const type = recorder.mimeType || mime || 'audio/webm';
    const ext = /mp4|aac|m4a/.test(type) ? 'mp4' : 'webm';
    const blob = new Blob(chunks, {type});
    try {
      const fd = new FormData();
      fd.append('file', blob, 'rec.' + ext);
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
  $('#stopBtn').hidden = state.mode !== 'auto'; // 模式1 演练中显示"中止演练"
  setStatus(state.mode === 'auto' ? '多智能体演练进行中…' : state.mode === 'drill' ? '生成患者与医生开场…' : '生成患者设定…');
  (state.mode === 'auto' ? startAuto() : state.mode === 'drill' ? startDrill() : startM2()).catch(e => {
    const m = friendlyError(e.message);
    setStatus('出错：' + m);
    showAlert('出错：' + m);
    $('#startBtn').disabled = false;
    $('#stopBtn').hidden = true;
  });
};

// 模式1 中止：协作式终止——服务端当前步骤收尾后照常产出部分报告与存档
$('#stopBtn').onclick = async () => {
  if (!state.autoRunId) return;
  $('#stopBtn').disabled = true;
  setStatus('正在中止演练，生成已完成部分的报告…');
  const resp = await fetch('/api/auto/stop', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({runId: state.autoRunId}),
  });
  if (!resp.ok) {
    setStatus('中止失败：' + await respError(resp));
    $('#stopBtn').disabled = false;
  }
  // 成功后由 SSE 的 done 事件（stopped=user_abort）收尾：渲染报告、复位按钮
};

// 模式3 中止：随时终止并结算已完成部分（报告 + 剧本导出）
$('#stopDrillBtn').onclick = async () => {
  if (!state.sessionId || state.running) return;
  $('#stopDrillBtn').disabled = true;
  try {
    const resp = await fetch('/api/drill/finish', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({sessionId: state.sessionId}),
    });
    const data = await resp.json();
    if (!resp.ok) { setStatus('中止失败：' + (data.error || resp.status)); return; }
    setStatus(`已中止演练（保留 ${data.rounds || 0} 句进度），报告与剧本已生成`);
    state.lastPairs = data.pairs || [];
    renderReport(data.report);
    renderFeedback(data.feedback);
    showExport(data.exportId);
    state.sessionId = null;
    state.pending = null;
    $('#inputBox').hidden = true;
    $('#startBtn').disabled = false;
  } finally {
    $('#stopDrillBtn').disabled = false;
  }
};

init().catch(e => { $('#modelBadge').textContent = '初始化失败：' + e.message; });
