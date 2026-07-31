import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const app = path.join(dist, 'mac-universal', '视频检查器.app');
if (!fs.existsSync(app)) throw new Error(`找不到 Universal App: ${app}`);

const main = path.join(app, 'Contents', 'MacOS', '视频检查器');
const mainArchs = execFileSync('lipo', ['-archs', main], { encoding: 'utf8' }).trim().split(/\s+/).sort();
if (mainArchs.join(' ') !== 'arm64 x86_64') throw new Error(`主程序不是 Universal: ${mainArchs.join(' ')}`);

for (const [relative, expected] of [
  ['Contents/Resources/bin/darwin-x64/rclone', 'x86_64'],
  ['Contents/Resources/bin/darwin-x64/ffmpeg', 'x86_64'],
  ['Contents/Resources/bin/darwin-arm64/rclone', 'arm64'],
  ['Contents/Resources/bin/darwin-arm64/ffmpeg', 'arm64']
]) {
  const file = path.join(app, relative);
  if (!fs.existsSync(file)) throw new Error(`缺少内置工具: ${relative}`);
  const description = execFileSync('file', [file], { encoding: 'utf8' });
  if (!description.includes(expected)) throw new Error(`${relative} 架构错误: ${description.trim()}`);
}

execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
const spctl = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', app], { encoding: 'utf8' });

const artifacts = fs.readdirSync(dist)
  .filter(name => /\.(dmg|zip)$/.test(name))
  .map(name => path.join(dist, name));
if (!artifacts.some(file => file.endsWith('.dmg')) || !artifacts.some(file => file.endsWith('.zip'))) {
  throw new Error('DMG 或 ZIP 制品缺失');
}

const sums = artifacts.map(file => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${hash}  ${path.basename(file)}`;
});
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sums.join('\n') + '\n');
fs.writeFileSync(path.join(dist, 'build-manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  electron: '43.1.0',
  electronBuilder: '26.15.3',
  rclone: '1.73.2',
  ffmpeg: '8.1',
  minimumMacOS: '15.0',
  appArchitectures: mainArchs,
  signing: 'ad-hoc',
  notarized: false,
  gatekeeperAssessment: {
    status: spctl.status,
    stdout: spctl.stdout.trim(),
    stderr: spctl.stderr.trim(),
    expectedToFailWithoutDeveloperId: true
  },
  artifacts: sums
}, null, 2));

console.log('Universal 架构、内置工具、ad-hoc 签名与制品校验完成');
