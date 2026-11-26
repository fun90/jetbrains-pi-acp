import test from 'node:test';
import assert from 'node:assert/strict';
import { displayOptions, fencePreviews } from '../src/dialog.js';

test('只有依次编号的选项才去掉序号，去掉后重复或为空时保持原样', () => {
  assert.deepEqual(displayOptions(['1. 甲', '2. 乙']), ['甲', '乙']);
  for (const options of [['甲', '乙'], ['1. 甲', '3. 乙'], ['2. 甲', '1. 乙'], ['1. 甲', '2. 甲'], ['1. ', '2. 乙'], ['1.甲', '2.乙']]) {
    assert.deepEqual(displayOptions(options), options);
  }
});

test('多个预览各自放进代码块，没有预览的标题不变', () => {
  assert.equal(fencePreviews('普通标题\n\n第二段'), '普通标题\n\n第二段');
  assert.equal(fencePreviews('题目\n\n--- 1. A preview ---\na\n  b\n\n--- 2. B — x preview ---\nc'),
    '题目\n\n**1. A**\n\n```text\na\n  b\n```\n\n**2. B — x**\n\n```text\nc\n```');
});
