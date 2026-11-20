import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {startServer, post} from './helpers.mjs';

const JUDGE = JSON.stringify({
  accuracy_medical_knowledge: 4, accuracy_information_integrity: 4,
  technique_discourse_management: 4, technique_use_of_person: 5,
  technique_cultural_interpretation: 4, ethics_role_boundaries: 5,
  ethics_impartiality: 5, effectiveness_trust_building: 4,
  effectiveness_fluency: 4, empathy_expression: 4, ethics_decision: 5,
  comment: '开场完整', revision: '', polish: '', key_point: '保持第一人称',
});

// 模拟 LLM：按提示词特征返回对应内容，覆盖患者信息、诊前开场、患者应答、评分
function mockModel() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const text = (body.messages || []).map(m => m.content).join('\n');
      let content = 'ok';
      if (text.includes('你的任务是根据选定的疾病类型')) content = JSON.stringify({symptoms: ['下背痛'], medical_history: '无'});
      else if (text.includes('请完成诊前接入')) content = 'Hello, I am your medical interpreter today. May I confirm your name and date of birth? Have you used a medical interpreter before?';
      else if (text.includes('口译员刚向你问好')) content = 'No, I have never used a medical interpreter. My name is Emily Clark.';
      else if (text.includes('请你根据下列原话及口译译文')) content = JUDGE;
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, port: srv.address().port})));
}

test('模式3 诊前接入：患者回答会回传，再进入原则阐述', async t => {
  const mock = await mockModel();
  const s = await startServer({DRY_RUN: '0', AMI_API_KEY: 'test', AMI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`});
  t.after(() => { s.stop(); mock.srv.close(); });

  const start = await post(s.base, '/api/drill/start', {
    scenario: 'consult', interpreterType: 'professional', scoringMode: 'ai', maxRounds: 2,
    params: {disease: '肾结石', country: '美国', language: '英文', department: '泌尿外科', doctorLanguage: '中文', intakePath: 'direct'},
  });
  assert.equal(start.status, 200);
  const session = await start.json();
  assert.equal(session.intake.path, 'direct');

  const step = await post(s.base, '/api/drill/step', {
    sessionId: session.sessionId,
    translation: 'Hello, welcome. I am your medical interpreter today. May I confirm your name and date of birth? Have you used a medical interpreter before?',
  });
  assert.equal(step.status, 200);
  const data = await step.json();

  assert.ok(data.reply, '患者的回答应回传给前端展示');
  assert.match(data.reply.text, /never used a medical interpreter/);
  assert.equal(data.next.speaker, 'task', '不熟悉口译的患者应进入原则阐述任务');
  assert.ok(data.score, '开场话轮应有评分');
});
