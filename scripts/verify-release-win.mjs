import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const unpacked = path.join(dist, 'win-unpacked');
if (!fs.existsSync(unpacked)) throw new Error(`找不到 Windows 产物目录: ${unpacked}`);

// Windows PE 二进制无法在 macOS 上执行，只能校验文件头声明的目标架构。
function assertPeAmd64(file, label) {
  if (!fs.existsSync(file)) throw new Error(`缺少 ${label}`);
  const header = Buffer.alloc(4096);
  const handle = fs.openSync(file, 'r');
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${label} 不是 Windows PE 文件`);
  const peOffset = header.readUInt32LE(0x3c);
  if (header.toString('latin1', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error(`${label} PE 头损坏`);
  const machine = header.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) throw new Error(`${label} 架构错误: 0x${machine.toString(16)}，期望 x86-64 (0x8664)`);
}

assertPeAmd64(path.join(unpacked, '视频检查器.exe'), '主程序 视频检查器.exe');
assertPeAmd64(path.join(unpacked, 'resources', 'bin', 'win32-x64', 'rclone.exe'), '内置 rclone.exe');
assertPeAmd64(path.join(unpacked, 'resources', 'bin', 'win32-x64', 'ffmpeg.exe'), '内置 ffmpeg.exe');

const binDir = path.join(unpacked, 'resources', 'bin');
const strayDirs = fs.readdirSync(binDir).filter(name => name !== 'win32-x64');
if (strayDirs.length) throw new Error(`Windows 包内混入了其他平台的二进制: ${strayDirs.join(', ')}`);

const asar = path.join(unpacked, 'resources', 'app.asar');
if (!fs.existsSync(asar)) throw new Error('缺少 app.asar');

const artifacts = fs.readdirSync(dist)
  .filter(name => /-x64\.zip$/.test(name))
  .map(name => path.join(dist, name));
if (!artifacts.length) throw new Error('Windows ZIP 制品缺失');

const sums = artifacts.map(file => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `${hash}  ${path.basename(file)}`;
});
fs.writeFileSync(path.join(dist, 'SHA256SUMS-win.txt'), sums.join('\n') + '\n');
fs.writeFileSync(path.join(dist, 'build-manifest-win.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  platform: 'win32',
  electron: '43.1.0',
  electronBuilder: '26.15.3',
  rclone: '1.73.2',
  ffmpeg: '8.1.2 (BtbN win64-lgpl)',
  appArchitectures: ['x64'],
  signing: 'none',
  buildHost: `${process.platform}-${process.arch}`,
  runtimeVerification: 'static-only: PE 头架构校验，未在 Windows 上实际运行',
  artifacts: sums
}, null, 2));

console.log('Windows x64 产物结构、PE 架构与制品校验完成');
console.log('提示: 交叉构建无法验证运行时行为，请在 Windows 机器上实测启动与播放。');
