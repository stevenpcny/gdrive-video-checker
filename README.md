# 视频检查器

用于批量检查 Google Drive 视频：流式播放、进度条帧预览、穿帮点记录、上传、重命名、文件夹跨目录移动和 Google Drive 共享权限管理。

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
| L | 区间循环（未设区间时取当前帧 ±10） |
| Shift+L | 整个视频循环播放（也可点底栏「🔁 循环」），播完不跳下一个 |
| B | 显示/隐藏补丁框（载入补丁配置后） |
| N / Shift+N | 跳到下一个/上一个补丁接点 |
| Enter / P | 下一个 / 上一个 |

视频两侧区域可点击切换前后视频。窗口会根据视频横竖比例自动调整，并限制在当前屏幕可用范围内。

文件夹行右侧的 `👥` 可管理链接查看/编辑权限和指定用户权限；`⇲` 可将文件夹移动到其他目录。公开编辑权限会允许拿到链接的人上传、修改和删除内容，程序会在应用前二次确认。

## 补丁验收（flow-video-patch）

把 flow-video-patch 合成时生成的 `<成片名>.report.json`（或 merge 配置 `<成片名>.merge.json`）和成片放在同一个文件夹，打开成片就会自动载入；也可以在左侧「补丁」面板点「载入」手动选。载入后：

- **补丁框**：画面上标出每个补丁的贴回区（红）、完全替换的核心（红虚线）、保护区（绿）和人物裁切（白虚线），跟着关键帧移动；进度条上标出补丁区间和接点。
- **补丁体检**：逐个补丁检查——
  - 补丁区内的隔帧闪烁、跳变、抖动（检查框跟着人走）；
  - 接缝硬边、切断和边界呼吸；
  - 接缝 LAB 色差：sRGB(D65)→CIELAB，ΔE 用 CIE76，每条边分开量，内侧取样越过羽化带；
  - 每个补丁的起止和分段接点前后有没有跳。

  先按 `C` 打开 A/B 对比并选好原片，体检会和原片同位置成对比较，只报补丁新引入的问题，还会查贴回区以外有没有被改（衣服被调色、整幅偏色）、保护区（原嘴等）有没有保住。没有原片时，受画面内容影响的判据只给提示。结果可以一键记成带说明的穿帮点。
- **正常速度覆盖**：自动记录以 0.9–1.1× 连续播放经过的修补帧，面板显示还有哪些没看。拖动、逐帧、慢放不算。
- **验收记录**：按 flow-video-patch 的 13 项逐项填写（未看/通过/不通过/不适用＋证据），自动体检的发现和合成报告里的技术核验会列在对应项下面作参考，导出为 `visual-review.json`。没按正常速度看完全部修补帧时，「正常速度完整播放」不会记为通过。
- **联系图 / 证据图**：导出全部修补帧的联系图（帧太多时等间隔抽，最多 400 格），以及当前帧的 成片 / 原片 / 差异 三联放大图。

自动体检只用于定位问题，不等于视觉验收。数值阈值目前是在合成缺陷片上标定的，见下面的校准。

### 命令行

```bash
node cli.js patchcheck 成片.mp4 --plan 成片.report.json --source 原片.mp4 --align --review 验收记录.json --sheet 联系图.png --evidence 证据图目录
```

输出 JSON；帧号从 0 开始，区间 `[start, end)`。`--review` 生成的验收记录里人工项保持 `not_run`，自动发现写进 evidence 和 `automated`。

### 用真实成片校准阈值

准备一份 CSV（表头 `video,plan,source,label`，label 为 `pass` 或 `fail`，路径相对 CSV 所在目录），每类最好 10 条以上：

```bash
node scripts/calibrate.mjs 样本.csv --out 校准结果.json
```

会列出每个判据当前阈值的检出率和误报率，以及建议阈值。每个判据只针对一种毛病，它的「检出率」是对全部穿帮样本算的，所以单项偏低是正常的，看「整体」那一行。

## YouTube 视频

在左侧「粘贴 Drive 或 YouTube 链接」框里粘贴 YouTube 链接（`youtube.com/watch`、`youtu.be`、Shorts、直播回放均可），点「打开链接」。应用会用 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 把视频下载到本机缓存，下载完成后按本地视频打开，逐帧、放大镜、差分、A/B 对比等功能全部可用。

- 需要先安装 yt-dlp：在「终端」运行 `brew install yt-dlp`（会一并装上它需要的 deno）。YouTube 经常改版，下载失败时先运行 `brew upgrade yt-dlp`。
- 画质选分辨率最高的版本，同分辨率优先 H.264；1080p 以上画面和声音分开下载，再用内置 ffmpeg 合并。
- 下载的视频保存在 `~/Library/Caches/local.video-checker/youtube/`，同一视频不会重复下载；最多保留 20GB / 30 天。
- 私享、会员或年龄限制的视频无法下载。请只下载你有权使用的视频，YouTube 服务条款原则上不允许第三方工具下载。

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

构建 Windows x64 免安装 ZIP（可在 macOS 上交叉构建）：

```bash
npm run release:win
```

Windows 构建说明：

- 目标为 x64 免安装 ZIP，解压后运行 `视频检查器.exe`；不生成安装程序（NSIS 在 macOS 上需要 Wine）。
- rclone 1.73.2 与 FFmpeg 8.1.2 使用官方/BtbN 预编译 Windows 二进制（LGPL-only 变体），下载后按固定 SHA-256 校验。
- 未签名，Windows SmartScreen 首次运行会提示"未知发布者"。
- 交叉构建无法验证运行时行为，`verify:release:win` 只做产物结构与 PE 架构静态校验，发布前需在 Windows 上实测。

## 架构

- `electron/main.js`：Electron 生命周期、安全 BrowserWindow、动态端口、窗口尺寸和内置工具定位。
- `server.js`：可嵌入 HTTP 服务、Google Drive API 工作流、Range 视频流、缓存、缩略图和 rclone 子进程管理。
- `public/`：无 Node 权限的 renderer UI；通过带随机 token 的 loopback 服务访问后端。
- `vendor/bin/darwin-{x64,arm64}/`、`vendor/bin/win32-x64/`：包内 rclone/ffmpeg，按平台分目录，打包时只带入目标平台的一份。
- `scripts/`：双架构资源准备、FFmpeg 构建、Windows 资源准备和发布验证。

关闭主窗口会退出应用，并终止 rclone/ffmpeg 子进程和本地监听端口。

## 已知限制

- 当前未经过 Apple 公证，首次打开有 Gatekeeper 提示。
- Electron/Chromium 原生解码能力决定可播放格式；扩展名被列出不代表对应 codec 一定可用。
- `marks.json` 以 remote 和文件路径为 key；在本程序内移动文件夹会同步标记，但在其他地方重命名或移动后旧标记不会自动跟随。
- Intel 和 Apple Silicon 都包含在 Universal 包中，但正式发布仍应分别在真实 Intel Mac 和 Apple Silicon Mac 上验收。

## 第三方许可证

见应用包 `Contents/Resources/licenses/` 和源码目录 `licenses/`。FFmpeg 对应源码归档、SHA-256 与构建参数随发布包提供。
