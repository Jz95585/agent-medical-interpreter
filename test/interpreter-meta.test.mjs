import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {interpreterTurn} from '../src/agents.mjs';

const META = '好的，我明白了。我将严格遵守所有指示，作为王译员，提供准确、流利、符合语境的专业口译。请提供下一轮对话。';
const OK = '好的医生，我明白了。我没有其他问题了，谢谢您。';

function mock(respond) {
  const state = {calls: 0, prompts: []};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      state.calls += 1;
      state.prompts.push(body.messages[1]?.content || '');
      const content = respond(body, state.calls);
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, state, port: srv.address().port})));
}

function makeState() {
  return {
    settings: {scenario: 'consult', doctorLanguage: '中文', interpreterType: 'professional'},
    patientInfo: {language: '英文', disease_info: {disease_type: '肾结石', symptoms: [], medical_history: ''}},
    interpreter: {name: '王译员'},
    log: [
      {role: 'doctor', content: '请您按时服药，两周后复查。'},
      {role: 'interpreter', dir: 'to_patient', content: 'Please take your medicine and come back in two weeks.'},
      {role: 'patient', content: 'Okay doctor, I understand. I have no more questions. Thank you.'},
    ],
    scores: [],
  };
}

async function run(respond) {
  const {srv, state: mockState, port} = await mock(respond);
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    const r = await interpreterTurn(env, makeState(), undefined, 2);
    return {r, mockState};
  } finally { srv.close(); }
}

test('译员输出说明文字时重试并返回译文', async () => {
  const {r, mockState} = await run((body) => {
    const p = body.messages[1].content;
    if (p.includes('请只把下面这句话翻译成')) return OK;
    return META;
  });
  assert.equal(mockState.calls, 3, '原始调用 + 纠正重试 + 最小上下文兜底');
  assert.equal(r.content, OK);
});

test('兜底后仍是说明文字则报错，不写入剧本', async () => {
  await assert.rejects(run(() => META), /未返回有效译文/);
});

test('正常译文不触发重试', async () => {
  const {r, mockState} = await run(() => OK);
  assert.equal(mockState.calls, 1);
  assert.equal(r.content, OK);
});
