import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {startServer, root} from './helpers.mjs';

const JUDGE = JSON.stringify({
  accuracy_medical_knowledge: 4, accuracy_information_integrity: 4,
  technique_discourse_management: 4, technique_use_of_person: 5,
  technique_cultural_interpretation: 4, ethics_role_boundaries: 5,
  ethics_impartiality: 5, effectiveness_trust_building: 4,
  effectiveness_fluency: 4, empathy_expression: 4, ethics_decision: 5,
  comment: 'ok', revision: '', polish: '', key_point: 'ok',
});
const TEACHING = JSON.stringify({medicalKnowledge: '知识', workflow: '流程', terminology: [], languagePoints: []});

// 模拟：管理者每轮都想终止；第一次诊断审核不通过，第二次通过
function mockModel() {
  const state = {diagCalls: 0};
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const text = (body.messages || []).map(m => m.content).join('\n');
      let content = 'ok';
      if (body.max_tokens === 200) content = '{"order":[0,1,2]}';
      else if (text.includes('你的任务是根据选定的疾病类型')) content = JSON.stringify({symptoms: ['发热'], medical_history: '无'});
      else if (text.includes('请完成诊前接入')) content = 'Hello, I am your medical interpreter today. May I confirm your name and date of birth? Have you used a medical interpreter before?';
      else if (text.includes('口译员刚向你问好')) content = 'Yes, I have worked with a medical interpreter before. My name is Emily.';
      else if (text.includes('医疗对话审核员')) {
        state.diagCalls += 1;
        content = state.diagCalls === 1
          ? JSON.stringify({diagnosis: '', treatment: '', sufficient: false, reason: '医生尚未给出明确诊断'})
          : JSON.stringify({diagnosis: '甲型流感', treatment: '休息、对症退热', sufficient: true, reason: ''});
      } else if (text.includes('医疗多智能体对话管理者')) content = 'TERMINATE';
      else if (text.includes('请你根据下列原话及口译译文')) content = JUDGE;
      else if (text.includes('产出讲解材料')) content = TEACHING;
      else if (text.includes('继续以患者的身份')) content = 'I feel better now. Thank you, doctor.';
      else if (text.includes('医学科普改写助手')) content = '这是科普内容。';
      else {
        const i = text.lastIndexOf('"role":"from_');
        if (i >= 0) content = text.slice(i, i + 30).includes('from_patient') ? 'Hello, doctor.' : '您好，医生。';
        else if (text.includes('继续以')) content = '我认为是甲型流感。建议多休息，必要时服用退烧药。';
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({choices: [{message: {content}, finish_reason: 'stop'}]}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, state, port: srv.address().port})));
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map(chunk => {
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
}

test('管理者想终止但诊断未完成时继续演练，第二次通过后才结束', async t => {
  const mock = await mockModel();
  const s = await startServer({DRY_RUN: '0', AMI_API_KEY: 'test', AMI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`});
  t.after(() => { s.stop(); mock.srv.close(); });

  const resp = await fetch(s.base + '/api/auto', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      scenario: 'consult', maxRounds: 5,
      params: {disease: '甲型流感', country: '美国', language: '英文', department: '呼吸和危重症医学科', doctorLanguage: '中文', intakePath: 'direct'},
    }),
  });
  assert.equal(resp.status, 200);
  const events = parseSse(await resp.text());
  const done = events.find(e => e.type === 'done');

  assert.ok(done, '应正常结束');
  assert.equal(done.stopped, 'manager', '诊断达标后由管理者终止');
  assert.ok(done.rounds >= 2, '第一次终止被拦下后应继续至少一轮');
  assert.equal(mock.state.diagCalls, 2, '诊断审核应被调用两次');
  assert.ok(events.some(e => e.type === 'status' && /暂不能结束/.test(e.label)), '应提示终止被拦截');

  if (done.saved) fs.rmSync(path.join(root, 'output', done.saved), {force: true});
});
