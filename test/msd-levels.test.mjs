import test from 'node:test';
import assert from 'node:assert/strict';
import {search} from '../src/msd.mjs';

test('未收录疾病专条时标记为 related', () => {
  const r = search('肾结石', 2);
  assert.equal(r.level, 'related');
  assert.ok(r.hits.length > 0);
});

test('别名命中疾病专条时标记为 disease', () => {
  assert.equal(search('甲型流感', 2).level, 'disease');
  assert.equal(search('慢阻肺', 2).level, 'disease');
  assert.equal(search('慢性背痛', 2).level, 'disease');
});

test('疾病名直接命中时标记为 disease', () => {
  assert.equal(search('高血压', 2).level, 'disease');
});

test('完全不存在的疾病标记为 none', () => {
  const r = search('不存在的罕见病名XYZ', 2);
  assert.equal(r.level, 'none');
  assert.deepEqual(r.hits, []);
});
