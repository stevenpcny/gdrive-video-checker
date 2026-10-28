'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

test('calibration sweep finds the separating threshold and scores the current one', async () => {
  const { sweep, parseCsv, METRICS } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'calibrate.mjs')));
  const rows = parseCsv('video,plan,label\n"a,1.mp4",a.json,fail\nb.mp4,b.json,pass\n');
  assert.deepEqual(rows[0], { video: 'a,1.mp4', plan: 'a.json', label: 'fail' });
  const metric = METRICS.find(m => m.id === 'seamDeltaE');
  const samples = [3, 4, 5, 6].map(v => ({ label: 'pass', metrics: { seamDeltaE: v } }))
    .concat([7, 9, 12, 20].map(v => ({ label: 'fail', metrics: { seamDeltaE: v } })));
  const result = sweep(samples, metric);
  assert.equal(result.suggested.threshold, 7);
  assert.equal(result.suggested.tpr, 1);
  assert.equal(result.suggested.fpr, 0);
  assert.equal(result.current.threshold, 8);
  assert.equal(result.current.tpr, 0.75);
  assert.equal(result.enough, false);
  assert.throws(() => parseCsv('video,label\n'), /plan/);
});
