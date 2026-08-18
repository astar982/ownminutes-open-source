# iOS TestFlight Acceptance Runbook

## Boundary

This runbook verifies the OwnMinutes Expo iOS app on a real iPhone or an iOS simulator before TestFlight or App Store review.

It is not a replacement for provider quality testing. ASR accuracy, speaker separation, summary quality, Apple IAP sandbox purchases, production database, object storage, KMS, and public HTTPS deployment still need their own acceptance evidence.

Source smoke, unit tests, simulator runs, screenshots, and static review cannot satisfy any real-iPhone/TestFlight scenario in this runbook. They are useful preflight evidence only. Every non-simulator scenario must be executed from the named TestFlight build on a physical iPhone and recorded in the private evidence file.

## Required Build

Use the mobile project and EAS profile that are checked by `smoke:testflight-config`.

```bash
npm run mobile:ios:prereqs
npm run mobile:ios:native:preflight
npm run smoke:testflight-config
npm run smoke:ios-appstore-compliance
npm run mobile:typecheck
npm run smoke:mobile-ui
npm run smoke:ios-native-build-script
npm run smoke:ios-native-build
npm run smoke:ios-simulator-ui
npm run smoke:mobile-stability
npm run smoke:mobile-recording-watchdog
npm run smoke:mobile-recording-storage
npm run smoke:mobile-realtime
npm run smoke:testflight-preflight
npm run mobile:testflight:build
npm run mobile:testflight:submit
```

The expected iOS app configuration is:

- App name: `OwnMinutes`
- Bundle ID: `app.ownminutes.mobile`
- EAS profile: `testflight`
- iOS distribution: `store`
- Microphone permission key: `NSMicrophoneUsageDescription`
- Device family: iPhone only (`UIDeviceFamily=[1]`)
- Background modes: `audio` only
- Export declaration: `ITSAppUsesNonExemptEncryption=false`
- Privacy manifest: root application declaration plus valid embedded SDK manifests

## Local Xcode App Store Archive

EAS is optional when the Mac already has a valid Xcode team login and Apple Distribution identity. OwnMinutes supports a local two-stage archive path that keeps the Expo-managed `apps/mobile/ios` directory out of Git:

```bash
npm run mobile:ios:local:preflight
```

The candidate preflight requires a clean Git worktree, a positive unique `OWNMINUTES_IOS_BUILD_NUMBER`, all six public HTTPS URLs, and a live `deployment:verify` pass. A real candidate build is:

```bash
OWNMINUTES_IOS_BUILD_NUMBER=11 \
EXPO_PUBLIC_API_BASE_URL=https://app.example.com \
OWNMINUTES_APP_URL=https://app.example.com \
OWNMINUTES_PRIVACY_URL=https://app.example.com/privacy \
OWNMINUTES_TERMS_URL=https://app.example.com/terms \
OWNMINUTES_SUPPORT_URL=https://app.example.com/support \
OWNMINUTES_SUPPORT_EMAIL=support@example.com \
OWNMINUTES_HEALTH_CHECK_URL=https://app.example.com/api/health \
npm run mobile:ios:local:build
```

The script runs the independent native Release simulator smoke, creates an unsigned generic iOS archive, then exports it with Xcode `app-store-connect` automatic signing. It verifies the final code signature, App Store provisioning profile, `beta-reports-active=true`, `get-task-allow=false`, Bundle ID, version/build number, embedded API origin, absence of localhost/LAN API origins, iPhone-only family, background audio mode, exempt-encryption declaration, and all root/SDK privacy manifests.

For a build that is deliberately restricted to an existing internal TestFlight group and must never be used for external testing or App Store review, use the explicit internal-only path:

```bash
OWNMINUTES_IOS_BUILD_NUMBER=12 \
EXPO_PUBLIC_API_BASE_URL=https://your-shared-test-host.example \
OWNMINUTES_APP_URL=https://your-shared-test-host.example \
OWNMINUTES_PRIVACY_URL=https://your-shared-test-host.example/privacy \
OWNMINUTES_TERMS_URL=https://your-shared-test-host.example/terms \
OWNMINUTES_SUPPORT_URL=https://your-shared-test-host.example/support \
OWNMINUTES_SUPPORT_EMAIL=support@example.com \
OWNMINUTES_HEALTH_CHECK_URL=https://your-shared-test-host.example/api/health \
OWNMINUTES_DEPLOYMENT_VERIFY_ADMIN_BEARER_TOKEN=<short-lived-private-token> \
npm run mobile:ios:local:internal-build
```

This scope still requires public HTTPS pages, `releaseReady=true`, protected administrator diagnostics, and complete deployment configuration other than the explicitly reported legal operator identity. It records `productionDeploymentVerified=false`; it does not weaken the production or App Review gate. The build writes a private `UploadOptions.plist` with `destination=upload`, `manageAppVersionAndBuildNumber=false`, and `testFlightInternalTestingOnly=true`. Upload the verified archive only with that plist:

```bash
xcodebuild -exportArchive \
  -archivePath .data/testflight-local/OwnMinutes.xcarchive \
  -exportPath .data/testflight-local/internal-upload \
  -exportOptionsPlist .data/testflight-local/UploadOptions.plist \
  -allowProvisioningUpdates
```

Do not use `mobile:ios:local:upload` for an internal-only candidate: that command uses `altool`, which cannot apply the internal-only distribution restriction. Before upload, verify the private plist values with `plutil`; they must be `destination=upload`, `testFlightInternalTestingOnly=true`, and `manageAppVersionAndBuildNumber=false`.

To verify only that this Mac and Apple team can create an App Store-signed IPA before the stable backend exists:

```bash
EXPO_PUBLIC_API_BASE_URL=https://staging.ownminutes.app \
npm run mobile:ios:local:signing-probe
```

The resulting filename contains `SIGNING-PROBE-DO-NOT-UPLOAD`. It proves local signing and export only. **DO NOT UPLOAD** it to App Store Connect because the placeholder API origin is not a verified stable backend. Signing probes do not satisfy TestFlight acceptance.

All archives, IPAs, export options, profiles, checksums, and logs stay under ignored `.data/testflight-local/`. Apple certificates, private keys, App Store Connect credentials, provisioning profiles, and signed IPAs must never be committed.

## Development-Signed Physical iPhone Acceptance

Before a real TestFlight candidate exists, the current source can be built, signed, installed, and launched directly on a paired iPhone. This path requires a clean Git worktree, an Apple Development identity, an available paired iPhone with Developer Mode enabled, and a live public HTTPS API origin:

```bash
EXPO_PUBLIC_API_BASE_URL=https://app.example.com \
npm run mobile:ios:device:preflight

EXPO_PUBLIC_API_BASE_URL=https://app.example.com \
npm run mobile:ios:device:build

EXPO_PUBLIC_API_BASE_URL=https://app.example.com \
npm run mobile:ios:device:install
```

If this Mac can reach the verified public origin only through a local HTTP/SOCKS proxy, declare it explicitly for the preflight health probe:

```bash
OWNMINUTES_DEVICE_PREFLIGHT_PROXY=http://127.0.0.1:7897 \
EXPO_PUBLIC_API_BASE_URL=https://app.example.com \
npm run mobile:ios:device:preflight
```

The proxy URL must not contain credentials. It is used only by the Mac-side `/api/health` probe and is never embedded in the App. The iPhone must still prove that it can reach the public API on its own test network; a proxied Mac probe does not satisfy physical-device or China-network acceptance.

The preflight reports only the device name, model, OS, pairing, availability, and Developer Mode state. It does not print the device identifier, hardware UDID, or serial number. The build verifies the Apple Development signature, provisioning profile, selected-device registration, bundle/version/build values, embedded HTTPS API origin, absence of a loopback default, and the same app compliance contract used by the App Store path. `--install` additionally installs and launches the app with `devicectl`.

Private logs, checksums, summaries, and the `DEVICE-ACCEPTANCE-DO-NOT-UPLOAD` package remain under ignored `.data/ios-device-acceptance/` with restricted permissions. This package is for physical-device QA only. It is not an App Store profile, must not be uploaded, and does not prove TestFlight processing, distribution, Sandbox IAP, long-recording stability, or commercial readiness.

## Local App Store Connect Validation And Upload

The local archive path also supports App Store Connect validation and upload without EAS. Create an App Store Connect API key with the minimum role required to upload builds. Keep its `.p8` file outside the repository, set it to mode `0600`, and never paste its contents into `.env`, terminal arguments, GitHub, Obsidian, logs, or evidence.

Required private runtime fields:

```bash
export OWNMINUTES_ASC_API_KEY_ID=XXXXXXXXXX
export OWNMINUTES_ASC_API_ISSUER_ID=00000000-0000-0000-0000-000000000000
export OWNMINUTES_ASC_API_PRIVATE_KEY_PATH=/absolute/private/path/AuthKey_XXXXXXXXXX.p8
```

After building a real candidate, run the local-only preflight:

```bash
npm run mobile:ios:local:upload-preflight
```

It rejects a missing/tampered IPA, a `SIGNING-PROBE-DO-NOT-UPLOAD` artifact, a stale candidate from another Git commit, a dirty worktree, incomplete distribution checks, a local/LAN API host, missing API credentials, and a key file readable by group/other users.

Validate the candidate with Apple's installed Xcode `altool` before upload:

```bash
npm run mobile:ios:local:validate
```

Validation writes only a private 0600 receipt to `.data/acceptance/appstore-upload-latest.json`. A validation receipt is useful diagnostics but does not prove that a TestFlight build was uploaded.

The real upload is deliberately double-gated. The npm command sets the required upload flag and the script still requires a verified `--upload` operation:

```bash
npm run mobile:ios:local:upload
```

The script uses `xcrun altool --upload-package --wait` and records only candidate hash, bundle/version/build, code commit, API host, delivery ID, processed state, and boolean checks. It does not record API key ID, issuer ID, private-key path/content, IPA path, Apple session data, or raw provider output. Verify the private upload receipt with:

```bash
npm run mobile:ios:local:upload-evidence
```

An upload receipt proves delivery to App Store Connect, not TestFlight installation, review availability, Sandbox IAP, real-iPhone recording, or commercial readiness. Continue with build processing, internal TestFlight assignment, installation on a real iPhone, and the full acceptance matrix below.

## Native Release Simulator Smoke

Before TestFlight, run an independent Release simulator build instead of relying only on Expo Go:

```bash
npm run mobile:ios:native:preflight
npm run smoke:ios-native-build
```

The native smoke fails before launch if the generated Release `.app` does not pass `inspectIosAppBundle`. Its JSON summary includes `appStoreCompliance`, including device family, background modes, URL schemes, privacy-manifest count, collected data, required-reason categories, and every boolean check. To inspect a retained app manually:

```bash
OWNMINUTES_KEEP_NATIVE_SMOKE=1 npm run smoke:ios-native-build
OWNMINUTES_IOS_COMPLIANCE_APP_PATH=/absolute/path/to/OwnMinutes.app \
  npm run mobile:ios:compliance
```

The preflight is read-only. The full smoke requires macOS, Xcode, CocoaPods, GitHub CLI authentication, and a booted iOS Simulator. It stages `apps/mobile` under an ASCII temporary path so React Native 0.85 / CocoaPods does not parse the Chinese repository path. It then:

- runs Expo prebuild without committing `apps/mobile/ios`;
- reuses version-bound React Native core and Hermes debug/release archives from ignored `.data/native-smoke-cache/` when their integrity checks pass;
- fetches only the OpenIAP Apple source required by `expo-iap` and points the temporary Podfile at it;
- runs a signed Release Xcode simulator build with a bundled JavaScript payload;
- installs and launches `app.ownminutes.mobile`;
- scans the launched PID for symbol mismatch, missing native module, uncaught native function, and fatal runtime errors;
- captures `.data/screenshots/ownminutes-ios-native-latest.png` and private logs under `.data/native-smoke`;
- removes temporary iOS/Pods/DerivedData after success.

Hermes caches are keyed by the exact `hermes-compiler` version, checked with `gzip -t`, and pinned to the official Maven Central SHA-256 values. The preflight fails when a new Hermes version has no reviewed checksum, and the full smoke fails when the retained archives do not match. Cache files are local build inputs only: keep them ignored, never commit the 20-30 MB tarballs, and update the checksum table only after comparing with Maven Central when React Native changes.

The native summary must report `hermesCacheReused=true`, `hermesCacheRetained=true`, and `hermesChecksumsVerified=true` on a warm-cache verification run. A cold first run may report `hermesCacheReused=false` while it downloads and retains the current artifacts, but checksum verification must still be true.

This proves native compilation and launch, including ExpoIap linkage. It does not prove StoreKit sandbox purchases, microphone behavior on a real iPhone, background recording continuity, ASR quality, or TestFlight distribution.

## Simulator Preview Preconditions

Before using `npm run mobile:ios`, run:

```bash
npm run mobile:ios:prereqs
```

This command is intentionally read-only. It does not install CocoaPods, does not run `expo prebuild`, and does not create `apps/mobile/ios`.

Interpretation:

- `canUseExpoGoPreview=true`: run `npm run mobile:ios` and capture simulator screenshots.
- `expoGoInstalled=false`: `npm run mobile:ios` may stop at `Fetching Expo Go`; install/open Expo Go in the booted simulator first.
- `cocoaPodsAvailable=false`: do not switch to `expo run:ios` yet; native local builds need CocoaPods.
- `nativeIosDirectoryPresent=true`: remove the generated directory unless the project intentionally leaves Expo managed workflow.
- `backendPreviewOk=false`: start `npm run build && npm run preview:screen` before recording tests.

When the backend, Metro, booted simulator, and Expo Go are already running, capture a repeatable simulator screenshot with:

```bash
npm run smoke:ios-simulator-ui
```

This opens `exp://127.0.0.1:8081` in the booted simulator and writes:

```text
.data/screenshots/ownminutes-ios-simulator-latest.png
```

The screenshot smoke verifies that the simulator opens the current OwnMinutes Expo bundle and that the screenshot is a valid PNG. It does not replace human visual review or real iPhone/TestFlight recording tests. Expo Go development overlays can appear in the screenshot.

## Required Backend

For simulator or local device testing, start the backend preview:

```bash
npm run build
npm run preview:screen
npm run smoke:app
npm run smoke:release
```

Build 11 TestFlight/App Store packages use the public HTTPS API origin embedded at archive time. The production UI must not expose an API URL field, a development connection shortcut, or any way for a signed-in or signed-out user to change that origin. Verify the embedded origin against the signed candidate summary and `docs/public-deployment-runbook.md`; do not ask a tester to type a server address.

Local simulator and development-signed device runs may still choose a development origin at build time. That is a developer-only launch configuration, not an in-app setting:

```bash
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3003 npm run mobile:ios
EXPO_PUBLIC_API_BASE_URL=http://192.168.x.x:3003 npm run mobile:ios:device:build
```

These development builds cannot satisfy TestFlight acceptance. A candidate archive must embed a verified public HTTPS origin and must fail preflight if it embeds localhost, a LAN address, public HTTP, an empty value, or an invalid URL.

## Preflight

1. Install candidate Build 11 from TestFlight. Expo Go or a development-signed build can supply preflight evidence only and cannot pass the real-device scenarios.
2. Open the app.
3. On a clean install, confirm the first screen is the branded account screen and defaults to `登录`.
4. Switch to `注册`; confirm name, email, password, password visibility, privacy consent, privacy policy, terms, and submit action fit without overlap.
5. Confirm exactly three bottom tabs are visible: `记录`, `会议`, `我的`. `设置与偏好` is a secondary page under `我的`; it is not a fourth bottom tab. No connection/API URL control is visible before or after login.
6. Sign in or register a test account; confirm success enters `记录` automatically.
7. Relaunch with a valid saved session; confirm the launch state finishes and enters `记录` without showing the login screen.
8. Log out; confirm the app returns to the account screen.
9. Confirm the signed-candidate receipt and server deployment record name the same embedded public HTTPS API origin. The app has no editable API URL field and no development connection entry in this TestFlight build.
10. Under `我的`, open `设置与偏好`. Confirm `会议处理方式` exposes `官方额度` and, only after the user's own ASR and summary credentials pass health checks, `使用自己的模型 (BYOK)`.
11. Confirm provider keys are not shown as raw secrets in the app UI, logs, exported account data, or evidence.
12. Open `会议` and confirm the `本机录音` recovery entry is visible even when its count is zero. Opening it must never require the server.
13. Read the microphone notice and confirm the user consent copy is visible before recording.
14. Start a short test and confirm `录制稳定性检查` shows `设备存储空间` with a real remaining-space value. A known value below 512 MiB must block a new recording; a value below 1 GiB must warn about long-meeting storage; a probe failure may continue only with a visible warning and ongoing file-growth monitoring.

## Test Matrix

| Scenario | Duration | Required Actions |
| --- | ---: | --- |
| Simulator smoke | 1-3 minutes | Login, check backend, switch all tabs, verify UI layout and navigation. |
| Real iPhone short meeting | 5 minutes | Grant microphone permission, record, stop, upload, finalize, open meeting detail. |
| Real iPhone normal meeting | 30 minutes | Record intermittently, pause/resume once, stop, confirm local audio and finalize. |
| Real iPhone long meeting | 90 minutes | Keep recording active, speak every 5-10 minutes, confirm no crash and no memory runaway. |
| Weak Wi-Fi | 30 minutes | Record continuously for 30 minutes. During the middle 10 minutes alternate weak Wi-Fi, airplane mode, and recovery without stopping the meeting. Confirm the local file keeps growing, force-quit/relaunch recovery is available, upload resumes, finalization completes, and the final audio plays and exports. |
| Offline recovery | 10 minutes | Start recording, disconnect network for 60 seconds, stop, reconnect, retry upload. |
| Offline cold start | 5 minutes | Sign in online once, terminate the app, make the same API origin unreachable, relaunch, confirm `离线记录模式` and an enabled record action; restore the service and confirm automatic session revalidation removes the banner within 30-60 seconds. |
| Force-quit recording recovery | 5 minutes | Record for at least 30 seconds, force-quit without tapping stop, relaunch, open the always-visible `本机录音` recovery entry, confirm the recording is isolated from automatic upload, run recovery validation, then play, export, upload, and finalize it. |
| Background and lock screen | 10 minutes | Lock the phone and briefly switch apps, return, confirm the formal recording continued, timer recovered, local audio is playable, and `后台录音` transition count is visible. |
| Headset interruption | 5 minutes | Start with headset, disconnect if available, confirm warning and recoverable state. |
| Share and Markdown | 1 meeting | Publish share, open share page, copy/download Markdown, import into Obsidian or Files. |
| Account deletion | 1 account | Delete test account, confirm session, meetings, provider summaries, and shares are gone. |
| Build 10 to 11 in-place upgrade | Build 10 to Build 11 | Start logged in on Build 10 with existing recordings, update inside TestFlight without uninstalling or clearing data, then confirm the session and local data survive on Build 11. |
| Legacy local audio recovery | 5 legacy indexes | Before the update, record exactly 5 stale/local recording index entries. On Build 11 the `本机录音` entry must remain visible before, during, and after the scan. Reconnect each entry to its preserved source file, play and export each of the five, and confirm the inaccessible warning clears without deleting an index or source file. |
| Meeting audio detail navigation | 40 detail cycles | Open and return from an available-audio detail 20 times and an unavailable-audio detail 20 times; exercise playback controls where available and confirm no ErrorBoundary or navigation lock. |
| Meeting deletion consistency | 2 meetings | Delete one meeting normally. For the second, let the delete request reach the server and then drop the response. The UI must show `正在确认删除状态`, not false success/failure; refresh/retry must reconcile server truth, remain idempotent, and keep the deleted meeting absent after relaunch. |
| Three consecutive meetings | 3 x 5 minutes | Record, stop, finalize, play, and verify history for three separate 5-minute meetings without reinstalling, signing out, or force-quitting between meetings. |
| Login session continuity | upgrade plus 2 relaunches | Begin logged in on Build 10, update to Build 11, force-quit and relaunch twice, and confirm the session and local recordings remain available without an unexpected login prompt. |
| Official and BYOK route billing | 2 x 1-5 minutes | Complete one official-quota meeting and one BYOK meeting. The selected route is snapshotted when each meeting starts and cannot change until that meeting ends. Match both meeting IDs to provider/cost ledger records and reconcile the official-minute balance; no mock or simulated billing may be used. |
| Apple Sandbox billing reconciliation | 1 purchase + restore | In the TestFlight build, purchase one real Sandbox Plus or Pro subscription, then run Restore Purchases. Record only a redacted transaction fingerprint, never a receipt or raw transaction ID. Confirm StoreKit, App Store Server verification, server entitlement, quota, and restored state all refer to the same product/account transaction and simulated billing is disabled. |

## P0 Build 10 To 11 Real-Device Procedure

Use the same physical iPhone and test account for this sequence. Do not uninstall OwnMinutes, clear app data, delete the five legacy indexes, or sign out between the Build 10 baseline and Build 11 verification.

1. On TestFlight Build 10, confirm the account is logged in and record the five legacy index identifiers, their source-file presence, duration, and current accessibility state. Capture the official-minute balance and the current meeting-history count.
2. Install Build 11 with TestFlight's `Update` action. Do not remove Build 10 first. Record `Previous build: 10`, `Candidate build: 11`, and `In-place update without uninstall: pass` only after the update completes on the same app container.
3. Launch Build 11. Confirm the saved session restores, the history count does not shrink, exactly three bottom tabs appear, and no connection/API URL control is exposed. Open `会议 > 本机录音`; this recovery entry must be visible even before scanning and when its count reaches zero. Confirm all five legacy source files still exist. Run reconnect/recovery for every legacy index; record five reconnected, five playable, and five exportable items. The inaccessible count must become zero and the warning must clear.
4. Choose one meeting with playable audio and one meeting whose audio is intentionally unavailable. Enter each detail and return to the meeting list 20 times. The unavailable case must show a recoverable in-page state, not the global `应用暂时无法打开` ErrorBoundary. Confirm every return succeeds and playback controls produce zero errors.
5. Delete one disposable meeting on a normal network. Then create another disposable meeting, let its delete request reach the server, and interrupt the response. Before truth is known the app must show `正在确认删除状态`; it must not claim `会议删除失败` or remove the local original merely because the response was lost. Refresh/retry, compare the final list/API truth, and confirm an already absent record is treated idempotently. Relaunch and confirm both meetings remain absent.
6. Without reinstalling or signing out, complete three consecutive five-minute meetings. Each meeting needs a unique meeting ID, a playable local recording, a finalized server record, and a visible history entry. Confirm data, timers, upload state, transcript, and controls do not leak from one meeting to the next.
7. Start a recording, force-quit after at least 30 seconds, and relaunch. The `本机录音` entry must still be visible; the interrupted item must not upload before recovery validation. Recover it, confirm its duration, play and export it, then complete upload/finalization. Force-quit and relaunch once more. Confirm the same account remains authenticated and all local recordings remain available.
8. Select official quota, note the meeting ID, and start a 1-5 minute meeting. While recording, attempt to change the processing mode; the UI/API must keep the meeting's frozen `official_quota` route. Record the actual provider route and cost-ledger event, processed minutes, official balance before/after, and charged minutes. The ledger meeting ID must match; the charged amount must equal both processed whole minutes and the balance delta.
9. Select BYOK, note the new meeting ID, and start another 1-5 minute meeting. While recording, attempt to change the processing mode; the frozen route must stay `byok`. Verify a provider request used the user's configured provider without exposing its key, the cost ledger is tied to the same meeting ID, the official balance is unchanged, and charged official minutes equal zero. `OWNMINUTES_ENABLE_SIMULATED_BILLING` and IAP mocks must be disabled for this evidence.
10. In TestFlight Sandbox, buy one Plus or Pro subscription and run Restore Purchases. Store the real receipt only in Apple's/your private billing system; the evidence file may contain a SHA-256 transaction fingerprint but no raw receipt or raw transaction ID. Reconcile the StoreKit product, App Store Server verification, app account binding, server entitlement/quota, and restored state. A source smoke, locally forged transaction, or screenshot cannot pass this gate.

Do not mark a P0 scenario `pass` from source inspection, an automated source smoke, a simulator, a mocked billing response, or a screenshot alone. The billing scenario requires server-side route/billing evidence matched to both real meeting IDs; the update scenario requires TestFlight's in-place update on the same physical app container.

## Acceptance Metrics

The iOS build can move toward TestFlight beta only if all of these are true:

- App installs and launches without crashing.
- Clean install opens the account screen; a valid restored session opens the recorder after restoration completes.
- A saved session with a fresh same-origin 24-hour offline snapshot opens the recorder while the API is temporarily unreachable; expired, malformed, or cross-origin snapshots do not.
- Network/5xx failures preserve the local session and recording files; authoritative 401/403 responses clear the session and offline snapshot.
- Registration requires explicit privacy-policy and terms consent.
- Login/register success enters the recorder; logout/delete returns to the account screen.
- Tapping record while signed out routes to login instead of leaving a hidden error below the fold.
- Login/register works against the public HTTPS API origin embedded in the candidate archive.
- The signed candidate, upload receipt, and deployed server name the same embedded API origin; no TestFlight user can edit it.
- The login screen and `我的 > 设置与偏好` expose no API URL or development connection control.
- External TestFlight testing has public HTTPS app, privacy, terms, support, and health-check URLs configured before build.
- The public HTTPS deployment health and release-readiness probes pass before the candidate is distributed; the production app does not expose those operator diagnostics to users.
- Microphone permission prompt appears with the expected iOS copy.
- Every recording performs a bounded free-space preflight. Known free space below 512 MiB blocks start; free space below 1 GiB is visible as a warning. The 512 MiB start budget must cover a 120-minute 16kHz mono 16-bit PCM recording plus the 128 MiB emergency reserve.
- Active recording rechecks free space every 15 seconds. Below 128 MiB it performs one orderly stop, keeps the local audio, and writes the recovery index before claiming success.
- At 110 minutes of meeting-session wall time, including paused time, the app displays the remaining time and explains the automatic limit. At 120 session minutes, it performs one orderly stop, writes the recovery index before claiming success, and lets the user start a new meeting instead of creating an upload that exceeds the supported PCM budget.
- A native recorder completion or encoding error cannot leave the app stuck in `recording`; it transitions through one stop path, preserves the local file when possible, and reports an unverified recovery state when the index cannot be confirmed.
- Exactly three bottom tabs, `记录 / 会议 / 我的`, remain usable. `设置与偏好` remains reachable only as a secondary page under `我的`.
- `会议 > 本机录音` is always visible, including when there are zero local items or the server is unavailable.
- Local recording survives stop and can be retried or exported.
- Local recording can be played back after stop.
- A recording interrupted by process termination remains marked as active and is never auto-uploaded before two stable size probes, native-player load, and a valid recovered duration all pass.
- Relaunch presents `检查并恢复` as the primary action for an interrupted recording; successful validation restores the authoritative duration and failed validation keeps the original file.
- Keep Awake is active during recording and released after stop/failure.
- App background/inactive transitions are surfaced in the stability panel as `后台录音`; Expo prebuild must contain `UIBackgroundModes: audio`, but only real-device playback can prove that no audio was lost.
- 5/30/90 minute runs record whether the app crashed, whether memory/battery looked abnormal, and whether the recording stayed recoverable.
- PCM input, realtime chunk buffer, and realtime upload indicators update during recording.
- A 30-minute weak-network recording keeps the local file growing through the interruption, remains recoverable after force quit, resumes upload, finalizes, plays, and exports after reconnection.
- Meeting detail appears after finalize.
- Real-time transcript is treated as a draft, and meeting notes remain clearly tied to post-meeting processing.
- Share link and Obsidian Markdown are generated.
- Public share does not expose transcript or audio by default.
- Account deletion removes the test account data and invalidates session.
- Build 11 is installed over Build 10 through TestFlight without uninstalling, and the saved session, history, local indexes, and source files remain intact.
- Exactly five pre-existing legacy recording indexes reconnect to their preserved source files; five are playable, five are exportable, zero remain inaccessible, and the stale warning clears while the recovery entry remains visible.
- Available-audio and unavailable-audio meeting details each survive 20 enter/return cycles with zero ErrorBoundary appearances, stuck navigation states, or playback-control errors.
- Normal-network and lost-response meeting deletion show a pending-confirmation state until server truth is known; they never produce a false failure/success, retry is idempotent, and deleted meetings remain absent after relaunch.
- Three consecutive five-minute meetings produce three unique IDs, three playable local recordings, three finalized meetings, and three history entries without cross-meeting state leakage.
- The authenticated session survives the in-place update plus two force-quit/relaunch cycles without an unexpected login prompt, and local recordings remain available.
- The processing route is frozen per meeting at start. The official-quota meeting stays on `official_quota` and deducts exactly its processed minutes; the BYOK meeting stays on `byok`, reaches the configured provider, and deducts zero official minutes. Both meeting IDs reconcile to server provider/cost-ledger records with simulation disabled.
- One real TestFlight Sandbox Plus or Pro transaction and restore reconcile across StoreKit, App Store Server verification, account binding, server entitlement/quota, and restored state. Evidence stores only a redacted transaction fingerprint, never a raw receipt or transaction ID.
- No raw API key, Apple private key, token, cookie, or customer audio is committed to Git.

## Failure Criteria

Any of these blocks TestFlight beta:

- App crash during 5, 30, or 90 minute recording.
- Microphone permission cannot be requested or recovered.
- Recording stops silently without visible warning.
- A recording starts with known free space below 512 MiB, or continues below the 128 MiB emergency threshold without attempting an orderly stop.
- The app claims a low-storage recording was preserved before its local recovery index was written.
- A recording session reaches 120 wall-clock minutes without attempting an orderly stop, or claims the duration-limited recording was preserved before its local recovery index exists.
- A native completion/error leaves the UI in `recording`, triggers duplicate stop paths, or reports success without a confirmed local recovery index.
- Local audio URI is missing after stop.
- Pending upload is lost after app restart.
- A process-terminated recording is auto-uploaded before validation, cannot be played after recovery, loses its original file, or is presented as a normal new-meeting state.
- The TestFlight binary exposes an editable API URL/development connection control, embeds a non-public/non-HTTPS origin, or disagrees with the upload/deployment receipts.
- External TestFlight uses localhost, 127.0.0.1, LAN IP, public HTTP, or a manually entered service origin instead of the archive's verified public HTTPS origin.
- Finalize starts before upload state reaches a stable terminal state.
- Share link exposes transcript or audio without explicit publish setting.
- Delete account leaves meetings or shares accessible.
- Build 11 requires uninstall/reinstall, loses the Build 10 login session, shrinks history, or loses any local recording index/source file.
- The `本机录音` entry disappears, or any of the five legacy indexes cannot reconnect, play, or export; any legacy source file is deleted; the inaccessible count is non-zero; or the stale warning remains after successful recovery.
- Any available/unavailable audio-detail cycle opens the global ErrorBoundary, cannot return, locks navigation, or produces a playback-control error.
- A lost delete response is shown as success/failure before truth is reconciled, the local original is removed before confirmed server truth, retry is not idempotent, or the meeting reappears after relaunch.
- Any of the three consecutive five-minute meetings lacks a unique ID, playable local recording, finalized record, or history entry, or carries state from another meeting.
- The saved login session does not survive the in-place update and two force-quit/relaunch cycles, or local recordings disappear during those checks.
- A meeting's processing route changes after start, differs from the selected official/BYOK route, the official balance delta does not equal processed/charged minutes, BYOK deducts official minutes, simulation is enabled, or no matching meeting-level server billing/provider evidence exists.
- A claimed Apple billing pass lacks a real TestFlight Sandbox transaction, uses a simulated/mock transaction, cannot reconcile purchase and restore to the same StoreKit/App Store Server/server-entitlement state, or places a raw receipt/transaction ID in evidence.
- Provider credential raw secret appears in UI, logs, Markdown, or exported account data.

## Evidence Template

Keep evidence in a private QA note or issue. Do not commit real meeting audio or transcripts.

For repeatable local checks, copy the completed evidence into:

```text
.data/acceptance/ios-testflight-latest.md
```

The `.data` directory is ignored by Git. Do not commit this private evidence file, real meeting audio, raw transcripts, account cookies, API keys, Apple keys, provider tokens, or customer data.

To create the private evidence file structure before QA, run:

```bash
npm run ios:testflight:evidence:draft
```

This writes `.data/acceptance/ios-testflight-latest.md` with every required scenario and field set to `pending`. The draft is intentionally incomplete: `npm run ios:testflight:evidence` must fail until every scenario is replaced with real simulator, iPhone, or TestFlight evidence and each block ends with `Decision: pass`.

Fill one evidence block per scenario in the test matrix. The checker requires every scenario block to include its own `Scenario:`, expected `Duration:`, upload/finalize/share/Markdown/delete fields, and `Decision: pass`. A field appearing in one scenario does not satisfy another scenario. Any `Decision: fail` blocks the evidence file.
It also requires each scenario to record install source, app launch result, signed embedded API-origin verification, microphone permission, crash status, memory/battery observation, audio playback, and the transcript/summary boundary. The top-level `API Base URL` value comes from the signed candidate/upload receipt; it is not typed into the app.

Build 11 P0 regression scenarios also have scenario-specific machine-checked fields shown below. Counts, route immutability, deletion truth, transaction fingerprint format, and billing arithmetic are validated by the checker; `pending`, narrative-only evidence, a source smoke, simulator evidence, or a locally forged receipt cannot pass them.

After filling the evidence, run:

```bash
OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH=.data/acceptance/ios-testflight-latest.md npm run ios:testflight:evidence
```

```text
Date:
Tester:
Device:
iOS version:
Build source: App Store Connect/Local Xcode Release
Build version:
Distribution: TestFlight/Simulator
API Base URL: <copy from signed candidate receipt; do not type into the app>
Scenario:
Duration:
Network:
Account:
Meeting ID:
Install source:
App launch: pass/fail
Embedded production API origin: pass/fail
Microphone permission: pass/fail
Storage preflight: pass/fail
Free storage observed:
PCM buffers:
Realtime chunks:
Realtime uploaded:
Foreground/background interruptions:
Last interruption time:
Crash observed: no/yes
Memory/battery observation:
Upload pending after stop:
Upload failed:
Audio playback: pass/fail
Local audio retry/export: pass/fail
Finalize: pass/fail
Transcript/summary boundary: pass/fail
Share link: pass/fail
Markdown export: pass/fail
Delete cleanup: pass/fail
Known issues:
Decision: pass/fail
```

Append the matching fields to each P0 scenario block exactly as written:

```text
# Weak Wi-Fi
Weak-network wall time minutes: 30
Local file growth during outage: pass
Upload resumed after reconnect: pass
Finalized after reconnect: pass
Reconnected audio playback: pass
Reconnected audio export: pass

# Force-quit recording recovery
Force quit while recording: pass
Local recovery entry visible after relaunch: pass
Automatic upload before recovery validation: no
Recovered audio playback: pass
Recovered audio export: pass
Recovered meeting finalized: pass

# Build 10 to 11 in-place upgrade
Previous build: 10
Candidate build: 11
In-place update without uninstall: pass
Existing local data preserved: pass
Bottom navigation tab count: 3
Development connection control visible: no

# Legacy local audio recovery
Legacy index entries before update: 5
Legacy index entries reconnected: 5
Legacy playable entries: 5
Legacy exportable entries: 5
Legacy inaccessible index entries after update: 0
Local recovery entry always visible: pass
Legacy unavailable warning cleared: pass
Legacy audio playback: pass
Legacy audio export: pass
Legacy source files preserved: pass

# Meeting audio detail navigation
Available audio detail cycles: 20
Unavailable audio detail cycles: 20
Available audio return: pass
Unavailable audio return: pass
Error boundary shown: no
Playback control errors: 0

# Meeting deletion consistency
Normal delete UI result: pass
Normal delete final state: absent
Weak-network delete UI result: pass
Weak-network delete final state: absent
Lost delete response induced: pass
Pending confirmation shown before truth: pass
Server truth reconciled: pass
Local audio removed before truth: no
Delete false-failure message observed: no
Delete retry idempotent: pass
Deleted meeting visible after relaunch: no

# Three consecutive meetings
Consecutive meeting count: 3
Unique meeting IDs: 3
Playable local recordings: 3
Finalized meetings: 3
All three history entries visible: pass
Cross-meeting state leakage: no

# Login session continuity
Logged in before update: pass
Session restored after update: pass
Session restored after force quit: pass
Unexpected login prompt: no
Local recordings retained after session checks: pass

# Official and BYOK route billing
Official expected route: official_quota
Official actual route: official_quota
Official route immutable during meeting: pass
Official meeting ID matched ledger: pass
Official processed minutes: <number greater than 0>
Official minutes before: <number>
Official minutes after: <number>
Official charged minutes: <same number as processed and before minus after>
Official billing event verified: pass
BYOK expected route: byok
BYOK actual route: byok
BYOK route immutable during meeting: pass
BYOK meeting ID matched ledger: pass
BYOK official minutes before: <number>
BYOK official minutes after: <same number as before>
BYOK charged official minutes: 0
BYOK provider request verified: pass
BYOK billing event verified: pass
Simulated billing used: no

# Apple Sandbox billing reconciliation
StoreKit environment: Sandbox
Product ID: ownminutes.plus.monthly or ownminutes.pro.monthly
Transaction fingerprint: sha256:<64 lowercase hex characters>
Raw receipt stored in evidence: no
App Store Server transaction verified: pass
App account binding matched: pass
Server entitlement matched: pass
Official quota matched entitlement: pass
Restore purchases matched entitlement: pass
Simulated billing used: no
```

## Commands

Run these commands after any change to the mobile app, backend recording APIs, release readiness, TestFlight config, or storage:

```bash
npm run mobile:ios:prereqs
npm run smoke:testflight-config
npm run smoke:ios-device-acceptance-script
npm run mobile:typecheck
npm run smoke:mobile-ui
npm run smoke:ios-simulator-ui
npm run smoke:mobile-stability
npm run smoke:mobile-recording-storage
npm run smoke:mobile-realtime
npm run smoke:testflight-preflight
npm run smoke:app
npm run smoke:release
npm run smoke:ios-testflight-runbook
npm run smoke:ios-testflight-evidence
npm run ios:testflight:evidence:draft
git diff --check
```

After real iPhone or TestFlight QA, also run:

```bash
OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH=.data/acceptance/ios-testflight-latest.md npm run ios:testflight:evidence
```

## Rollback

If a build fails iOS recording acceptance:

1. Stop promoting that build in TestFlight.
2. Record the failed scenario and build version.
3. Revert only the related mobile or backend change.
4. Rebuild with EAS.
5. Rerun the 5 minute real iPhone short meeting scenario and every P0 scenario affected by the change.
6. Any P0 failure blocks promotion. Do not resume long-meeting or external tester rollout until the short scenario and all affected P0 scenarios pass with new real-device evidence.

## Production Exit

This runbook is complete only when there is evidence for:

- one simulator smoke
- one 5 minute real iPhone recording
- one 30 minute real iPhone recording
- one 90 minute real iPhone recording
- one 30-minute weak-network recording that remains recoverable, resumes upload, finalizes, plays, and exports
- one offline recovery
- one offline cold-start recovery
- one force-quit-during-recording recovery through the always-visible local recovery entry
- one background and lock-screen risk check
- one headset interruption check where possible
- one share and Markdown export
- one account deletion cleanup
- one Build 10 to Build 11 in-place TestFlight update without uninstalling or clearing data
- an always-visible `会议 > 本机录音` entry, with all five legacy indexes reconnected, playable, exportable, and zero still inaccessible
- 20 available-audio plus 20 unavailable-audio detail enter/return cycles without ErrorBoundary
- one normal-network and one lost-response meeting deletion with pending-confirmation UI, reconciled server truth, and idempotent retry
- three consecutive five-minute meetings with independent playable/finalized/history state
- one login-session continuity check across the update and two force-quit/relaunch cycles
- one official-quota and one BYOK real meeting with immutable per-meeting routes, matching provider/cost-ledger evidence, verified official-minute arithmetic, and simulation disabled
- one real TestFlight Sandbox Plus or Pro purchase plus restore reconciled across StoreKit, App Store Server verification, server entitlement/quota, and a redacted transaction fingerprint
- one passing private evidence check with `npm run ios:testflight:evidence`

Before public App Store release, repeat the same matrix against the public HTTPS backend, production database, production object storage, production KMS or secret store, real ASR provider credentials, and Apple IAP sandbox purchase flow.
