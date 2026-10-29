// 剧本导出：零依赖生成 .docx（手写最小 OOXML + 存储型 ZIP 容器）
// 结构参考 docs/1. 医学英语情景演练剧本-流感（分析案例）.docx：
// 标题 → 演练设定（含患者小传）→ 剧本正文（说话人：台词）→ 口译评估记录 → 演练报告 → 剧本讲解
import {getScenario} from './scenarios.mjs';

// ─── CRC32 ───
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ─── 存储型 ZIP（不压缩，docx 体积小无需 deflate）───
function zipStore(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, f.data);
    central.push({nameBuf, crc, size: f.data.length, offset});
    offset += 30 + nameBuf.length + f.data.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(dosTime, 12);
    h.writeUInt16LE(dosDate, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.size, 20);
    h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt32LE(c.offset, 42);
    chunks.push(h, c.nameBuf);
    offset += 46 + c.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

// ─── OOXML 段落 ───
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function run(text, {bold = false, size = 22, color = ''} = {}) {
  const rPr = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体" w:hint="eastAsia"/>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${color ? `<w:color w:val="${color}"/>` : ''}</w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(runsOrText, {before = 0, after = 120} = {}) {
  const runs = Array.isArray(runsOrText) ? runsOrText.map(r => run(r.text, r)).join('') : run(runsOrText);
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}" w:line="312" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
}

// ─── 剧本组装 ───
function buildScriptDocx(record) {
  const s = record.settings || {};
  const pi = record.patientInfo || {};
  const doc = record.doctor || {name: '张医生', specialization: ''};
  const scenarioNames = {consult: '门诊常规诊治', followup: '复诊', appointment: '预约挂号', checkup: '检查检验咨询', pretravel: '行前注意事项'};
  const scenarioName = scenarioNames[s.scenario] || s.scenario || '';
  const personaName = (record.report && record.report.perDim && s.interpreterType) ? '' : '';
  const interpreterName = '王译员';
  const dims = (record.report && record.report.perDim) || [];
  const perfect = dims.length ? dims.length * 5 : '';

  const ps = [];

  // 标题
  ps.push(para([{text: '医疗口译情景演练剧本', bold: true, size: 36}], {after: 60}));
  ps.push(para([{text: `${scenarioName} · ${pi.disease_info?.disease_type || s.params?.disease || ''} · ${doc.specialization}`, size: 21, color: '595959'}], {after: 240}));

  // 一、演练设定
  ps.push(para([{text: '一、演练设定', bold: true, size: 28}], {before: 120}));
  ps.push(para([
    {text: `${record.doctor.roleLabel || '医生'}：`, bold: true}, {text: `${doc.name}（${doc.specialization}），使用${s.doctorLanguage || '中文'}`},
  ]));
  ps.push(para([
    {text: '口译员：', bold: true}, {text: `${interpreterName}（${personaLabelOf(s.interpreterType)}），${s.doctorLanguage || '中文'} ↔ ${pi.language || '英文'} 双向口译${s.mode === 'drill' ? '（译文由用户扮演者提供）' : ''}`},
  ]));
  ps.push(para([
    {text: '患者小传：', bold: true},
    {text: `${pi.name || ''}，${pi.gender || ''}，${pi.age || ''} 岁，来自${pi.country || ''}，母语${pi.language || ''}。性格${pi.personality || ''}，健康素养${pi.health_literacy || ''}，宗教信仰${pi.religion || '无特定信仰'}，饮食习惯${pi.dietary || '无特殊要求'}，文化禁忌${pi.taboos || '无特殊禁忌'}。`},
  ]));
  ps.push(para([
    {text: '主诉症状：', bold: true}, {text: (pi.disease_info?.symptoms || []).join('；') || '—'},
  ]));
  ps.push(para([
    {text: '既往症：', bold: true}, {text: pi.disease_info?.medical_history || '无特殊病史'},
  ]));
  ps.push(para([
    {text: '演练模式：', bold: true}, {text: `${({auto: '模式1 · 智能体自动演练', drill: '模式3 · 用户扮演译员', m2: '模式2 · 用户扮演医生（直接用外语与患者沟通，无译员）'})[s.mode] || s.mode} · 共 ${record.rounds ?? '—'} 句${record.hintUsed ? ` · 演练中使用参考建议 ${record.hintUsed} 次` : ''} · 评分量规：${s.mode === 'm2' ? '医护英语沟通（医生）' : personaLabelOf(s.interpreterType)}`},
  ]));

  // 二、剧本正文
  ps.push(para([{text: '二、剧本正文', bold: true, size: 28}], {before: 200}));
  let lastRound = 0;
  for (const e of record.log || []) {
    if (e.role === 'doctor') {
      lastRound += 1;
      ps.push(para([{text: `【第 ${lastRound} 轮】`, bold: true, size: 20, color: '808080'}], {before: 160, after: 60}));
      ps.push(para([{text: `${doc.name}：`, bold: true}, {text: e.content}]));
    } else if (e.role === 'patient') {
      ps.push(para([{text: `${pi.name || '患者'}：`, bold: true}, {text: e.content}]));
    } else if (e.role === 'interpreter') {
      ps.push(para([{text: `${interpreterName}（${e.dir === 'to_patient' ? '译给患者' : '译给医生'}）：`, bold: true}, {text: e.content}]));
    }
  }

  // 三、口译评估记录（AI 评分 + 人工评分对照）
  if ((record.scores || []).length || (record.humanScores || []).length) {
    ps.push(para([{text: '三、口译评估记录', bold: true, size: 28}], {before: 200}));
    let round = 0;
    let half = 0;
    const humanByHalf = new Map((record.humanScores || []).map(h => [h.half, h]));
    const maxHalf = Math.max((record.scores || []).length, (record.humanScores || []).length);
    const rlShort = record.doctor.roleLabel === '前台接待员' ? '前台' : (record.doctor.roleLabel || '医生');
    for (let h = 1; h <= maxHalf; h++) {
      half = h;
      const ai = (record.scores || [])[h - 1];
      const hu = humanByHalf.get(h);
      if (!ai && !hu) continue;
      round = Math.ceil(h / 2);
      const dirLabel = ai ? (h % 2 === 1 ? rlShort + '→患' : '患→' + rlShort) : (hu.dir === 'to_patient' ? rlShort + '→患' : '患→' + rlShort);
      const scoreParts = [];
      if (ai) scoreParts.push(`AI ${ai.total} / ${ai.perfect}`);
      if (hu) scoreParts.push(`人评 ${hu.score} / 5`);
      ps.push(para([{text: `第 ${round} 轮 · ${dirLabel} · ${scoreParts.join(' · ')}`, bold: true, size: 22}], {before: 100, after: 40}));
      if (ai) {
        if (ai.comment) ps.push(para([{text: 'AI 总评：', bold: true, size: 20, color: '595959'}, {text: ai.comment, size: 20, color: '595959'}], {after: 20}));
        if (ai.key_point) ps.push(para([{text: 'AI 要点：', bold: true, size: 20, color: '595959'}, {text: ai.key_point, size: 20, color: '595959'}], {after: 40}));
      }
      if (hu) {
        if (hu.comment) ps.push(para([{text: '人工评语：', bold: true, size: 20, color: '595959'}, {text: hu.comment, size: 20, color: '595959'}], {after: 40}));
        if (ai) {
          const delta = +(hu.score / 5 * ai.perfect - ai.total).toFixed(1);
          ps.push(para([{text: `分差参考：`, bold: true, size: 20, color: '595959'}, {text: `人评折算 ${hu.score / 5 * ai.perfect} 分，与 AI 相差 ${delta > 0 ? '+' : ''}${delta} 分`, size: 20, color: '595959'}], {after: 80}));
        }
      }
    }
  }

  // 四、演练报告
  if (record.report) {
    ps.push(para([{text: '四、演练报告', bold: true, size: 28}], {before: 200}));
    if (record.report.totalAvg != null) {
      ps.push(para([{text: `AI 场均 ${record.report.totalAvg} / 5，共 ${record.report.utterances} 句译文（量规满分 ${perfect}）`}], {after: 80}));
      for (const d of record.report.perDim || []) {
        ps.push(para([{text: `${d.group} · ${d.label}：`, size: 20}, {text: `${d.avg}`, bold: true, size: 20}], {after: 20}));
      }
    }
    if (record.report.human) {
      ps.push(para([{text: `人工评分均分 ${record.report.human.avg} / 5，共 ${record.report.human.count} 句（人工评分模式未启用 AI 逐维打分）`}], {before: record.report.totalAvg != null ? 60 : 0, after: 80}));
    }
    if ((record.report.keyPoints || []).length) {
      ps.push(para([{text: '关键语言服务要点', bold: true, size: 24}], {before: 120, after: 40}));
      record.report.keyPoints.forEach((k, i) => ps.push(para([{text: `${i + 1}. ${k}`, size: 21}], {after: 20})));
    }
    if ((record.report.comments || []).length) {
      ps.push(para([{text: '总评摘录', bold: true, size: 24}], {before: 120, after: 40}));
      record.report.comments.forEach((c, i) => ps.push(para([{text: `${i + 1}. ${c}`, size: 21}], {after: 20})));
    }
  }

  // 五、剧本讲解（医学知识 · 诊疗流程 · 专业术语 · 语言表达难点）
  const teaching = record.teaching || {};
  const scenarioCfg = getScenario(s.scenario);
  const hasTeaching = teaching.medicalKnowledge || teaching.workflow || (teaching.terminology || []).length || (teaching.languagePoints || []).length;
  if (hasTeaching || (record.msdRefs || []).length || scenarioCfg.keyPoints.length) {
    ps.push(para([{text: '五、剧本讲解（医学知识 · 诊疗流程 · 术语 · 语言难点）', bold: true, size: 28}], {before: 200}));

    if (teaching.medicalKnowledge) {
      ps.push(para([{text: '1. 医学知识讲解', bold: true, size: 24}], {before: 80, after: 40}));
      ps.push(para([{text: teaching.medicalKnowledge, size: 21}], {after: 80}));
    }
    if ((record.msdRefs || []).length) {
      ps.push(para([{text: '诊疗手册（专业版）参考条目：', bold: true, size: 21}], {after: 40}));
      for (const ref of record.msdRefs) {
        ps.push(para([{text: `《${ref.title}》（${ref.topic} · ${ref.subTopic}）：`, bold: true, size: 20}, {text: ref.content.slice(0, 200), size: 20}], {after: 40}));
      }
    }
    if (record.consumerPlain) {
      ps.push(para([{text: '患者通俗版对照（consumer version，供译员参考患者能听懂的说法）：', bold: true, size: 21}], {before: 40, after: 40}));
      ps.push(para([{text: record.consumerPlain, size: 20, color: '595959'}], {after: 80}));
    }

    if (teaching.workflow) {
      ps.push(para([{text: '2. 诊疗流程讲解', bold: true, size: 24}], {before: 80, after: 40}));
      ps.push(para([{text: teaching.workflow, size: 21}], {after: 40}));
      if (scenarioCfg.doctorGoals?.length) {
        ps.push(para([{text: `本场景流程阶段：${scenarioCfg.doctorGoals.join(' → ')}`, size: 20, color: '595959'}], {after: 80}));
      }
    }

    if ((teaching.terminology || []).length) {
      ps.push(para([{text: '3. 专业术语（本对话提取）', bold: true, size: 24}], {before: 80, after: 40}));
      for (const t of teaching.terminology) {
        ps.push(para([{text: `${t.term}（${t.en}）：`, bold: true, size: 21}, {text: t.explanation, size: 21}], {after: 30}));
      }
    }

    if ((teaching.languagePoints || []).length || scenarioCfg.keyPoints.length) {
      ps.push(para([{text: '4. 语言表达难点与句型参考', bold: true, size: 24}], {before: 80, after: 40}));
      for (const lp of teaching.languagePoints || []) {
        ps.push(para([{text: `${lp.title}：`, bold: true, size: 21}, {text: lp.explanation, size: 21}], {after: 30}));
      }
      if (scenarioCfg.keyPoints.length) {
        ps.push(para([{text: '场景句型参考：', bold: true, size: 21}], {before: 40, after: 40}));
        for (const kp of scenarioCfg.keyPoints) {
          ps.push(para([{text: `${kp.title}：`, bold: true, size: 20}, {text: `${kp.en}（${kp.zh}）`, size: 20}], {after: 30}));
        }
      }
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${ps.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const buf = zipStore([
    {name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8')},
    {name: '_rels/.rels', data: Buffer.from(rels, 'utf8')},
    {name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8')},
  ]);
  return buf;
}

function personaLabelOf(id) {
  return id === 'dual' ? '双角色护士（口译）' : '职业医疗口译员';
}

export {buildScriptDocx};
