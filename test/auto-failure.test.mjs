import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {startServer, root} from './helpers.mjs';

// 模拟 LLM 全部返回 500，验证自动演练中断时仍保留报告与存档
function failingModel() {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(500, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'mock failure'}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, port: srv.address().port})));
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map(chunk => {
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
}

test('自动演练中途失败时返回 done 事件并保留已完成内容', async t => {
  const mock = await failingModel();
  const s = await startServer({
    DRY_RUN: '0',
    AMI_API_KEY: 'test',
    AMI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
  });
  t.after(() => { s.stop(); mock.srv.close(); });

  const resp = await fetch(s.base + '/api/auto', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({scenario: 'consult', maxRounds: 1, params: {disease: '肾结石', country: '美国', language: '英文'}}),
  });
  assert.equal(resp.status, 200);
  const events = parseSse(await resp.text());

  const errors = events.filter(e => e.type === 'error');
  const done = events.find(e => e.type === 'done');
  assert.ok(errors.length >= 1, '应下发 error 事件供页面提示');
  assert.ok(done, '应下发 done 事件，避免前端停留在运行中');
  assert.equal(done.stopped, 'error');
  assert.ok(done.saved, '应保存已完成部分');
  // mock 全 500：故障发生在诊前接入阶段（round 0），主流程尚未开始 → 已完成 0 轮
  assert.equal(done.rounds, 0);

  if (done.saved) fs.rmSync(path.join(root, 'output', done.saved), {force: true});
});
