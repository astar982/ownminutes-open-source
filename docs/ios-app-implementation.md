# iOS App 实施记录

## 当前实现

已新增 `apps/mobile`，使用 Expo / React Native，目标是先通过 TestFlight 在 iPhone 真机验证会议录音和上传链路。

## 已实现能力

- `expo-audio` 本地录音。
- `useAudioStream` PCM 实时流计数，作为后续火山实时 ASR 接入点。
- `expo-keep-awake` 录音时保持屏幕活跃。
- `expo-network` 显示网络状态。
- `expo-file-system` + `expo-sharing` 导出 Markdown。
- `expo-clipboard` 复制 Markdown。
- 后端地址可在 App 内编辑。
- 录音结束后上传完整音频到 `/api/meetings/[id]/chunks`。
- App 首页可调用 `/api/providers/diagnostics` 检查后端 provider 配置，不回显任何密钥。
- App 内明确提示参会人知情和实时草稿/正式纪要分层。
- iOS `NSMicrophoneUsageDescription` 已配置。

## 技术选择

第一版没有把 Web 原型套壳成 App，而是使用原生 Expo 音频能力。原因：

- iOS 实时录音稳定性比 WebView 更关键。
- 后续需要 TestFlight、麦克风权限、系统分享、文件导出。
- 火山实时 ASR 可能要求 PCM/WAV 音频流，App 原生层更容易控制。

## 重要限制

- Expo `AudioRecorder` 保存完整音频，适合会后重处理。
- Expo `AudioStream` 提供 PCM buffer，适合实时 ASR，但真实火山 WebSocket 协议尚未接入。
- 当前 App 结束录音后上传完整音频作为 sequence 1，尚未实现每 1-3 秒上传音频分片。
- 真机后台录音、锁屏、来电、耳机断开必须专项测试后才能承诺稳定。

## 下一步

1. 确认火山实时 ASR 产品文档和鉴权方式。
2. 将 `useAudioStream` 的 PCM buffer 转成火山要求的音频帧。
3. 后端实现火山 WebSocket session 管理。
4. App 保持完整录音本地保存，实时 ASR 失败不影响原始音频。
5. 增加本地上传队列，支持断网后恢复上传。
