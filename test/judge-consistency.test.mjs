import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {judgeTurn} from '../src/agents.mjs';

const DIMS = [
  'accuracy_medical_knowledge', 'accuracy_information_integrity',
  'technique_discourse_management', 'technique_use_of_person',
  'technique_cultural_interpretation', 'ethics_role_boundaries',
  'ethics_impartiality', 'effectiveness_trust_building',
  'effectiveness_fluency', 'empathy_expression', 'ethics_decision',
];

function replyWith(score) {
  const body = Object.fromEntries(DIMS.map(k => [k, score]));
  body.comment = score <= 2 ? '本句存在明显问题' : '整体表现良好';
  body.key_point = '保持第一人称';
  return {choices: [{message: {content: JSON.stringify(body)}, finish_reason: 'stop'}]};
}

// 按队列依次返回预设回复，并记录请求体
function startMock(replies) {
  const state = {calls: 0, bodies: []};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      state.bodies.push(JSON.parse(raw));
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({srv, state, port: srv.address().port})));
}

const newState = () => ({
  settings: {interpreterType: 'professional', doctorLanguage: '中文'},
  patientInfo: {language: '英文'},
  scores: [],
});

test('低分出现异常时补采两次并按维度取中位数', async () => {
  // 第一次全 1 分（20 分，疑为异常），后两次全 5 分
  const {srv, state, port} = await startMock([replyWith(1), replyWith(5), replyWith(5)]);
  try {
    const r = await judgeTurn({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, newState(), '原话', '译文');
    assert.equal(state.calls, 3);
    assert.equal(r.samples, 3);
    assert.equal(r.total, 55);
    assert.equal(r.percent, 100);
    assert.match(r.comment, /整体表现良好/, '评语应取自与中位分最接近的样本');
  } finally { srv.close(); }
});

test('真实低分补采后仍然保持低分', async () => {
  const {srv, state, port} = await startMock([replyWith(1), replyWith(1), replyWith(1)]);
  try {
    const r = await judgeTurn({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, newState(), '原话', '译文');
    assert.equal(state.calls, 3);
    assert.equal(r.total, 11);
    assert.equal(r.percent, 20);
  } finally { srv.close(); }
});

test('正常分数不触发补采', async () => {
  const {srv, state, port} = await startMock([replyWith(4)]);
  try {
    const r = await judgeTurn({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, newState(), '原话', '译文');
    assert.equal(state.calls, 1);
    assert.equal(r.samples, undefined);
    assert.equal(r.percent, 80);
  } finally { srv.close(); }
});

test('评判调用使用 temperature 0', async () => {
  const {srv, state, port} = await startMock([replyWith(4)]);
  try {
    await judgeTurn({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, newState(), '原话', '译文');
    assert.equal(state.bodies[0].temperature, 0);
  } finally { srv.close(); }
});
