import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {patientTurn} from '../src/agents.mjs';

function mock() {
  const state = {rerankCalls: 0};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      let content = 'Hello, I am in pain.';
      if (body.max_tokens === 200) { state.rerankCalls += 1; content = '{"order":[0,1,2]}'; }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, state, port: srv.address().port})));
}

function makeState(disease) {
  return {
    settings: {scenario: 'consult', mode: 'auto', doctorLanguage: '中文', interpreterType: 'professional'},
    patientInfo: {
      name: 'Emily', country: '美国', language: '英文', personality: '平和', health_literacy: '一般',
      religion: '无特定信仰', dietary: '无特殊要求', taboos: '无特殊禁忌',
      disease_info: {disease_type: disease, symptoms: ['疼痛'], medical_history: '无'},
    },
    interpreter: {name: '王译员'},
    log: [], scores: [],
  };
}

async function run(disease) {
  const {srv, state: mockState, port} = await mock();
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    await patientTurn(env, makeState(disease), undefined);
    return mockState.rerankCalls;
  } finally { srv.close(); }
}

test('相关条目不做精排，避免无效调用', async () => {
  assert.equal(await run('肾结石'), 0);
});

test('疾病专条才做精排', async () => {
  assert.equal(await run('甲型流感'), 1);
});
