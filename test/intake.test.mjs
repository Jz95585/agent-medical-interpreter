import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {startServer, post, root} from './helpers.mjs';
import {classifyPatientFamiliar} from '../src/agents.mjs';

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map(chunk => {
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
}

// ─── 分类函数单测：关键词直接判定优先，模糊时走模型（干跑） ───
test('classifyPatientFamiliar：关键词命中/否决与模型兜底', async t => {
  const env = {DRY_RUN: '1'};
  assert.equal(await classifyPatientFamiliar(env, '我上次住院用过医疗口译服务'), true);
  assert.equal(await classifyPatientFamiliar(env, 'Yes, I have worked with an interpreter before.'), true);
  assert.equal(await classifyPatientFamiliar(env, '这是我第一次见口译员'), false);
  assert.equal(await classifyPatientFamiliar(env, 'This is my first time here.'), false);
  assert.equal(await classifyPatientFamiliar(env, 'Hello hello.'), false); // 无关键词 → 模型（干跑样例 false）
});

// ─── 模式1：诊前接入先于问诊（译员迎候路径） ───
test('模式1 direct 路径：译员开场话轮先于医生第一句', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const resp = await post(s.base, '/api/auto', {
    scenario: 'consult', maxRounds: 1, params: {intakePath: 'direct', disease: '肾结石', country: '美国', language: '英文'},
  });
  assert.equal(resp.status, 200);
  const events = parseSse(await resp.text());
  const messages = events.filter(e => e.type === 'message');
  const scores = events.filter(e => e.type === 'score');

  const interpOpen = messages.findIndex(m => m.round === 0 && m.speaker === 'interpreter');
  const patientReply = messages.findIndex(m => m.round === 0 && m.speaker === 'patient');
  const doctorMsg = messages.findIndex(m => m.round === 1 && m.speaker === 'doctor');
  assert.ok(interpOpen >= 0, '应有译员诊前开场话轮');
  assert.ok(patientReply > interpOpen, '患者应答复在开场之后');
  assert.ok(doctorMsg > patientReply, '医生第一句应在诊前接入之后');
  assert.ok(!messages.some(m => m.speaker === 'receptionist'), 'direct 路径不应出现前台');
  assert.ok(scores.some(sc => sc.round === 0), '诊前接入话轮应有评分');
  // 干跑患者的回答包含"worked with an interpreter"关键词 → 熟悉 → 不出现原则阐述的第二条译员话轮
  const round0InterpCount = messages.filter(m => m.round === 0 && m.speaker === 'interpreter').length;
  assert.equal(round0InterpCount, 1, '熟悉口译的患者应跳过原则阐述');

  const done = events.find(e => e.type === 'done');
  assert.ok(done, '应正常完成');
  if (done.saved) fs.rmSync(path.join(root, 'output', done.saved), {force: true});
});

// ─── 模式1：前台引荐路径 ───
test('模式1 reception 路径：前台引荐→译员转达→患者应答', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const resp = await post(s.base, '/api/auto', {
    scenario: 'consult', maxRounds: 1, params: {intakePath: 'reception', disease: '肾结石', country: '美国', language: '英文'},
  });
  const events = parseSse(await resp.text());
  const messages = events.filter(e => e.type === 'message');
  assert.equal(messages[0].speaker, 'receptionist', '第一条应是前台引荐');
  assert.equal(messages[0].lang, '中文');
  assert.ok(messages[1].speaker === 'interpreter' && messages[1].round === 0, '译员随后转达+自我介绍');
  assert.ok(messages.some(m => m.round === 1 && m.speaker === 'doctor'), '医生在接入后开诊');
  const done = events.find(e => e.type === 'done');
  if (done.saved) fs.rmSync(path.join(root, 'output', done.saved), {force: true});
});

// ─── 模式3：用户扮演译员，先完成诊前接入任务 ───
test('模式3 direct 路径：开场为接入任务，完成后医生入场', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const start = await post(s.base, '/api/drill/start', {
    scenario: 'consult', params: {intakePath: 'direct', disease: '肾结石', country: '美国', language: '英文'},
  });
  const data = await start.json();
  assert.equal(start.status, 200);
  assert.equal(data.intake.path, 'direct');
  assert.equal(data.first, null);
  assert.ok(data.intakeTask.includes('诊前接入任务'), '应下发开场任务卡');
  assert.ok(data.intakeHint.includes('诊前接入'), '应下发输入提示');

  const step1 = await post(s.base, '/api/drill/step', {
    sessionId: data.sessionId,
    translation: 'Hello! Please have a seat. I am the medical interpreter today. May I confirm your name and date of birth? Have you used a medical interpreter before?',
  });
  const d1 = await step1.json();
  assert.ok(d1.score, '开场应有评分');
  assert.ok(d1.reply && d1.reply.lang === '英文', '患者应答应与医生开场同批下发');
  // 干跑患者回复含 "worked with a medical interpreter" → 熟悉 → 直接进入主流程
  assert.equal(d1.next.speaker, 'doctor', '熟悉口译的患者应直接进入医生问诊');
  assert.equal(d1.next.round, 1);
  // 验证方式：再次提交 → 下一话轮 speaker 应为 doctor 或 patient（主流程）
  const step2 = await post(s.base, '/api/drill/step', {
    sessionId: data.sessionId,
    translation: 'The patient says her name is Olivia Martin and she has used an interpreter before.',
  });
  const d2 = await step2.json();
  assert.ok(d2.next, '主流程继续');
  assert.ok(['doctor', 'patient'].includes(d2.next.speaker), '应进入主流程话轮');

  const fin = await post(s.base, '/api/drill/finish', {sessionId: data.sessionId});
  const df = await fin.json();
  assert.equal(df.stopped, 'user_abort');
  assert.ok(Array.isArray(df.pairs) && df.pairs.length >= 1, '应产出逐句对照');
  assert.ok(df.pairs.some(p => p.stage === 'intake'), '对照应标注诊前接入话轮');
  if (df.saved) fs.rmSync(path.join(root, 'output', df.saved), {force: true});
});

// ─── 模式3：前台引荐路径 ───
test('模式3 reception 路径：先收到前台引荐词', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const start = await post(s.base, '/api/drill/start', {
    scenario: 'consult', params: {intakePath: 'reception', disease: '肾结石', country: '美国', language: '英文'},
  });
  const data = await start.json();
  assert.equal(data.first.speaker, 'receptionist');
  assert.ok(data.first.lang === '中文');
  assert.equal(data.intakeTask, data.first.text, '待译原话应为引荐词');
  assert.ok(data.intakeHint.includes('翻译给患者'));
});
