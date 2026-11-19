import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {startServer, root} from './helpers.mjs';

// 慢速 LLM：每个请求延迟 250ms 再正常返回，留出用户点"中止"的窗口
function slowModel() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({choices: [{message: {content: '您好，我是张医生。请问您怎么称呼？'}, finish_reason: 'stop'}]}));
      }, 250);
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

test('用户中止自动演练：协作式收尾并产出部分报告与存档', async t => {
  const mock = await slowModel();
  const s = await startServer({
    DRY_RUN: '0',
    AMI_API_KEY: 'test',
    AMI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
  });
  t.after(() => { s.stop(); mock.srv.close(); });

  const runId = 'testrun123';
  const resp = await fetch(s.base + '/api/auto', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({runId, scenario: 'consult', maxRounds: 30, params: {disease: '肾结石', country: '美国', language: '英文'}}),
  });
  assert.equal(resp.status, 200);

  // 读流的同时，稍后触发中止（演练还在跑）
  const events = [];
  const reading = resp.text().then(t => parseSse(t).forEach(e => events.push(e)));
  await new Promise(r => setTimeout(r, 400));
  const stopResp = await fetch(s.base + '/api/auto/stop', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({runId}),
  });
  assert.equal(stopResp.status, 200);
  await reading;

  const done = events.find(e => e.type === 'done');
  assert.ok(done, '中止后应下发 done 事件');
  assert.equal(done.stopped, 'user_abort');
  assert.ok(done.saved, '中止演练应照常存档');
  if (done.saved) fs.rmSync(path.join(root, 'output', done.saved), {force: true});
});

test('对不存在的中止请求返回 404', async t => {
  const mock = await slowModel();
  const s = await startServer({DRY_RUN: '0', AMI_API_KEY: 'test', AMI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`});
  t.after(() => { s.stop(); mock.srv.close(); });
  const resp = await fetch(s.base + '/api/auto/stop', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({runId: 'nonexistent'}),
  });
  assert.equal(resp.status, 404);
});
