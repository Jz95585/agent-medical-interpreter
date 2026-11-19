import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer, post} from './helpers.mjs';

// AI 答疑：/api/ask 基础校验 + MSD 检索联动 + 引用来源只标注实际引用条目
test('缺少问题参数返回 400', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const resp = await post(s.base, '/api/ask', {question: ''});
  assert.equal(resp.status, 400);
});

test('提问命中 MSD 条目时返回回答与来源标注', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const resp = await post(s.base, '/api/ask', {
    question: '为什么这句要译给患者？肾结石患者会问治疗方式吗？',
    transcript: [
      {role: 'doctor', text: '您好，我是张医生。请坐，先请问您怎么称呼？'},
      {role: 'interpreter', dir: 'to_patient', text: 'Hello, I am Dr. Zhang. May I have your name, please?'},
    ],
    disease: '肾结石',
    doctorLanguage: '中文',
    patientLanguage: '英文',
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.ok(typeof data.answer === 'string' && data.answer.length > 10, '应返回非空回答');
  assert.ok(/\[\d+\]/.test(data.answer), '干跑回答应含引用标记');
  assert.ok(Array.isArray(data.sources) && data.sources.length >= 1, 'MSD 命中时应返回来源');
  const src = data.sources[0];
  assert.equal(src.source, 'MSD 诊疗手册（专业版）');
  assert.ok(src.title, '来源应含条目标题');
  assert.ok(src.topic, '来源应含章节信息');
});

test('与知识库无关的提问不返回编造来源', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const resp = await post(s.base, '/api/ask', {
    question: '12345 问号占位提问',
    transcript: [],
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.sources.length, 0, '未引用条目时来源应为空数组');
});
