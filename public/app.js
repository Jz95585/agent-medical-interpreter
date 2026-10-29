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
  aiTotals: [],       // 每句 AI 总分（与 pairs 按序对应）
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

  function applyRoleUI(cur) {
    const rl = cur?.roleLabel || '医生';
    $('#doctorRoleLabel').textContent = rl;
    $('#doctorSummary').textContent = rl + '设定';
    $('#departmentField').style.display = cur?.department === false ? 'none' : '';
    $('#doctorAvatar').src = rl === '前台接待员' ? 'av_receptionist.svg' : 'av_doctor.svg';
  }

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
  $('#speechBtn').onclick = speechInput;
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

  await loadRubric(); // 预加载，供 personaNote 展示
  showPersonaNote();
}

function showPersonaNote() {
  const rub = state.rubricDraft;
  if (!rub) return;
  const persona = rub[state.persona];
  $('#personaNote').innerHTML = persona.personaNote.map(s => '· ' + s).join('<br>') +
    `<br>共 ${persona.dims.length} 个维度，满分 ${persona.dims.length * 5}`;
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
  for (const id of ['doctorCol', 'interpCol', 'patientCol']) $('#' + id).innerHTML = '';
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

function bubble(colId, tagText, text, extraClass = '', lang = '') {
  const div = document.createElement('div');
  div.className = 'bubble ' + extraClass;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = tagText;
  const body = document.createElement('span');
  body.textContent = text;
  div.append(tag, body);
  if (lang) {
    const btn = document.createElement('button');
    btn.className = 'speakBtn';
    btn.textContent = '🔊';
    btn.title = '朗读本条';
    btn.onclick = (e) => { e.stopPropagation(); speak(text, lang); };
    div.appendChild(btn);
  }
  $(colId).appendChild(div);
  $(colId).scrollTop = 1e9;
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

function speak(text, lang) {
  if (!('speechSynthesis' in window)) { setStatus('当前浏览器不支持语音合成'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANG_TTS[lang] || (lang === '中文' ? 'zh-CN' : 'en-US');
  const v = pickVoice(lang);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

function setStatus(text) { $('#statusLine').textContent = text; }

function roleLabel() {
  const cur = state.config?.scenarios.find(x => x.id === $('#scenario').value);
  return cur?.roleLabel || '医生';
}
function dirLabel(dir) {
  const rl = roleLabel();
  const short = rl === '前台接待员' ? '前台' : rl;
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
  setStatus(`患者：${data.patientInfo.name}（${data.patientInfo.age}岁 · ${data.patientInfo.country}）· 你以【${data.settings.personaName}】身份开始口译，满分 ${data.settings.perfect}`);
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
      state.aiTotals.push(data.score.total);
    } else {
      state.aiTotals.push(null);
    }
    if (data.finished) {
      const who = data.finished.reason === 'patient_terminate' ? '患者' : data.finished.reason === 'doctor_terminate' ? '医生' : '达到轮数上限';
      setStatus(`演练结束：${who}终止了对话。`);
      state.lastPairs = data.pairs || [];
      renderReport(data.report);
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
  const ratio = score.total / score.perfect;
  card.innerHTML = `
    <div class="head"><span>${label}</span>
      <span class="total ${scoreClass(ratio)}">${score.total} / ${score.perfect}</span></div>
    <div class="comment"></div>
    <div class="kp"></div>`;
  card.querySelector('.comment').textContent = score.comment || '';
  card.querySelector('.kp').textContent = score.key_point ? '要点：' + score.key_point : '';
  list.prepend(card);
  const bubbles = document.querySelectorAll('#interpCol .bubble');
  if (bubbles.length) bubbles[bubbles.length - 1].classList.add('scored');
}

function renderReport(report) {
  if (!report) return;
  $('#report').hidden = false;
  $('#exportRow').innerHTML = '';
  if (report.totalAvg == null) {
    // 人工评分模式：无 AI 逐维数据
    $('#reportTotal').innerHTML = `人工评分均分 <span style="color:var(--green)">${report.human?.avg ?? '—'}</span> / 5 · 共 ${report.human?.count ?? 0} 句已评分`;
    $('#reportDims').innerHTML = '';
  } else {
    $('#reportTotal').innerHTML = `AI 场均 <span style="color:var(--green)">${report.totalAvg}</span> / 5 · 共 ${report.utterances} 句译文`;
    $('#reportDims').innerHTML = report.perDim.map(d => `
      <div class="dimRow">
        <div class="name"><span>${d.group} · ${d.label}</span><span>${d.avg}</span></div>
        <div class="dimBar"><i style="width:${(d.avg / 5) * 100}%"></i></div>
      </div>`).join('');
  }
  if (report.human) {
    state.humanCmp = report.human.items.map(h => {
      const ai = state.aiTotals[h.half - 1];
      return `<li>第${h.round}轮 · ${dirLabel(h.dir)} · 人评 ${h.score}/5${ai ? ` · AI ${ai}/5` : ''}${h.comment ? ` · ${h.comment}` : ''}</li>`;
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
      <div class="pairHead"><span>第${p.round}轮 · ${dirLabel(p.dir)}</span><span>${ai ? `AI ${ai}/5` : 'AI 未评分'}</span></div>
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
  $('#humanStatus').textContent = `已提交 ${data.report.human?.count || 0} 句人工评分，均分 ${data.report.human?.avg} / 5，已计入报告与 docx 导出。`;
  $('#humanBox').hidden = true;
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
    $('#refBox').innerHTML = `<span class="tag">参考建议（${data.targetLang}，正式口译中应先尝试自己翻译）</span>${data.reference}`;
    $('#refBox').hidden = false;
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
  setStatus(`患者：${data.patientInfo.name}（${data.patientInfo.age}岁 · ${data.patientInfo.country} · ${data.patientInfo.personality}）· 评分量规【医护英语沟通】满分 ${data.settings.perfect}`);
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
    if (data.score) { addScoreCard(data.score, `第${data.half}句 · 我的表达`); state.aiTotals.push(data.score.total); }
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
    $('#refBoxM2').innerHTML = `<span class="tag">参考建议（${data.targetLang}，建议先自己尝试再参考）</span>${data.reference}`;
    $('#refBoxM2').hidden = false;
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

// ─── 语音输入（Web Speech API 占位实现，对应设计稿语音识别模块）───
function speechInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus('当前浏览器不支持 Web Speech API，请直接键入译文。'); return; }
  const targetLang = /[\u4e00-\u9fff]/.test(state.pending?.original || '') ? 'en-US' : 'zh-CN';
  const rec = new SR();
  rec.lang = targetLang;
  rec.interimResults = false;
  setStatus('正在聆听…（' + (targetLang === 'en-US' ? '说英文' : '说中文') + '）');
  rec.onresult = (e) => {
    $('#translationInput').value += e.results[0][0].transcript;
    setStatus('语音已转入，请核对后提交。');
  };
  rec.onerror = () => setStatus('语音识别失败，请直接键入。');
  rec.start();
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
