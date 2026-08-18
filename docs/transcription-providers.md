# 转写 Provider

OwnMinutes 的转写层采用 provider 模式，不把录音链路绑定到某一家模型服务。

## 配置

复制 `.env.example` 为 `.env.local`，设置：

```bash
TRANSCRIPTION_PROVIDER=mock
```

可选值：

- `mock`：默认，占位转写，适合本地开发。
- `openai`：OpenAI 实时/会后转写适配器入口。
- `volcano`：火山引擎语音识别适配器入口。

## 火山引擎

火山引擎 key 不能直接当 OpenAI key 用。使用火山时，需要：

```bash
TRANSCRIPTION_PROVIDER=volcano
VOLCANO_ACCESS_KEY_ID=
VOLCANO_SECRET_ACCESS_KEY=
VOLCANO_ASR_API_KEY=
VOLCANO_ASR_APP_ID=
VOLCANO_ASR_TOKEN=
VOLCANO_ASR_CLUSTER=
VOLCANO_ASR_MODE=flash
VOLCANO_ASR_RECOGNIZE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
VOLCANO_ASR_RESOURCE_ID=volc.bigasr.auc_turbo
OWNMINUTES_ASR_FILE_STRATEGY=single
OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1
OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES=30
VOLCANO_ASR_TURBO_RECOGNIZE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
VOLCANO_ASR_TURBO_RESOURCE_ID=volc.bigasr.auc_turbo
VOLCANO_ASR_SUBMIT_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit
VOLCANO_ASR_QUERY_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/query
VOLCANO_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
ARK_API_KEY=
ARK_CHAT_MODEL=
```

注意：

- `VOLCANO_ACCESS_KEY_ID` / `VOLCANO_SECRET_ACCESS_KEY` 是账号级访问密钥。
- 会后录音文件识别需要语音服务运行时 `VOLCANO_ASR_API_KEY`，或 `VOLCANO_ASR_APP_ID` + `VOLCANO_ASR_TOKEN`。
- 大模型流式语音识别需要单独开通流式 Resource ID。新版控制台可用开通后创建的 API Key；旧版使用 `AppID + Token`。文件 ASR 已可用的旧 Key 不代表流式握手一定有权限。
- 账号 AK/SK 不能直接等同于实时 ASR token。
- 当前生产安全默认是实时 ASR 2.0 优先复用，文件 ASR 保持 `single` + `flash` + Turbo；官方 Turbo-only 文件处理最多自动覆盖 30 分钟，超限时保留本地音频并停止高价调用。
- `standard_then_turbo` 路由已经实现，但当前账号的低价标准文件资源 `volc.seedasr.auc` 仍未授权，真实探测为 HTTP `403` / 状态 `45000030`，因此现在不能启用。授权完成并通过真实探测后，才可把它设为低价主路由。
- `standard_then_turbo` 只允许在标准提交明确未被接受的 `429`、`5xx` 或 `45000000` 场景内、且音频未超过时长上限时，最多提交一次 Turbo。`403` / `45000030`、参数错误、网络结果不明、提交已接受后的查询超时/失败、无语音都不得自动转 Turbo。
- 账号级 BYOK 强制使用 `single` 且关闭平台 Turbo fallback，不继承服务器侧的资源、兜底和计费策略。
- 如果“重新生成纪要”已有通过质量门禁的正式逐字稿，会直接复用逐字稿，只重跑摘要，文件 ASR 调用次数和分钟数均为 0；mock、fallback、占位或未验证逐字稿不能复用。
- 方舟总结与语音 ASR 鉴权不是同一套。生产候选需要 `ARK_API_KEY`、`ARK_CHAT_MODEL`、HTTPS `ARK_BASE_URL`、`OWNMINUTES_SUMMARY_JSON_ONLY=1`、幻觉处理、重试和人工复核策略，并通过 `npm run summary:preflight`。
- 任何被粘贴到聊天里的 AK/SK 都应视为已泄露，后续应在火山控制台轮换。

当前已实现：

- 后端保存音频分片。
- `POST /api/meetings/:id/finalize` 读取完整音频并做会后正式处理。
- 火山录音文件识别适配器：`VOLCANO_ASR_API_KEY` 或 `VOLCANO_ASR_APP_ID` + `VOLCANO_ASR_TOKEN`。
- 火山会后 ASR 结果解析：兼容嵌套 `utterances` / `segments` / `utterance_list`、`speaker_id` / `speakerId` / `spk`、`word_list` / `words` 等常见结构，统一输出 `Speaker N`、时间戳和逐字稿段落。
- 方舟结构化纪要适配器：`ARK_API_KEY` + `ARK_CHAT_MODEL`；生产 readiness 还要求 HTTPS Base URL、JSON-only、幻觉处理、重试和人工复核策略。
- 结果保存到 `.data/meetings/<meetingId>/result.json` 和 `.data/meetings/<meetingId>/obsidian.md`。

当前已实现但仍需真人验收：

- 火山实时 WebSocket ASR：3 秒 PCM 分片、二进制协议、心跳、重连、结束握手、状态审计、失败不影响正式录音、累计草稿原位更新。
- Web 与 iOS BYOK 设置提供实时识别连接测试；它只验证 Key/Resource/WebSocket 权限，不上传会议音频。
- 单设备混合音频不承诺 100% 准确说话人识别。第一版仍需会后允许用户改名，并用真人多人会议验收。

## 配置诊断

后端提供安全诊断接口：

```text
GET /api/providers/diagnostics
```

返回内容只包含 provider、adapter、ready、能力布尔值、缺失环境变量名和诊断说明，不返回任何密钥原文。

能力字段：

- `fileAsrReady`：会后录音文件识别是否可调用。
- `realtimeConfigured`：实时 WebSocket 所需字段是否齐全。
- `realtimeProtocolReady`：实时 WebSocket 协议是否已经实现并允许进入生产验收。
- `realtimeReady`：代码和运行时字段具备进入真实验收的条件，不等于账号流式权限或真人会议质量已经通过。只配置 `VOLCANO_ASR_WS_URL` 不会让它变成 `true`。
- `summaryReady`：方舟模型总结是否达到生产候选门禁；不仅要求 `ARK_API_KEY + ARK_CHAT_MODEL`，还要求 HTTPS Base URL、JSON-only、幻觉处理、重试和人工复核策略。

移动端首页可点击“检查 Provider 配置”查看当前后端配置是否足够。

Web 端提供配置中心：

```text
/settings
GET /api/settings/providers
```

`/settings` 面向后续商用化，支持账号级加密保存 BYOK、字段诊断、文件 ASR 提交/完整识别测试、实时 WebSocket 连接测试和方舟连通测试。密钥不会回显到页面或写入手机本地。

本地还提供两个安全探测命令：

```bash
npm run volcano:probe
npm run volcano:asr-auth-probe
npm run volcano:realtime-auth-probe
```

`volcano:probe` 用账号 AK/SK 调用火山 OpenAPI，只输出脱敏的 IAM / Ark 能力摘要。当前已确认：

- AK/SK 有效，IAM 只读探测可用。
- Ark 可列出基础模型。
- 已通过 Ark OpenAPI 创建总结用 Endpoint：`ownminutes-summary`。
- 可通过账号 AK/SK 为该 Endpoint 签发临时 `ARK_API_KEY` 并写入 `.env.local`，不会在终端输出密钥原文。

初始化或续期 Ark 总结配置：

```bash
npm run volcano:ark-bootstrap
```

默认配置：

- Endpoint 名称：`ownminutes-summary`
- Foundation model：`deepseek-v4-flash`
- Model version：`260425`
- 临时 API Key 有效期：`86400` 秒，可通过 `ARK_TEMP_KEY_DURATION_SECONDS` 调整。

`volcano:asr-auth-probe` 用一段假音频验证 ASR 鉴权，不打印密钥。当前已确认：

- 账号 AK 作为 `X-Api-Key` 会返回 `Invalid X-Api-Key`。
- 账号 AK/SK 作为 `X-Api-App-Key` / `X-Api-Access-Key` 会返回 grant 不存在。
- 因此账号 AK/SK 不能直接替代语音识别运行时 `VOLCANO_ASR_API_KEY` 或 `VOLCANO_ASR_APP_ID + VOLCANO_ASR_TOKEN`。

当前本地能力状态：

- 方舟会后总结：可用。
- 火山会后 ASR：极速文件识别鉴权与真实样本链路可用，正式质量仍需真人会议抽样。
- 火山实时 ASR：2.0 小时版已开通，专用 Key 握手和 16 秒中文分片 live 验收通过；正式发布仍需弱网和 1-3 分钟真人多人会议。

## 低价主路由启用门禁

当前不要把 `VOLCANO_ASR_RESOURCE_ID` 从 Turbo 改成 `volc.seedasr.auc` 后直接发布。启用 `standard_then_turbo` 必须同时满足：

1. 控制台已为生产账号授权标准文件资源，真实音频探测不再返回 `403` / `45000030`。
2. `VOLCANO_ASR_MODE=standard`，主 `VOLCANO_ASR_RESOURCE_ID` 是非 Turbo 资源。
3. Turbo URL、Turbo Resource ID、`OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED=1` 和 `1..30` 分钟成本上限均显式配置。
4. `npm run asr:preflight`、`npm run smoke:asr-resilience`、`npm run smoke:asr-turbo-cost-policy` 全部通过。
5. 用真实 5-30 秒中文样本验证标准主路由成功，并用故障注入确认每次操作最多一个 Turbo 提交；日志和证据中不得出现密钥或音频签名 URL。

在上述门禁完成前，生产保持实时 2.0 + `single/flash` Turbo 文件兜底，并使用 30 分钟硬上限控制最坏成本。

## 历史变量兼容

旧配置里可能出现：

```bash
VOLCANO_APP_ID=
VOLCANO_ASR_ENDPOINT=
```

代码仍兼容这两个变量，但新配置建议使用 `VOLCANO_ASR_APP_ID` 和 `VOLCANO_ASR_WS_URL`，语义更明确。

不同火山语音产品可能要求不同鉴权字段、音频格式和 WebSocket/HTTP 协议。当前 `volcanoRealtimeTranscriptionAdapter` 做配置检查和诊断返回；真实实时 WebSocket 协议仍需单独实现和压测。

接入真实火山协议前必须确认：

- 选择的火山语音识别产品名称。
- 是否支持实时流式 ASR。
- 是否支持会议场景、标点、热词、说话人分离。
- 音频编码要求，例如 PCM、Opus、WAV 或 WebM。
- 鉴权方式。
- WebSocket 或 HTTP endpoint。
- 返回事件结构。

## 设计原则

- 录音分片必须先保存到服务端，再调用转写 provider。
- provider 失败不能影响原始录音保存。
- 实时转写只作为草稿。
- 实时逐字稿只有在覆盖率和质量门禁通过后才能作为正式逐字稿复用；否则才进入受成本上限保护的文件 ASR。
- 正式逐字稿已通过质量门禁时，重新生成纪要只重跑摘要，不能重复消费 ASR。
