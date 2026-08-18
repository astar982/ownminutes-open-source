# OwnMinutes 商用 Provider 配置方案

## 目标

OwnMinutes 后续如果开放给普通用户或小团队使用，不能只依赖开发者在服务器 `.env.local` 里手工写模型 Key。商用版需要把模型配置做成后台能力，让用户知道：

- 需要配置哪些语音识别和大模型服务。
- 每个字段从哪里获取。
- 当前配置是否能用。
- 费用和失败原因是否清楚。
- 密钥是否被安全保存。

## 当前已落地

- `/settings`：模型配置中心页面。
- `/api/settings/providers`：返回 provider 目录和当前诊断状态。
- `src/lib/provider-catalog.ts`：集中维护模型服务、字段、官方入口和本地 `.env` 模板。
- 页面只展示字段和状态，不返回密钥原文，也不从浏览器保存密钥。

这个边界是有意保留的：当前项目还没有登录、租户、权限、加密密钥库和审计日志，直接做“网页保存 API Key”会给后续商用埋安全问题。

## 本地个人版配置

个人版继续使用 `.env.local`：

```bash
TRANSCRIPTION_PROVIDER=volcano

VOLCANO_ASR_API_KEY=
VOLCANO_ASR_APP_ID=
VOLCANO_ASR_TOKEN=
VOLCANO_ASR_CLUSTER=
VOLCANO_ASR_MODE=flash
VOLCANO_ASR_RECOGNIZE_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
VOLCANO_ASR_RESOURCE_ID=volc.bigasr.auc_turbo
VOLCANO_ASR_SUBMIT_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit
VOLCANO_ASR_QUERY_URL=https://openspeech.bytedance.com/api/v3/auc/bigmodel/query
VOLCANO_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel

ARK_API_KEY=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_CHAT_MODEL=
```

关键判断：

- 火山账号 AK/SK 不能等同于语音识别运行时 Key。
- 会后 ASR 至少需要 `VOLCANO_ASR_API_KEY`，或 `VOLCANO_ASR_APP_ID + VOLCANO_ASR_TOKEN`。
- 默认采用极速版直接上传模式；标准版提交/查询接口保留为兼容模式。WebM、M4A 等音频会先在服务端规范化为火山支持的格式。
- 总结模型生产候选不仅需要 `ARK_API_KEY + ARK_CHAT_MODEL`，还必须通过 `summary:preflight`：HTTPS `ARK_BASE_URL`、`OWNMINUTES_SUMMARY_JSON_ONLY=1`、幻觉处理、重试和人工复核策略都要齐全。
- 实时 ASR 配置齐全后，还需要单独实现和压测 WebSocket 协议。

## 商用版后台必须补齐

1. 账号和租户

每个团队要有独立租户。管理员可以配置模型，普通成员只能使用。

2. 密钥加密保存

密钥不能明文保存，也不能再次返回浏览器。推荐使用 KMS 或等价方案加密，数据库只保存密文、尾号、创建时间和状态。

3. Provider 健康检查

保存配置前必须验证：

- Key 是否有效。
- 模型或 Endpoint 是否存在。
- ASR 权限是否开通。
- 余额或额度是否足够。
- 文件识别和总结链路是否能完成最小样本调用。

4. 默认平台额度 + BYOK

建议同时支持两种模式：

- 平台统一额度：适合不懂模型配置的普通用户，产品按套餐收费。
- 用户自带 Key：适合成本敏感或已有企业账号的用户。

5. 成本和用量

每次会议记录：

- 录音时长。
- ASR 调用次数和费用。
- 总结模型 token 和费用。
- 存储大小。
- 分享链接访问量。

6. 审计和风控

记录谁修改了配置、何时修改、修改了哪类字段，但不记录密钥原文。异常调用、连续失败、额度耗尽时要提示管理员。

## 推荐产品路径

第一阶段保留当前本地配置中心：

- 展示配置项。
- 展示缺失状态。
- 提供跳转入口。
- 提供 `.env` 模板。

第二阶段增加管理员后台：

- 登录和组织。
- Provider 配置保存。
- 保存前健康检查。
- 加密密钥存储。
- 用量记录。

第三阶段做商业化套餐：

- 平台统一额度。
- BYOK 模式。
- 会议时长额度。
- 分享页权限。
- Obsidian / Markdown / 飞书文档等导出能力。

## 支付与权益门禁

公开注册环境不能允许用户直接调用套餐切换接口给自己发放 Plus / Pro 权益。当前 `/api/account/plan` 默认返回 `simulated_billing_disabled`，只有显式设置：

```bash
OWNMINUTES_ENABLE_SIMULATED_BILLING=1
```

时才允许开发或验收环境模拟切换套餐。生产和公开测试环境应保持关闭。正式会员、分钟包和官方额度需要通过 Apple IAP、服务端交易校验、后台订单或人工审核发放，并记录订单幂等、退款撤销和权益回收。

## 不建议现在做的事

- 不建议让所有用户直接填服务器 `.env`。
- 不建议把 API Key 存 localStorage。
- 不建议在没有登录和租户隔离时做“保存模型配置”按钮。
- 不建议在公开环境启用 `OWNMINUTES_ENABLE_SIMULATED_BILLING=1`。
- 不建议承诺单设备混合录音下 100% 准确说话人识别。
- 不建议在真实 ASR 未跑通前做公开商用宣传。
