#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const source = readFileSync("apps/mobile/App.tsx", "utf8");
const configSource = readFileSync("apps/mobile/src/config.ts", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const recordingStoreSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const postMeetingSource = readFileSync("apps/mobile/src/post-meeting-presentation.ts", "utf8");
const exportFileSource = readFileSync("apps/mobile/src/export-file-name.ts", "utf8");
const meetingHistorySource = readFileSync("apps/mobile/src/meeting-history.ts", "utf8");
const firstRunSource = readFileSync("apps/mobile/src/first-run.ts", "utf8");
const meetingCostSource = readFileSync("apps/mobile/src/meeting-cost.ts", "utf8");
const appErrorBoundarySource = readFileSync("apps/mobile/src/app-error-boundary.tsx", "utf8");
const componentsSource = readFileSync("apps/mobile/src/components.tsx", "utf8");
const mobileIndexSource = readFileSync("apps/mobile/index.ts", "utf8");
const passwordRouteSource = readFileSync("src/app/api/auth/password/route.ts", "utf8");
const obsidianVaultSmokeSource = readFileSync("scripts/smoke-obsidian-vault-export.mjs", "utf8");
const ciSource = readFileSync(".github/workflows/ci.yml", "utf8");
const iapSource = readFileSync("apps/mobile/src/IapPlanStore.tsx", "utf8");
const appConfig = JSON.parse(readFileSync("apps/mobile/app.json", "utf8"));
const readme = readFileSync("apps/mobile/README.md", "utf8");
const mobilePackage = JSON.parse(readFileSync("apps/mobile/package.json", "utf8"));
const bundledNativeModules = JSON.parse(readFileSync("apps/mobile/node_modules/expo/bundledNativeModules.json", "utf8"));
const recordStart = source.indexOf('{activeTab === "record" ? (');
const recordEnd = source.indexOf('{activeTab === "meetings" ? (');
const recordSurface = source.slice(recordStart, recordEnd);
const meetingDetailSurfaceStart = source.indexOf("{selectedMeeting ? (");
const meetingDetailSurfaceEnd = source.indexOf('{activeTab === "settings" ? (', meetingDetailSurfaceStart);
const meetingDetailSurface = source.slice(meetingDetailSurfaceStart, meetingDetailSurfaceEnd);
const startRecordingStart = source.indexOf("async function startRecording()");
const startRecordingEnd = source.indexOf("async function doStartRecording(");
const startRecordingFlow = source.slice(startRecordingStart, startRecordingEnd);
const doStartRecordingStart = source.indexOf("async function doStartRecording(");
const doStartRecordingEnd = source.indexOf("async function pauseRecording()");
const doStartRecordingFlow = source.slice(doStartRecordingStart, doStartRecordingEnd);
const canResetMeetingStart = source.indexOf("const canResetMeeting =");
const canResetMeetingEnd = source.indexOf("const providerSetupState", canResetMeetingStart);
const canResetMeetingFlow = source.slice(canResetMeetingStart, canResetMeetingEnd);
const resetMeetingStart = source.indexOf("async function resetMeeting()");
const resetMeetingEnd = source.indexOf("async function handleMediaServicesReset()", resetMeetingStart);
const resetMeetingFlow = source.slice(resetMeetingStart, resetMeetingEnd);
const openMeetingDetailStart = source.indexOf("async function openMeetingDetail(");
const openMeetingDetailEnd = source.indexOf("function closeMeetingDetail()");
const openMeetingDetailFlow = source.slice(openMeetingDetailStart, openMeetingDetailEnd);
const launchScreenStart = source.indexOf("function AppLaunchScreen()");
const launchScreenEnd = source.indexOf("function PasswordResetModal(");
const launchScreen = source.slice(launchScreenStart, launchScreenEnd);
const emailVerificationStart = source.indexOf("function EmailVerificationModal(");
const emailVerificationEnd = source.indexOf("function AppLaunchScreen()", emailVerificationStart);
const emailVerificationSurface = source.slice(emailVerificationStart, emailVerificationEnd);
const quickTabsStart = source.lastIndexOf("{showPrimaryNavigation ? (");
const quickTabsEnd = source.indexOf("</SafeAreaView>", quickTabsStart);
const quickTabsSurface = source.slice(quickTabsStart, quickTabsEnd);
const localRecoveryLibraryStart = source.indexOf("{showDeviceLegacyRecovery ? (");
const localRecoveryLibraryEnd = source.indexOf("{showHistoryControls ? <>", localRecoveryLibraryStart);
const localRecoveryLibrary = source.slice(localRecoveryLibraryStart, localRecoveryLibraryEnd);

const uiFixtureServerMeetings = [{ meetingId: "server-meeting" }];
const uiFixtureLocalRecordings = [
  { meetingId: "server-meeting" },
  ...Array.from({ length: 5 }, (_, index) => ({ meetingId: `local-recovery-${index + 1}` })),
];
const uiFixtureServerIds = new Set(uiFixtureServerMeetings.map((meeting) => meeting.meetingId));
const uiFixtureStandaloneLocalRecordings = uiFixtureLocalRecordings.filter(
  (recording) => !uiFixtureServerIds.has(recording.meetingId),
);

const checks = {
  alwaysShowsDeduplicatedLocalRecoveryLibrary:
    uiFixtureServerMeetings.length === 1 &&
    uiFixtureStandaloneLocalRecordings.length === 5 &&
    source.includes("const showStandaloneLocalRecordings = standaloneLocalRecordings.length > 0") &&
    !source.includes('standaloneLocalRecordings.length > 0 && (networkStatus !== "online" || meetings.length === 0)') &&
    source.includes("const showDeviceLegacyRecovery = true") &&
    !source.includes("const showDeviceLegacyRecovery = deviceLegacyRecoveryRecordings.length > 0") &&
    localRecoveryLibrary.includes('t("runtime.localRecoveryHubTitle", { count: deviceLegacyRecoveryRecordings.length })') &&
    localRecoveryLibrary.includes("deviceLegacyRecoveryRecordings.map((recording)") &&
    localRecoveryLibrary.includes("standaloneLocalRecordings.map((recording)") &&
    source.includes("selectDeviceLegacyRecoveryRecordings(pendingRecordings)") &&
    source.includes("!serverMeetingIds.has(recording.meetingId)") &&
    source.includes("recording.activeRecording !== true ||") &&
    i18nSource.match(/localRecoveryHubTitle:/g)?.length === 3,
  freezesProcessingModePerRecording:
    source.includes("const frozenProcessingMode = selectedProcessingMode") &&
    source.includes("processingMode: frozenProcessingMode") &&
    source.includes(".filter(hasFrozenProcessingMode)") &&
    source.includes('t("processingMode.legacyTitle")') &&
    source.includes("await retryUpload(resolved)") &&
    apiSource.includes('"x-ownminutes-processing-mode": params.processingMode') &&
    apiSource.includes("processingMode: params.processingMode") &&
    source.includes("selectedMeetingLocalRecording?.processingMode ??") &&
    source.includes("meetingResultProcessingMode(selectedMeeting.result)") &&
    recordingStoreSource.includes("processingMode?: UserProcessingMode") &&
    i18nSource.match(/legacyRequired:/g)?.length === 3,
  hasThreePrimaryTabs:
    source.includes('type MobileTab = "record" | "meetings" | "settings" | "account"') &&
    ["record", "meetings", "account"].every((tab) => quickTabsSurface.includes(`label={t("nav.${tab}")}`)) &&
    !quickTabsSurface.includes('label={t("nav.settings")}') &&
    quickTabsSurface.includes('active={activeTab === "account" || activeTab === "settings"}'),
  hasAccountFirstRunFlow:
    source.includes('useState<MobileTab>("account")') &&
    source.includes("sessionRestoreComplete") &&
    source.includes("sessionRestoreStartedRef") &&
    source.includes("if (!i18nReady || !apiBaseUrlRestored || sessionRestoreStartedRef.current) return") &&
    source.includes("[apiBaseUrlRestored, i18nReady, restoreSession]") &&
    source.includes("if (!i18nReady || !apiBaseUrlRestored || !sessionRestoreComplete)") &&
    source.includes("<AppLaunchScreen />") &&
    source.includes('setActiveTab("record")') &&
    startRecordingFlow.includes("setAuthMessage(") &&
    startRecordingFlow.includes('setActiveTab("account")') &&
    source.includes('? t("record.signInToRecord")') &&
    source.includes("styles.authSubmit") &&
    source.includes("switchAuthMode") &&
    source.includes("authAcceptedTerms") &&
    source.includes("authPasswordVisible") &&
    source.includes('Alert.alert(t("auth.registrationAlertTitle"), t("auth.registrationAlertBody"))') &&
    apiSource.includes("readMobileJsonResponse<AuthResponse>") &&
    apiSource.includes("mobileRegistrationUnavailableMessage(mobileApiLanguage)") &&
    i18nSource.includes('registrationUnavailable: "Account registration is temporarily unavailable.') &&
    i18nSource.includes('registrationUnavailable: "账号注册服务暂时不可用') &&
    i18nSource.includes('registrationUnavailable: "帳號註冊服務暫時無法使用'),
  hasSimpleEmailVerificationCodeFlow:
    source.includes("const emailVerificationCodeLength = 6") &&
    source.includes("const emailVerificationResendDurationSeconds = 60") &&
    source.includes("emailVerificationCodeCopy: Record<AppLocale, EmailVerificationCodeCopy>") &&
    source.includes('"zh-Hans": {') &&
    source.includes('"zh-Hant": {') &&
    source.includes("requestAccountEmailVerificationCode") &&
    source.includes("confirmAccountEmailVerificationCode") &&
    source.includes("updateEmailVerificationCode") &&
    source.includes("submitEmailVerificationCode(code)") &&
    source.includes("setEmailVerificationResendSeconds((seconds) => Math.max(0, seconds - 1))") &&
    emailVerificationSurface.includes('keyboardType="number-pad"') &&
    emailVerificationSurface.includes('inputMode="numeric"') &&
    emailVerificationSurface.includes("maxLength={emailVerificationCodeLength}") &&
    emailVerificationSurface.includes('textContentType="oneTimeCode"') &&
    emailVerificationSurface.includes('autoComplete="one-time-code"') &&
    emailVerificationSurface.includes("autoFocus") &&
    emailVerificationSurface.includes("copy.changeEmail") &&
    emailVerificationSurface.includes("copy.resendIn(resendSeconds)") &&
    !emailVerificationSurface.includes("pasteLink") &&
    !emailVerificationSurface.includes("clipboard") &&
    apiSource.includes("/api/auth/email-verification/code/request") &&
    apiSource.includes("/api/auth/email-verification/code/confirm") &&
    apiSource.includes("export async function confirmAccountEmailVerification(apiBaseUrl: string, token: string)") &&
    source.includes("details.status !== 404 || !emailVerificationToken") &&
    source.includes("const password = authPassword;") &&
    !source.includes("const password = authPassword.trim();") &&
    source.includes("const normalizedEmail = authEmail.trim().toLowerCase()") &&
    source.includes("localizedAuthFailure(locale, error, authMode)"),
  usesCurrentAppIconOnLaunchScreen:
    appConfig.expo.icon === "./assets/icon.png" &&
    existsSync("apps/mobile/assets/icon.png") &&
    source.includes('import appIcon from "./assets/icon.png"') &&
    launchScreen.includes("<Image") &&
    launchScreen.includes('source={appIcon}') &&
    launchScreen.includes("styles.launchMark") &&
    !launchScreen.includes("<Ionicons") &&
    source.includes('<Image accessible={false} alt="" resizeMode="cover" source={appIcon} style={styles.authBrandImage} />') &&
    source.includes("authBrandImage:"),
  keepsUnauthenticatedFlowFocused:
    source.includes("const showPrimaryNavigation = Boolean(currentUser)") &&
    source.includes("{showPrimaryNavigation ? (") &&
    source.includes('accessibilityLabel={t("nav.account")}') &&
    source.includes('activeTab === "settings"') &&
    source.includes("CUSTOM_API_BASE_URL_EDITING_ENABLED") &&
    source.includes('t("auth.developmentConnection")') &&
    configSource.includes("CUSTOM_API_BASE_URL_EDITING_ENABLED = __DEV__") &&
    source.includes("styles.contentWithoutNavigation"),
  keepsSmallScreenFormsReachableWithKeyboard:
    source.includes("Platform,") &&
    source.split('automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}').length - 1 >= 3 &&
    source.split('keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}').length - 1 >= 3 &&
    source.split('keyboardShouldPersistTaps="handled"').length - 1 >= 3,
  hasAccessibleAccountAndRecoveryFlows:
    source.includes("const authNameInputRef = useRef<TextInput>(null)") &&
    source.includes("const authEmailInputRef = useRef<TextInput>(null)") &&
    source.includes("const authPasswordInputRef = useRef<TextInput>(null)") &&
    source.includes("authEmailInputRef.current?.focus()") &&
    source.includes("authPasswordInputRef.current?.focus()") &&
    source.includes("confirmPasswordInputRef.current?.focus()") &&
    source.includes('accessibilityLabel={t("auth.name")}') &&
    source.includes('accessibilityLabel={t("auth.email")}') &&
    source.includes('accessibilityLabel={t("auth.password")}') &&
    source.includes('accessibilityLabel={t("passwordReset.newPassword")}') &&
    source.includes('accessibilityLabel={t("passwordReset.confirmPassword")}') &&
    source.includes('`${t("auth.privacyPolicy")} ${t("auth.conjunction")} ${t("auth.terms")}`') &&
    source.includes('accessibilityLiveRegion="polite"') &&
    source.includes("<View accessibilityElementsHidden style={styles.authBrandMark}>") &&
    source.split("<Ionicons accessibilityElementsHidden").length - 1 >= 10 &&
    source.includes('accessibilityRole="tab" accessibilityState={{ selected: active }}'),
  hasAccessibleAuthenticatedWorkspace:
    source.includes('<Text accessibilityRole="header" style={styles.title}>{t("record.title")}</Text>') &&
    source.includes('accessibilityLabel={t("record.transcript")}') &&
    source.includes('accessibilityLabel={t("record.notes")}') &&
    source.includes('accessibilityState={{ disabled: heroActionDisabled }}') &&
    source.includes('accessibilityLabel={t("meetings.refreshHistory")} accessibilityRole="button"') &&
    source.includes('accessibilityLabel="API Base URL"') &&
    source.match(/secureTextEntry=\{false\}/g)?.length >= 5 &&
    source.match(/accessibilityElementsHidden/g)?.length >= 50 &&
    source.includes('accessibilityHint={detail}\n      accessibilityLabel={label}\n      accessibilityRole="button"') &&
    source.includes('accessibilityState={{ disabled }}\n      disabled={disabled}') &&
    [
      'accessibilityLabel="ASR API Key"',
      'accessibilityLabel={t("providerSetup.legacyAppId")}',
      'accessibilityLabel={t("providerSetup.legacyAccessToken")}',
      'accessibilityLabel={t("providerSetup.realtimeWebSocketUrl")}',
      'accessibilityLabel={t("providerSetup.realtimeResourceId")}',
      'accessibilityLabel={t("providerSetup.fileAsrResourceId")}',
      'accessibilityLabel="Endpoint ID"',
      'accessibilityLabel="Ark API Key"',
      'accessibilityLabel="Ark Base URL"',
    ].every((accessibilityLabel) => source.includes(accessibilityLabel)) &&
    componentsSource.includes('<Text accessibilityRole="header" style={styles.panelTitle}>') &&
    componentsSource.includes('<View accessible accessibilityLabel={`${label}：${value}`} style={styles.stat}>') &&
    iapSource.includes('accessibilityLabel={t("iap.restorePurchase")} accessibilityRole="button"') &&
    iapSource.includes('accessibilityState={{ disabled: disabled || !onPress, selected: active }}') &&
    appErrorBoundarySource.includes('accessibilityLabel={translate(locale, "appError.retry")} accessibilityRole="button"'),
  hasMinimumInteractiveTargets:
    source.includes("style={styles.authConsentCheckbox}") &&
    source.includes("style={styles.authLegalLinkButton}") &&
    source.includes("authConsentCheckbox:") &&
    source.includes("authLegalLinkButton:") &&
    source.includes("emailVerificationChangeEmail:") &&
    source.includes("providerInlineLink:") &&
    source.includes("heroMeetingTitleInput:") &&
    iapSource.includes("style={styles.legalLinkButton}") &&
    iapSource.includes("legalLinkButton: { justifyContent: \"center\", minHeight: 44 }"),
  protectsNonSensitiveMeetingEditors:
    source.includes("const nonSensitiveTextInputProps = {") &&
    source.includes('autoComplete: "off"') &&
    source.includes('importantForAutofill: "no"') &&
    source.includes("secureTextEntry: false") &&
    source.includes('textContentType: "none"') &&
    (source.match(/\{\.\.\.nonSensitiveTextInputProps\}/g)?.length ?? 0) >= 13 &&
    ["summaryField", "keyTopics", "risks", "openQuestions", "knowledgePoints", "speakerViews", "decisionLog", "actionItems"].every((key) =>
      source.includes(`accessibilityLabel={t("meetingDetail.${key}")}`),
    ) &&
    source.includes('accessibilityLabel={t("meetingDetail.newSpeakerName", { speaker })}') &&
    source.includes('key={currentUser ? `authenticated-${currentUser.id}` : "unauthenticated"}') &&
    source.includes("authPasswordInputRef.current?.blur()") &&
    source.includes("Keyboard.dismiss()") &&
    source.includes("await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))"),
  hasFocusedRecordSurface:
    recordSurface.includes("styles.recorderHero") &&
    recordSurface.includes("styles.heroPrimaryAction") &&
    recordSurface.includes("styles.heroSecondaryAction") &&
    recordSurface.includes("styles.heroPrimaryActionLabel") &&
    recordSurface.includes("styles.heroSidePlaceholder") &&
    recordSurface.includes("styles.waveformStrip") &&
    recordSurface.includes("styles.timer") &&
    recordSurface.includes("styles.heroLocalStatus") &&
    recordSurface.includes("statusLabel(status, locale)") &&
    recordSurface.includes("heroHint") &&
    recordSurface.includes("styles.heroRecordingError") &&
    !recordSurface.includes("styles.providerWarningCard") &&
    !recordSurface.includes("styles.providerReadyCard") &&
    !recordSurface.includes("styles.meetingBriefCard") &&
    !recordSurface.includes("showHeroStatusGrid") &&
    !recordSurface.includes("MobileFlowHint"),
  keepsRecordingSurfaceSimple:
    recordSurface.includes('{!recordingActive ? <View style={styles.recordSegmentTabs}>') &&
    recordSurface.includes("recordingActive && recordingFileHealthWarning") &&
    !recordSurface.includes('<Stat label="实时分片"') &&
    source.includes("{__DEV__ ? <>") &&
    source.includes('<Stat label="实时分片"'),
  hasHonestLocalRecordingStatus:
    source.includes('const heroLocalStatusLabel = recordingFileHealthWarning') &&
    source.includes('t("record.localReady")') &&
    source.includes('t("record.localConfirming")') &&
    source.includes('t("record.localSaving")') &&
    source.includes('t("record.localPaused")') &&
    source.includes('t("record.localSaved")') &&
    source.includes('t("record.localNeedsCheck")') &&
    recordSurface.includes("heroLocalStatusIcon") &&
    recordSurface.includes("heroLocalStatusLabel") &&
    recordSurface.includes("styles.heroLocalStatusWarning") &&
    !recordSurface.includes("已开启本地保存"),
  hasNativeVisualLanguage:
    source.includes('backgroundColor: "#f7f8f6"') &&
    source.includes('backgroundColor: "#eaf2ed"') &&
    source.includes('backgroundColor: "#ffffff"') &&
    source.includes('backgroundColor: "#d94e45"') &&
    source.includes("fontSize: 64") &&
    source.includes("height: 82") &&
    source.includes("width: 82") &&
    source.includes("styles.heroActionButtons") &&
    source.includes("styles.recordSegmentTabs") &&
    source.includes('borderBottomColor: "#087456"') &&
    source.includes("styles.recordSegmentButtonActive") &&
    source.includes("borderRadius: 999"),
  usesRealIconLibrary:
    source.includes('from "@expo/vector-icons"') &&
    source.includes("<Ionicons") &&
    Boolean(mobilePackage.dependencies?.["@expo/vector-icons"]),
  keepsExpoNativeVersionsAligned:
    mobilePackage.dependencies?.["expo-font"] === bundledNativeModules["expo-font"] &&
    mobilePackage.dependencies?.["expo"]?.startsWith("~56.") &&
    mobilePackage.dependencies?.["expo-constants"]?.startsWith("~56.") &&
    mobilePackage.dependencies?.["expo-sharing"]?.startsWith("~56."),
  keepsPrimaryRecordingActions:
    source.includes('t("record.startRecording")') &&
    source.includes('status === "requesting"') &&
    source.includes('t("record.preparing")') &&
    source.includes('status === "recording" ? t("record.pause") : t("record.resume")') &&
    source.includes('{recordingActive ? t("record.endMeeting") : heroActionLabel}') &&
    source.includes("styles.heroPrimaryActionStop") &&
    !recordSurface.includes("styles.heroRecordOrb"),
  startsEachMeetingFromCleanState:
    canResetMeetingFlow.includes("canShowMeetingProgress") &&
    canResetMeetingFlow.includes('status !== "requesting"') &&
    canResetMeetingFlow.includes('status !== "recording"') &&
    canResetMeetingFlow.includes('status !== "paused"') &&
    canResetMeetingFlow.includes('status !== "processing"') &&
    resetMeetingFlow.includes('status === "requesting" || status === "recording"') &&
    resetMeetingFlow.includes('status === "paused" || status === "processing"') &&
    source.includes('? t("record.newMeeting")') &&
    source.includes("if (canResetMeeting) {") &&
    source.includes("void resetMeeting()") &&
    source.includes('canResetMeeting ? "add" : "mic"') &&
    source.includes("hasInterruptedRecording && canResetMeeting") &&
    source.includes('t("record.interruptedNewMeetingKeepsAudio")') &&
    resetMeetingFlow.includes("setAutoSyncMessage(null)") &&
    resetMeetingFlow.includes("setFinalMeetingResult(null)") &&
    resetMeetingFlow.includes("setFormalMarkdown(null)") &&
    resetMeetingFlow.includes("setSegments([])") &&
    doStartRecordingFlow.includes("setFinalMeetingResult(null)") &&
    doStartRecordingFlow.includes("setFormalMarkdown(null)") &&
    doStartRecordingFlow.includes("setSegments([])"),
  keepsArchivedMeetingsOutOfNewMeeting:
    source.includes('userLocalRecordings.find((recording) => recording.meetingId === meetingId) ?? null') &&
    !source.includes("?? userPendingRecordings[0]") &&
    source.includes("const ownedRecordings = selectAccountLocalRecordings(recordings, userId)") &&
    source.includes("!recording.finalizedAt && !recording.localRecoveryOnly") &&
    source.includes("ownedRecordings.find((recording) => !recording.finalizedAt)"),
  hasRecordOutputs:
    source.includes('type RecordSegment = "transcript" | "notes"') &&
    source.includes('t("record.transcript")') &&
    source.includes('t("record.notes")') &&
    source.includes("activeMeetingResult.summary.summary") &&
    source.includes('t("record.decisions")') &&
    source.includes('t("record.actions")') &&
    source.includes('t("record.copyMarkdown")') &&
    source.includes('t("record.exportObsidian")'),
  hasVisiblePostMeetingProgress:
    source.includes("getPostMeetingPresentation({") &&
    source.includes("}, locale)") &&
    source.includes('setRecordSegment("notes")') &&
    postMeetingSource.includes('locale: AppLocale = "zh-Hans"') &&
    postMeetingSource.includes("const text = copy[locale]") &&
    postMeetingSource.includes("step: 1") &&
    postMeetingSource.includes("step: 2") &&
    postMeetingSource.includes("step: 3") &&
    postMeetingSource.includes("title: text.savingTitle") &&
    postMeetingSource.includes("title: text.uploadingTitle") &&
    postMeetingSource.includes("title: text.summarizingTitle") &&
    postMeetingSource.includes("statusLabel: text.pendingSync") &&
    postMeetingSource.includes("statusLabel: text.pendingGeneration") &&
    postMeetingSource.includes("statusLabel: text.recover") &&
    source.includes('setStatus("complete")') &&
    source.includes('setAutoSyncMessage(t("runtime.localSavedSyncing"))') &&
    source.includes("void (async () => {") &&
    source.includes("syncPendingRecordings({") &&
    source.includes("styles.processingStepTrack"),
  hasReliableShareAndObsidianExport:
    source.includes("Share,") &&
    source.includes("await Share.share({") &&
    !source.includes("Sharing.shareAsync(url") &&
    source.includes("buildMarkdownExportFileName(exportTitle, exportMeetingId)") &&
    source.includes("selectedMeeting?.meetingId ?? meetingId") &&
    source.includes("selectedMeeting?.title ?? meetingTitle") &&
    source.includes('label={t("meetingDetail.exportObsidian")}') &&
    source.includes('setShareMessage(t("meetingDetail.shareReadyMessage", {') &&
    source.includes('t("meetingShare.expiresAt"') &&
    apiSource.includes("expiresAt: params.expiresAt") &&
    source.includes('setShareMessage(t("meetingDetail.shareRevokedMessage"))') &&
    source.includes("setExportMessage") &&
    source.includes("setShareMessage") &&
    source.includes('setShareMessage(t("meetingDetail.shareAndCopyFailed", { message: copyMessage }))') &&
    source.includes("function messageHasError(message: string)") &&
    source.includes("messageHasError(shareMessage) ? styles.error : styles.success") &&
    exportFileSource.includes("replace(/[\\\\/:*?\"<>|]/g") &&
    !existsSync("apps/mobile/src/markdown.ts") &&
    obsidianVaultSmokeSource.includes("OWNMINUTES_AUTH_DATA_DIR: authPath") &&
    obsidianVaultSmokeSource.includes("fs.rmSync(authPath") &&
    ciSource.includes("npm run smoke:obsidian-vault"),
  hasScalableMeetingHistory:
    source.includes('accessibilityLabel={t("meetings.search")}') &&
    source.includes('placeholder={t("meetings.searchPlaceholder")}') &&
    source.includes('id: "completed", label: t("meetings.completed")') &&
    source.includes('id: "pending", label: t("meetings.pending")') &&
    source.includes('id: "shared", label: t("meetings.shared")') &&
    source.includes("filterMeetingHistory(meetings") &&
    source.includes("const historyPageSize = 20") &&
    source.includes('meetings.length >= 8 || historyQuery.trim().length > 0 || historyFilter !== "all"') &&
    source.includes("{showHistoryControls ? <>") &&
    source.includes("visibleMeetings.length < filteredMeetings.length") &&
    source.includes("setHistoryVisibleCount((count) => count + historyPageSize)") &&
    !source.includes("meetings.slice(0, 12)") &&
    meetingHistorySource.includes('MeetingHistoryFilter = "all" | "completed" | "pending" | "shared"') &&
    meetingHistorySource.includes('meeting.share.visibility !== "public"') &&
    meetingHistorySource.includes('meeting.metadata.participants') &&
    meetingHistorySource.includes('meeting.metadata.tags'),
  hasFocusedMeetingDetail:
    source.includes("{!selectedMeeting && !selectedLocalRecording ? (") &&
    source.includes('accessibilityLabel={t("meetings.back")}') &&
    source.includes("function closeMeetingDetail()") &&
    source.includes("const activeMeetingResult = finalMeetingResult") &&
    source.includes("selectedMeeting.obsidianMarkdown ?? selectedMeeting.result?.obsidianMarkdown") &&
    source.includes("function syncCurrentMeetingOutput(") &&
    source.includes("targetMeetingId !== meetingId") &&
    !openMeetingDetailFlow.includes("setFinalMeetingResult") &&
    !openMeetingDetailFlow.includes("setFormalMarkdown") &&
    !openMeetingDetailFlow.includes("setSegments") &&
    source.includes("selectedMeeting.result.summary.actionItems.slice(0, 5)") &&
    source.includes("selectedMeeting.generatedAt ?? selectedMeeting.updatedAt") &&
    source.includes('t("meetings.transcriptCount", { count: selectedMeeting.transcriptCount })') &&
    source.includes("selectedMeeting.result.summary.decisions.slice(0, 5)") &&
    source.includes("selectedMeeting.result.summary.speakerViews.slice(0, 3)") &&
    source.includes("disabled={summarySaving}") &&
    source.includes("disabled={speakerSaving}") &&
    source.includes("disabled={selectedFinalizing}"),
  hasSimplifiedMeetingDetailHierarchy: (() => {
    const summary = meetingDetailSurface.indexOf('t("meetings.summary")');
    const decisions = meetingDetailSurface.indexOf('t("meetingDetail.keyDecisions")');
    const actions = meetingDetailSurface.indexOf('t("meetingDetail.actionItems")');
    const transcript = meetingDetailSurface.indexOf('label={t("ux.transcript")}');
    const sharing = meetingDetailSurface.indexOf('label={t("meetings.sharing")}');
    const more = meetingDetailSurface.indexOf('label={t("ux.moreTools")}');
    const speakerViews = meetingDetailSurface.indexOf('t("meetingDetail.speakerViews")', more);
    return [summary, decisions, actions, transcript, sharing, more, speakerViews].every((index) => index >= 0) &&
      summary < decisions && decisions < actions && actions < transcript && transcript < sharing && sharing < more && more < speakerViews &&
      meetingDetailSurface.includes("showMeetingTools && selectedMeeting.result") &&
      meetingDetailSurface.includes("showMeetingTools && selectedMeetingSpeakers.length > 0") &&
      meetingDetailSurface.includes("showMeetingTools && selectedMeetingTranscript.length > 0");
  })(),
  hasProtectedLocalAudioPlayback:
    source.includes("useAudioPlayer,") &&
    source.includes("useAudioPlayerStatus,") &&
    source.includes("function MeetingAudioPlayer(") &&
    source.includes("keepAudioSessionActive: false") &&
    source.includes("player.seekTo(") &&
    source.includes('player.setPlaybackRate(nextRate, "medium")') &&
    source.includes("parseTranscriptTimestampSeconds") &&
    doStartRecordingFlow.includes("meetingAudioControllerRef.current?.pause();") &&
    meetingDetailSurface.includes("selectedMeetingLocalRecording && !recordingLifecycleBusy") &&
    meetingDetailSurface.includes("playTranscriptAt(segment.timestamp)") &&
    meetingDetailSurface.includes("shareSelectedMeetingRecording"),
  keepsHonestResultGate:
    source.includes('t("record.noFormalNotesTitle")') &&
    source.includes('t("record.noFormalNotesDetail")') &&
    source.includes('t("record.needsProcessing")') &&
    source.includes('t("record.notesModelMissing")') &&
    source.includes("isMobilePlaceholderSummary(result.summary.summary)") &&
    source.includes('detail.qualityStatus === "verified"') &&
    source.includes('throw new Error(t("meetingDetail.markdownNotReady"))') &&
    source.includes('disabled={!canExportMarkdown}') &&
    !source.includes("buildMeetingMarkdown"),
  preventsBlankNativeRoot:
    mobileIndexSource.includes("AppErrorBoundary") &&
    mobileIndexSource.includes("registerRootComponent(OwnMinutesRoot)") &&
    appErrorBoundarySource.includes("style={styles.appRoot}") &&
    appErrorBoundarySource.includes("flex: 1") &&
    appErrorBoundarySource.includes('translate(locale, "appError.title")') &&
    appErrorBoundarySource.includes('translate(locale, "appError.body")') &&
    appErrorBoundarySource.includes("supportCodeForError") &&
    appErrorBoundarySource.includes("OM-R-"),
  keepsRecordingConsent:
    startRecordingFlow.includes('Alert.alert(t("recordingFlow.consentTitle"), t("recordingFlow.consentBody"), [') &&
    startRecordingFlow.includes('{ text: t("common.cancel"), style: "cancel" }') &&
    startRecordingFlow.includes('text: t("recordingFlow.consentStart")') &&
    startRecordingFlow.includes('consentMethod: "in_app_confirmation"') &&
    startRecordingFlow.includes("consentPolicyVersion: recordingConsentPolicyVersion") &&
    recordingStoreSource.includes("consentMethod?: RecordingConsentMethod") &&
    apiSource.includes('"X-OwnMinutes-Consent-Method"'),
  keepsMeetingManagement:
    source.includes('Panel title={t("meetings.title")}') &&
    source.includes('Panel title={t("meetings.detail")}') &&
    source.includes("saveSelectedMeetingSpeakers") &&
    source.includes("saveSelectedMeetingSummary") &&
    source.includes("confirmDeleteMeeting"),
  keepsMeetingIdentityAndArchive:
    source.includes('accessibilityLabel={t("record.meetingTitle")}') &&
    source.includes("createDefaultMeetingTitle") &&
    source.includes("title: meetingTitle") &&
    source.includes("working.title || createDefaultMeetingTitle") &&
    recordingStoreSource.includes("title?: string") &&
    recordingStoreSource.includes("normalizePendingTitle") &&
    source.includes("saveSelectedMeetingMetadata") &&
    source.includes('label={t("meetings.meetingInfo")}') &&
    source.includes("metadataParticipantsDraft") &&
    source.includes("metadataProjectDraft") &&
    source.includes("metadataTagsDraft") &&
    apiSource.includes("updateMeetingMetadata") &&
    apiSource.includes("participants: params.participants"),
  keepsProviderSettings:
    source.includes('<LanguageSelector variant="settings" />') &&
    source.includes('label={t("settings.recordingPrivacy")}') &&
    source.includes('label={t("settings.ownModels")}') &&
    source.includes('Panel title={t("settings.provider")}') &&
    source.includes("showProviderEditor") &&
    source.includes('{__DEV__ ? <>') &&
    source.includes('Panel title="录制稳定性检查"'),
  supportsCommercialByokSetup:
    source.includes("providerAsrApiKey") &&
    source.includes("providerAsrToken") &&
    source.includes("providerArkApiKey") &&
    source.includes('<Text style={styles.providerStepTitle}>{t("providerSetup.asrStepTitle")}</Text>') &&
    source.includes('<Text style={styles.providerStepTitle}>{t("providerSetup.summaryStepTitle")}</Text>') &&
    source.includes('accessibilityLabel="ASR API Key"') &&
    source.includes('accessibilityLabel={t("providerSetup.legacyAppId")}') &&
    source.includes('accessibilityLabel={t("providerSetup.legacyAccessToken")}') &&
    source.includes("VOLCANO_ASR_TOKEN: asrToken") &&
    source.includes('setProviderMessage(t("providerSetup.asrFieldsRequired"))') &&
    source.includes('label={providerMode === "volcano-asr" ? t("providerSetup.openSpeechConsole") : t("providerSetup.openArkConsole")}') &&
    source.includes('<ExternalLinkAction label={t("providerSetup.viewAsrAuthDocs")}') &&
    source.includes('t("providerSetup.realtimeConnectionTest")') &&
    source.includes("runMobileRealtimeAsrTest") &&
    apiSource.includes("runRealtimeAsrAuthTest") &&
    apiSource.includes("/api/account/provider-health/realtime-test") &&
    source.includes("Linking.openURL") &&
    !source.includes("providerSecret"),
  guidesFirstMeetingChoice:
    source.includes("getFirstRunGuide({") &&
    source.includes("officialProcessingStatus,") &&
    source.includes('accountUsage?.officialProcessing?.status ?? "unknown"') &&
    source.includes("markOfficialProcessingUnknown") &&
    !source.includes("officialProcessingReady = true") &&
    !source.includes("refreshOfficialProviderDiagnostic") &&
    source.includes("mobileByokCoverage.complete") &&
    source.includes('event.type === "meeting_finalize"') &&
    source.includes("<FirstRunGuideCard") &&
    source.includes('action === "start"') &&
    source.includes('action === "configure"') &&
    source.includes('action === "plans"') &&
    firstRunSource.includes('primaryAction: "start"') &&
    firstRunSource.includes('primaryAction: "configure"') &&
    firstRunSource.includes('secondaryAction: "plans"') &&
    firstRunSource.includes('input.officialProcessingStatus === "unknown"') &&
    firstRunSource.includes("if (input.hasCompletedMeeting) return null"),
  separatesOfficialServiceFromUserByok:
    source.includes("async function checkAdminDiagnostics") &&
    source.includes('currentUser?.role !== "admin"') &&
    source.includes("fetchProviderDiagnostic(targetApiBaseUrl, sessionCookie)") &&
    source.includes("fetchReleaseReadinessSummary(targetApiBaseUrl, sessionCookie)") &&
    source.includes("const health = await fetchBackendHealth(targetApiBaseUrl)") &&
    !source.includes("refreshOfficialProviderDiagnostic") &&
    !source.includes("officialProcessingReady: providerSetupState.ready") &&
    apiSource.includes("/api/account/usage") &&
    meetingCostSource.includes('input.officialProcessingStatus === "ready"') &&
    meetingCostSource.includes('input.officialProcessingStatus === "unknown"'),
  showsTransparentMeetingCost:
    source.includes("getMeetingCostPreview({") &&
    source.includes("formatMeetingBilling(activeMeetingResult ?? {}, locale)") &&
    source.includes("formatMeetingBilling(selectedMeeting?.result ?? {}, locale)") &&
    source.includes("<MeetingCostIndicator") &&
    meetingCostSource.includes('locale: AppLocale = "zh-Hans"') &&
    meetingCostSource.includes('translate(locale, "cost.actualUse"') &&
    meetingCostSource.includes('translate(locale, "cost.ownBillingDetail"') &&
    meetingCostSource.includes('translate(locale, "cost.billingDetail"') &&
    meetingCostSource.includes('translate(locale, "cost.lowSuffix")') &&
    source.includes("formatUsageNote(event.note, event, locale)") &&
    meetingCostSource.includes('route: "byok"') &&
    meetingCostSource.includes('input.processingMode === "byok"') &&
    meetingCostSource.includes('translate(locale, "cost.byokUnavailableDetail")') &&
    meetingCostSource.includes('route: "official_quota"') &&
    !meetingCostSource.includes('route: coverage.hasAny ? "hybrid" : "official_quota"'),
  keepsProviderSetupRecoverable:
    source.includes("showProviderAdvancedFields") &&
    source.includes('accessibilityLabel={t("providerSetup.legacyAdvanced")}') &&
    source.includes("confirmDeleteProviderCredential") &&
    source.includes("removeProviderCredential") &&
    source.includes("await refreshAccountUsage()") &&
    apiSource.includes("export async function deleteProviderCredential") &&
    apiSource.includes('method: "DELETE"') &&
    source.includes('setProviderMessage(t("providerSetup.providerDeleted"))'),
  preventsNativeSecretAutofill:
    source.match(/autoComplete="off"/g)?.length >= 3 &&
    source.match(/importantForAutofill="no"/g)?.length >= 3 &&
    source.match(/textContentType="none"/g)?.length >= 3 &&
    source.includes('value={providerAsrApiKey}') &&
    source.includes('value={providerAsrToken}') &&
    source.includes('value={providerArkApiKey}'),
  hasGuidedSettingsFlow:
    source.includes("function beginProviderSetup()") &&
    source.includes('setAuthMode("register")') &&
    source.includes('setAuthMessage(t("providerSetup.signInToConfigure"))') &&
    source.includes("setShowProviderEditor(true)") &&
    source.includes("providerPanelYRef.current") &&
    source.includes('detail={t("settings.ownModelsDetail")}') &&
    source.includes("showAdvancedSettings") &&
    source.includes('t("settings.advanced")') &&
    source.includes("expanded={showAdvancedSettings}"),
  usesProgressiveDisclosure:
    source.includes("showMeetingEditor") &&
    source.includes("showSpeakerEditor") &&
    source.includes("showShareControls") &&
    source.includes("showConnectionSettings") &&
    source.includes("showProviderEditor") &&
    source.includes("showProviderAdvancedFields") &&
    source.includes("showUsageHistory") &&
    source.includes("showMembership") &&
    source.includes('label={t("meetings.editNotes")}') &&
    source.includes('label={t("meetings.speakers")}') &&
    source.includes('label={t("meetings.sharing")}') &&
    source.includes('label={t("account.membership")}') &&
    source.includes("function SectionToggle") &&
    source.includes("function MenuAction"),
  hasNativeTranscriptSpeakerCorrection:
    apiSource.includes("export async function updateMeetingTranscriptSpeakers") &&
    apiSource.includes("transcriptSpeakerAssignments") &&
    source.includes("saveSelectedTranscriptSpeakers") &&
    source.includes('label={t("ux.correctTranscript")}') &&
    source.includes('detail={t("meetingDetail.transcriptDetail", { count: selectedMeetingTranscript.length })}') &&
    source.includes('<Text style={styles.help}>{t("meetingDetail.transcriptReviewDetail")}</Text>') &&
    source.includes("transcriptReviewPageSize") &&
    source.includes("visibleSelectedMeetingTranscript") &&
    source.includes("transcriptSpeakerChoices") &&
    source.includes('accessibilityLabel={t("meetingDetail.assignSpeaker", { speaker, timestamp: segment.timestamp })}') &&
    source.includes('accessibilityLabel={t("meetingDetail.speakerName", { timestamp: segment.timestamp })}') &&
    source.includes('autoComplete="off"') &&
    source.includes('importantForAutofill="no"') &&
    source.includes('secureTextEntry={false}') &&
    source.includes('textContentType="none"') &&
    source.includes('t("meetingDetail.transcriptReviewDetail")') &&
    source.includes('setTranscriptSpeakerMessage(t("meetingDetail.transcriptUpdated", { count: Object.keys(speakerAssignments).length }))') &&
    source.includes("humanReview: response.humanReview ?? selectedMeeting.humanReview") &&
    source.includes("share: response.share ?? selectedMeeting.share") &&
    source.includes('setTranscriptSpeakerError(false)'),
  switchesAsrAuthWithoutStaleSecrets:
    source.includes('removeSecrets:') &&
    source.includes('["VOLCANO_ASR_TOKEN"]') &&
    source.includes('["VOLCANO_ASR_API_KEY"]'),
  keepsAccountManagement:
    source.includes('Panel plain={!currentUser} title={currentUser ? t("account.status") : undefined}') &&
    source.includes("styles.authScreen") &&
    source.includes('t("auth.registerTitle")') &&
    source.includes('t("auth.developmentConnection")') &&
    source.includes("shareAccountExport") &&
    source.includes("confirmDeleteAccount"),
  hasNativeHelpAndLegalAccess:
    source.includes("openOwnMinutesPage") &&
    source.includes('label={t("account.helpAndLegal")}') &&
    source.includes('label={t("account.support")}') &&
    source.includes('label={t("account.privacy")}') &&
    source.includes('label={t("account.terms")}') &&
    source.includes('label={t("account.dataDeletion")}') &&
    source.includes('openOwnMinutesPage("/support")') &&
    source.includes('openOwnMinutesPage("/privacy")') &&
    source.includes('openOwnMinutesPage("/terms")') &&
    source.includes('openOwnMinutesPage("/data-deletion")') &&
    source.includes('t("auth.supportAndDeletion")') &&
    source.includes('t("providerSetup.cannotOpenLinkTitle")') &&
    source.includes('t("providerSetup.deviceCannotOpenLink")'),
  hasPasswordRecoveryAndChange:
    apiSource.includes("requestAccountPasswordReset") &&
    apiSource.includes("changeAccountPassword") &&
    source.includes('t("auth.forgotPassword")') &&
    source.includes("requestPasswordReset") &&
    source.includes("showPasswordChange") &&
    source.includes("submitPasswordChange") &&
    source.includes('t("account.saveNewPassword")') &&
    passwordRouteSource.includes("getRequestSessionToken") &&
    !passwordRouteSource.includes("SESSION_COOKIE_NAME"),
  hasNativePasswordResetCompletion:
    apiSource.includes("confirmAccountPasswordReset") &&
    apiSource.includes("/api/auth/password-reset/confirm") &&
    source.includes("function PasswordResetModal") &&
    source.includes("extractPasswordResetToken") &&
    source.includes("pastePasswordResetLink") &&
    source.includes("submitPasswordReset") &&
    source.includes('t("passwordReset.pasteLink")') &&
    source.includes('t("passwordReset.submit")') &&
    source.includes('autoComplete="new-password"') &&
    !source.includes("打开重置页"),
  hasNativeEmailVerification:
    apiSource.includes("requestAccountEmailVerificationCode") &&
    apiSource.includes("confirmAccountEmailVerificationCode") &&
    apiSource.includes("/api/auth/email-verification/code/request") &&
    apiSource.includes("/api/auth/email-verification/code/confirm") &&
    apiSource.includes("requestAccountEmailVerification") &&
    apiSource.includes("confirmAccountEmailVerification") &&
    apiSource.includes("/api/auth/email-verification/request") &&
    apiSource.includes("/api/auth/email-verification/confirm") &&
    source.includes("function EmailVerificationModal") &&
    source.includes("submitEmailVerificationCode") &&
    source.includes('keyboardType="number-pad"') &&
    source.includes('textContentType="oneTimeCode"') &&
    source.includes('autoComplete="one-time-code"') &&
    source.includes("legacyLinkRequired") &&
    !emailVerificationSurface.includes("pasteEmailVerificationLink"),
  hasHonestNativeIapFlow:
    source.includes("<IapPlanStoreProvider") &&
    source.includes("session={currentUser && sessionCookie") &&
    source.includes("<IapPlanStore />") &&
    iapSource.includes('from "expo-iap"') &&
    iapSource.includes('plus: { captionKey: "iap.plusCaption", minutes: 600') &&
    iapSource.includes('pro: { captionKey: "iap.proCaption", minutes: 1800') &&
    iapSource.includes("storeProduct?.displayPrice") &&
    iapSource.includes("submitAppleTransaction") &&
    iapSource.includes("fetchAppleAccountToken") &&
    iapSource.includes("apple: { appAccountToken, sku: productId }") &&
    apiSource.includes("/api/payments/apple/account-token") &&
    iapSource.includes("coordinatorRef.current.run") &&
    iapSource.includes("verify: () => submitAppleTransaction") &&
    iapSource.includes("finish: candidate.purchase") &&
    iapSource.includes("IapPlanStoreViewContext.Provider value={storeView}") &&
    iapSource.includes("getAvailablePurchases({") &&
    iapSource.includes("onlyIncludeActiveItemsIOS: true") &&
    iapSource.includes("alsoPublishToEventListenerIOS: true") &&
    iapSource.includes("localizedLegalPagePath(locale, path)") &&
    iapSource.includes('if (locale === "en") return `/en${path}`') &&
    iapSource.includes('if (locale === "zh-Hant") return `/zh-Hant${path}`') &&
    source.includes("localizedOwnMinutesWebPath(locale, pathname)") &&
    source.includes('if (locale === "en") return `/en${pathname}`') &&
    source.includes('if (locale === "zh-Hant") return `/zh-Hant${pathname}`') &&
    iapSource.includes('Constants.appOwnership === "expo"') &&
    iapSource.includes('"iap.expoGoUnsupported"') &&
    iapSource.includes('t("iap.iapNotConfigured")') &&
    iapSource.includes('t("iap.restorePurchase")') &&
    Boolean(mobilePackage.dependencies?.["expo-iap"]) &&
    appConfig.expo.plugins.includes("expo-iap") &&
    !source.includes("updateAccountPlan"),
  hasNativeSessionAuth:
    apiSource.includes('headers.set("Authorization", `Bearer ${sessionToken}`)') &&
    apiSource.includes('credentials: "include"') &&
    apiSource.includes("fetchWithSession") &&
    source.includes("await SecureStore.setItemAsync(sessionCookieKey"),
  hasOfflineLocalRecordingEntryWithoutDuplicates:
    source.includes("const standaloneLocalRecordings = userBrowsableLocalRecordings.filter(") &&
    source.includes("!serverMeetingIds.has(recording.meetingId)") &&
    source.includes("const showStandaloneLocalRecordings = standaloneLocalRecordings.length > 0") &&
    source.includes('if (networkStatus !== "online" && localRecording)') &&
    source.includes("openLocalRecording(localRecording)") &&
    source.includes("selectedPlaybackRecording") &&
    source.includes('title={t("runtime.localRecordingDetailTitle")}') &&
    source.includes('t("runtime.localRecordingSafeDetail")') &&
    !source.includes("<Text style={styles.emptyStateIcon}>✦</Text>"),
  hasExplicitSafeLocalRecordingDeletion:
    source.includes("confirmDeleteSelectedLocalRecording") &&
    source.includes("deleteLocalRecordingFromDevice({") &&
    source.includes('"runtime.localRecoveryDeleteBody"') &&
    source.includes('t("runtime.localDeleteDetail")') &&
    source.includes('kind="danger"') &&
    source.includes('t("runtime.speechEnhancementDetail")'),
  usesStructuredAutoSyncTone:
    source.includes('type AutoSyncNoticeTone = "info" | "warning"') &&
    source.includes("const autoSyncTone = autoSyncNotice?.tone") &&
    source.includes('autoSyncTone === "warning" ? "#9a6d35" : "#1f6f55"') &&
    !source.includes('autoSyncMessage.includes("重试")') &&
    !source.includes('autoSyncMessage.includes("联网")'),
  usesSafeAreaContext:
    source.includes('from "react-native-safe-area-context"') &&
    source.includes("SafeAreaProvider") &&
    Boolean(mobilePackage.dependencies?.["react-native-safe-area-context"]),
  documentsCurrentRecorder:
    readme.includes("记录 / 会议 / 我的") &&
    readme.includes("单任务录音界面") &&
    readme.includes("浅色录音台") &&
    readme.includes("绿色圆形麦克风按钮") &&
    readme.includes("36 段声波") &&
    readme.includes("16 kHz") &&
    readme.includes("Linear PCM/CAF") &&
    readme.includes("异常中断") &&
    readme.includes("4 MiB") &&
    readme.includes("FileHandle") &&
    readme.includes("SHA-256") &&
    !readme.includes("iOS 正式原始录音使用 44.1 kHz") &&
    readme.includes("ffmpeg") &&
    readme.includes("Ionicons") &&
    readme.includes("实时转写") &&
    readme.includes("会议纪要") &&
    readme.includes("AppID + Token") &&
    readme.includes("smoke:mobile-ui"),
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) {
  process.exitCode = 1;
}
