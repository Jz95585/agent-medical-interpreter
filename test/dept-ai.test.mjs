import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from './helpers.mjs';

// 疾病 → 科室联动：本地字典精确命中 → AI 兜底（输出必须落在合法科室列表内）
test('本地字典命中的疾病直接返回，不调用模型', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const r = await fetch(s.base + '/api/dept?disease=' + encodeURIComponent('肾结石'));
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.department, '泌尿外科');
  assert.equal(data.source, 'builtin');
});

test('未收录的疾病走 AI 兜底，返回合法科室名', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const r = await fetch(s.base + '/api/dept?disease=' + encodeURIComponent('胃溃疡'));
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.department, '消化内科'); // 干跑样例
  assert.equal(data.source, 'ai');
});

test('空疾病名返回空结果', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const r = await fetch(s.base + '/api/dept?disease=');
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.department, '');
  assert.equal(data.source, 'none');
});
