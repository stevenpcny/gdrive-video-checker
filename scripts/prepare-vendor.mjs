import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.73.2';
const targets = [
  {
    archive: `rclone-v${version}-osx-amd64.zip`,
    dir: 'darwin-x64',
    arch: 'x86_64',
    sha256: 'ff3215b1b93e4588e0ccfef11e4c49755a91d42f4bc89c98bf89f6d30b0ae16f'
  },
  {
    archive: `rclone-v${version}-osx-arm64.zip`,
    dir: 'darwin-arm64',
    arch: 'arm64',
    sha256: '879fd46e0338bf6244f55af6bde9f151a1711dd62abdc46117a4c11cfb0a601e'
  }
];

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

for (const target of targets) {
  const destinationDir = path.join(root, 'vendor', 'bin', target.dir);
  const destination = path.join(destinationDir, 'rclone');
  fs.mkdirSync(destinationDir, { recursive: true });
  if (!fs.existsSync(destination)) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-checker-rclone-'));
    try {
      const archive = path.join(temp, target.archive);
      await download(`https://downloads.rclone.org/v${version}/${target.archive}`, archive);
      const actual = sha256(archive);
      if (actual !== target.sha256) throw new Error(`${target.archive} SHA-256 不匹配: ${actual}`);
      execFileSync('ditto', ['-x', '-k', archive, temp]);
      const extracted = path.join(temp, target.archive.replace(/\.zip$/, ''), 'rclone');
      fs.copyFileSync(extracted, destination);
      fs.chmodSync(destination, 0o755);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  const description = execFileSync('file', [destination], { encoding: 'utf8' });
  if (!description.includes(target.arch)) throw new Error(`${destination} 架构错误: ${description.trim()}`);
  const buildInfo = execFileSync('vtool', ['-show-build', destination], { encoding: 'utf8' });
  const minos = /minos\s+([0-9.]+)/.exec(buildInfo)?.[1];
  if (!minos || Number(minos.split('.')[0]) > 15) throw new Error(`${destination} 最低系统版本超出 macOS 15: ${minos || 'unknown'}`);
  if ((process.arch === 'x64' && target.arch === 'x86_64') || process.arch === target.arch) {
    execFileSync(destination, ['version'], { stdio: 'inherit' });
  }
}

const licenseDir = path.join(root, 'licenses');
fs.mkdirSync(licenseDir, { recursive: true });
const licensePath = path.join(licenseDir, 'rclone-LICENSE.txt');
if (!fs.existsSync(licensePath)) {
  await download(`https://raw.githubusercontent.com/rclone/rclone/v${version}/COPYING`, licensePath);
}
fs.writeFileSync(path.join(licenseDir, 'rclone-version.txt'), `rclone v${version}\n`);
console.log(`rclone v${version} 双架构资源已准备完成`);
