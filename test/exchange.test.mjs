import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer, post} from './helpers.mjs';

const params = {disease: '肾结石', country: '美国', language: '英文', gender: '女', age: 42, doctorLanguage: '中文'};

test('演练结束后导出的 docx 使用会话中的译员名', async t => {
  const s = await startServer();
  t.after(s.stop);

  const startResp = await post(s.base, '/api/drill/start', {
    scenario: 'consult', interpreterType: 'professional', scoringMode: 'ai', maxRounds: 1, params,
  });
  assert.equal(startResp.status, 200);
  const start = await startResp.json();

  const step1 = await post(s.base, '/api/drill/step', {sessionId: start.sessionId, translation: 'Hello, I am the interpreter.'});
  assert.equal(step1.status, 200);

  const step2 = await post(s.base, '/api/drill/step', {sessionId: start.sessionId, translation: 'Thank you, doctor.'});
  assert.equal(step2.status, 200);
  const done = await step2.json();
  assert.equal(done.finished.reason, 'max_rounds');
  assert.ok(done.exportId, '结束后应返回 exportId');

  const docx = await fetch(`${s.base}/api/export/${done.exportId}`);
  assert.equal(docx.status, 200);
  const buf = Buffer.from(await docx.arrayBuffer());

  // docx 为存储型 ZIP，document.xml 未压缩，可直接在字节中查找文本
  assert.ok(buf.includes(Buffer.from('王译员', 'utf8')), '导出的剧本应包含会话中的译员名');
  assert.ok(!buf.includes(Buffer.from('口译员：口译员', 'utf8')), '不应回落成默认占位名');
});
