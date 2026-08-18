#!/usr/bin/env node

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;

async function main() {
  const readinessUrl = `${baseUrl}/api/release/readiness`;
  const unauthenticatedResponse = await fetchReadiness(readinessUrl);
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      "x-forwarded-for": "192.0.2.246",
    },
    body: JSON.stringify({
      name: "Release Readiness Admin",
      email: `release-readiness-${Date.now()}@ownminutes.local`,
      password: `OwnMinutesRelease-${Date.now()}`,
    }),
  });
  const registerPayload = await readJson(registerResponse, "/api/auth/register");
  const cookie = registerResponse.headers.get("set-cookie")?.split(";")[0] || "";
  if (!registerPayload.ok || !cookie) throw new Error("Release readiness smoke could not create its isolated admin.");
  const response = await fetchReadiness(readinessUrl, cookie);
  const payload = await readJson(response, "/api/release/readiness");
  const report = payload.report;
  const groups = report?.groups ?? [];
  const items = groups.flatMap((group) => group.items ?? []);
  const requiredGroups = ["product", "acceptance", "ai", "commercial", "production", "compliance"];
  const itemIds = new Set(items.map((item) => item.id));
  const blockers = report?.blockers ?? [];
  const fileAsrBlocker = blockers.find((blocker) => blocker.id === "file-asr");
  const iosSimulatorItem = items.find((item) => item.id === "ios-simulator-ui-smoke");
  const iosTestFlightEvidenceItem = items.find((item) => item.id === "ios-testflight-evidence-smoke");
  const recordingEvidenceItem = items.find((item) => item.id === "recording-long-test-evidence-smoke");
  const summaryEvidenceItem = items.find((item) => item.id === "summary-evidence-smoke");
  const mobileRealtimeItem = items.find((item) => item.id === "mobile-realtime-chunks-smoke");
  const finalizationRecoveryItem = items.find((item) => item.id === "finalization-recovery-smoke");
  const providerClosedLoopItem = items.find((item) => item.id === "provider-closed-loop-smoke");
  const remoteStorageItem = items.find((item) => item.id === "remote-object-storage-smoke");
  const sourceText = await import("node:fs").then((fs) => fs.readFileSync("src/lib/release-readiness.ts", "utf8"));
  const mobileRealtimeSmokeSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/smoke-mobile-realtime-chunks.mjs", "utf8"));
  const asrAcceptanceCheckerSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/check-asr-acceptance-evidence.mjs", "utf8"));
  const asrAcceptanceTemplateSource = await import("node:fs").then((fs) => fs.readFileSync("docs/asr-acceptance-evidence-template.md", "utf8"));
  const asrMeetingBatchCheckerSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/check-asr-meeting-batch-evidence.mjs", "utf8"));
  const iosEvidenceCheckerSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/check-ios-testflight-acceptance-evidence.mjs", "utf8"));
  const iosEvidenceSmokeSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/smoke-ios-testflight-acceptance-evidence.mjs", "utf8"));
  const recordingEvidenceCheckerSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/check-recording-acceptance-evidence.mjs", "utf8"));
  const recordingEvidenceSmokeSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/smoke-recording-acceptance-evidence.mjs", "utf8"));
  const summaryEvidenceCheckerSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/check-summary-acceptance-evidence.mjs", "utf8"));
  const summaryEvidenceSmokeSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/smoke-summary-acceptance-evidence.mjs", "utf8"));
  const finalizationRecoverySmokeSource = await import("node:fs").then((fs) => fs.readFileSync("scripts/smoke-finalization-recovery.mjs", "utf8"));
  const screenshotExists = await import("node:fs").then((fs) => fs.existsSync(".data/screenshots/ownminutes-ios-simulator-latest.png"));
  const runbookPaths = new Set(blockers.map((blocker) => blocker.runbook?.path).filter(Boolean));
  const speakerDiarizationBlocker = blockers.find((blocker) => blocker.id === "speaker-diarization");
  const blockerById = new Map(blockers.map((blocker) => [blocker.id, blocker]));
  const fileAsrProductionEvidenceMarkers = [
    "OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE",
    "OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY",
    "OWNMINUTES_ASR_FALLBACK_POLICY",
    "OWNMINUTES_ASR_PRIVACY_POLICY",
    "OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH",
  ];
  const blockerVerificationEvidenceReady = [
    ["file-asr", "smoke:asr-meeting-batch", "asr:meeting-batch:check", "asr:meeting-batch:collect"],
    ["summary-model", "smoke:summary-evidence", "summary:acceptance:evidence", "summary:acceptance:evidence:draft"],
    ["speaker-diarization", "smoke:asr-meeting-batch", "asr:meeting-batch:check", "asr:meeting-batch:collect"],
    ["payments", "smoke:iap-evidence", "iap:acceptance:evidence", "iap:acceptance:evidence:draft"],
    ["database", "smoke:database-evidence", "database:acceptance:evidence", "database:evidence:draft"],
    ["object-storage", "smoke:storage-evidence", "storage:acceptance:evidence", "storage:evidence:draft"],
    ["secret-management", "smoke:secret-evidence", "secret:acceptance:evidence", "secret:evidence:draft"],
    ["public-url", "smoke:deployment-evidence", "deployment:acceptance:evidence", "deployment:evidence:draft"],
  ].every(([id, smokeCommand, acceptanceCommand, draftCommand]) => {
    const blocker = blockerById.get(id);
    if (!blocker) return true;
    const command = blocker.verificationCommand ?? "";
    return command.includes(smokeCommand) && command.includes(acceptanceCommand) && (!draftCommand || command.includes(draftCommand)) && command.includes(".data/acceptance/");
  });
  const summary = {
    ok: payload.ok === true,
    adminRouteProtected:
      unauthenticatedResponse.status === 401 &&
      unauthenticatedResponse.headers.get("cache-control")?.includes("no-store") === true,
    exposesTopLevelSummary:
      JSON.stringify(payload.summary) === JSON.stringify(report?.summary) &&
      JSON.stringify(payload.blockers) === JSON.stringify(report?.blockers) &&
      JSON.stringify(payload.nextAction) === JSON.stringify(report?.nextAction),
    exposesGeneratedAt: typeof payload.generatedAt === "string" && payload.generatedAt === report?.generatedAt,
    groupCount: groups.length,
    itemCount: items.length,
    blockerCount: blockers.length,
    criticalBlocked: report?.summary?.criticalBlocked,
    hasNextAction: Boolean(report?.nextAction?.title && report?.nextAction?.nextAction),
    blockerPrioritiesValid: blockers.every((blocker) => ["critical", "high", "medium"].includes(blocker.priority)),
    blockersHaveAcceptanceEvidence: blockers.every((blocker) => typeof blocker.acceptanceEvidence === "string" && blocker.acceptanceEvidence.length > 20),
    blockersHaveVerificationCommands: blockers.every((blocker) => typeof blocker.verificationCommand === "string" && blocker.verificationCommand.startsWith("npm run ")),
    blockerVerificationEvidenceReady,
    fileAsrRequiresProductionEvidence:
      Boolean(fileAsrBlocker) &&
      fileAsrProductionEvidenceMarkers.some((marker) => fileAsrBlocker?.evidence?.includes(marker)) &&
      fileAsrBlocker?.verificationCommand?.includes("smoke:asr-meeting-batch") &&
      fileAsrBlocker?.verificationCommand?.includes("asr:meeting-batch:check") &&
      fileAsrBlocker?.verificationCommand?.includes(".data/acceptance/asr-meeting-batch-latest.json"),
    fileAsrReadinessNotRuntimeOnly:
      sourceText.includes("getFileAsrProductionReadiness") &&
      sourceText.includes("fileAsrRuntimeReady") &&
      sourceText.includes("OWNMINUTES_ASR_REAL_AUDIO_EVIDENCE") &&
      sourceText.includes("OWNMINUTES_ASR_QUALITY_SAMPLING_POLICY") &&
      sourceText.includes("OWNMINUTES_ASR_FALLBACK_POLICY") &&
      sourceText.includes("OWNMINUTES_ASR_PRIVACY_POLICY") &&
      sourceText.includes("getAsrMeetingBatchReadiness") &&
      sourceText.includes("ASR_MEETING_BATCH_AUDIO_HASH_PROVIDER_BINDING") &&
      sourceText.includes("ASR_MEETING_BATCH_MANUAL_QUALITY_REVIEW") &&
      !sourceText.includes("const fileAsrReady = Boolean(providerDiagnostic.capabilities?.fileAsrReady ?? providerDiagnostic.ready);"),
    fileAsrRuntimeEndpointAndTurboCostGuardAligned:
      sourceText.includes("const primaryResourceIsTurbo = isTurboAsrResource(primaryResourceId);") &&
      sourceText.includes('strategy === "single" && (mode === "flash" || primaryResourceIsTurbo)') &&
      sourceText.includes('mode === "standard" && primaryResourceIsTurbo') &&
      sourceText.includes("turboCostGuardRequired && fallbackEnabled !== \"1\"") &&
      sourceText.includes("isOfficialVolcanoRuntimeEndpoint(recognizeUrl)") &&
      sourceText.includes("isOfficialVolcanoRuntimeEndpoint(submitUrl)") &&
      sourceText.includes("isOfficialVolcanoRuntimeEndpoint(queryUrl)") &&
      sourceText.includes("isOfficialVolcanoRuntimeEndpoint(fallbackRecognizeUrl)") &&
      sourceText.includes('url.hostname === "openspeech.bytedance.com"') &&
      sourceText.includes("!url.port") &&
      sourceText.includes("!url.username") &&
      sourceText.includes("!url.password") &&
      sourceText.includes("!url.hash"),
    hasSpeakerDiarizationBlocker:
      itemIds.has("speaker-diarization") &&
      Boolean(speakerDiarizationBlocker) &&
      speakerDiarizationBlocker?.priority === "critical" &&
      speakerDiarizationBlocker?.evidence?.includes("OWNMINUTES_SPEAKER_DIARIZATION_REAL_AUDIO_EVIDENCE") &&
      speakerDiarizationBlocker?.evidence?.includes("OWNMINUTES_SPEAKER_RENAME_WORKFLOW") &&
      speakerDiarizationBlocker?.nextAction?.includes("会后改名") &&
      speakerDiarizationBlocker?.verificationCommand?.includes("smoke:asr-acceptance") &&
      sourceText.includes("getSpeakerDiarizationReadiness") &&
      sourceText.includes("OWNMINUTES_SPEAKER_DIARIZATION_QUALITY_SAMPLING_POLICY") &&
      sourceText.includes("OWNMINUTES_SPEAKER_ASSIGNMENT_FALLBACK_POLICY") &&
      sourceText.includes("OWNMINUTES_SPEAKER_LIMITATION_NOTICE") &&
      sourceText.includes("speakerCorrectionWorkflowReady") &&
      sourceText.includes("src/components/meeting-transcript-speaker-editor.tsx") &&
      sourceText.includes("speakerSegmentCorrectionVerified"),
    asrAcceptanceRequiresRealtimeFinalBoundary:
      asrAcceptanceCheckerSource.includes('"Realtime draft clearly labeled: yes"') &&
      asrAcceptanceCheckerSource.includes('"Realtime draft not published as formal transcript: yes"') &&
      asrAcceptanceCheckerSource.includes('"Post-meeting transcript reprocessed from full audio: yes"') &&
      asrAcceptanceCheckerSource.includes('"Post-meeting transcript quality better than realtime draft: yes"') &&
      asrAcceptanceCheckerSource.includes('"Final summary uses post-meeting transcript: yes"') &&
      asrAcceptanceCheckerSource.includes("hasRealtimeBoundaryRows") &&
      asrAcceptanceTemplateSource.includes("Realtime vs post-meeting boundary") &&
      asrAcceptanceTemplateSource.includes("Realtime result") &&
      asrAcceptanceTemplateSource.includes("Final reprocessed full audio") &&
      asrAcceptanceTemplateSource.includes("Realtime not published as formal"),
    asrAcceptanceRequiresStructuredRealMeetingBatch:
      asrAcceptanceCheckerSource.includes("validateAsrMeetingBatchEvidence") &&
      asrAcceptanceCheckerSource.includes("meetingBatchValidation.ok") &&
      asrAcceptanceTemplateSource.includes("## Structured Meeting Batch") &&
      asrAcceptanceTemplateSource.includes("at least three different real Mandarin meetings") &&
      asrMeetingBatchCheckerSource.includes("validateAsrMeetingBatchEvidence") &&
      asrAcceptanceCheckerSource.includes("Speaker segment assignment correction verified: yes") &&
      sourceText.includes("getAsrMeetingBatchReadiness") &&
      sourceText.includes("ASR_MEETING_BATCH_NO_RAW_TRANSCRIPT_OR_AUDIO"),
    iosSimulatorEvidenceTracked:
      itemIds.has("ios-simulator-ui-smoke") &&
      sourceText.includes("getIosSimulatorScreenshotEvidence") &&
      sourceText.includes("readPngDimensions") &&
      sourceText.includes(".data/screenshots/ownminutes-ios-simulator-latest.png") &&
      sourceText.includes("Expo Go 开发浮层") &&
      (!screenshotExists ||
        (iosSimulatorItem?.evidence?.includes(".data/screenshots/ownminutes-ios-simulator-latest.png") &&
          /\d+x\d+/.test(iosSimulatorItem.evidence) &&
          iosSimulatorItem.evidence.includes("更新于") &&
          iosSimulatorItem.evidence.includes("Expo Go 开发浮层") &&
          iosSimulatorItem.evidence.includes("正式 TestFlight/App Store 包不会显示"))),
    iosTestFlightEvidenceRequiresRuntimeQuality:
      itemIds.has("ios-testflight-evidence-smoke") &&
      iosTestFlightEvidenceItem?.detail?.includes("崩溃状态") &&
      iosTestFlightEvidenceItem?.evidence?.includes("音频回放") &&
      iosTestFlightEvidenceItem?.evidence?.includes("转写/纪要边界") &&
      iosTestFlightEvidenceItem?.evidence?.includes("ios:testflight:evidence:draft") &&
      iosTestFlightEvidenceItem?.nextAction?.includes("ios:testflight:evidence:draft") &&
      iosEvidenceCheckerSource.includes('"Distribution:"') &&
      iosEvidenceCheckerSource.includes("OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_DRAFT_PATH") &&
      iosEvidenceCheckerSource.includes("draftDecision") &&
      iosEvidenceCheckerSource.includes('"Install source:"') &&
      iosEvidenceCheckerSource.includes('"App launch: pass"') &&
      iosEvidenceCheckerSource.includes('"API Base URL persisted: pass"') &&
      iosEvidenceCheckerSource.includes('"Microphone permission: pass"') &&
      iosEvidenceCheckerSource.includes('"Crash observed: no"') &&
      iosEvidenceCheckerSource.includes('"Memory/battery observation:"') &&
      iosEvidenceCheckerSource.includes('"Audio playback: pass"') &&
      iosEvidenceCheckerSource.includes('"Transcript/summary boundary: pass"') &&
      iosEvidenceSmokeSource.includes("draftRejectedUntilManualChecks") &&
      iosEvidenceSmokeSource.includes("draftGenerated") &&
      iosEvidenceSmokeSource.includes("Distribution: Expo Go") &&
      iosEvidenceSmokeSource.includes("Memory/battery observation: stable during smoke fixture"),
    secretEvidenceRequiresDraft:
      sourceText.includes("secret:evidence:draft") &&
      sourceText.includes("secret:vault:live:verify") &&
      sourceText.includes("OWNMINUTES_SECRET_EVIDENCE_PATH=.data/acceptance/secret-management-latest.md") &&
      sourceText.includes("OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH=.data/acceptance/vault-transit-live-latest.json") &&
      sourceText.includes("24 小时有效") &&
      sourceText.includes("在真实 Vault 环境"),
    recordingEvidenceRequiresDurabilityProof:
      itemIds.has("recording-long-test-evidence-smoke") &&
      recordingEvidenceItem?.detail?.includes("上传完成后再 finalize") &&
      recordingEvidenceItem?.evidence?.includes("音频文件") &&
      recordingEvidenceItem?.evidence?.includes("转写/纪要边界") &&
      recordingEvidenceCheckerSource.includes('"Started at:"') &&
      recordingEvidenceCheckerSource.includes('"Stopped at:"') &&
      recordingEvidenceCheckerSource.includes('"Timer reached expected duration: pass"') &&
      recordingEvidenceCheckerSource.includes('"Local audio URI/file exists: pass"') &&
      recordingEvidenceCheckerSource.includes('"Finalize waited for upload completion: pass"') &&
      recordingEvidenceCheckerSource.includes('"Crash or tab freeze observed: no"') &&
      recordingEvidenceCheckerSource.includes('"Memory/battery observation:"') &&
      recordingEvidenceCheckerSource.includes('"Transcript boundary: pass"') &&
      recordingEvidenceCheckerSource.includes('"Summary boundary: pass"') &&
      recordingEvidenceCheckerSource.includes('"Recovery after restart/reopen: pass"') &&
      recordingEvidenceSmokeSource.includes("Memory/battery observation: stable during smoke fixture"),
    summaryEvidenceRequiresGroundingProof:
      itemIds.has("summary-evidence-smoke") &&
      summaryEvidenceItem?.detail?.includes("抽样引用") &&
      summaryEvidenceItem?.evidence?.includes("至少 3 条逐字稿样本") &&
      summaryEvidenceItem?.evidence?.includes("至少 5 条 grounding 样本") &&
      summaryEvidenceCheckerSource.includes('"Transcript quality:"') &&
      summaryEvidenceCheckerSource.includes('"Transcript sample count:"') &&
      summaryEvidenceCheckerSource.includes('"Grounding sample count:"') &&
      summaryEvidenceCheckerSource.includes('"Low confidence policy:"') &&
      summaryEvidenceCheckerSource.includes('"Schema validation:"') &&
      summaryEvidenceCheckerSource.includes('"Field coverage:"') &&
      summaryEvidenceCheckerSource.includes('"Citation samples recorded:"') &&
      summaryEvidenceCheckerSource.includes('"Low confidence handled:"') &&
      summaryEvidenceCheckerSource.includes('"No placeholder transcript used:"') &&
      summaryEvidenceCheckerSource.includes('"No fallback summary presented as verified:"') &&
      summaryEvidenceCheckerSource.includes('"Repeat generation delta within threshold:"') &&
      summaryEvidenceSmokeSource.includes('"Grounding sample count": "5"') &&
      summaryEvidenceSmokeSource.includes('"Low confidence policy"'),
    mobileRealtimeRequiresRejectedFormatProof:
      itemIds.has("mobile-realtime-chunks-smoke") &&
      mobileRealtimeItem?.detail?.includes("rejected_format") &&
      mobileRealtimeItem?.evidence?.includes("失败隔离") &&
      mobileRealtimeSmokeSource.includes("invalidRealtimeTracked") &&
      mobileRealtimeSmokeSource.includes("rejectedRealtimeStatusReadable") &&
      mobileRealtimeSmokeSource.includes("formatMismatchCount") &&
      mobileRealtimeSmokeSource.includes("maxAbsByteDrift") &&
      mobileRealtimeSmokeSource.includes("rejected_format"),
    finalizationRecoveryGateReady:
      finalizationRecoveryItem?.status === "ready" &&
      finalizationRecoveryItem?.detail?.includes("并发请求去重") &&
      finalizationRecoveryItem?.detail?.includes("未验证纪要") &&
      finalizationRecoverySmokeSource.includes("concurrentRequestsDeduplicated") &&
      finalizationRecoverySmokeSource.includes("idempotentRetryReturnsExistingResult") &&
      finalizationRecoverySmokeSource.includes("idempotentRecoveryDoesNotNeedAudioObject") &&
      finalizationRecoverySmokeSource.includes("usageChargedOnce") &&
      finalizationRecoverySmokeSource.includes("unverifiedShareRequiresApiConfirmation") &&
      finalizationRecoverySmokeSource.includes("failedStateIsDurableAndRetryable") &&
      finalizationRecoverySmokeSource.includes("failedMeetingRecoversAfterAudioRestore") &&
      finalizationRecoverySmokeSource.includes("processingFileLifecycle"),
    providerClosedLoopGateReady:
      providerClosedLoopItem?.status === "ready" &&
      providerClosedLoopItem?.detail?.includes("火山正式转写") &&
      providerClosedLoopItem?.detail?.includes("临时 Obsidian Vault") &&
      providerClosedLoopItem?.evidence?.includes("provider-closed-loop-latest.md") &&
      sourceText.includes('id: "provider-closed-loop-smoke"') &&
      sourceText.includes('packageScriptExists("smoke:provider-closed-loop-script")'),
    realStorageVerifierGateReady:
      remoteStorageItem?.status === "ready" &&
      remoteStorageItem?.detail?.includes("真实云桶 verifier") &&
      remoteStorageItem?.evidence?.includes("OWNMINUTES_REAL_OBJECT_STORAGE_ACCEPTANCE=1") &&
      sourceText.includes('packageScriptExists("storage:real:verify")') &&
      sourceText.includes('packageScriptExists("smoke:storage-real-verifier")'),
    criticalBlockersHaveRunbooks: blockers
      .filter((blocker) => blocker.priority === "critical")
      .every((blocker) => Boolean(blocker.runbook?.label && blocker.runbook?.path)),
    hasExpectedRunbooks: [
      "docs/asr-runtime-runbook.md",
      "docs/postgres-migration-runbook.md",
      "docs/object-storage-runbook.md",
      "docs/secret-management-runbook.md",
      "docs/apple-iap-sandbox-runbook.md",
      "docs/public-deployment-runbook.md",
    ].every((path) => runbookPaths.has(path)),
    hasRequiredGroups: requiredGroups.every((id) => groups.some((group) => group.id === id)),
    hasCriticalItems: [
      "app-workspace-smoke",
      "recording-consent-smoke",
      "manual-acceptance-script",
      "manual-acceptance-export",
      "account-page-smoke",
      "account-deletion-smoke",
      "pricing-page-smoke",
      "recording-long-test-runbook",
      "recording-long-test-evidence-smoke",
      "meetings-closed-loop-smoke",
      "share-confirmation-smoke",
      "obsidian-vault-smoke",
      "settings-provider-smoke",
      "asr-diagnostics-smoke",
      "asr-production-preflight-smoke",
      "asr-runtime-runbook",
      "asr-sample-transcription-smoke",
      "provider-closed-loop-smoke",
      "asr-acceptance-evidence-smoke",
      "asr-acceptance-private-evidence-smoke",
      "email-diagnostics-smoke",
      "email-production-preflight-smoke",
      "postgres-migration-smoke",
      "postgres-production-preflight-smoke",
      "postgres-evidence-smoke",
      "secret-management-smoke",
      "secret-management-production-preflight-smoke",
      "secret-management-evidence-smoke",
      "apple-iap-endpoints-smoke",
      "apple-iap-verifier-smoke",
      "apple-iap-production-preflight-smoke",
      "entitlement-billing-guard-smoke",
      "apple-iap-sandbox-runbook",
      "apple-iap-evidence-smoke",
      "deployment-diagnostics-smoke",
      "public-deployment-runbook",
      "public-deployment-evidence-smoke",
      "remote-object-storage-smoke",
      "object-storage-production-preflight-smoke",
      "object-storage-evidence-smoke",
      "mobile-ui-smoke",
      "ios-simulator-ui-smoke",
      "testflight-config-smoke",
      "testflight-preflight-smoke",
      "ios-appstore-upload-smoke",
      "ios-testflight-runbook",
      "ios-testflight-evidence-smoke",
      "mobile-stability-smoke",
      "mobile-realtime-chunks-smoke",
      "summary-production-preflight-smoke",
      "summary-evidence-smoke",
      "transcript-quality-smoke",
      "meeting-result-quality-smoke",
      "finalization-recovery-smoke",
      "file-asr",
      "realtime-asr",
      "speaker-diarization",
      "database",
      "object-storage",
      "payments",
      "legal-pages",
      "data-deletion",
    ].every((id) => itemIds.has(id)),
    acceptanceSmokeReady: [
      "app-workspace-smoke",
      "recording-consent-smoke",
      "manual-acceptance-script",
      "manual-acceptance-export",
      "account-page-smoke",
      "account-deletion-smoke",
      "pricing-page-smoke",
      "recording-long-test-runbook",
      "recording-long-test-evidence-smoke",
      "meetings-closed-loop-smoke",
      "share-confirmation-smoke",
      "obsidian-vault-smoke",
      "settings-provider-smoke",
      "asr-diagnostics-smoke",
      "asr-production-preflight-smoke",
      "asr-runtime-runbook",
      "asr-sample-transcription-smoke",
      "provider-closed-loop-smoke",
      "asr-acceptance-evidence-smoke",
      "asr-acceptance-private-evidence-smoke",
      "email-diagnostics-smoke",
      "email-production-preflight-smoke",
      "postgres-migration-smoke",
      "postgres-production-preflight-smoke",
      "postgres-evidence-smoke",
      "secret-management-smoke",
      "secret-management-production-preflight-smoke",
      "secret-management-evidence-smoke",
      "apple-iap-endpoints-smoke",
      "apple-iap-verifier-smoke",
      "apple-iap-production-preflight-smoke",
      "entitlement-billing-guard-smoke",
      "apple-iap-sandbox-runbook",
      "apple-iap-evidence-smoke",
      "deployment-diagnostics-smoke",
      "public-deployment-runbook",
      "public-deployment-evidence-smoke",
      "remote-object-storage-smoke",
      "object-storage-production-preflight-smoke",
      "object-storage-evidence-smoke",
      "mobile-ui-smoke",
      "ios-simulator-ui-smoke",
      "testflight-config-smoke",
      "testflight-preflight-smoke",
      "ios-appstore-upload-smoke",
      "ios-testflight-runbook",
      "ios-testflight-evidence-smoke",
      "mobile-stability-smoke",
      "mobile-realtime-chunks-smoke",
      "summary-production-preflight-smoke",
      "summary-evidence-smoke",
      "transcript-quality-smoke",
      "meeting-result-quality-smoke",
      "legal-pages",
      "data-deletion",
    ].every((id) => items.some((item) => item.id === id && item.status === "ready")),
    hasBlockedItems: Number(report?.summary?.blocked ?? 0) > 0,
    mvpReady: report?.summary?.mvpReady,
    testflightReady: report?.summary?.testflightReady,
    commercialReady: report?.summary?.commercialReady,
    hasLayeredReadinessBooleans:
      typeof report?.summary?.mvpReady === "boolean" &&
      typeof report?.summary?.testflightReady === "boolean" &&
      typeof report?.summary?.commercialReady === "boolean",
    statusesValid: items.every((item) => ["ready", "warning", "blocked"].includes(item.status)),
    leaksSecrets: JSON.stringify(payload).includes("AKL") || JSON.stringify(payload).includes("Secret Access Key") || JSON.stringify(payload).includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.ok ||
    !summary.adminRouteProtected ||
    !summary.exposesTopLevelSummary ||
    !summary.exposesGeneratedAt ||
    summary.groupCount < 5 ||
    summary.itemCount < 12 ||
    summary.blockerCount < 1 ||
    typeof summary.criticalBlocked !== "number" ||
    summary.criticalBlocked < 1 ||
    !summary.hasNextAction ||
    !summary.blockerPrioritiesValid ||
    !summary.blockersHaveAcceptanceEvidence ||
    !summary.blockersHaveVerificationCommands ||
    !summary.blockerVerificationEvidenceReady ||
    !summary.fileAsrRequiresProductionEvidence ||
    !summary.fileAsrReadinessNotRuntimeOnly ||
    !summary.fileAsrRuntimeEndpointAndTurboCostGuardAligned ||
    !summary.hasSpeakerDiarizationBlocker ||
    !summary.asrAcceptanceRequiresRealtimeFinalBoundary ||
    !summary.asrAcceptanceRequiresStructuredRealMeetingBatch ||
    !summary.iosSimulatorEvidenceTracked ||
    !summary.iosTestFlightEvidenceRequiresRuntimeQuality ||
    !summary.secretEvidenceRequiresDraft ||
    !summary.recordingEvidenceRequiresDurabilityProof ||
    !summary.summaryEvidenceRequiresGroundingProof ||
    !summary.mobileRealtimeRequiresRejectedFormatProof ||
    !summary.finalizationRecoveryGateReady ||
    !summary.providerClosedLoopGateReady ||
    !summary.realStorageVerifierGateReady ||
    !summary.criticalBlockersHaveRunbooks ||
    !summary.hasExpectedRunbooks ||
    !summary.hasRequiredGroups ||
    !summary.hasCriticalItems ||
    !summary.acceptanceSmokeReady ||
    !summary.hasBlockedItems ||
    summary.mvpReady !== true ||
    summary.testflightReady !== false ||
    summary.commercialReady !== false ||
    !summary.hasLayeredReadinessBooleans ||
    !summary.statusesValid ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

async function fetchReadiness(url, cookie) {
  try {
    return await fetch(url, {
      cache: "no-store",
      headers: cookie ? { Cookie: cookie } : undefined,
    });
  } catch (error) {
    const cause = error?.cause;
    const connectionRefused = cause?.code === "ECONNREFUSED";
    const host = new URL(url).origin;
    const hint = connectionRefused
      ? `Release readiness smoke 需要本地预览服务。请先运行：npm run preview:screen，然后重试：SMOKE_BASE_URL=${host} npm run smoke:release`
      : `Release readiness smoke 无法访问 ${host}。请检查 SMOKE_BASE_URL、网络和本地服务状态。`;
    throw new Error(`${hint}\n原始错误：${error.message}`);
  }
}

async function readJson(response, path) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
