import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer, post} from './helpers.mjs';

const params = {disease: '肾结石', country: '美国', language: '英文', gender: '女', age: 42};

test('模式2 结束返回逐句表达反馈', async t => {
  const s = await startServer();
  t.after(s.stop);

  const startResp = await post(s.base, '/api/m2/start', {scenario: 'consult', maxRounds: 1, params});
  assert.equal(startResp.status, 200);
  const start = await startResp.json();

  const turnResp = await post(s.base, '/api/m2/turn', {sessionId: start.sessionId, utterance: 'Hello, I am Dr. Zhang. What brings you in today?'});
  assert.equal(turnResp.status, 200);
  const turn = await turnResp.json();

  assert.equal(turn.finished.reason, 'max_rounds');
  assert.equal(turn.utterances.length, 1);
  assert.equal(turn.utterances[0].text, 'Hello, I am Dr. Zhang. What brings you in today?');
  assert.ok(turn.feedback, '结束后应返回个性化反馈');
  assert.equal(turn.feedback.references.length, 1);
  assert.ok(turn.feedback.plan.length >= 1);

  // 报告必须按 medstaff 量规汇总；修复前会回落到 professional 维度并全部记 0
  assert.equal(turn.report.overall, 77);
  assert.equal(turn.report.utterances, 1);
});
