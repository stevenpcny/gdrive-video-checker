'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeItem, validateMoveTarget } = require('../public/batch-ops');

const entry = (Name, IsDir = false) => ({ Name, IsDir });

test('batch items preserve type and current-directory path', () => {
  assert.deepEqual(makeItem(entry('clip.mp4'), false, 'jobs/today'), {
    entry: entry('clip.mp4'),
    isDir: false,
    name: 'clip.mp4',
    parent: 'jobs/today',
    path: 'jobs/today/clip.mp4',
    key: 'file\0jobs/today/clip.mp4'
  });
});

test('batch move rejects the source directory and descendants', () => {
  const items = [makeItem(entry('source', true), true, 'jobs')];
  assert.equal(validateMoveTarget(items, 'jobs', []), '这里就是原位置');
  assert.equal(validateMoveTarget(items, 'jobs/source/child', []), '不能把文件夹移入自身或它的子目录');
});

test('batch move reports every conflicting name and permits a safe target', () => {
  const items = [
    makeItem(entry('one.mp4'), false, 'jobs'),
    makeItem(entry('two', true), true, 'jobs')
  ];
  assert.equal(
    validateMoveTarget(items, 'archive', [entry('one.mp4'), entry('two', true)]),
    '目标位置已存在：one.mp4、two'
  );
  assert.equal(validateMoveTarget(items, 'archive', [entry('other.mp4')]), '');
});
