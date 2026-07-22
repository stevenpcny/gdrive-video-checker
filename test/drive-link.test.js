'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DriveLink = require('../public/drive-link');

test('parses Google Drive file links into a safe preview URL', () => {
  assert.deepEqual(
    DriveLink.parse('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing&resourcekey=0-demo'),
    {
      type: 'file',
      id: '1AbCdEfGhIjKlMnOp',
      resourceKey: '0-demo',
      previewUrl: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview?resourcekey=0-demo'
    }
  );
  assert.equal(
    DriveLink.parse('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp').previewUrl,
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview'
  );
});

test('distinguishes folders and rejects lookalike hosts', () => {
  assert.deepEqual(
    DriveLink.parse('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing'),
    { type: 'folder', id: '1AbCdEfGhIjKlMnOp' }
  );
  assert.equal(DriveLink.parse('https://drive.google.com.evil.example/file/d/1AbCdEfGhIjKlMnOp/view'), null);
  assert.equal(DriveLink.parse('not a url'), null);
});
