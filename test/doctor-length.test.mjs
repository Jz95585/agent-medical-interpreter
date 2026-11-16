import test from 'node:test';
import assert2 from 'node:assert/strict';
import http from 'node:http';
import {doctorTurn} from '../src/agents.mjs';

const LONG_REPLY = '您好，我是张医生。请先坐下休息一下。请问您怎么称呼？我想先了解一下您的基本情况和本次就诊的主要不适。您描述的疼痛如果发生在腰部并向腹股沟放射，还伴随血尿和恶心呕吐，往往提示泌尿系统结石的可能。结石在输尿管里移动时会划伤管壁引起绞痛和出血，也会造成排尿不适。所以接下来我需要了解疼痛开始的时间、性质和伴随症状，请您逐一告诉我。';

const SHORT_REPLY = '您好，我是张医生。请问您怎么称呼？';

// mock：rerank 请求（max_tokens=200）返回排序 JSON；doctor 首次生成返回超长文本，纠正重试返回短文本
function mockModel() {
  const state = {bodies: [], doctorCalls: 0};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      state.bodies.push(body);
      let content;
      if (body.max_tokens === 200) content = '{"order":[0,1,2]}';
      else if (state.doctorCalls++ === 0) content = LONG_REPLY;
      else content = SHORT_REPLY;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({srv, state, port: srv.address().port})));
}

// mock：rerank 正常返回；doctor 恒为短文本
function mockShort() {
  const state = {bodies: []};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      state.bodies.push(body);
      const content = body.max_tokens === 200 ? '{"order":[0,1,2]}' : SHORT_REPLY;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({srv, state, port: srv.address().port})));
}

function makeState() {
  return {
    settings: {scenario: 'consult', doctorLanguage: '中文', interpreterType: 'professional'},
    patientInfo: {language: '英文', disease_info: {disease_type: '肾结石', symptoms: [], medical_history: ''}},
    log: [],
    scores: [],
    sqlQueries: [],
    doctor: {name: '张医生', roleLabel: '医生', specialization: '泌尿外科'},
  };
}

test('超长医生话轮触发纠正重试并取较短者', async () => {
  const {srv, state: mock, port} = await mockModel();
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    const state = makeState();
    const result = await doctorTurn(env, state, undefined);
    // 注意：检索 rerank 也会发一次 LLM 请求（仅 user 消息），按"纠正"特征定位重试请求
    const fixes = mock.bodies.filter(b => b.messages[1]?.content.includes('纠正'));
    assert2.equal(fixes.length, 1, '应恰好重试一次');
    assert2.match(fixes[0].messages[1].content, /超过/, '重试提示应指出超限');
    assert2.equal(result.content, SHORT_REPLY, '落地较短者');
    assert2.equal(state.log[0].content, SHORT_REPLY);
  } finally {
    srv.close();
  }
});

test('正常长度话轮不触发重试', async () => {
  const {srv, state: mock, port} = await mockShort();
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    const state = makeState();
    const result = await doctorTurn(env, state, undefined);
    assert2.equal(mock.bodies.filter(b => b.messages[1]?.content.includes('纠正')).length, 0, '不应有纠正重试');
    assert2.equal(result.content, SHORT_REPLY);
  } finally {
    srv.close();
  }
});
