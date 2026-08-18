import type { MeetingStatus } from "./types";
import type { AppLocale } from "./i18n/core";

const copy = {
  en: {
    processing: "Processing",
    savingHint: "Securing the local recording before it uploads automatically.",
    savingDetail: "The full recording is saved safely on this device before network sync begins.",
    savingTitle: "Saving the local recording",
    savingSubtitle: "Safely saving the full recording",
    uploadingHint: "The local recording is safe. Uploading the full audio now.",
    uploadingDetail: "A failed upload never deletes the local recording. Sync can resume when the network returns.",
    uploadingTitle: "Uploading the full audio",
    uploadingSubtitle: "Local recording saved, syncing now",
    summarizingHint: "The full audio is uploaded. Creating the final transcript and meeting notes.",
    summarizingDetail: "OwnMinutes is recognizing the complete audio and organizing the summary, decisions, and action items.",
    summarizingTitle: "Creating final meeting notes",
    summarizingSubtitle: "Full audio uploaded, organizing notes",
    recover: "Recovery needed",
    recoverUploadedHint: "The full audio is uploaded. Retry note generation now; automatic retries will also continue.",
    recoverLocalHint: "The audio is safe on this device. Retry upload now or let sync resume when the network returns.",
    recoverUploadedSubtitle: "Audio uploaded, note generation incomplete",
    recoverLocalSubtitle: "Audio saved locally, sync incomplete",
    pendingGeneration: "Pending notes",
    pendingGenerationHint: "The full audio is uploaded. Final notes will continue processing.",
    pendingGenerationSubtitle: "Audio uploaded, waiting for final notes",
    pendingSync: "Pending sync",
    pendingSyncHint: "The audio is safe on this device and will sync automatically when online.",
    pendingSyncSubtitle: "Audio saved locally, waiting for a connection",
  },
  "zh-Hans": {
    processing: "处理中",
    savingHint: "正在封存本地录音，完成后会自动上传。",
    savingDetail: "完整录音会先安全保存到本机，再进入网络同步。",
    savingTitle: "正在保存本地录音",
    savingSubtitle: "正在安全保存完整录音",
    uploadingHint: "本地录音已保存，正在上传完整音频。",
    uploadingDetail: "上传失败不会删除本地录音，网络恢复后可继续同步。",
    uploadingTitle: "正在上传完整音频",
    uploadingSubtitle: "本地录音已保存，正在同步",
    summarizingHint: "完整音频已上传，正在生成正式逐字稿和会议纪要。",
    summarizingDetail: "系统正在重新识别完整音频，并整理摘要、决策和待办。",
    summarizingTitle: "正在生成正式纪要",
    summarizingSubtitle: "完整音频已上传，正在整理纪要",
    recover: "待恢复",
    recoverUploadedHint: "完整音频已上传，可点击重试生成纪要；系统也会自动重试。",
    recoverLocalHint: "音频已安全保存在本机，可点击重试上传；联网后也会自动续传。",
    recoverUploadedSubtitle: "音频已上传，纪要生成未完成",
    recoverLocalSubtitle: "音频已保存在本机，同步未完成",
    pendingGeneration: "待生成",
    pendingGenerationHint: "完整音频已上传，系统会继续生成正式纪要。",
    pendingGenerationSubtitle: "音频已上传，等待生成正式纪要",
    pendingSync: "待同步",
    pendingSyncHint: "音频已安全保存在本机，联网后会自动续传。",
    pendingSyncSubtitle: "音频已保存在本机，等待联网同步",
  },
  "zh-Hant": {
    processing: "處理中",
    savingHint: "正在封存本機錄音，完成後會自動上傳。",
    savingDetail: "完整錄音會先安全儲存在本機，再進入網路同步。",
    savingTitle: "正在儲存本機錄音",
    savingSubtitle: "正在安全儲存完整錄音",
    uploadingHint: "本機錄音已儲存，正在上傳完整音訊。",
    uploadingDetail: "上傳失敗不會刪除本機錄音，網路恢復後可繼續同步。",
    uploadingTitle: "正在上傳完整音訊",
    uploadingSubtitle: "本機錄音已儲存，正在同步",
    summarizingHint: "完整音訊已上傳，正在產生正式逐字稿和會議紀要。",
    summarizingDetail: "系統正在重新辨識完整音訊，並整理摘要、決策和待辦。",
    summarizingTitle: "正在產生正式紀要",
    summarizingSubtitle: "完整音訊已上傳，正在整理紀要",
    recover: "待復原",
    recoverUploadedHint: "完整音訊已上傳，可點擊重試產生紀要；系統也會自動重試。",
    recoverLocalHint: "音訊已安全儲存在本機，可點擊重試上傳；連線後也會自動續傳。",
    recoverUploadedSubtitle: "音訊已上傳，紀要產生未完成",
    recoverLocalSubtitle: "音訊已儲存在本機，同步未完成",
    pendingGeneration: "待產生",
    pendingGenerationHint: "完整音訊已上傳，系統會繼續產生正式紀要。",
    pendingGenerationSubtitle: "音訊已上傳，等待產生正式紀要",
    pendingSync: "待同步",
    pendingSyncHint: "音訊已安全儲存在本機，連線後會自動續傳。",
    pendingSyncSubtitle: "音訊已儲存在本機，等待網路同步",
  },
} as const;

export type PostMeetingPresentation = {
  hint: string;
  progress?: {
    detail: string;
    step: 1 | 2 | 3;
    title: string;
  };
  statusLabel: string;
  subtitle: string;
};

export function getPostMeetingPresentation(input: {
  audioUploaded: boolean;
  finalized: boolean;
  hasLocalRecording: boolean;
  status: MeetingStatus;
}, locale: AppLocale = "zh-Hans"): PostMeetingPresentation | null {
  const text = copy[locale];
  if (input.status === "processing") {
    if (!input.hasLocalRecording) {
      return {
        hint: text.savingHint,
        progress: {
          detail: text.savingDetail,
          step: 1,
          title: text.savingTitle,
        },
        statusLabel: text.processing,
        subtitle: text.savingSubtitle,
      };
    }
    if (!input.audioUploaded) {
      return {
        hint: text.uploadingHint,
        progress: {
          detail: text.uploadingDetail,
          step: 2,
          title: text.uploadingTitle,
        },
        statusLabel: text.processing,
        subtitle: text.uploadingSubtitle,
      };
    }
    return {
      hint: text.summarizingHint,
      progress: {
        detail: text.summarizingDetail,
        step: 3,
        title: text.summarizingTitle,
      },
      statusLabel: text.processing,
      subtitle: text.summarizingSubtitle,
    };
  }

  if (!input.hasLocalRecording || input.finalized) return null;

  if (input.status === "error") {
    return {
      hint: input.audioUploaded ? text.recoverUploadedHint : text.recoverLocalHint,
      statusLabel: text.recover,
      subtitle: input.audioUploaded ? text.recoverUploadedSubtitle : text.recoverLocalSubtitle,
    };
  }

  return input.audioUploaded
    ? {
        hint: text.pendingGenerationHint,
        statusLabel: text.pendingGeneration,
        subtitle: text.pendingGenerationSubtitle,
      }
    : {
        hint: text.pendingSyncHint,
        statusLabel: text.pendingSync,
        subtitle: text.pendingSyncSubtitle,
      };
}
