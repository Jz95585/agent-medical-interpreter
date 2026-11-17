import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {rerank} from '../src/msd.mjs';

const HITS = [
  {title: 'A', subTopic: 'a', content: '1'},
  {title: 'B', subTopic: 'b', content: '2'},
  {title: 'C', subTopic: 'c', content: '3'},
];

function mock(reply, status = 200) {
  const state = {calls: 0};
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.calls += 1;
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(status === 200
        ? JSON.stringify({choices: [{message: {content: reply()}, finish_reason: 'stop'}]})
        : JSON.stringify({error: 'mock failure'}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, state, port: srv.address().port})));
}

test('精排请求失败时回退原序', async () => {
  const {srv, state, port} = await mock(() => '', 500);
  try {
    const out = await rerank({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, '测试病', HITS);
    assert.equal(state.calls, 1);
    assert.deepEqual(out.map(h => h.title), ['A', 'B', 'C']);
  } finally { srv.close(); }
});

test('精排返回重复编号时去重并补全', async () => {
  const {srv, port} = await mock(() => '{"order":[0,0,1]}');
  try {
    const out = await rerank({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, '测试病', HITS);
    assert.deepEqual(out.map(h => h.title), ['A', 'B', 'C']);
    assert.equal(out.length, 3);
  } finally { srv.close(); }
});

test('只有一个候选时不发起精排请求', async () => {
  const {srv, state, port} = await mock(() => '{"order":[0]}');
  try {
    const out = await rerank({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, '测试病', [HITS[0]]);
    assert.equal(state.calls, 0);
    assert.equal(out.length, 1);
  } finally { srv.close(); }
});
