import test from 'node:test';
import assert from 'node:assert/strict';
import {startServer, post} from './helpers.mjs';

test('RUBRIC_PUBLIC=0 时量规读写接口全部关闭', async t => {
  const s = await startServer({RUBRIC_PUBLIC: '0'});
  t.after(s.stop);

  const cfg = await (await fetch(s.base + '/api/config')).json();
  assert.equal(cfg.rubricPublic, false);

  const read = await fetch(s.base + '/api/rubric');
  assert.equal(read.status, 403);

  const save = await post(s.base, '/api/rubric/save', {persona: 'professional', dims: []});
  assert.equal(save.status, 403);

  const reset = await post(s.base, '/api/rubric/reset', {});
  assert.equal(reset.status, 403);
});

test('RUBRIC_PUBLIC=1 时量规可读', async t => {
  const s = await startServer({RUBRIC_PUBLIC: '1'});
  t.after(s.stop);

  const cfg = await (await fetch(s.base + '/api/config')).json();
  assert.equal(cfg.rubricPublic, true);

  const read = await fetch(s.base + '/api/rubric');
  assert.equal(read.status, 200);
  const store = await read.json();
  assert.ok(store.professional.dims.length >= 10);
});
