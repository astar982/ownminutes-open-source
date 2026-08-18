# OwnMinutes Mobile

iOS TestFlight 原型，使用 Expo / React Native。

## 开发

```bash
npm run mobile:ios:prereqs
npm run ios
```

或从仓库根目录：

```bash
npm run mobile:ios:prereqs
npm run mobile:ios
```

`mobile:ios:prereqs` 只做本机环境诊断，不安装 CocoaPods、不生成 `ios/` 目录。它会检查：

- 是否有已启动的 iOS Simulator。
- Expo Go 是否已安装到当前模拟器。
- 本地后端 `http://127.0.0.1:3003/api/health` 是否可访问。
- 当前项目是否仍保持 Expo managed 脚本，避免误提交半生成的 `apps/mobile/ios`。
- 麦克风权限文案是否仍在 `app.json` 中。

如果 Expo Go 未安装，`npm run mobile:ios` 可能停在 `Fetching Expo Go`。此时先在模拟器安装/打开 Expo Go，或者明确切换到 native `expo run:ios` 路线并准备 CocoaPods；不要提交自动生成但未完成的 `apps/mobile/ios` 目录。

## TestFlight 构建准备

移动端 Expo 项目配置在 `apps/mobile/app.json`，EAS 配置在 `apps/mobile/eas.json`。从仓库根目录执行：

```bash
npm run mobile:testflight:preflight
npm run mobile:testflight:build
npm run mobile:testflight:submit
```

等价于进入移动端目录后执行：

```bash
cd apps/mobile
eas build --platform ios --profile testflight
eas submit --platform ios --profile testflight
```

当前 iOS 配置：

- App 名称：`OwnMinutes`
- Bundle ID：`app.ownminutes.mobile`
- 麦克风权限：`NSMicrophoneUsageDescription`
- 构建 profile：`testflight` / `distribution=store`
- 原生内购：`expo-iap` / StoreKit 2；Expo Go 只显示禁用预览态
- 首版设备范围：iPhone-only；iPad UX 和 13 英寸素材验收前保持 `supportsTablet=false`
- 登录页直接提供“支持与数据删除”；登录后“我的”包含折叠的帮助与合规入口，可打开支持、隐私政策、服务条款和数据删除说明。

### 多语言

- 首批支持 English、简体中文和繁體中文。默认跟随系统，用户也可在登录页或“我的 > 设置与偏好”手动切换；不支持的系统语言回退到 English。
- 语言偏好保存在本机 SecureStore。登录、注册、录音、会议历史/详情、人工复核、分享/导出、Provider/BYOK、会员购买和账号管理主路径均使用同一运行时词典。
- iOS/Android 原生应用名与麦克风权限文案也提供三种语言；Release 门禁会校验三组原生资源完整且英文基础权限文案不含中文。
- 移动端请求统一发送 `Accept-Language`。新生成的会议纪要、无语音/无模型兜底和 Markdown 会使用请求语言；已有纪要不会因切换界面语言自动重算，需明确重新生成，避免重复计费。
- 当前 BYOK 仍连接火山引擎中国区服务。界面和纪要语言已国际化，不等于海外 Provider、英文 ASR 准确率或跨区域网络已经验收。

### App Store 素材

品牌图标、当前简体中文元数据和 6.9 英寸原生 Release 截图通过根目录命令生成和校验：

```bash
npm run mobile:brand:generate
npm run appstore:screenshots:capture
npm run appstore:prepare
npm run smoke:appstore-submission
```

截图输出只保存在 ignored 的 `.data/appstore-submission/`。截图构建使用代表性内容，不读取真实账号、模型密钥或客户会议，也不替代真机/TestFlight 验收。稳定公网 URL 和审核联系方式具备后再运行 `npm run appstore:validate`。完整流程见 `docs/app-store-submission-runbook.md`。

英文/繁体中文 App Store 元数据与商店截图仍需在正式海外上架前单独制作和审核；运行时三语完成不代表商店素材已本地化。

EAS 不是唯一构建路径。本机已有有效 Xcode Team 和 Apple Distribution 证书时，也可以从仓库根目录执行：

```bash
npm run mobile:ios:local:preflight
npm run mobile:ios:local:build
```

本地候选构建要求 clean Git、唯一 `OWNMINUTES_IOS_BUILD_NUMBER`、六个稳定公网 HTTPS URL 和实时部署验证通过。它会运行原生 Release smoke、生成 generic iOS Archive、使用 `app-store-connect` 自动签名导出，并核验最终 IPA 的签名、Store profile、Bundle ID、版本、build number 和实际默认 API marker。

没有稳定公网时只能执行签名探针：

```bash
EXPO_PUBLIC_API_BASE_URL=https://staging.ownminutes.app npm run mobile:ios:local:signing-probe
```

输出文件会带 `SIGNING-PROBE-DO-NOT-UPLOAD`，只能证明 Apple 签名链可用，不能上传或冒充 TestFlight 候选包。

### 本地原生构建说明

先检查本机条件，再运行完整 Release 原生 smoke：

```bash
npm run mobile:ios:native:preflight
npm run smoke:ios-native-build
npm run mobile:ios:small-screen:verify
```

完整 smoke 会把移动端复制到 ASCII 临时目录，执行 Expo prebuild、CocoaPods、Release Xcode build、模拟器签名、安装与启动；随后按本次 App PID 扫描 symbol/native-module/fatal 日志，并保存：

```text
.data/screenshots/ownminutes-ios-native-latest.png
.data/native-smoke/expo-prebuild.log
.data/native-smoke/pod-install.log
.data/native-smoke/xcodebuild.log
.data/native-smoke/runtime.log
```

`mobile:ios:small-screen:verify` 会自动复用或创建 iPhone SE（第三代）模拟器，执行同一套当前源码 Release 构建、安装、启动、运行时日志和 App Store 合规检查，并强制截图必须为 750x1334。小屏登录/注册、键盘避让或固定高度控件改动后必须运行；截图保存在 ignored 的 `.data/screenshots/ownminutes-ios-small-screen-latest.png`，仍不能替代实体 iPhone、VoiceOver 或 TestFlight 验收。

成功后临时 iOS、Pods、OpenIAP source 和 DerivedData 会自动删除；调试失败时会保留临时目录。设置 `OWNMINUTES_KEEP_NATIVE_SMOKE=1` 可在成功后保留临时工程，设置 `OWNMINUTES_NATIVE_SMOKE_PRESERVE_APP_DATA=1` 可避免 smoke 卸载模拟器内已有 OwnMinutes 数据。

2026-07-10 已在 iPhone 17 Pro Simulator 完成独立 Release 原生构建和启动验证：`ExpoIap 4.3.6`、`openiap 2.2.4`、`expo-secure-store`、后台音频配置均进入原生 App，Xcode 结果为 `BUILD SUCCEEDED`。正常模拟器签名后首屏可启动，未出现原生模块缺失或未捕获错误。

项目历史工作区曾位于包含中文字符的路径，React Native 0.85 的 CocoaPods URI 处理会拒绝这类路径。`smoke:ios-native-build` 始终使用系统临时目录中的 ASCII staging；EAS/GitHub checkout 通常也是 ASCII 路径，不受此限制。不要为解决该问题提交生成的 `apps/mobile/ios`。

Expo 56 必须显式保留 `expo-font ~56.0.7`。`@expo/vector-icons` 的宽泛 peer dependency 曾使 npm 单独安装 `expo-font 57`，虽然 TypeScript 和 `expo install --check` 通过，但独立 App 启动时会发生 Swift symbol mismatch。`smoke:mobile-ui` 现在会校验这一版本对齐。

## 后端地址

开发构建可在 `我的 > 设置与偏好 > 服务连接` 填写 `API Base URL`。输入使用 URL 键盘；完整地址会在失焦、键盘“前往”或点击“保存并检查”时规范化并保存，不会把每个未完成的输入片段逐次写入本机。TestFlight / App Store Release 固定连接构建时注入的官方公网 HTTPS 服务，登录前后都不能修改服务器地址。

本机模拟器开发默认地址：

```text
http://127.0.0.1:3003
```

Release 构建没有配置 `EXPO_PUBLIC_API_BASE_URL` 时默认地址为空，不会静默回退到本机。TestFlight 候选包必须在构建时注入已经在线验证的公网 HTTPS 地址。

移动端在应用层统一校验所有 `fetch` 和原生音频上传地址。公网服务只允许 HTTPS；HTTP 仅允许 loopback 或 RFC1918 局域网开发地址。FTP、格式错误、带内嵌账号密码或公网 HTTP 的地址会在发送账号、会议或模型凭据前失败关闭，支持/隐私/条款/数据删除外链复用同一规则。

原生录音开始后会继续解析延迟返回的文件 URI，并立即写入异常中断恢复索引。录音中每 5 秒检查本地文件是否存在和持续增长，暂停不误报，连续 15 秒无增长会在主录音页告警。异常终止后重启会恢复索引并自动同步；成功生成纪要后，录音转为“已完成本地归档”，不再自动重试，但重启后仍可导出、重新生成纪要，删除账号时也能完整清理。

同一 Wi-Fi 下真机开发不要使用 `localhost`，应填写电脑局域网地址，例如：

```text
http://192.168.1.10:3003
```

也可以在启动前设置：

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.10:3003 npm run ios
```

TestFlight 外部测试、App Store 审核、密码重置邮件、公开分享和 Apple IAP 通知不能使用 localhost、127.0.0.1 或局域网 IP，必须使用公网 HTTPS，例如：

```text
https://app.example.com
```

生产构建前必须设置 `EXPO_PUBLIC_API_BASE_URL=https://...`、`OWNMINUTES_APP_URL=https://...`、`OWNMINUTES_PRIVACY_URL=https://.../privacy`、`OWNMINUTES_TERMS_URL=https://.../terms`、`OWNMINUTES_SUPPORT_URL=https://.../support`、`OWNMINUTES_SUPPORT_EMAIL=support@真实域名` 和 `OWNMINUTES_HEALTH_CHECK_URL=https://.../api/health`，并按 `docs/public-deployment-runbook.md` 验证 `/api/health`、合规页面和移动端短会录制。根目录 `npm run mobile:testflight:build` 会先执行 `mobile:testflight:preflight`；如果 API Base URL、App URL、隐私政策、服务条款、支持页、支持邮箱或健康检查 URL 是本地/占位配置、无效 URL、公网 HTTP、缺失值或路径错误，会直接阻止构建，避免把不完整公网配置打进 TestFlight 包。

本机已有 Xcode Distribution 签名时，可在根目录使用 `mobile:ios:local:build` 生成候选，再用 `mobile:ios:local:upload-preflight`、`mobile:ios:local:validate` 和 `mobile:ios:local:upload` 直接交付 App Store Connect，不依赖 EAS。App Store Connect `.p8` 必须保存在仓库外且权限为 `0600`；签名探测包永远不可上传。完整边界见 `docs/ios-testflight-acceptance-runbook.md`。

后端需要先在仓库根目录启动：

```bash
npm run build
npm run preview:screen
```

## 当前能力

- 新安装先进入原生账号首屏；已有有效会话恢复完成后直接进入 `记录`。账号首屏使用 OwnMinutes 品牌、登录/注册分段控件、图标输入、密码显隐、注册隐私同意和连接设置入口，不再把“请先登录”错误藏在录音页底部。
- 原生登录、注册、邮箱验证和密码重置已补齐 VoiceOver 标题、字段、按钮、链接、复选框状态与动态消息语义；装饰图标不会作为私有字体字符被单独朗读。硬件键盘/软件键盘的“下一项”按姓名、邮箱、密码顺序移动焦点，最后仍由用户明确提交，不自动创建账号。
- 登录后的 `记录 / 会议 / 我的` 也按真实 iPhone SE Release 辅助功能树验收：页面和面板标题为 heading，主操作、刷新、折叠项、菜单和购买项有角色/状态，统计按“标签：数值”成对朗读；所有装饰 Ionicons 隐藏，会议标题、会议搜索、API URL 与 BYOK 非敏感参数不会误报为安全输入框，ASR/Ark 密钥和高级参数均有独立字段名。
- 未登录用户从 `记录` 点击主按钮会直接返回登录页；登录/注册成功自动进入录音页，退出或删除账号自动回到账号页。登录请求处理中会禁用模式切换和重复提交。
- 主屏采用 `记录 / 会议 / 我的` 三个移动端 Tab；语言、录音隐私、BYOK 和开发连接均从“我的 > 设置与偏好”进入。
- 底部 Tab 和主操作使用 Ionicons 线性图标；`smoke:mobile-ui` 会防止退回纯文字或手工形状图标。
- `记录` Tab 与 Web `/app` v25 对齐为单任务录音界面：顶部只保留 `OwnMinutes / 会议记录`，浅色录音台集中展示会议名、状态、本地保存、64px 计时和 36 段声波；绿色圆形麦克风按钮是日常开始入口，录音中切换为红色结束按钮，暂停/继续和新会议使用两侧圆形图标。模型配置、Provider、失败分片和稳定性诊断全部收进设置页，不打断录音主流程。
- 首场会议完成前，记录页会根据账号状态给出一个明确主动作：有官方额度时可直接跑 1 分钟短会；额度耗尽时转到 BYOK 或官方额度；已保存但未配齐的 BYOK 转到继续配置。官方处理是否实际接受本场请求最终由已认证的服务端处理入口判定，用户 BYOK 状态来自账号 Provider credentials/health；管理员内部 Provider 详情只通过受保护的 `/api/providers/diagnostics` 查看。首场处理完成后该引导自动消失。
- 录音台在日常会议开始前显示本场预计处理路由：完整且健康的 ASR + Ark 配置为“自己的模型”，不扣官方分钟；只配置一部分时为“混合处理”，仍按时长扣官方分钟；未配置时使用官方额度。官方额度低于 10 分钟会提前预警。
- 正式结果保存 `processingRoute / processedMinutes / officialMinutesCharged`。会后录音台、会议详情和“我的”用量流水展示实际路由、处理分钟和官方扣减；旧用量事件按官方额度兼容读取。完整 BYOK 扣 0 分钟，官方/混合处理扣整分钟，强制重新生成按新结果版本结算，普通幂等重试不重复收费。
- iOS 正式原始录音使用 16 kHz、单声道、16-bit Linear PCM/CAF，优先保证长会议异常中断后的原音可恢复；实时识别继续使用独立 16 kHz PCM。Web MediaRecorder、CAF、M4A 和历史格式在服务端通过 ffmpeg 统一转为 16 kHz 单声道音频，并只对送入正式识别的临时副本执行轻度语音降噪；本机原音不会被覆盖。
- 会后处理支持 `queued / processing / completed / failed`：生产队列返回 `202` 后，App 会轮询正式结果；排队、重试和失败状态保留已上传音频，不重复上传整段录音。
- `会议 / 我的` 不再被录音主控台压在上方，三个移动端 Tab 固定在底部；低频设置降为“我的”的二级页面。
- `记录` Tab 内部使用 `实时转写 / 会后纪要` 分段结果区，首屏只保留录音、实时草稿和会后输出主链路。
- `会后纪要` 在正式结果生成前只显示空状态，不展示示例摘要、示例决策或占位 Markdown；复制 / 分享 `.md` 文件必须等服务端正式 Markdown 生成后才可用。
- `会议` Tab 管理会议历史、会议详情、分享权限、复制分享链接、Markdown 输出和单场会议删除。
- 会议详情支持发言人校正，可把 `Speaker 1/2` 改成真实姓名，并同步更新逐字稿、纪要、待办负责人、分享页和 Obsidian Markdown；页面会提示单设备混合录音无法承诺 100% 自动区分说话人，发布分享或沉淀知识库前需要人工确认。
- 会议详情提供分页的“逐字稿与发言归属”：可查看正式逐字稿，用 44px 快捷标签或姓名输入逐段修正被分错人的内容；保存后同步正式逐字稿、公开分享和 Obsidian Markdown。该操作不会假装自动改写纪要观点归因或待办负责人，App 会要求继续人工复核纪要。
- 会议详情支持人工修订纪要，可编辑摘要、关键主题、发言人观点、风险、未解决问题、知识点、决策和待办，保存后同步刷新分享页和 Obsidian Markdown。
- “我的 > 设置与偏好”管理显示语言、录音隐私、API Base URL、后端检查和 Provider/BYOK；开发诊断仍保留上传与识别管道、实时 PCM 指标、录制稳定性检查和合规提示。BYOK 收敛成“1 语音识别 / 2 纪要总结”，基础表单只展示推荐 Key 和必要 Endpoint，旧版鉴权、WebSocket、Resource ID 与 Base URL 按需展开。
- iOS BYOK 表单支持火山新控制台专用 ASR API Key，也支持高级区内的旧控制台 AppID + Token；ASR API Key、ASR Token 和 Ark API Key 使用独立输入状态，切换 Provider 不会把另一类密钥误存。设置页提供火山语音控制台、方舟控制台和 ASR 鉴权文档的系统浏览器入口，保存后刷新模型状态与账号成本模式，错误配置可确认后删除。
- 未登录用户点击配置会直接进入注册页；已登录用户会自动滚动到 BYOK 表单。上传管道、录制稳定性和合规状态默认收进“高级诊断”，普通设置页只保留配置向导和后端连接主路径。
- 在 ASR API Key 与 AppID + Token 之间切换时，客户端会显式请求后端删除旧鉴权密钥；删除与新密钥保存都会进入密钥审计，避免旧 Key 残留后继续被优先调用。
- `我的` Tab 管理登录注册、账号状态、套餐、用量、导出数据、退出和删除账号。
- 注册 / 登录 OwnMinutes 账号。
- 普通后端连接检查只读取最小化的 `/api/health`，用于录音前确认 API Base URL 可访问；管理员可另行读取受保护的 `/api/release/readiness` 和 Provider 内部诊断。API Base URL 会保存在本机，可一键恢复默认值，并明确提示当前地址是否只适合模拟器、局域网开发或可用于 TestFlight 公网 HTTPS。
- 使用 SecureStore 保存本机会话；原生请求从会话 Cookie 提取 token 并发送 `Authorization: Bearer`，Web 仍使用 HttpOnly Cookie。
- 在线认证成功后会额外在 SecureStore 保存一份只含白名单用户资料、绑定当前 API Base URL、最长 24 小时有效的离线会话快照。断网或服务临时不可达时，已登录用户冷启动仍可进入 `记录` 并先把完整音频保存在本机；App 在线时每 30 秒重新验证服务。只有 `/api/auth/me` 明确返回 401/403 才会清除会话，退出、删号、改密码和套餐变化会同步维护快照。快照不包含 Cookie、密码、Provider Key、token 或 API Key。
- 导出账号数据 JSON，包含账号、用量、Provider 掩码摘要和会议清单。
- 删除账号并清理服务端会议、Provider、用量和分享数据。
- 查看当前方案和官方额度。
- 查看近期官方额度流水。
- 查看成本模式：官方额度、BYOK 或混合模式。
- Free 始终可用；独立 iOS 开发构建/TestFlight 在支付服务配置完成后通过 App Store 购买或恢复 Plus / Pro。Expo Go 和未配置环境只显示禁用预览态，不执行模拟方案切换。
- 配置火山 ASR / 火山方舟 BYOK Provider。
- 查看已保存 Provider 的字段和密钥掩码。
- 对火山 ASR / 火山方舟执行用户级配置健康检查，显示可用用途、缺失字段和下一步。
- 在移动端设置页执行 `ASR 提交测试`，确认火山 ASR provider 是否接受请求并返回诊断；完整识别测试仍在 Web `/settings` 上传或录制样本跑到 `transcribed`。
- 可手动触发火山方舟 Ark 轻量真实连通测试，确认 Key、Endpoint 和 Base URL 能调用 Chat Completions。
- 录音上传和会后正式处理会带登录会话，匹配 Web 端账号权限。
- 读取账号会议历史。
- 打开会议详情，查看正式摘要、决策和逐字稿。
- 只复制 / 分享服务端正式 Obsidian Markdown，未生成正式纪要前不会导出占位 Markdown。
- 发布 / 撤销会议分享链接。
- 未验证或 fallback 纪要公开时，除了 App 内人工确认弹窗，还必须向服务端提交明确的 `confirmUnverified` 标记；直接绕过界面调用 API 会被拒绝。
- 控制分享页是否公开逐字稿。
- 复制 / 系统分享会议纪要链接。
- 删除单场会议，并清理该会议的原始音频、纪要、Markdown 和分享链接。
- 麦克风权限申请。
- 开始录音前弹出“录音前确认”，用户确认参会人已知情同意后才请求麦克风并开始录音。
- 本地完整音频录制。
- iOS 启动录音遵循 `prepare -> record -> 尽早获取 URI -> 可用时持久化恢复索引`；不能在 `prepare` 后、`record` 前要求 URI 已存在，也不能因 URI 短暂延迟而终止已经运行的录音。URI 尚未返回时继续正式录音，并在停止后取得最终 URI；真正的启动异常才会停止原生录音器并尽量保留已创建文件。
- 录音启动错误会直接显示在主录音按钮下方，不再只写到整页底部，避免用户误判为点击没有反应。
- 用户确认录音后立即进入“准备录音 / 正在准备”状态并禁用重复点击；系统音频初始化较慢时，界面仍会给出明确反馈。
- 原生录音器准备超过 8 秒会进入可见错误态并清理音频会话，不会无限卡在“正在准备”。
- 初始会话恢复使用单次执行门闩；设置 `sessionCookie` 引起 callback 依赖变化时不能再次恢复旧的 pending recording，否则正在录音的状态会被错误覆盖为“已完成”，而原生录音仍在后台继续。
- PCM 实时流计数，并按约 3 秒阈值切出真实 PCM 字节候选分片；内存最多保留最近 20 个分片，为火山实时 ASR WebSocket 预留接入点。
- 实时 PCM 候选分片会推送到 `/api/meetings/:id/realtime-chunks` 独立草稿接口，不写入会后正式音频 manifest。
- 后端会为实时草稿接口维护轻量会话状态，可通过 `GET /api/meetings/:id/realtime-chunks` 查看累计分片数、字节数、provider 状态、最后诊断和草稿数量；该状态不保存 PCM 音频，账号删除时会同步清理 realtime-only session。
- 录制稳定性检查面板放在设置页：显示账号会话、网络、麦克风权限、Keep Awake、后台录音、PCM 输入流、实时分片缓存、本地音频、多会议待处理队列和上传状态，避免记录页首屏像工程诊断面板。
- 本地录音与会后处理恢复：正式录音从创建时就写入 iOS Documents，并在停止后整理到 `ownminutes-recordings` 管理目录；每场未完成会议进入同一恢复索引，新会议不会覆盖上一场恢复入口。索引通过完整临时文件提交并维护同内容安全备份，所有读改写串行执行；主索引截断或提交中断时会自动恢复，主索引与备份同时损坏时失败关闭、保留原音频并提示不要卸载 App。恢复记录同时持久化稳定 upload id、recordedAt、总片数和已完成片号；完整音频提交成功后才标记 `audioUploadedAt`。
- 待处理录音会在用户登录且网络恢复后自动续传：队列按会议创建时间从旧到新处理，严格隔离当前账号；上传前查询服务端状态，只补传缺失的 4 MiB 分片。失败记录会持久化错误、尝试次数和下次重试时间，使用 15 秒起步、最长 15 分钟的指数退避；已提交音频只幂等重试 finalize。
- 录音与实时草稿解耦：暂停会同时暂停正式录音和实时 PCM；恢复时先恢复正式录音，实时输入失败只显示诊断，不会停止本地正式录音。iOS 音频服务重置和从后台返回后的原生录音状态都会被检测并提示恢复。
- 原始音频兜底导出：后端不可用时，可通过系统分享把本地录音导出到 Files / AirDrop 等位置。
- 录音结束后上传完整音频到现有 Next.js API。
- 会后完整音频使用 4 MiB 可恢复分片：Expo `FileHandle` 按 offset 读取、`expo-crypto` 计算 SHA-256、cache 临时片通过后台原生二进制上传；服务端上传提交阶段每次只读取并校验一个分片，顺序写入 `0600` 临时文件，ffprobe 直接读文件，再通过对象存储 `putFile` 流式写入正式音频。生产对象存储模式下，会后 ASR 再通过 `getFile` 顺序落盘、文件转码、私有临时对象和短时签名 URL 交给火山，Node 不再生成整段 Base64 音频；本地存储开发模式保留 Buffer fallback，并继续受 96 MiB 上限约束。
- 服务端默认每账号最多保留 4 个活动上传、256 MiB 暂存；72 小时没有新分片的租约会在后续状态/上传请求中机会性回收，生产 bucket 仍需 lifecycle 兜底。客户端可从本地 M4A 重新建立上传，限额或回收不会删除设备原始录音。
- 会议和我的页面采用渐进展开：会后首屏优先展示摘要、决策、待办、逐字稿与分享；纪要编辑、发言人校正、导出、删除、后端连接、BYOK、用量、会员和高级诊断按需展开。
- 上传状态、provider、adapter、diagnostic 展示。
- Markdown 复制和系统分享导出。

## 当前限制

- `expo-iap` 已接入客户端购买、恢复和服务端交易提交，并已在独立 iOS Simulator App 中完成原生编译与启动验证。本机已安装 CocoaPods 1.17.0，但 EAS 未登录，Apple 商品/Server API/公网通知也未完成，因此真实 StoreKit sandbox 购买仍需开发构建或 TestFlight 验收；不能把模拟器原生启动当作支付通过。

- 火山实时 ASR WebSocket 协议、心跳、有界重连、停止握手和失败隔离已经实现；正式发布前仍需配置语音运行时凭证，并完成弱网和真实中文会议验收。
- 当前移动端 BYOK 表单只覆盖火山 ASR 和火山方舟的核心字段。
- 默认健康检查是配置预检，不会主动消耗 ASR 识别额度；Ark 真实测试只在用户手动触发时执行。
- 当前移动端只做 ASR submit 层测试，不做真实音频 `transcribed` 测试和 Provider 余额检查。
- Expo 原生配置已启用 `UIBackgroundModes: audio`，运行时也显式开启 `allowsBackgroundRecording`；代码层已支持锁屏/切后台继续录制。该能力仍必须用正式 TestFlight 包在真实 iPhone 上完成 5/30/90 分钟、锁屏、切后台、来电和耳机中断专项验证，不能用模拟器或静态 smoke 代替。
- 当前会生成 3 秒级 PCM 候选分片内存队列，并通过独立实时草稿接口推送给火山 WebSocket 会话；后端只持久化轻量会话状态，不保存实时 PCM。正式会后处理仍以完整录音文件为准，因此实时服务故障不会破坏原始录音和正式纪要链路。

## 验收保护

从仓库根目录运行：

```bash
npm run mobile:typecheck
npm run smoke:mobile-ui
npm run smoke:mobile-recording-index
npm run smoke:mobile-offline-session
npm run smoke:ios-native-build-script
npm run mobile:ios:native:preflight
npm run mobile:ios:small-screen:verify
npm run smoke:ios-simulator-ui
npm run smoke:mobile-stability
npm run smoke:recording-resume
npm run smoke:mobile-realtime
npm run smoke:asr-acceptance-evidence
npm run smoke:testflight-config
npm run smoke:testflight-preflight
npm run smoke:ios-testflight-evidence
```

`smoke:mobile-ui` 会检查 Expo App 必须保留首次启动账号入口、会话恢复导航、官方服务与用户 BYOK 独立诊断、首次官方额度/BYOK 分流、每场预计/实际处理成本、未登录录音跳转、登录/注册分段控件、隐私同意、密码显隐、账号与找回流程的 VoiceOver 标签/状态/动态消息和字段焦点顺序、登录后的 heading/主操作/折叠项/统计成对朗读/非密码输入类型、ASR 与 Ark 全字段标签、`记录 / 会议 / 我的` 三个底部 Tab、设置二级返回、浅色录音工具面、圆形开始/结束按钮、两侧暂停/新会议图标、Ionicons 图标、录音中仅显示实时转写、会后纪要诚实空状态、本机原音回听、正式 Markdown 导出门槛、会议历史/分享、发言人改名、逐段发言归属校正、基础/高级 BYOK 配置、配置删除恢复、管道和账号管理入口，并校验 Expo 56 原生依赖版本对齐。动态 first-run smoke 覆盖六种状态；meeting-cost smoke 覆盖服务器官方能力、完整 BYOK 免费、部分配置混合扣费、低额度提醒、额度耗尽和实际账单文案。根目录 `smoke:meetings` 还会真实验证逐段校正、过期段落冲突、分享与 Markdown 一致性；`smoke:processing-route` 验证官方/混合/BYOK 三路结算和强制重算边界。
`smoke:ios-native-build-script` 静态保护 ASCII staging、managed source、Release build、OpenIAP 本地 source、Expo 版本对齐、模拟器安装/启动、PID 日志扫描、750x1334 小屏模式、截图和临时文件清理。`mobile:ios:native:preflight` 是只读环境检查；`smoke:ios-native-build` 和 `mobile:ios:small-screen:verify` 才会执行完整原生构建和重装模拟器 App。主工作区、邮箱验证和密码重置 ScrollView 必须继续保留 iOS 键盘 inset、交互式收起和表单点击保持，防止小屏键盘遮住后续字段或主按钮。
`smoke:ios-simulator-ui` 会在已启动的 iOS Simulator 中打开 Expo Go 预览并保存截图到 `.data/screenshots/ownminutes-ios-simulator-latest.png`。运行前需要本地后端 `127.0.0.1:3003`、Metro `127.0.0.1:8081`、已启动模拟器和已安装 Expo Go；该截图 smoke 只证明模拟器可打开和截图可采集，不替代真实 iPhone/TestFlight 长录音验收。
`smoke:mobile-stability` 会检查后台录音 Expo 配置、运行时 AudioMode、Documents 持久目录、多会议恢复索引、暂停/恢复 PCM 语义、实时失败隔离、iOS 音频服务重置、账号删除本地清理，以及后端检查、麦克风权限、Keep Awake、原始音频导出、原生分片续传和上传队列状态。`smoke:mobile-recording-index` 会故障注入主索引截断、提交中断、双副本损坏、备份刷新和 20 路并发修改，确保恢复或失败关闭时不覆盖原音频；`smoke:mobile-pending-sync` 会实际验证账号隔离、最旧会议优先、定时退避、手动强制重试和 15 分钟退避上限；`smoke:recording-resume` 用 300 秒音频验证乱序、缺片、幂等、冲突、跨账号隔离、权威时长和删除防复活。
`smoke:mobile-offline-session` 会动态验证 24 小时有效期、API Base URL 绑定、服务端额外用户字段白名单抽取、畸形/过期/跨服务快照拒绝、断网和 500 保留、401/403 失效、30 秒在线重验证，以及退出/删号清理；真实 iPhone SE Release 模拟器证据保存在 ignored `.data/screenshots/ownminutes-ios-offline-cold-start-latest.png`、`ownminutes-ios-session-revalidated-latest.png` 和 `ownminutes-ios-invalid-session-cleared-latest.png`。
`smoke:mobile-realtime` 会实际向独立实时分片接口提交 3 秒 PCM 数据，并确认它不会污染会后正式音频 manifest；同时验证实时会话状态可查询、累计计数正确、不泄露 Provider 密钥、账号删除会清理 realtime-only session。
`smoke:asr-acceptance-evidence` 会验证真实 ASR/说话人私有证据检查器本身：完整证据必须覆盖 `transcribed` 小音频、非 fallback 会议逐字稿、摘要归因、分享/Markdown、多人说话人标签、改名流程、质量抽样表和无密钥泄露。真实 ASR QA 证据应保存在 `.data/acceptance/asr-latest.md`，再运行 `OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence`。
`smoke:testflight-config` 会检查 Bundle ID、麦克风权限、EAS `testflight` profile、TestFlight 公网 HTTPS preflight、根目录构建/提交脚本和 TestFlight 文档是否一致。
`smoke:testflight-preflight` 会验证 TestFlight 构建前置脚本必须拦截缺失环境、只配置 API、localhost、LAN、公网 HTTP、错误合规路径，并只允许完整公网 HTTPS URL 集合通过。
`smoke:ios-testflight-evidence` 会验证私有真机验收证据检查器本身：完整证据必须逐场景覆盖模拟器、5/30/90 分钟、弱网、离线恢复、切后台风险、耳机中断、分享 Markdown 和账号删除；每个场景都必须有自己的关键字段和 `Decision: pass`，缺项或 `Decision: fail` 必须失败。真实 QA 证据应保存在 `.data/acceptance/ios-testflight-latest.md`，再运行 `OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH=.data/acceptance/ios-testflight-latest.md npm run ios:testflight:evidence`；不要提交 `.data` 下的私有音频、转写或账号证据。
