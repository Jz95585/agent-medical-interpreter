import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {doctorTurn} from '../src/agents.mjs';

function mockModel() {
  const state = {bodies: []};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      state.bodies.push(JSON.parse(raw));
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content: '您好，请问您哪里不舒服？'}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({srv, state, port: srv.address().port})));
}

function makeState(disease) {
  return {
    settings: {scenario: 'consult', doctorLanguage: '中文', interpreterType: 'professional'},
    patientInfo: {language: '英文', disease_info: {disease_type: disease, symptoms: [], medical_history: ''}},
    log: [],
    scores: [],
    sqlQueries: [],
    doctor: {name: '张医生', roleLabel: '医生', specialization: '泌尿外科'},
  };
}

async function run(disease) {
  const {srv, state: mock, port} = await mockModel();
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    const state = makeState(disease);
    await doctorTurn(env, state, undefined);
    return {system: mock.bodies[0].messages[0].content, user: mock.bodies[0].messages[1].content, state};
  } finally {
    srv.close();
  }
}

test('相关条目时提示医生不得当作疾病依据', async () => {
  const {system, user, state} = await run('肾结石');
  assert.equal(state.msdLevel, 'related');
  assert.match(system, /未收录该疾病的专门条目/);
  assert.match(system, /不得作为该疾病的诊断或治疗依据/);
  assert.match(user, /参考资料/, '相关条目仍应注入供参考');
});

test('命中疾病专条时不出现未收录提示', async () => {
  const {system, state} = await run('甲型流感');
  assert.equal(state.msdLevel, 'disease');
  assert.doesNotMatch(system, /未收录/);
});
