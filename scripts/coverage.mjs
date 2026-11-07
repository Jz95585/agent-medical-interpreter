// 知识库覆盖度自检：列出产品中出现的疾病在 MSD 语料里的匹配级别
// 用法：npm run coverage [-- --strict]（--strict 时有缺失则退出码 1）
import {DISEASE_EXAMPLES, PRESET_PATIENTS} from '../src/pools.mjs';
import {search} from '../src/msd.mjs';

const LABEL = {disease: '疾病专条', related: '仅相关条目', none: '未收录'};
const diseases = [...new Set([...DISEASE_EXAMPLES, ...PRESET_PATIENTS.map(p => p.disease)])];

const rows = diseases.map(d => {
  const {level, hits} = search(d, 3);
  return {d, level, titles: hits.map(h => h.title)};
});

for (const r of rows) {
  console.log(`${r.d}\t${LABEL[r.level]}\t${r.titles.join(' / ') || '—'}`);
}

const covered = rows.filter(r => r.level === 'disease').length;
const missing = rows.filter(r => r.level !== 'disease');
console.log(`\n覆盖率：${covered}/${rows.length} 有疾病专条`);

if (missing.length) {
  console.log('需补语料或补别名：');
  for (const r of missing) console.log(`  - ${r.d}（${LABEL[r.level]}）`);
}

if (process.argv.includes('--strict') && missing.length) process.exit(1);
