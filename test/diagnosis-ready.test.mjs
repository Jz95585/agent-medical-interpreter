import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {diagnosisReady} from '../src/agents.mjs';

function mock(reply, status = 200) {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(status === 200
        ? JSON.stringify({choices: [{message: {content: reply()}, finish_reason: 'stop'}]})
        : JSON.stringify({error: 'mock failure'}));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({srv, port: srv.address().port})));
}

const state = () => ({
  patientInfo: {disease_info: {disease_type: '肾结石'}},
  log: [
    {role: 'doctor', content: '可能是肾结石。'},
    {role: 'patient', content: '好的，谢谢医生。'},
  ],
});

async function run(reply, status) {
  const {srv, port} = await mock(reply, status);
  try {
    return await diagnosisReady({AMI_BASE_URL: `http://127.0.0.1:${port}/v1`, AMI_API_KEY: 't'}, state(), undefined);
  } finally { srv.close(); }
}

test('诊断与方案完成时允许终止', async () => {
  const r = await run(() => JSON.stringify({diagnosis: '输尿管结石', treatment: '多饮水，两周后复查', sufficient: true, reason: ''}));
  assert.equal(r.sufficient, true);
  assert.equal(r.diagnosis, '输尿管结石');
});

test('缺少诊断或方案时不允许终止', async () => {
  const r = await run(() => JSON.stringify({diagnosis: '', treatment: '', sufficient: false, reason: '医生尚未给出明确诊断'}));
  assert.equal(r.sufficient, false);
  assert.match(r.reason, /诊断/);
});

test('判定服务不可用时退回原终止逻辑，避免卡住', async () => {
  const r = await run(() => '', 500);
  assert.equal(r.sufficient, true);
  assert.equal(r.degraded, true);
});
