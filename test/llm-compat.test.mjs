import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {callModel} from '../src/llm.mjs';

// 模拟不接受 reasoning 字段的模型：带 reasoning 返回 400，去掉后返回正常
function mock({rejectReasoning = true, always400 = false} = {}) {
  const state = {calls: 0, hadReasoning: []};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      state.calls += 1;
      state.hadReasoning.push('reasoning' in body);
      if (always400 || (rejectReasoning && 'reasoning' in body)) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: {message: 'reasoning_effort none is not supported'}}));
        return;
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: 'ok'}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, state, port: srv.address().port})));
}

test('模型拒绝 reasoning 字段时自动去掉并重试', async () => {
  const {srv, state, port} = await mock();
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't', AMI_MODEL: 'mistralai/mistral-large-4-0'};
    const r = await callModel(env, [{role: 'user', content: 'hi'}], {max: 20, tag: 'test'});
    assert.equal(state.calls, 2);
    assert.deepEqual(state.hadReasoning, [true, false]);
    assert.equal(r.message, 'ok');
  } finally { srv.close(); }
});

test('去掉 reasoning 后仍失败才抛错', async () => {
  const {srv, state, port} = await mock({always400: true});
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    await assert.rejects(callModel(env, [{role: 'user', content: 'hi'}], {max: 20}), /暂时不可用（400）/);
    assert.equal(state.calls, 2);
  } finally { srv.close(); }
});
