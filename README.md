# 视频检查器

用于批量检查 Google Drive 视频：流式播放、进度条帧预览、合格/不合格标记、不合格自动移动、上传、重命名、文件夹跨目录移动和 Google Drive 共享权限管理。

## 分发版

### 系统要求

- macOS 15 或更高版本
- 同一个 Universal 应用同时支持 Intel `x86_64` 和 Apple Silicon `arm64`
- 不需要预装 Node.js、rclone、ffmpeg 或 Google Chrome
- 需要联网访问 Google Drive

### 安装

发布目录提供：

- `视频检查器-<版本>-universal.dmg`
- `视频检查器-<版本>-universal.zip`
- `SHA256SUMS`

DMG：打开后将「视频检查器」拖入 Applications。ZIP：解压后将应用移入 Applications。

当前版本使用 ad-hoc 签名，没有 Apple Developer ID，也没有 Apple 公证。通过浏览器下载后，macOS 可能阻止首次启动：

1. 在 Finder 中右键「视频检查器」并选择「打开」。
2. 如果仍被拦截，进入「系统设置 → 隐私与安全性」，选择「仍要打开」。
3. 企业 MDM 管理的 Mac 可能不允许绕过 Gatekeeper。

ad-hoc 签名只能证明应用包构建后未被修改，不能证明开发者身份。分发前请同时核对 `SHA256SUMS`。

## 连接 Google Drive

首次启动提供三种方式，配置只保存在当前 Mac：

1. **服务账号 JSON**：导入 `type: service_account` 密钥，并将目标 Drive 文件夹共享给该服务账号邮箱。
2. **导入 rclone.conf**：选择已有配置；应用会验证 remote，并在覆盖私有配置前备份旧文件。
3. **Google OAuth**：应用通过内置 rclone 逐步配置，并在系统默认浏览器完成 Google 登录授权。

应用使用独立的 rclone 配置，不修改 `~/.config/rclone/rclone.conf`。

## 用户数据

```text
~/Library/Application Support/视频检查器/
  marks.json
  settings.json
  keys/
  rclone/rclone.conf
  migration.json

~/Library/Caches/local.video-checker/
  video/
  thumbs/
  uploads/

~/Library/Logs/视频检查器/
  main.log
  server.log
```

首次启动会复制旧版 `$HOME/谷歌云盘视频检查器/marks.json` 和 `keys/`，不会删除旧文件。检测到全局 rclone 配置时，可由用户选择是否导入。

## 使用

| 键 | 作用 |
|---|---|
| 空格 | 播放/暂停 |
| ← / → | 后退/快进 5 秒；Shift 为 30 秒 |
| , / . | 逐帧后退/前进 |
| ↑ / ↓ | 调倍速（0.5x–3x） |
| M | 静音 |
| G | 标记合格并切换下一个 |
| B | 标记不合格、移入子文件夹并切换下一个 |
| Enter / P | 下一个 / 上一个 |

误按不合格后可在提示消失前撤销。视频两侧区域可点击切换前后视频。窗口会根据视频横竖比例自动调整，并限制在当前屏幕可用范围内。

文件夹行右侧的 `👥` 可管理链接查看/编辑权限和指定用户权限；`⇲` 可将文件夹移动到其他目录。公开编辑权限会允许拿到链接的人上传、修改和删除内容，程序会在应用前二次确认。

## 开发

```bash
npm install
npm start
npm test
```

构建 Universal DMG 和 ZIP：

```bash
npm run release:local
```

构建过程会：

- 使用 Electron 43.1.0 和 electron-builder 26.15.3。
- 下载并校验 rclone 1.73.2 官方 x86_64/arm64 二进制。
- 从 FFmpeg 8.1 官方源码构建 LGPL-only x86_64/arm64 二进制。
- 生成 ad-hoc 签名 Universal 应用、DMG、ZIP、SHA-256 和构建 manifest。

## 架构

- `electron/main.js`：Electron 生命周期、安全 BrowserWindow、动态端口、窗口尺寸和内置工具定位。
- `server.js`：可嵌入 HTTP 服务、Google Drive API 工作流、Range 视频流、缓存、缩略图和 rclone 子进程管理。
- `public/`：无 Node 权限的 renderer UI；通过带随机 token 的 loopback 服务访问后端。
- `vendor/bin/darwin-{x64,arm64}/`：包内 rclone/ffmpeg。
- `scripts/`：双架构资源准备、FFmpeg 构建和发布验证。

关闭主窗口会退出应用，并终止 rclone/ffmpeg 子进程和本地监听端口。

## 已知限制

- 当前未经过 Apple 公证，首次打开有 Gatekeeper 提示。
- Electron/Chromium 原生解码能力决定可播放格式；扩展名被列出不代表对应 codec 一定可用。
- `marks.json` 以 remote 和文件路径为 key；在本程序内移动文件夹会同步标记，但在其他地方重命名或移动后旧标记不会自动跟随。
- Intel 和 Apple Silicon 都包含在 Universal 包中，但正式发布仍应分别在真实 Intel Mac 和 Apple Silicon Mac 上验收。

## 第三方许可证

见应用包 `Contents/Resources/licenses/` 和源码目录 `licenses/`。FFmpeg 对应源码归档、SHA-256 与构建参数随发布包提供。
