import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {callModel} from '../src/llm.mjs';

// 按顺序返回预设的 finish_reason，并记录每次请求的 max_tokens
function mock(seq) {
  const state = {calls: 0, maxTokens: []};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      state.maxTokens.push(body.max_tokens);
      const reason = seq[Math.min(state.calls, seq.length - 1)];
      state.calls += 1;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: reason === 'length' ? 'x' : 'ok'}, finish_reason: reason}]}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, state, port: srv.address().port})));
}

test('输出超长时自动放宽上限重试一次', async () => {
  const {srv, state, port} = await mock(['length', 'stop']);
  try {
    const r = await callModel({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'},
      [{role: 'user', content: 'hi'}], {max: 100, tag: 'test'});
    assert.equal(state.calls, 2);
    assert.deepEqual(state.maxTokens, [100, 200]);
    assert.equal(r.message, 'ok');
  } finally { srv.close(); }
});

test('重试后仍超长才抛错', async () => {
  const {srv, state, port} = await mock(['length', 'length']);
  try {
    await assert.rejects(
      callModel({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, [{role: 'user', content: 'hi'}], {max: 100, tag: 'test'}),
      /长度上限/,
    );
    assert.equal(state.calls, 2);
  } finally { srv.close(); }
});

test('上限放宽不超过 4000', async () => {
  const {srv, state, port} = await mock(['length', 'stop']);
  try {
    await callModel({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, [{role: 'user', content: 'hi'}], {max: 3000, tag: 'test'});
    assert.deepEqual(state.maxTokens, [3000, 4000]);
  } finally { srv.close(); }
});
