// MSD 诊疗手册知识检索：专业版直接关键词匹配；通俗版由 LLM 改写并缓存
// 数据源：project/msd_diseases_final_new.json（topic → sub_topic → title → content）
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {callModel} from './llm.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(base, '..', 'data', 'msd_diseases_final_new.json');
const CACHE_FILE = path.join(base, '.consumer_cache.json');

let entries = null; // [{topic, subTopic, title, content}]

function loadEntries() {
  if (entries) return entries;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  entries = [];
  for (const [topic, subs] of Object.entries(raw)) {
    for (const [subTopic, titles] of Object.entries(subs)) {
      for (const [title, content] of Object.entries(titles)) {
        entries.push({topic, subTopic, title: title.trim(), content: String(content).trim()});
      }
    }
  }
  return entries;
}

// 关键词检索：title 命中权重最高，其次 sub_topic / topic / content
function search(query, topN = 3) {
  const list = loadEntries();
  const kws = query.split(/[\s,，、;；/]+/).map(s => s.trim()).filter(s => s.length >= 2);
  if (!kws.length) return [];
  const scored = [];
  for (const e of list) {
    let score = 0;
    for (const kw of kws) {
      if (e.title.includes(kw)) score += 4;
      if (e.subTopic.includes(kw)) score += 2;
      if (e.topic.includes(kw)) score += 1;
      if (e.content.includes(kw)) score += 1;
    }
    if (score > 0) scored.push({score, e});
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map(({e}) => ({title: e.title, topic: e.topic, subTopic: e.subTopic, content: e.content.slice(0, 600)}));
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), {recursive: true});
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch { /* 缓存写入失败不影响主流程 */ }
}

// 通俗版改写（consumer version）：按健康素养水平改写为患者易懂的语言
async function consumerize(env, title, content, signal) {
  const cache = loadCache();
  if (cache[title]) return cache[title];
  const r = await callModel(env, [
    {role: 'system', content: '你是医学科普改写助手。把医学手册内容改写为没有医学背景的患者能听懂的口语化解释。保留关键信息（这是什么病、常见症状、如何治疗、何时需要就医），不使用专业术语或使用后立即用大白话解释。输出改写后的文本，不要任何额外说明。'},
    {role: 'user', content: `【${title}】\n${content.slice(0, 1500)}`},
  ], {max: 500, temperature: 0.3, tag: 'consumer', signal});
  cache[title] = r.message;
  saveCache(cache);
  return r.message;
}

export {search, consumerize};
