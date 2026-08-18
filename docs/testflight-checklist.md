# TestFlight 准备清单

## Apple 账号

- 加入 Apple Developer Program。
- 在 App Store Connect 创建 App。
- Bundle ID：`app.ownminutes.mobile`。
- App 名称：`OwnMinutes`。

## 构建

可使用 EAS，也可以使用已经验证的本地 Xcode App Store 归档。移动端 Expo 项目位于 `apps/mobile`，生成的 `ios/` 目录和签名产物都不得提交。

从仓库根目录执行：

```bash
npm run mobile:testflight:build
npm run mobile:testflight:submit
```

等价于进入移动端项目目录执行：

```bash
npm install -g eas-cli
cd apps/mobile
eas login
eas build --platform ios --profile testflight
eas submit --platform ios --profile testflight
```

本地 Xcode 路径：

```bash
npm run mobile:ios:local:preflight
OWNMINUTES_IOS_BUILD_NUMBER=<唯一正整数> \
EXPO_PUBLIC_API_BASE_URL=https://app.example.com \
OWNMINUTES_APP_URL=https://app.example.com \
OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy \
OWNMINUTES_TERMS_URL=https://app.example.com/terms \
OWNMINUTES_SUPPORT_URL=https://app.example.com/support \
OWNMINUTES_SUPPORT_EMAIL=support@example.com \
OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health \
npm run mobile:ios:local:build
npm run mobile:ios:local:upload-preflight
npm run mobile:ios:local:validate
npm run mobile:ios:local:upload
npm run mobile:ios:local:upload-evidence
```

稳定公网环境建立前可以运行 `mobile:ios:local:signing-probe` 验证本机 Apple 签名，但文件名带 `SIGNING-PROBE-DO-NOT-UPLOAD` 的 IPA 严禁上传。

构建前先跑本地检查：

```bash
npm run smoke:testflight-config
npm run smoke:ios-local-testflight-script
npm run smoke:ios-testflight-runbook
npm run mobile:typecheck
npm run smoke:mobile-ui
npm run smoke:mobile-stability
```

真机和 TestFlight 验收步骤见：

```text
docs/ios-testflight-acceptance-runbook.md
```

## App 审核/测试资料

- 简体中文元数据：`app-store/metadata/zh-Hans.json`。
- 稳定公网隐私政策、支持页和营销 URL。
- App Store Connect 内的专用审核账号或测试说明；密码不得写入仓库。
- 麦克风用途说明。
- 第三方 AI 处理说明。
- 数据删除说明。
- 6.9 英寸截图：录音、实时转写、正式纪要、会议历史、BYOK 成本设置。
- 首版是 iPhone-only；恢复 `supportsTablet=true` 前必须补 iPad UX、13 英寸截图和真机矩阵。

素材生成和严格校验：

```bash
npm run mobile:brand:generate
npm run appstore:screenshots:capture
npm run appstore:prepare
npm run smoke:appstore-submission
```

完整边界见 `docs/app-store-submission-runbook.md`。

## 必测真机场景

- 5 分钟录音。
- 30 分钟录音。
- 90 分钟录音。
- 锁屏。
- 切后台。
- 来电话。
- 蓝牙耳机断开。
- 弱网/断网/恢复网络。
- 结束后上传失败重试。
- Markdown 导出到 Files / Obsidian。

## 不应承诺

- 不承诺电话录音。
- 不承诺单设备混合录音 100% 准确区分发言人。
- 不承诺实时草稿就是正式纪要。
