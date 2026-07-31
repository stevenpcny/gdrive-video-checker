'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppPaths } = require('../electron/paths');
const { migrateLegacyData } = require('../electron/migration');

test('legacy migration copies user data without deleting source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-checker-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = {
    getPath(name) {
      return {
        appData: path.join(root, 'Application Support'),
        home: root
      }[name];
    }
  };
  const paths = createAppPaths(app);
  const legacyRoot = path.join(root, 'legacy');
  const globalRcloneConfig = path.join(root, '.config', 'rclone', 'rclone.conf');
  fs.mkdirSync(path.join(legacyRoot, 'keys'), { recursive: true });
  fs.mkdirSync(path.dirname(globalRcloneConfig), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'marks.json'), '{"video":"ok"}');
  fs.writeFileSync(path.join(legacyRoot, 'keys', 'drive.json'), '{"type":"service_account"}');
  fs.writeFileSync(globalRcloneConfig, '[drive]\ntype = drive\n');

  const result = migrateLegacyData(paths, { legacyRoot, globalRcloneConfig });
  assert.deepEqual(result.copied.sort(), ['keys/drive.json', 'marks.json']);
  assert.equal(result.globalRcloneConfigAvailable, true);
  assert.equal(fs.existsSync(path.join(legacyRoot, 'marks.json')), true);
  assert.equal(fs.existsSync(path.join(legacyRoot, 'keys', 'drive.json')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.marksFile, 'utf8')), { video: 'ok' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.keysDir, 'drive.json'), 'utf8')), {
    type: 'service_account'
  });

  const second = migrateLegacyData(paths, { legacyRoot, globalRcloneConfig });
  assert.equal(second.completedAt, result.completedAt);
});
