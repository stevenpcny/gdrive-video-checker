import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'vendor', 'bin', 'win32-x64');
const licenseDir = path.join(root, 'licenses');

const rcloneVersion = '1.73.2';
const ffmpegVersion = '8.1.2';
const ffmpegBuild = 'autobuild-2026-07-30-13-32';
const ffmpegArchive = `ffmpeg-n${ffmpegVersion}-32-gcfa62de001-win64-lgpl-8.1.zip`;

const targets = [
  {
    name: 'rclone.exe',
    url: `https://downloads.rclone.org/v${rcloneVersion}/rclone-v${rcloneVersion}-windows-amd64.zip`,
    archive: `rclone-v${rcloneVersion}-windows-amd64.zip`,
    sha256: 'b77a72eab9692f9032dac89d7e13e07ce4747acd9ae402168cc8fe306de1138e',
    entry: `rclone-v${rcloneVersion}-windows-amd64/rclone.exe`
  },
  {
    name: 'ffmpeg.exe',
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${ffmpegBuild}/${ffmpegArchive}`,
    archive: ffmpegArchive,
    sha256: 'c5a091e6a0e446f737f5ae78f9ed38dc02081c014156097468c196b606c4717f',
    entry: `${ffmpegArchive.replace(/\.zip$/, '')}/bin/ffmpeg.exe`,
    licenseEntry: `${ffmpegArchive.replace(/\.zip$/, '')}/LICENSE.txt`,
    licenseFile: 'ffmpeg-windows-LICENSE.txt'
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

// Windows PE 二进制无法在 macOS 上执行，只能校验文件头声明的目标架构。
function assertPeAmd64(file) {
  const header = Buffer.alloc(4096);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file} 不是 Windows PE 文件`);
  const peOffset = header.readUInt32LE(0x3c);
  if (header.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error(`${file} PE 头损坏`);
  const machine = header.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) throw new Error(`${file} 架构错误: 0x${machine.toString(16)}，期望 x86-64 (0x8664)`);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(licenseDir, { recursive: true });

for (const target of targets) {
  const destination = path.join(outputDir, target.name);
  if (!fs.existsSync(destination)) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-checker-win-'));
    try {
      const archive = path.join(temp, target.archive);
      await download(target.url, archive);
      const actual = sha256(archive);
      if (actual !== target.sha256) throw new Error(`${target.archive} SHA-256 不匹配: ${actual}`);
      const entries = [target.entry, target.licenseEntry].filter(Boolean);
      execFileSync('unzip', ['-q', '-o', archive, ...entries, '-d', temp]);
      fs.copyFileSync(path.join(temp, target.entry), destination);
      fs.chmodSync(destination, 0o755);
      if (target.licenseEntry) {
        fs.copyFileSync(path.join(temp, target.licenseEntry), path.join(licenseDir, target.licenseFile));
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  assertPeAmd64(destination);
}

fs.writeFileSync(path.join(licenseDir, 'rclone-version.txt'), `rclone v${rcloneVersion}\n`);
fs.writeFileSync(path.join(licenseDir, 'ffmpeg-windows-build.txt'), `FFmpeg ${ffmpegVersion} (n${ffmpegVersion}-32-gcfa62de001)
Source: ${targets[1].url}
SHA-256: ${targets[1].sha256}
Provider: BtbN/FFmpeg-Builds ${ffmpegBuild}
License profile: LGPL-only build variant; --enable-gpl and --enable-nonfree are not used
Architecture: x86-64
Purpose: local thumbnail extraction only
Corresponding sources and build scripts: https://github.com/BtbN/FFmpeg-Builds
`);

console.log(`Windows x64 资源已准备完成: rclone v${rcloneVersion}, FFmpeg ${ffmpegVersion}`);
