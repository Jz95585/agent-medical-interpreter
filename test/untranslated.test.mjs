import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {interpreterTurn, bigramOverlap} from '../src/agents.mjs';

// 复制原文的场景：mock 前两次返回中文原样复制，第三次返回真正的日文译文
const COPY = '沃克先生，您好。您描述的腰部腹部阵发性剧痛并放射到腹股沟，还有恶心和血尿，这些症状让我高度怀疑是输尿管结石。';
const JP = 'ウォークさん、こんにちは。腰部と腹部の陣発性の激しい痛みが鼠径部に放散しており、吐き気や血尿も見られることから、尿管結石が強く疑われます。';

function mockModel() {
  const state = {bodies: [], copyCount: 0};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      state.bodies.push(body);
      let content;
      if (body.max_tokens === 200) content = '{"order":[0]}'; // rerank
      else if (state.copyCount < 2) { state.copyCount++; content = COPY; } // 前两次原样复制
      else content = JP; // 第三次真正翻译
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({srv, state, port: srv.address().port})));
}

function makeState() {
  return {
    settings: {scenario: 'consult', doctorLanguage: '中文', interpreterType: 'professional', mode: 'auto'},
    patientInfo: {language: '日文', disease_info: {disease_type: '肾结石', symptoms: [], medical_history: ''}},
    interpreter: {name: '王译员'},
    log: [{role: 'doctor', content: COPY}],
    scores: [],
    sqlQueries: [],
    doctor: {name: '张医生', roleLabel: '医生', specialization: '泌尿外科'},
  };
}

test('译员原样复制原文时触发纠正并最终产出目标语言译文', async () => {
  assert.ok(bigramOverlap(COPY, COPY) > 0.9, '相同文本重合率应接近 1');
  const {srv, state: mock, port} = await mockModel();
  try {
    const env = {AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'};
    const state = makeState();
    const result = await interpreterTurn(env, state, undefined, 1);
    assert.equal(result.dir, 'to_patient');
    assert.equal(result.content, JP, '最终应落地日文译文而非中文复制');
    // 纠正提示应指出"原样复制"
    const fixes = mock.bodies.filter(b => b.messages[1]?.content.includes('原样复制'));
    assert.ok(fixes.length >= 1, '至少一次纠正提示指出未翻译');
  } finally {
    srv.close();
  }
});
