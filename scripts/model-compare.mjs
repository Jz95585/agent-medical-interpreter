// 模型对比：同一病例分别用多个模型跑完整演练，统计语言正确性、未翻译、话轮长度与耗时
// 用法：node scripts/model-compare.mjs [--models=a,b,c] [--reps=2] [--rounds=2] [--disease=甲型流感]
import {spawn} from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {langMismatch, bigramOverlap} from '../src/agents.mjs';
import {findDepartment} from '../src/pools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const models = opt('models', 'deepseek/deepseek-v4.1-flash,meta-llama/llama-4-maverick,mistralai/mistral-large-4-0')
  .split(',').map(s => s.trim()).filter(Boolean);
const reps = Math.max(1, Number(opt('reps', '2')) || 2);
const rounds = Math.max(1, Number(opt('rounds', '2')) || 2);
const disease = opt('disease', '甲型流感');
const scenario = opt('scenario', 'consult');
const department = findDepartment(disease) || '呼吸和危重症医学科';

const META_RE = /请提供(下一轮|后续)(对话|内容)?|作为.{0,12}(译员|口译员)|我将.{0,8}遵守.{0,12}(指示|要求)|我将.{0,8}(提供|给出).{0,8}(口译|翻译)|请继续(对话|提供下一轮)|please provide the next|as (an|the) interpreter/i;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const {port} = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(model) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {...process.env, DRY_RUN: '0', AMI_MODEL: model, BIND: '127.0.0.1', PORT: String(port), RUBRIC_PUBLIC: '0'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  proc.stderr.on('data', d => stderr.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/config');
      if (r.ok) return {base, proc, stop: () => proc.kill()};
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('服务端启动超时：' + stderr.join('').slice(0, 200));
}

function parseSse(text) {
  return text.split('\n\n').filter(Boolean).map(chunk => {
    const line = chunk.split('\n').find(l => l.startsWith('data: '));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
}

function evaluate(events, ms) {
  const msgs = events.filter(e => e.type === 'message');
  let langViolations = 0;
  let untranslated = 0;
  let meta = 0;
  const doctorLens = [];
  let lastOriginal = '';
  for (const m of msgs) {
    if (m.speaker === 'doctor') { doctorLens.push(m.text.length); lastOriginal = m.text; continue; }
    if (m.speaker === 'patient') { lastOriginal = m.text; continue; }
    if (m.speaker !== 'interpreter') continue;
    const expected = m.dir === 'to_patient' ? '英文' : '中文';
    if (langMismatch(m.text, expected)) langViolations += 1;
    if (bigramOverlap(lastOriginal, m.text) > 0.7) untranslated += 1;
    if (META_RE.test(m.text)) meta += 1;
  }
  const done = events.find(e => e.type === 'done');
  const error = events.find(e => e.type === 'error');
  return {
    ms,
    stopped: done?.stopped || 'none',
    error: error?.error || '',
    messages: msgs.length,
    intakeMessages: msgs.filter(m => m.round === 0).length,
    langViolations,
    untranslated,
    meta,
    doctorAvg: doctorLens.length ? Math.round(doctorLens.reduce((a, b) => a + b, 0) / doctorLens.length) : 0,
    doctorMax: doctorLens.length ? Math.max(...doctorLens) : 0,
    overall: done?.report?.overall ?? null,
  };
}

const results = [];

for (const model of models) {
  for (let rep = 1; rep <= reps; rep += 1) {
    process.stdout.write(`\n[${model}] 第 ${rep}/${reps} 次 … `);
    const s = await startServer(model);
    try {
      const t = Date.now();
      const resp = await fetch(s.base + '/api/auto', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          scenario,
          maxRounds: rounds,
          params: {disease, country: '美国', language: '英文', department, doctorLanguage: '中文', intakePath: 'direct'},
        }),
        signal: AbortSignal.timeout(300000),
      });
      const events = parseSse(await resp.text());
      const row = {model, rep, ...evaluate(events, Date.now() - t)};
      results.push(row);
      console.log(`${row.ms}ms 错误=${row.error || '无'} 语言错=${row.langViolations} 未翻译=${row.untranslated} 说明=${row.meta} 综合=${row.overall ?? '—'}`);
    } finally {
      s.stop();
    }
  }
}

const out = path.join('/tmp', `model-compare-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify({config: {disease, scenario, rounds, reps}, results}, null, 2));

console.log('\n模型'.padEnd(38) + '平均耗时  错误  语言错  未翻译  说明  医生均长  综合');
for (const model of models) {
  const rows = results.filter(r => r.model === model);
  const avg = k => (rows.reduce((a, b) => a + b[k], 0) / rows.length).toFixed(0);
  const errs = rows.filter(r => r.error || r.stopped === 'error').length;
  console.log(
    model.padEnd(36) +
    `${avg('ms')}ms`.padEnd(10) +
    String(errs).padEnd(6) +
    avg('langViolations').padEnd(8) +
    avg('untranslated').padEnd(8) +
    avg('meta').padEnd(6) +
    avg('doctorAvg').padEnd(10) +
    rows.map(r => r.overall ?? '—').join('/')
  );
}
console.log('\n原始结果：' + out);
