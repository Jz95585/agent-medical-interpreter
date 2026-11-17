import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPromptPreview} from '../src/agents.mjs';

test('提示词预览包含五个智能体与占位符', () => {
  const p = buildPromptPreview('consult', 'professional');
  assert.ok(p.doctorSystem.includes('话轮长度'));
  assert.ok(p.patientSystem.includes('【宗教信仰】'));
  assert.ok(p.patientSystem.includes('【饮食习惯】'));
  assert.ok(p.patientSystem.includes('【文化禁忌】'));
  assert.ok(p.interpreterSystem.includes('共情视角要求'));
  assert.ok(p.judgeSystem.includes('评分校准'));
  assert.ok(p.managerSystem.includes('CONTINUE'));
  assert.doesNotMatch(JSON.stringify(p), /undefined/);
});

test('提示词预览跟随场景变化', () => {
  const a = buildPromptPreview('appointment', 'professional');
  assert.equal(a.scenarioName, '预约挂号');
  assert.ok(a.doctorSystem.includes('前台接待员'));
});

test('运行时字段统一用占位符，不显示具体取值', () => {
  const p = buildPromptPreview('consult', 'professional');
  assert.ok(p.doctorSystem.includes('【科室】'));
  assert.ok(p.doctorSystem.includes('【医生语言】'));
  assert.doesNotMatch(p.doctorSystem, /示例科室|泌尿外科|心血管内科/);
  assert.ok(p.interpreterSystem.includes('【患者语言】'));
});
