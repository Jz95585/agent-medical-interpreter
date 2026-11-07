import test from 'node:test';
import assert from 'node:assert/strict';
import {langMismatch} from '../src/agents.mjs';

const ZH = '您好，请问您这种疼痛是从什么时候开始的？';
const JA = 'こんにちは、その痛みはいつから始まりましたか。';
const KO = '안녕하세요, 그 통증은 언제부터 시작되었나요?';
const EN = 'Hello, when did this pain first start?';
const FR = "Bonjour, depuis quand cette douleur a-t-elle commencé ?";

test('中文方向：汉字文本通过，日文/韩文/英文被判定为不符', () => {
  assert.equal(langMismatch(ZH, '中文'), false);
  assert.equal(langMismatch(JA, '中文'), true);
  assert.equal(langMismatch(KO, '中文'), true);
  assert.equal(langMismatch(EN, '中文'), true);
});

test('日文方向：假名文本通过，中文/韩文被判定为不符', () => {
  assert.equal(langMismatch(JA, '日文'), false);
  assert.equal(langMismatch(ZH, '日文'), true);
  assert.equal(langMismatch(KO, '日文'), true);
});

test('韩文方向：谚文文本通过，中文/日文被判定为不符', () => {
  assert.equal(langMismatch(KO, '韩文'), false);
  assert.equal(langMismatch(ZH, '韩文'), true);
  assert.equal(langMismatch(JA, '韩文'), true);
});

test('拉丁语系方向：英文/法文通过，中日韩文本被判定为不符', () => {
  assert.equal(langMismatch(EN, '英文'), false);
  assert.equal(langMismatch(FR, '法语'), false);
  assert.equal(langMismatch(ZH, '英文'), true);
  assert.equal(langMismatch(JA, '英文'), true);
  assert.equal(langMismatch(KO, '英文'), true);
});

test('空输出按不符处理，触发重试', () => {
  assert.equal(langMismatch('', '日文'), true);
});
