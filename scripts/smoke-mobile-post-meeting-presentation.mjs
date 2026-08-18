#!/usr/bin/env node

const { getPostMeetingPresentation } = await import("../apps/mobile/src/post-meeting-presentation.ts");

const saving = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: false, status: "processing" });
const uploading = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: true, status: "processing" });
const generating = getPostMeetingPresentation({ audioUploaded: true, finalized: false, hasLocalRecording: true, status: "processing" });
const waitingForNetwork = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: true, status: "complete" });
const waitingForSummary = getPostMeetingPresentation({ audioUploaded: true, finalized: false, hasLocalRecording: true, status: "complete" });
const uploadRecovery = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: true, status: "error" });
const summaryRecovery = getPostMeetingPresentation({ audioUploaded: true, finalized: false, hasLocalRecording: true, status: "error" });
const finalized = getPostMeetingPresentation({ audioUploaded: true, finalized: true, hasLocalRecording: true, status: "complete" });
const untouched = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: false, status: "idle" });
const savingEnglish = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: false, status: "processing" }, "en");
const uploadRecoveryEnglish = getPostMeetingPresentation({ audioUploaded: false, finalized: false, hasLocalRecording: true, status: "error" }, "en");
const generatingTraditional = getPostMeetingPresentation({ audioUploaded: true, finalized: false, hasLocalRecording: true, status: "processing" }, "zh-Hant");
const waitingForSummaryTraditional = getPostMeetingPresentation({ audioUploaded: true, finalized: false, hasLocalRecording: true, status: "complete" }, "zh-Hant");

const checks = {
  savingIsStepOne: saving?.progress?.step === 1 && saving.progress.title === "正在保存本地录音",
  uploadingIsStepTwo: uploading?.progress?.step === 2 && uploading.progress.title === "正在上传完整音频",
  generatingIsStepThree: generating?.progress?.step === 3 && generating.progress.title === "正在生成正式纪要",
  offlineRecordingWaitsForSync: waitingForNetwork?.statusLabel === "待同步" && waitingForNetwork.hint.includes("本机"),
  uploadedRecordingWaitsForSummary: waitingForSummary?.statusLabel === "待生成" && waitingForSummary.subtitle.includes("正式纪要"),
  failedUploadIsRecoverable: uploadRecovery?.statusLabel === "待恢复" && uploadRecovery.hint.includes("重试上传"),
  failedSummaryIsRecoverable: summaryRecovery?.statusLabel === "待恢复" && summaryRecovery.hint.includes("重试生成纪要"),
  finalizedMeetingUsesResultPresentation: finalized === null,
  untouchedRecorderUsesIdlePresentation: untouched === null,
  simplifiedChineseRemainsDefault: saving?.statusLabel === "处理中" && saving.progress?.title === "正在保存本地录音",
  englishPresentationIsLocalized:
    savingEnglish?.statusLabel === "Processing" &&
    savingEnglish.progress?.title === "Saving the local recording" &&
    uploadRecoveryEnglish?.statusLabel === "Recovery needed" &&
    uploadRecoveryEnglish.hint.includes("Retry upload"),
  traditionalPresentationIsLocalized:
    generatingTraditional?.progress?.title === "正在產生正式紀要" &&
    waitingForSummaryTraditional?.statusLabel === "待產生" &&
    waitingForSummaryTraditional.subtitle.includes("等待產生正式紀要"),
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
