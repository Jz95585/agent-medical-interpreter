import test from 'node:test';
import assert from 'node:assert/strict';
import {turnTooLong} from '../src/agents.mjs';

test('英文句号计入句数，Dr. 与小数不误判', () => {
  const r = turnTooLong('Good morning. I am Dr. Zhang. May I have your name? Please take a seat. How long have you had this pain?');
  assert.ok(r && r.sentences === 5, 'Dr. 不应算一句，五个句子应被识别');

  assert.equal(turnTooLong('Take 0.5 mg twice a day. Come back if it gets worse.'), null);
});

test('中文句数超过 4 句被判定过长', () => {
  const r = turnTooLong('您好。请坐。请问您怎么称呼？哪里不舒服？疼了多久？');
  assert.ok(r && r.sentences === 5);
});

test('260 字上限仍然生效', () => {
  const r = turnTooLong('啊'.repeat(261));
  assert.ok(r && r.chars === 261);
});
