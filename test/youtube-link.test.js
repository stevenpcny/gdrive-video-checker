'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const YoutubeLink = require('../public/youtube-link');

test('parses common YouTube link shapes into a canonical watch URL', () => {
  const expected = { type: 'youtube', id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
  for (const input of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?feature=share',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
  ]) assert.deepEqual(YoutubeLink.parse(input), expected, input);
});

test('rejects non-YouTube hosts, playlists without a video, and bad IDs', () => {
  assert.equal(YoutubeLink.parse('https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(YoutubeLink.parse('https://www.youtube.com/playlist?list=PL123'), null);
  assert.equal(YoutubeLink.parse('https://youtu.be/short'), null);
  assert.equal(YoutubeLink.parse('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'), null);
  assert.equal(YoutubeLink.parse('file:///etc/passwd'), null);
  assert.equal(YoutubeLink.parse(''), null);
});
