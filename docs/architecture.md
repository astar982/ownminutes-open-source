# 技术架构

## 当前原型

- Next.js App Router
- TypeScript
- Tailwind CSS
- 浏览器MediaRecorder录音，按1秒分片缓存
- 麦克风设备选择和刷新
- 输入音量监测
- 录音格式、分片数量、缓存大小、采样率监控
- 音频分片上传API `/api/meetings/[id]/chunks`
- 服务端本地分片保存到 `.data/meetings`
- 按会议ID串行化manifest写入，避免并发分片覆盖
- Provider模式实时转写适配器：`mock | openai | volcano`
- 模拟实时转写数据
- 静态分享页
- Markdown生成函数

## 目标架构

```text
Browser MediaRecorder
-> WebSocket audio chunks
-> Realtime transcription service
-> Live transcript store
-> Rolling summary service
-> Audio object storage
-> Post-meeting processing job
-> Speaker diarization
-> Final transcript
-> Meeting summary
-> Share page
-> Obsidian export
```

## 数据模型草案

- Workspace：工作区
- Project：项目
- Meeting：会议
- Participant：参会人
- AudioAsset：音频文件
- TranscriptSegment：逐字稿片段
- Speaker：发言人
- Summary：会议纪要
- Decision：决策
- ActionItem：待办
- ShareLink：分享链接
- ObsidianExport：导出记录

## 处理策略

会议中：

- 音频按小片段推送。
- 当前原型通过HTTP multipart上传分片；后续可替换为WebSocket/WebRTC实时通道。
- 后端必须先保存分片，再调用识别适配器，避免识别服务失败导致原始录音丢失。
- 同一会议的manifest写入必须串行化。
- 实时转写失败时，原始录音仍必须持续保存。
- 实时转写只作为草稿。
- 每隔数分钟生成滚动摘要。
- 捕捉候选待办、决策和风险。

会议后：

- 保存完整音频。
- 对完整音频重新转写或校正。
- 做说话人识别。
- 生成正式纪要。
- 用户确认后发布和沉淀。

## 录音稳定性

详见 `docs/recording-reliability.md`。

## 转写适配器

当前代码使用 provider 工厂 `getRealtimeTranscriptionAdapter()`，通过 `TRANSCRIPTION_PROVIDER` 选择：

- `mock`：默认，占位转写。
- `openai`：OpenAI适配器入口，尚未接真实协议。
- `volcano`：火山引擎适配器入口，当前做配置诊断，真实协议待确认火山具体产品文档。

接口边界保留：

- 输入会议ID、分片序号、录音格式、分片大小、录制时间和分片时长。
- 输出适配器名称和可选逐字稿片段。

后续接OpenAI、火山或其他语音服务时，优先替换适配器实现，而不是改动页面录音逻辑。

详见 `docs/transcription-providers.md`。

## 后续服务选择

- 转写：OpenAI实时转写或其他语音服务。
- 说话人识别：优先作为独立后处理服务接入。
- 存储：S3、Cloudflare R2或Supabase Storage。
- 队列：BullMQ、Inngest或Vercel Workflow。
- 数据库：PostgreSQL。
