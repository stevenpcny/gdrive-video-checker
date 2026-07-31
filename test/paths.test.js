'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { safePath, resolveInside } = require('../server');

test('safePath rejects traversal and empty segments', () => {
  assert.equal(safePath('/folder/video.mp4/'), 'folder/video.mp4');
  assert.equal(safePath(''), '');
  assert.equal(safePath('../secret'), null);
  assert.equal(safePath('folder//video.mp4'), null);
});

test('resolveInside keeps static and thumbnail reads inside their roots', () => {
  const root = path.resolve('/tmp/video-checker-root');
  assert.equal(resolveInside(root, 'folder/file.jpg'), path.join(root, 'folder', 'file.jpg'));
  assert.equal(resolveInside(root, '../outside'), null);
  assert.equal(resolveInside(root, '/absolute'), null);
});
