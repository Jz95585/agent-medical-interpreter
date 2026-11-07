import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {judgeTurn} from '../src/agents.mjs';

function startMock(reply) {
  return new Promise(resolve => {
    const state = {calls: 0};
    const srv = http.createServer((req, res) => {
      state.calls += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(reply()));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({srv, state, port: srv.address().port});
    });
  });
}

const state = () => ({
  settings: {interpreterType: 'professional', doctorLanguage: '中文'},
  patientInfo: {language: '英文'},
  scores: [],
});

test('评判员超长时降级重试一次并记 0 分，不抛错', async () => {
  const {srv, state: mock, port} = await startMock(() => ({
    choices: [{message: {content: '{"comment":"输出过长"}'}, finish_reason: 'length'}],
  }));
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 'test'};
    const s = state();
    const r = await judgeTurn(env, s, '原话内容', '译文内容');
    assert.equal(mock.calls, 2, '应发起一次原始调用 + 一次降级重试');
    assert.equal(r.total, 0);
    assert.equal(r.percent, 0);
    assert.match(r.comment, /0 分/);
    assert.equal(s.scores.length, 1, '失败句仍应写入评分列表，保证句数对齐');
  } finally {
    srv.close();
  }
});

test('评判员正常返回时不重试', async () => {
  const dims = {
    accuracy_medical_knowledge: 4, accuracy_information_integrity: 4,
    technique_discourse_management: 4, technique_use_of_person: 5,
    technique_cultural_interpretation: 4, ethics_role_boundaries: 5,
    ethics_impartiality: 5, effectiveness_trust_building: 4,
    effectiveness_fluency: 4, empathy_expression: 4, ethics_decision: 5,
    comment: '整体良好', key_point: '保持第一人称',
  };
  const {srv, state: mock, port} = await startMock(() => ({
    choices: [{message: {content: JSON.stringify(dims)}, finish_reason: 'stop'}],
  }));
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 'test'};
    const r = await judgeTurn(env, state(), '原话', '译文');
    assert.equal(mock.calls, 1);
    assert.equal(r.perfect, 55);
    assert.equal(r.total, 48);
    assert.equal(r.percent, 87);
  } finally {
    srv.close();
  }
});
