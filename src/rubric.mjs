// 能力评估量规（可编辑）：默认 = ISO 21998:2021 十维 + 各译员类型专属维度
// 运行时从 data/rubric.json 读取；前端可编辑并保存，改动实时影响评判员
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.join(base, '..', 'data', 'rubric.json');

const BASE_DIMS = [
  {key: 'accuracy_medical_knowledge', group: '准确度', label: '医学术语与知识保真', focus: '术语翻译是否准确，医学概念是否失真'},
  {key: 'accuracy_information_integrity', group: '准确度', label: '信息完整性', focus: '有无漏译、增译、曲解，数字剂量是否保真'},
  {key: 'technique_discourse_management', group: '口译技巧', label: '对话管理', focus: '话轮处理、长段切分、必要的澄清与重复'},
  {key: 'technique_use_of_person', group: '口译技巧', label: '人称运用', focus: '是否始终第一人称，有无 the doctor says 式转述'},
  {key: 'technique_cultural_interpretation', group: '口译技巧', label: '文化与概念诠释', focus: '跨文化差异是否得到自然协调'},
  {key: 'ethics_role_boundaries', group: '职业伦理', label: '角色边界', focus: '有无越界给医疗建议、虚假安慰（如 don\'t worry）'},
  {key: 'ethics_impartiality', group: '职业伦理', label: '中立性', focus: '是否中立传递双方，不偏向任何一方'},
  {key: 'effectiveness_trust_building', group: '沟通有效性', label: '促进理解与信任', focus: '患者是否听得懂、医患信任是否被促进'},
  {key: 'effectiveness_fluency', group: '沟通有效性', label: '效率与流畅度', focus: '表达是否自然流畅、简洁高效'},
  {key: 'empathy_expression', group: '同理心', label: '体现与传达情感', focus: '情感语气是否得到传递与安抚'},
];

const DEFAULT_STORE = {
  levelAnchors: [
    '1-2分（负样本水平）：出现术语错误、信息遗漏或增减、人称混乱、角色越界、虚假承诺等明显不专业问题',
    '3分（基础合格）：信息基本完整准确，无重大错误，但表达平淡或略冗余，术语处理不够得体',
    '4-5分（黄金标准）：术语保真、信息完整、人称统一、文化协调自然，体现患者赋权与人文关怀',
  ],
  professional: {
    name: '职业医疗口译员',
    personaNote: [
      '你受全球医疗口译协会职业道德准则（如 NCIHC / IMIA 伦理条目）约束：保密、中立、准确、完整。',
      '你不涉及任何医疗判断：患者提出专业问题时，提示患者可以向医生提问，由医生解释。',
      '遇到不确定或没听清的内容，可以主动请求医生或患者重复、澄清。',
    ],
    dims: [...BASE_DIMS, {key: 'ethics_decision', group: '职业伦理', label: '伦理决策', focus: '面对专业问题与利益冲突时是否守住译员职责边界'}],
  },
  dual: {
    name: '双角色护士（口译）',
    personaNote: [
      '你同时承担接诊护士职责（dual-role interpreter）：可执行并转达护理操作信息，如测量体温、指引检查、交代取药流程。',
      '双重角色边界：护理相关的流程信息可以补充说明，但诊断、剂量调整等医疗判断只能由医生给出，不得代答。',
      '先完成口译职责，再以护士身份补充必要的就诊引导。',
    ],
    dims: [...BASE_DIMS, {key: 'role_balance', group: '口译技巧', label: '双重角色平衡', focus: '护理职责与口译职责的切换是否清晰、有无角色混淆'}],
  },
  medstaff: {
    name: '医护英语沟通（医生）',
    personaNote: [
      '该量规用于评估中国医生直接用外语与患者沟通的能力（无译员参与，设计稿模式2）。',
      '评估对象是医生自己说出的语句，而非口译译文。',
    ],
    dims: [
      {key: 'lang_accuracy', group: '语言', label: '语言准确性', focus: '语法、用词、句型是否正确自然，有无中式英语'},
      {key: 'terminology_use', group: '语言', label: '医学术语使用', focus: '术语是否准确，是否兼顾患者理解而适当通俗化'},
      {key: 'information_completeness', group: '沟通', label: '信息完整性', focus: '关键医疗信息是否表达完整，有无遗漏'},
      {key: 'explanation_confirmation', group: '沟通', label: '解释与确认', focus: '是否解释术语、确认患者理解、给予复述或提问机会'},
      {key: 'empathy_comfort', group: '态度', label: '同理心与安抚', focus: '是否关注患者情绪，给予恰当安抚，避免冷漠或虚假安慰'},
      {key: 'turn_management', group: '沟通', label: '话轮管理', focus: '一次一个要点、节奏清晰、有效引导患者回应'},
    ],
  },
};

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (raw && Array.isArray(raw.levelAnchors) && raw.professional?.dims?.length && raw.dual?.dims?.length) {
      // 兼容旧存档：补齐后增的量规类型
      for (const key of Object.keys(DEFAULT_STORE)) {
        if (!raw[key]) raw[key] = structuredClone(DEFAULT_STORE[key]);
      }
      return raw;
    }
  } catch { /* 首次运行无文件，使用默认 */ }
  return structuredClone(DEFAULT_STORE);
}

let store = loadStore();

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), {recursive: true});
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch { /* 保存失败不阻断主流程 */ }
}

const getLevelAnchors = () => store.levelAnchors;
const getPersona = (id) => store[id] || store.professional;
const allDims = (id) => getPersona(id).dims;
const perfectScore = (id) => allDims(id).length * 5;
const listPersonas = () => ['professional', 'dual'].map(id => ({id, name: store[id].name}));
// 量规编辑页可见的全部量规（含医护英语沟通）
const listRubricPersonas = () => Object.keys(store);

// 保存某一译员类型的量规编辑（人设要点 + 维度列表）
function savePersona(personaId, {personaNote, dims}) {
  if (!store[personaId]) throw Object.assign(new Error('未知量规类型'), {status: 400});
  if (!Array.isArray(dims) || dims.length < 3 || dims.length > 20) throw Object.assign(new Error('维度数量须在 3-20 之间'), {status: 400});
  const seen = new Set();
  const clean = dims.map(d => {
    const key = String(d.key || '').trim();
    const label = String(d.label || '').trim();
    const group = String(d.group || '').trim() || '通用';
    const focus = String(d.focus || '').trim();
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key) || seen.has(key)) throw Object.assign(new Error(`维度 key 无效或重复：${key || '(空)'}`), {status: 400});
    if (!label) throw Object.assign(new Error('存在未命名的维度'), {status: 400});
    seen.add(key);
    return {key, group, label, focus};
  });
  const note = Array.isArray(personaNote) ? personaNote.map(s => String(s).trim()).filter(Boolean) : [];
  store[personaId] = {...store[personaId], personaNote: note, dims: clean};
  persist();
  return store[personaId];
}

function resetStore() {
  store = structuredClone(DEFAULT_STORE);
  persist();
  return store;
}

function getStore() { return store; }

export {allDims, perfectScore, listPersonas, listRubricPersonas, getPersona, getLevelAnchors, savePersona, resetStore, getStore};
