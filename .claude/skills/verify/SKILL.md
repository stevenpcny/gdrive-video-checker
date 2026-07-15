---
name: verify
description: Runtime verification for the Google Drive video checker UI
---

# Verify the video checker

1. Launch `视频检查器.app/Contents/MacOS/launcher`; it must open `http://127.0.0.1:5572/?standalone=1` in a Chrome app window.
2. Navigate through the Drive folder list to portrait and landscape videos. Confirm the app window resizes after each selection and stays within the available screen.
3. Pause after each navigation click because playback automatically advances when a video ends.
4. For side-navigation changes, click near the inner edge, outer edge, top, middle, and bottom of both black gutters. Confirm the current-video label changes by exactly one item.
5. Click the center of the video and confirm it toggles playback without changing the selected item.
6. Resize the viewport and confirm `#prev-btn` ends at the video's left edge and `#next-btn` starts at the video's right edge.
7. Capture a viewport screenshot showing the video, both side gutters, and navigation arrows.
