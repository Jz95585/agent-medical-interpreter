import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {findDepartment, DISEASE_DEPARTMENT, DEPARTMENTS, DISEASE_EXAMPLES, PRESET_PATIENTS} from '../src/pools.mjs';
import {root} from './helpers.mjs';

test('常见疾病有科室映射，且科室名真实存在', () => {
  for (const [disease, dept] of Object.entries(DISEASE_DEPARTMENT)) {
    assert.ok(DEPARTMENTS.includes(dept), `${disease} 映射到不存在的科室 ${dept}`);
  }
  assert.equal(findDepartment('心脏神经病'), '心血管内科');
  assert.equal(findDepartment('肾结石'), '泌尿外科');
  assert.equal(findDepartment('不存在的病'), '');
});

test('示例疾病与预设疾病都有映射', () => {
  const diseases = [...DISEASE_EXAMPLES, ...PRESET_PATIENTS.map(p => p.disease)];
  const missing = diseases.filter(d => !findDepartment(d));
  assert.deepEqual(missing, []);
});

test('页面存在对话区告警容器', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="alertBox"/);
});
