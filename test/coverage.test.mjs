import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {root} from './helpers.mjs';

test('覆盖度脚本可运行并报告缺口', () => {
  const out = execFileSync(process.execPath, ['scripts/coverage.mjs'], {cwd: root, encoding: 'utf8'});
  assert.match(out, /覆盖率：\d+\/\d+/);
  assert.match(out, /肾结石\t仅相关条目/);
  assert.match(out, /需补语料或补别名/);
});
