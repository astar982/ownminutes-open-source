#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const source = readFileSync("apps/mobile/App.tsx", "utf8");
const recordingStoreSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const localAudioBoundarySource = readFileSync("apps/mobile/src/local-audio-error-boundary.tsx", "utf8");
const pendingSyncSource = readFileSync("apps/mobile/src/pending-sync.ts", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const appConfig = JSON.parse(readFileSync("apps/mobile/app.json", "utf8"));
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const configSource = readFileSync("apps/mobile/src/config.ts", "utf8");
const mobileReadme = readFileSync("apps/mobile/README.md", "utf8");
const testflightRunbook = readFileSync("docs/ios-testflight-acceptance-runbook.md", "utf8");
const realtimeRoutePath = "src/app/api/meetings/[id]/realtime-chunks/route.ts";
const realtimeRoute = existsSync(realtimeRoutePath) ? readFileSync(realtimeRoutePath, "utf8") : "";
const doStartRecordingFlow = source.slice(
  source.indexOf("async function doStartRecording("),
  source.indexOf("async function pauseRecording()"),
);
const pauseRecordingFlow = source.slice(
  source.indexOf("async function pauseRecording()"),
  source.indexOf("async function resumeRecording()"),
);
const resumeRecordingFlow = source.slice(
  source.indexOf("async function resumeRecording()"),
  source.indexOf("async function resetMeeting()"),
);
const deleteSelectedMeetingFlow = source.slice(
  source.indexOf("async function deleteSelectedMeeting()"),
  source.indexOf("async function startRecording()"),
);
const currentMeetingDeleteResetFlow = deleteSelectedMeetingFlow.slice(
  deleteSelectedMeetingFlow.indexOf("if (meetingId === targetMeetingId)"),
  deleteSelectedMeetingFlow.indexOf("setSelectedMeeting(null)"),
);
const meetingAudioPlayerFlow = source.slice(
  source.indexOf("function MeetingAudioPlayer("),
  source.indexOf("function ErrorState("),
);
const stopRecordingFlow = source.slice(
  source.indexOf("async function stopRecording(reason?: RecordingStopReason)"),
  source.indexOf("stopRecordingRef.current = stopRecording"),
);
const mediaServicesResetFlow = source.slice(
  source.indexOf("async function handleMediaServicesReset()"),
  source.indexOf("async function stopRecording(reason?: RecordingStopReason)"),
);
const retryUploadFlow = source.slice(
  source.indexOf("async function retryUpload("),
  source.indexOf("async function retrySelectedMeetingFinalization()"),
);
const shareAudioFlow = source.slice(
  source.indexOf("async function shareAudioFile("),
  source.indexOf("async function shareLocalRecording()"),
);
const checkAdminDiagnosticsFlow = source.slice(
  source.indexOf("async function checkAdminDiagnostics("),
  source.indexOf("async function checkBackend("),
);
const checkBackendFlow = source.slice(
  source.indexOf("async function checkBackend("),
  source.indexOf("async function restoreApiBaseUrl("),
);
const recorderStartIndex = doStartRecordingFlow.indexOf("recorder.record({ forDuration:");
const recorderUriReadIndex = doStartRecordingFlow.indexOf("recordingUri = await waitForRecorderUri(recorder)");
const resumeRealtimeStartIndex = resumeRecordingFlow.indexOf("await audioStream.stream.start()");
const resumeRecorderStartIndex = resumeRecordingFlow.indexOf("recorder.record({ forDuration: remainingSeconds })");
const resumeRecorderVerificationIndex = resumeRecordingFlow.indexOf("recorder.getStatus().isRecording");
const frozenRecordingUriMatch = stopRecordingFlow.match(
  /const\s+([A-Za-z0-9_]+)\s*=\s*activeRecordingUriRef\.current(?:\s*;|\s*\|\|)/,
);
const frozenRecordingUriName = frozenRecordingUriMatch?.[1] ?? "";
const frozenRecordingUriIndex = frozenRecordingUriMatch?.index ?? -1;
const recordingGenerationInvalidationIndex = stopRecordingFlow.indexOf("recordingGenerationRef.current += 1");
const boundedStartupRecorderStopIndex = doStartRecordingFlow.search(
  /await\s+withTimeout\(\s*recorder\.stop\(\),\s*8_?000\s*,/,
);
const boundedRecorderStopIndex = stopRecordingFlow.search(
  /await\s+withTimeout\(\s*recorder\.stop\(\),\s*8_?000\s*,/,
);
const startupRecoveryPersistIndex = doStartRecordingFlow.lastIndexOf("await persistPendingRecording({");
const startupRecoveryCleanupIndex = doStartRecordingFlow.lastIndexOf("await Promise.allSettled([");
const startupRecoveryUnlockIndex = doStartRecordingFlow.lastIndexOf("recordingLifecycleBusyRef.current = false");
const staleStartCleanupIndex = doStartRecordingFlow.indexOf("const abandonStaleRecordingStart = async () =>");
const staleStartCleanupEndIndex = doStartRecordingFlow.indexOf("};", staleStartCleanupIndex);
const staleStartAudioCleanupIndex = doStartRecordingFlow.indexOf("await Promise.allSettled([", staleStartCleanupIndex);
const staleStartUnlockIndex = doStartRecordingFlow.indexOf(
  "recordingLifecycleBusyRef.current = false",
  staleStartCleanupIndex,
);
const staleStartStopFenceIndex = doStartRecordingFlow.indexOf(
  "recordingStopInFlightRef.current = true",
  staleStartCleanupIndex,
);
const stalePreparedRecorderStopIndex = doStartRecordingFlow.indexOf(
  "recorder.stop()",
  staleStartCleanupIndex,
);
const staleStartStopUnlockIndex = doStartRecordingFlow.indexOf(
  "recordingStopInFlightRef.current = false",
  staleStartCleanupIndex,
);
const recorderPreparedIndex = doStartRecordingFlow.indexOf("durableRecorderPrepared = true");
const postPrepareSessionFenceIndex = doStartRecordingFlow.indexOf(
  "if (!recordingStartSessionIsCurrent(recordingStartFence))",
  recorderPreparedIndex,
);
const startupFailureIndex = doStartRecordingFlow.lastIndexOf(
  "} catch {\n      nativeDurationLimitArmedRef.current = false;",
);
const startupFailureFlow = doStartRecordingFlow.slice(startupFailureIndex);
const startupFailureStopFenceIndex = startupFailureFlow.indexOf(
  "recordingStopInFlightRef.current = true",
);
const startupFailureProcessingIndex = startupFailureFlow.indexOf(
  'recordingStatusRef.current = "processing"',
);
const startupFailureRecorderStopIndex = startupFailureFlow.indexOf("recorder.stop()");
const startupFailureStopUnlockIndex = startupFailureFlow.lastIndexOf(
  "recordingStopInFlightRef.current = false",
);
const startupFailureFirstAwaitIndex = startupFailureFlow.indexOf("await ");
const persistedLocalIndex = stopRecordingFlow.indexOf("await persistPendingRecording({");
const localIndexConfirmedIndex = stopRecordingFlow.indexOf("localRecordingIndexed = true", persistedLocalIndex);
const localCompleteStatusIndex = stopRecordingFlow.indexOf('setStatus("complete")', localIndexConfirmedIndex);
const realtimeSettleIndex = stopRecordingFlow.indexOf("settleRealtimePcmSession(", localCompleteStatusIndex);
const cloudSyncIndex = stopRecordingFlow.indexOf("syncPendingRecordings(", realtimeSettleIndex);
const backgroundCloudWorkIndex = stopRecordingFlow.lastIndexOf("void ", realtimeSettleIndex);

const checks = {
  hasStabilityPanel: source.includes('Panel title="录制稳定性检查"'),
  tracksMicrophonePermission: source.includes("microphonePermission") && source.includes("setMicrophonePermission"),
  tracksKeepAwakeState: source.includes("keepAwakeActive") && source.includes("setKeepAwakeActive"),
  tracksBackgroundRecording:
    source.includes("AppState.addEventListener") &&
    source.includes("backgroundInterruptions") &&
    source.includes("lastBackgroundAt") &&
    source.includes("录音期间经过 ${backgroundInterruptions} 次前后台切换") &&
    source.includes('label: "后台录音"') &&
    source.includes("iOS 已启用锁屏与后台录音能力") &&
    appConfig.expo.plugins.some(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-audio" && plugin[1]?.enableBackgroundRecording === true,
    ),
  configuresNativeAudioMode:
    source.includes("setAudioModeAsync") &&
    source.includes("allowsBackgroundRecording: true") &&
    source.includes('interruptionMode: "doNotMix"'),
  timesOutStalledRecorderPreparation:
    doStartRecordingFlow.includes("await withTimeout(") &&
    doStartRecordingFlow.includes("recorder.prepareToRecordAsync()") &&
    doStartRecordingFlow.includes("8000,") &&
    doStartRecordingFlow.includes('t("recordingFlow.prepareTimeout")') &&
    source.includes("function withTimeout<T>"),
  storesRecorderInDocumentDirectory:
    source.includes('directory: "document" as const') &&
    source.includes("Keep the recorder's Documents URI authoritative") &&
    recordingStoreSource.includes("scanRootOrphanRecordings"),
  startsRecorderBeforeReadingNativeUri:
    recorderStartIndex >= 0 &&
    recorderUriReadIndex > recorderStartIndex &&
    source.includes("recorder.uri || recorder.getStatus().url") &&
    doStartRecordingFlow.includes("recordingUri = await waitForRecorderUri(recorder)"),
  continuesRecordingWhenNativeUriIsDelayed:
    doStartRecordingFlow.includes("if (recordingUri) {") &&
    doStartRecordingFlow.includes('setRealtimeUploadDiagnostic(t("recordingFlow.delayedPath"))') &&
    doStartRecordingFlow.includes("void resolveDelayedRecordingUri({") &&
    doStartRecordingFlow.indexOf("await audioStream.stream.start()") > doStartRecordingFlow.indexOf('t("recordingFlow.delayedPath")'),
  persistsDelayedNativeUri:
    source.includes("resolveDelayedRecordingUri") &&
    source.includes("delayedRecordingUriAttempts") &&
    source.includes("recordingGenerationRef.current !== input.generation") &&
    source.includes('setRealtimeUploadDiagnostic(t("runtime.recordingIndexConfirmed"))'),
  monitorsNativeRecordingGrowth:
    source.includes("FileSystem.getInfoAsync(activeRecordingUri)") &&
    source.includes("assessRecordingFileHealth") &&
    source.includes('t("record.fileHealthy"') &&
    source.includes('t("record.fileStalled")'),
  stopsRecorderWhenStartupFails:
    source.includes("durableRecorderPrepared") &&
    boundedStartupRecorderStopIndex >= 0 &&
    !doStartRecordingFlow.includes("await recorder.stop();") &&
    source.includes("Continue cleanup even when the native recorder cannot stop cleanly."),
  startupRecoveryCleanupSurvivesIndexFailure:
    startupRecoveryPersistIndex >= 0 &&
    startupRecoveryCleanupIndex > startupRecoveryPersistIndex &&
    doStartRecordingFlow.slice(startupRecoveryPersistIndex, startupRecoveryCleanupIndex).includes("} catch {") &&
    doStartRecordingFlow.includes('t("recordingFlow.startRecoveryScan")') &&
    doStartRecordingFlow.slice(startupRecoveryCleanupIndex).includes("setKeepAwakeActive(false)"),
  startupCleanupStaysFencedUntilResourcesSettle:
    startupRecoveryCleanupIndex >= 0 &&
    startupRecoveryUnlockIndex > startupRecoveryCleanupIndex &&
    staleStartCleanupIndex >= 0 &&
    staleStartAudioCleanupIndex > staleStartCleanupIndex &&
    staleStartUnlockIndex > staleStartAudioCleanupIndex &&
    staleStartUnlockIndex < staleStartCleanupEndIndex,
  stalePreparedRecorderIsReleasedBeforeUnlock:
    recorderPreparedIndex >= 0 &&
    postPrepareSessionFenceIndex > recorderPreparedIndex &&
    staleStartStopFenceIndex > staleStartCleanupIndex &&
    stalePreparedRecorderStopIndex > staleStartStopFenceIndex &&
    staleStartStopUnlockIndex > stalePreparedRecorderStopIndex &&
    doStartRecordingFlow.includes("...(durableRecorderPrepared") &&
    doStartRecordingFlow.includes("释放已失效的原生录音准备会话超时。"),
  startupFailureBlocksConcurrentRecorderControls:
    startupFailureIndex >= 0 &&
    startupFailureStopFenceIndex >= 0 &&
    startupFailureProcessingIndex > startupFailureStopFenceIndex &&
    startupFailureFirstAwaitIndex > startupFailureProcessingIndex &&
    startupFailureRecorderStopIndex > startupFailureProcessingIndex &&
    startupFailureStopUnlockIndex > startupFailureRecorderStopIndex &&
    startupFailureFlow.includes('setStatus("processing")') &&
    startupFailureFlow.includes("durableRecorderPrepared = false") &&
    pauseRecordingFlow.includes(
      "if (recordingTransitionInFlightRef.current || recordingStopInFlightRef.current) return;",
    ) &&
    resumeRecordingFlow.includes(
      "if (recordingTransitionInFlightRef.current || recordingStopInFlightRef.current) return;",
    ) &&
    stopRecordingFlow.includes("if (recordingStopInFlightRef.current) return;"),
  boundsFinalRecorderStop:
    boundedRecorderStopIndex >= 0 &&
    !stopRecordingFlow.includes("await recorder.stop();"),
  freezesNativeUriBeforeInvalidatingRecorderGeneration:
    frozenRecordingUriIndex >= 0 &&
    frozenRecordingUriIndex < recordingGenerationInvalidationIndex &&
    boundedRecorderStopIndex > frozenRecordingUriIndex &&
    stopRecordingFlow.indexOf(frozenRecordingUriName, frozenRecordingUriIndex + frozenRecordingUriName.length) >
      boundedRecorderStopIndex,
  localRecoveryIndexCompletesBeforeCloudWork:
    persistedLocalIndex >= 0 &&
    localIndexConfirmedIndex > persistedLocalIndex &&
    localCompleteStatusIndex > localIndexConfirmedIndex &&
    backgroundCloudWorkIndex > localCompleteStatusIndex &&
    realtimeSettleIndex > backgroundCloudWorkIndex &&
    cloudSyncIndex > realtimeSettleIndex,
  keepsFormalRecordingWhenRealtimeFails:
    doStartRecordingFlow.includes("await audioStream.stream.start()") &&
    doStartRecordingFlow.includes('setRealtimeUploadDiagnostic(t("recordingFlow.realtimeStartFailed"))') &&
    resumeRecordingFlow.includes("recorder.record({ forDuration: remainingSeconds })") &&
    resumeRecordingFlow.includes("await audioStream.stream.start()") &&
    resumeRecordingFlow.includes('setRealtimeUploadDiagnostic(t("recordingFlow.realtimeResumeFailed"))'),
  reactivatesSharedAudioSessionBeforeDurableResume:
    resumeRealtimeStartIndex >= 0 &&
    resumeRecorderStartIndex > resumeRealtimeStartIndex &&
    resumeRecorderVerificationIndex > resumeRecorderStartIndex,
  verifiesNativeRecorderActuallyStarted:
    doStartRecordingFlow.includes("recorder.getStatus().isRecording") &&
    doStartRecordingFlow.indexOf("recorder.getStatus().isRecording") > recorderStartIndex,
  realtimeBuffersRequireActiveDurableRecording:
    source.includes('recordingStatusRef.current !== "recording"') &&
    source.includes("recordingStatusRef.current = status"),
  retriesRealtimeInputWhileDurableRecordingContinues:
    source.includes("realtimeStreamRestartInFlightRef") &&
    source.includes("const firstAttempt = setTimeout(() => void restart(), 2_000)") &&
    source.includes("const interval = setInterval(() => void restart(), 10_000)") &&
    source.includes('recordingStatusRef.current !== "recording"'),
  pausesAndResumesRealtimeInput:
    source.includes("async function pauseRecording()") &&
    source.includes("async function resumeRecording()") &&
    countOccurrences(source, "audioStream.stream.stop()") >= 3 &&
    countOccurrences(source, "audioStream.stream.start()") >= 2,
  handlesMediaServicesReset:
    source.includes("recorderState.mediaServicesDidReset") &&
    source.includes('t("runtime.mediaResetRecovered")') &&
    source.includes('t("runtime.mediaResetNeedsScan")') &&
    source.includes("recorder.getStatus()"),
  cancelsStaleForegroundRecorderChecks:
    source.includes("foregroundRecordingCheckTimerRef") &&
    source.includes("clearTimeout(foregroundRecordingCheckTimerRef.current)") &&
    source.includes("generation !== recordingGenerationRef.current") &&
    source.includes('recordingStatusRef.current !== "recording"') &&
    source.includes("recordingStopInFlightRef.current") &&
    source.includes("recordingTransitionInFlightRef.current") &&
    source.includes('appStateRef.current !== "active"') &&
    source.includes("}, 800);"),
  serializesPauseResumeAndStop:
    source.includes("recordingTransitionInFlightRef") &&
    source.includes("pendingRecordingStopRef") &&
    source.includes("setRecordingTransitionBusy(true)") &&
    source.includes("setRecordingTransitionBusy(false)") &&
    stopRecordingFlow.includes("if (recordingTransitionInFlightRef.current)") &&
    stopRecordingFlow.includes("pendingRecordingStopRef.current = { reason }") &&
    mediaServicesResetFlow.includes("if (recordingTransitionInFlightRef.current)") &&
    mediaServicesResetFlow.includes('pendingRecordingStopRef.current = { reason: "native-error" }') &&
    resumeRecordingFlow.includes("generation !== recordingGenerationRef.current") &&
    resumeRecordingFlow.includes('recordingStatusRef.current !== "paused"') &&
    resumeRecordingFlow.includes("pendingRecordingStopRef.current"),
  abandonsRealtimeStartupAfterConcurrentLifecycleChange:
    doStartRecordingFlow.includes("const recordingStartIsCurrent = () =>") &&
    doStartRecordingFlow.includes("const abandonRealtimeJournal = async () =>") &&
    countOccurrences(doStartRecordingFlow, "if (!recordingStartIsCurrent())") >= 4 &&
    doStartRecordingFlow.includes("await completePendingRealtimeSession(nextMeetingId)") &&
    doStartRecordingFlow.includes("audioStream.stream.stop()"),
  releasesKeepAwakeOnFailure: source.includes('setLastError(t("runtime.stopFailedPreserved"))') && countOccurrences(source, "setKeepAwakeActive(false)") >= 2,
  showsLocalAudioReadiness: source.includes('label: "本地音频"') && source.includes("recordedUri ?"),
  showsUploadQueueReadiness: source.includes('label: "上传队列"') && source.includes("uploadState.failed > 0"),
  showsPcmReadiness: source.includes('label: "PCM 输入流"') && source.includes("pcmBuffers > 0"),
  tracksRealtimeChunkBuffer:
    source.includes("realtimeChunkTargetMs") &&
    source.includes("accumulateRealtimePcmBuffer") &&
    source.includes("flushRealtimePcmBuffer") &&
    source.includes('label: "实时分片缓存"'),
  retainsRealtimeChunkBytes:
    source.includes("RealtimePcmChunk") &&
    source.includes("RealtimeUploadQueue") &&
    source.includes("queue.pendingCount()") &&
    source.includes("takeRealtimePendingBytes") &&
    source.includes("appendRealtimePcmChunk"),
  limitsRealtimeChunkMemory:
    source.includes("realtimeChunkQueueLimit") &&
    source.includes("nextRealtimeUploadSequence") &&
    source.includes("sequence === null") &&
    source.includes("setRealtimeDroppedChunks") &&
    source.includes('setRealtimeUploadDiagnostic(t("runtime.realtimeQueueCongested"))'),
  hasRealtimeChunkApiRoute:
    realtimeRoute.includes("storedForFinalization: false") &&
    realtimeRoute.includes("getRealtimeTranscriptionAdapter") &&
    realtimeRoute.includes("invalid pcm format"),
  uploadsRealtimeChunks:
    apiSource.includes("uploadRealtimePcmChunk") &&
    apiSource.includes("/realtime-chunks") &&
    source.includes("pushRealtimePcmChunk") &&
    source.includes("uploadRealtimePcmChunk"),
  uploadsFinalAudioWithNativeFileApi:
    apiSource.includes('File as ExpoFile, FileMode, Paths, UploadType') &&
    apiSource.includes("uploadTemporaryNativeFileWithTimeout(") &&
    apiSource.includes("file.createUploadTask(url, { ...options, signal })") &&
    apiSource.includes("uploadTask.uploadAsync()") &&
    apiSource.includes("uploadTask.release();") &&
    apiSource.includes("safeDeleteTemporaryUploadFile(file);") &&
    apiSource.includes("part-${partIndex}-${Crypto.randomUUID()}.bin") &&
    apiSource.includes("recordingUploadPartTimeoutMs = 120_000") &&
    apiSource.includes("UploadType.BINARY_CONTENT") &&
    apiSource.includes('sessionType: "background"') &&
    apiSource.includes("handle.readBytes(length)") &&
    apiSource.includes("buildSessionHeaders(params.authCookie)") &&
    !apiSource.includes("file.slice("),
  handlesRealtimeRejectedFormat:
    apiSource.includes('result.status === 422') &&
    apiSource.includes('payload.providerStatus === "rejected_format"') &&
    source.includes("setRealtimeRejectedChunks") &&
    source.includes("setRealtimeMaxByteDrift") &&
    source.includes('ack.providerStatus === "rejected_format"') &&
    source.includes('setRealtimeUploadDiagnostic(t("runtime.realtimeFormatRejected"))'),
  showsRealtimeUploadState:
    source.includes("realtimeUploadedChunks") &&
    source.includes("realtimeRejectedChunks") &&
    source.includes("实时已推送") &&
    source.includes("格式拒绝") &&
    source.includes("最大漂移") &&
    source.includes("正式音频") &&
    source.includes("不污染") &&
    source.includes("实时分片上传"),
  warnsWhenLiveTextNeverArrives:
    source.includes("liveRecordingDurationMs >= 60_000") &&
    source.includes("realtimeUploadedChunks >= 3") &&
    source.includes('t("runtime.realtimeTranscriptDelayed")') &&
    i18nSource.includes('realtimeTranscriptDelayed: "音频仍在持续上传'),
  resetsRealtimeChunkBuffer:
    source.includes("resetRealtimePcmBuffer") &&
    source.includes("setRealtimeChunks(0)") &&
    source.includes("setRealtimeUploadedChunks(0)") &&
    source.includes("setRealtimeRejectedChunks(0)") &&
    source.includes("setRealtimeMaxByteDrift(0)") &&
    source.includes("realtimeUploadQueueRef.current.cancelPending()"),
  resetsAppStateInterruptions:
    countOccurrences(source, "setBackgroundInterruptions(0)") >= 2 &&
    countOccurrences(source, "setLastBackgroundAt(null)") >= 2 &&
    source.includes("appStateStatusLabel(AppState.currentState)"),
  persistsPendingRecordingQueue:
    source.includes("pendingRecordings") &&
    source.includes("persistPendingRecording") &&
    recordingStoreSource.includes("index.json") &&
    recordingStoreSource.includes("upsertPendingRecording"),
  restoresPendingRecording:
    source.includes("restorePendingRecording") &&
    source.includes('t("runtime.recoveredPendingRecording"') &&
    source.includes('t("runtime.recoveredUploadedRecording"') &&
    source.includes("audioUploadedAt"),
  closesInterruptedRealtimeBeforeRecoveryUpload:
    source.includes("finishRealtimePcmSessionIfPresent({") &&
    source.indexOf("finishRealtimePcmSessionIfPresent({", source.indexOf("if (target?.activeRecording)")) <
      source.indexOf("activeRecording: false", source.indexOf("if (target?.activeRecording)")),
  retriesFinalizeWithoutReupload:
    source.includes("if (!working.audioUploadedAt)") &&
    source.includes('pendingRecording?.audioUploadedAt ? t("record.retryProcessing") : t("record.retryUpload")') &&
    source.includes('pendingRecording?.finalizedAt ? t("record.regenerate")') &&
    pendingSyncSource.includes("options.force === true && options.onlyMeetingId === recording.meetingId") &&
    source.includes("const finalized = await finalizeMeeting"),
  automaticallyResumesPendingUploads:
    source.includes("syncPendingRecordings") &&
    source.includes("autoSyncRequestRef") &&
    source.includes('networkStatus !== "online"') &&
    source.includes('t("runtime.syncStarting", { count: targets.length })') &&
    source.includes('t("runtime.syncOffline")') &&
    recordingStoreSource.includes("nextRetryAt?: string") &&
    recordingStoreSource.includes("uploadAttempts?: number") &&
    pendingSyncSource.includes("selectPendingSyncTargets") &&
    pendingSyncSource.includes("pendingRetryDelayMs") &&
    pendingSyncSource.includes("15 * 60 * 1000"),
  verifiesPendingFileExists:
    recordingStoreSource.includes("const fileInfo = await probeRecordingFile(recording.uri)") &&
    recordingStoreSource.includes("if (fileInfo.exists)") &&
    recordingStoreSource.includes("withRecordingStoreTimeout(") &&
    recordingStoreSource.includes("audioMimeTypeForUri(recording.uri)"),
  archivesLocalRecordingAfterFinalize:
    source.includes("finalizedAt: finalized.result?.generatedAt") &&
    source.includes("已完成会议的本地音频继续保留") &&
    pendingSyncSource.includes("!recording.finalizedAt") &&
    recordingStoreSource.includes("finalizedAt?: string"),
  clearsPendingRecordingOnAccountDelete:
    source.includes("deleteCurrentAccount") &&
    source.includes("deleteLocalRecordingsForUser(currentUser.id)") &&
    recordingStoreSource.includes("export async function deleteLocalRecordingsForUser") &&
    recordingStoreSource.includes("recording.userId === userId"),
  clearsLocalRecordingOnMeetingDelete:
    deleteSelectedMeetingFlow.includes("deleteMeetingWithConfirmation") &&
    deleteSelectedMeetingFlow.includes("requestDelete: () => deleteMeeting") &&
    deleteSelectedMeetingFlow.includes("const localRecording = pendingRecordingsRef.current.find") &&
    deleteSelectedMeetingFlow.includes("localDeletionPendingAt:") &&
    deleteSelectedMeetingFlow.includes("await deletePendingRecordingAfterRemoteDelete(targetMeetingId, currentUser?.id)") &&
    deleteSelectedMeetingFlow.includes("localCleanupPending = cleanup.pending") &&
    deleteSelectedMeetingFlow.includes("deletion.cleanupPending") &&
    deleteSelectedMeetingFlow.includes("setRecordedUri(null)") &&
    deleteSelectedMeetingFlow.includes("void refreshMeetings()") &&
    deleteSelectedMeetingFlow.includes('Alert.alert(t("meetingDetail.deletedTitle"), deletedBody)'),
  blocksDeletionOnlyForCurrentRecordingLifecycle:
    source.includes("selectedMeetingDeletionBlocked") &&
    source.includes('t("ux.finishRecordingBeforeDelete")') &&
    deleteSelectedMeetingFlow.includes("isMeetingDeletionBlocked({") &&
    deleteSelectedMeetingFlow.includes("currentMeetingId: currentMeetingIdRef.current") &&
    deleteSelectedMeetingFlow.includes("recordingLifecycleBusyRef.current") &&
    source.includes("disabled={shareUpdating || selectedMeetingDeletionBlocked}"),
  preservesCurrentMeetingStateWhenDeletingHistory:
    currentMeetingDeleteResetFlow.includes("setRecordedUri(null)") &&
    currentMeetingDeleteResetFlow.includes("setFinalMeetingResult(null)") &&
    currentMeetingDeleteResetFlow.includes("setFormalMarkdown(null)") &&
    currentMeetingDeleteResetFlow.includes("setSegments([])") &&
    !deleteSelectedMeetingFlow.slice(deleteSelectedMeetingFlow.indexOf("setSelectedMeeting(null)")).includes("setSegments([])"),
  blocksRecordingTimeRecoveryAndAudioExport:
    retryUploadFlow.includes("shouldBlockRecordingSensitiveMutation({") &&
    retryUploadFlow.indexOf("shouldBlockRecordingSensitiveMutation({") <
      retryUploadFlow.indexOf("if (target?.localRecoveryOnly)") &&
    shareAudioFlow.includes("shouldBlockRecordingSensitiveMutation({") &&
    source.includes("{!pendingRecording?.activeRecording || hasInterruptedRecording ? (") &&
    source.includes('disabled={recordingLifecycleBusy} label={hasInterruptedRecording ? t("record.recover")') &&
    source.includes('disabled={recordingLifecycleBusy} label={t("record.exportAudio")}') &&
    i18nSource.includes('recordingActionBlockedBody: "请先结束当前录音'),
  containsPlaybackFailuresInsideAudioCard:
    meetingAudioPlayerFlow.includes("const pauseSafely = useCallback") &&
    meetingAudioPlayerFlow.includes("if (!status.isLoaded || status.error) return") &&
    meetingAudioPlayerFlow.includes("pause: pauseSafely") &&
    meetingAudioPlayerFlow.includes("pauseSafely();") &&
    meetingAudioPlayerFlow.includes("async function togglePlayback()") &&
    meetingAudioPlayerFlow.includes("const nextStatus = player.currentStatus") &&
    countOccurrences(meetingAudioPlayerFlow, "} catch {") >= 4,
  probesLocalAudioBeforeMountingNativePlayer:
    source.includes("selectedMeetingAudioAvailability") &&
    source.includes("FileSystem.getInfoAsync(uri)") &&
    source.includes('info.exists && !info.isDirectory && info.size > 0 ? "available" : "unavailable"') &&
    source.includes('selectedMeetingAudioAvailability === "available"') &&
    source.includes("<LocalAudioErrorBoundary") &&
    source.includes("<MeetingAudioUnavailableCard") &&
    localAudioBoundarySource.includes("static getDerivedStateFromError") &&
    localAudioBoundarySource.includes("this.props.fallback"),
  boundsAndRepairsLocalAudioProbe:
    source.includes('withTimeout(FileSystem.getInfoAsync(uri), 2500, "local audio probe timeout")') &&
    source.includes("async function retrySelectedMeetingLocalAudio()") &&
    source.includes("await restorePendingRecording()") &&
    source.includes("void retrySelectedMeetingLocalAudio()"),
  disablesTranscriptPlaybackWithoutVerifiedAudio:
    source.includes('selectedMeetingAudioAvailability !== "available" || recordingLifecycleBusy') &&
    source.includes('selectedMeetingAudioAvailability !== "available" ||') &&
    source.includes("recordingStopInFlightRef.current"),
  exportsLocalRecording:
    source.includes("shareLocalRecording") &&
    source.includes('t("record.exportAudio")') &&
    source.includes("audioMimeTypeForUri(localUri)") &&
    source.includes("com.microsoft.waveform-audio") &&
    source.includes('withTimeout(FileSystem.getInfoAsync(localUri), 2500, "local audio export probe timeout")') &&
    source.includes("!fileInfo.exists || fileInfo.isDirectory || fileInfo.size <= 0") &&
    source.includes("await Sharing.shareAsync(localUri") &&
    source.includes('Alert.alert(t("meetingDetail.noSystemShareTitle"), t("meetingDetail.noSystemShareAudio"))'),
  checksBackendBeforeRecording: source.includes("checkBackend") && source.includes("检查后端连接"),
  separatesMinimalHealthFromAdminDiagnostics:
    checkAdminDiagnosticsFlow.includes('currentUser?.role !== "admin"') &&
    checkAdminDiagnosticsFlow.includes("fetchReleaseReadinessSummary(targetApiBaseUrl, sessionCookie)") &&
    checkAdminDiagnosticsFlow.includes("fetchProviderDiagnostic(targetApiBaseUrl, sessionCookie)") &&
    checkAdminDiagnosticsFlow.includes("AdminDiagnosticsAccessError") &&
    checkBackendFlow.includes("fetchBackendHealth(targetApiBaseUrl)") &&
    !checkBackendFlow.includes("fetchReleaseReadinessSummary(") &&
    !checkBackendFlow.includes("fetchProviderDiagnostic(") &&
    checkBackendFlow.includes("setReleaseSummary(null)") &&
    checkBackendFlow.includes("setProviderDiagnostic(null)") &&
    source.includes("管理员内部诊断（需要管理员权限）") &&
    source.includes("上线状态") &&
    source.includes("mobileReadinessStageLabel") &&
    source.includes("当前阶段：") &&
    source.includes("本地 MVP 可测不等于 TestFlight 或公开商用可上架") &&
    source.includes('label="MVP"') &&
    source.includes('label="TestFlight"') &&
    source.includes('label="商用"') &&
    source.includes("releaseSummary.mvpReady") &&
    source.includes("releaseSummary.testflightReady") &&
    source.includes("releaseSummary.commercialReady"),
  persistsApiBaseUrl:
    source.includes("apiBaseUrlKey") &&
    source.includes("persistApiBaseUrl") &&
    source.includes("SecureStore.setItemAsync(apiBaseUrlKey") &&
    source.includes('accessibilityLabel="API Base URL"') &&
    source.includes('textContentType="none"') &&
    source.includes('keyboardType="url"') &&
    source.includes('autoComplete="off"') &&
    source.includes('importantForAutofill="no"') &&
    source.includes('secureTextEntry={false}') &&
    source.includes("persistApiBaseUrl(event.nativeEvent.text)") &&
    source.includes("checkBackend(event.nativeEvent.text)") &&
    source.includes("const targetApiBaseUrl = normalizeApiBaseUrl(value)") &&
    source.includes('label={backendChecking ? "检查中" : "保存并检查"}'),
  locksReleaseApiBaseUrl:
    configSource.includes("export const CUSTOM_API_BASE_URL_EDITING_ENABLED = __DEV__") &&
    source.includes("if (!CUSTOM_API_BASE_URL_EDITING_ENABLED)") &&
    source.includes("await SecureStore.deleteItemAsync(apiBaseUrlKey)") &&
    source.includes("CUSTOM_API_BASE_URL_EDITING_ENABLED ?") &&
    !source.includes('<Panel title={t("account.fixedService")}>'),
  clearsEmptyApiBaseUrl: source.includes("SecureStore.deleteItemAsync(apiBaseUrlKey)") && source.includes("if (normalized)"),
  restoresApiBaseUrl: source.includes("restoreApiBaseUrl") && source.includes("apiBaseUrlRestored"),
  resetsApiBaseUrl: source.includes("resetApiBaseUrl") && source.includes("恢复默认地址"),
  normalizesApiBaseUrl: configSource.includes("normalizeApiBaseUrl") && source.includes("normalizeApiBaseUrl(value)"),
  classifiesApiBaseUrlModes:
    configSource.includes('ApiBaseUrlMode = "empty" | "invalid" | "local-simulator" | "lan-development" | "public-http" | "public-https"') &&
    configSource.includes("testflightReady: mode === \"public-https\""),
  warnsAboutTestFlightHttps:
    source.includes("TestFlight 外部测试和 App Store 必须使用公网 HTTPS") &&
    source.includes("getApiBaseUrlGuidance") &&
    source.includes("apiBaseUrlGuidance.detail"),
  readmeSeparatesLocalLanAndPublicHttps:
    mobileReadme.includes("本机模拟器开发默认地址") &&
    mobileReadme.includes("同一 Wi-Fi 下真机开发") &&
    mobileReadme.includes("TestFlight 外部测试") &&
    mobileReadme.includes("必须使用公网 HTTPS") &&
    mobileReadme.includes("后台录音"),
  runbookRequiresPublicHttpsForExternalTestflight:
    testflightRunbook.includes("public HTTPS API origin embedded at archive time") &&
    testflightRunbook.includes("The production UI must not expose an API URL field") &&
    testflightRunbook.includes("do not ask a tester to type a server address") &&
    testflightRunbook.includes(
      "External TestFlight uses localhost, 127.0.0.1, LAN IP, public HTTP, or a manually entered service origin instead of the archive's verified public HTTPS origin.",
    ),
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) {
  process.exitCode = 1;
}

function countOccurrences(input, pattern) {
  return input.split(pattern).length - 1;
}
