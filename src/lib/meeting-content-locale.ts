export const MEETING_CONTENT_LOCALES = ["en", "zh-Hans", "zh-Hant"] as const;

export type MeetingContentLocale = (typeof MEETING_CONTENT_LOCALES)[number];

export const DEFAULT_MEETING_CONTENT_LOCALE: MeetingContentLocale = "zh-Hans";

export function resolveMeetingContentLocale(value: string | null | undefined): MeetingContentLocale {
  if (!value) return DEFAULT_MEETING_CONTENT_LOCALE;

  const preferredLanguages = value
    .split(",")
    .map((item) => {
      const [tag, ...parameters] = item.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/i)?.[1])
        .find(Boolean);
      return {
        tag: tag.trim(),
        quality: quality === undefined ? 1 : Number(quality),
      };
    })
    .filter((item) => item.tag && item.quality > 0)
    .sort((left, right) => right.quality - left.quality);

  for (const { tag } of preferredLanguages) {
    const normalized = tag.replace(/_/g, "-").toLowerCase();
    if (normalized === "zh-hant" || normalized.startsWith("zh-hant-") || /^(zh-)?(tw|hk|mo)$/.test(normalized)) return "zh-Hant";
    if (normalized === "zh-hans" || normalized.startsWith("zh-hans-") || /^(zh-)?(cn|sg)$/.test(normalized)) return "zh-Hans";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "zh") return "zh-Hans";
  }

  return DEFAULT_MEETING_CONTENT_LOCALE;
}

type MeetingContentCopy = {
  outputLanguage: string;
  defaultTitle: (meetingId: string) => string;
  summarySystemPrompt: string;
  asrNoSpeechDiagnostic: string;
  asrIncompleteTranscript: string;
  fallbackTranscript: string;
  summaryProviderFailedDiagnostic: string;
  unknown: string;
  unnamedDecision: string;
  unnamedAction: string;
  localSummaryPrefix: string;
  noTranscriptSummary: string;
  defaultTopics: string[];
  conservativeRisk: string;
  setupQuestion: string;
  knowledgeFallback: string;
  noSpeech: {
    summary: string;
    topics: string[];
    risks: string[];
    openQuestions: string[];
    knowledgePoints: string[];
  };
  markdown: {
    summary: string;
    decisions: string;
    actions: string;
    action: string;
    owner: string;
    due: string;
    status: string;
    confirmed: string;
    candidate: string;
    risks: string;
    knowledge: string;
    topics: string;
    speakerViews: string;
    openQuestions: string;
    transcript: string;
    separator: string;
  };
  due: {
    today: string;
    tomorrow: string;
    thisWeek: string;
    nextWeek: string;
    monthEnd: string;
  };
};

const COPY: Record<MeetingContentLocale, MeetingContentCopy> = {
  en: {
    outputLanguage: "English",
    defaultTitle: (meetingId) => `OwnMinutes Meeting ${meetingId}`,
    summarySystemPrompt:
      "You are a rigorous meeting-minutes assistant. Return only valid JSON based on the transcript, with no Markdown or code fences, and never invent unsupported information. Even when the transcript is casual, does not match the title, has no formal decisions, or is very short, summarize what was actually discussed. Never return a refusal or a placeholder such as 'no relevant meeting content' or 'no content'. Write 'Unknown' when an owner, due date, or fact is missing. Write every human-readable field in English.",
    asrNoSpeechDiagnostic: "no-speech: Volcano post-meeting transcription detected no speech that could be used; the audio was preserved so the microphone can be checked before regenerating the minutes.",
    asrIncompleteTranscript: "Formal transcription has not completed. The audio was preserved.",
    fallbackTranscript: "The audio was saved and is waiting for formal transcription to be configured.",
    summaryProviderFailedDiagnostic: "summary_provider_failed: The minutes model is temporarily unavailable; a transcript-grounded local summary was used.",
    unknown: "Unknown",
    unnamedDecision: "Untitled decision",
    unnamedAction: "Untitled action item",
    localSummaryPrefix: "Conservative local summary: ",
    noTranscriptSummary: "The meeting audio was saved, but no usable transcript is available. Configure post-meeting ASR and a summary model, then regenerate the minutes.",
    defaultTopics: ["Meeting recording", "Post-meeting transcription", "Human review"],
    conservativeRisk: "This is a conservative local summary. The transcript and summary quality require human review while model configuration is unavailable.",
    setupQuestion: "Should post-meeting ASR and a summary model be configured to generate more complete minutes?",
    knowledgeFallback: "This result came from a conservative local summary. Complete ASR and summary-model setup before treating it as durable knowledge.",
    noSpeech: {
      summary: "No usable speech was detected in this recording. The audio was safely preserved; check the microphone and regenerate the minutes.",
      topics: ["Recording quality check"],
      risks: ["No usable speech was detected. The room may have been silent, the microphone may have been too far away, or the wrong input device may have been selected."],
      openQuestions: ["Should the microphone be checked and the meeting recorded again?"],
      knowledgePoints: ["This recording did not produce durable meeting knowledge."],
    },
    markdown: {
      summary: "Meeting summary",
      decisions: "Decision log",
      actions: "Action items",
      action: "Action",
      owner: "Owner",
      due: "Due",
      status: "Status",
      confirmed: "Confirmed",
      candidate: "Candidate",
      risks: "Risks and blockers",
      knowledge: "Knowledge to retain",
      topics: "Topics",
      speakerViews: "Speaker views",
      openQuestions: "Open questions",
      transcript: "Transcript",
      separator: ": ",
    },
    due: { today: "Today", tomorrow: "Tomorrow", thisWeek: "This week", nextWeek: "Next week", monthEnd: "End of month" },
  },
  "zh-Hans": {
    outputLanguage: "简体中文",
    defaultTitle: (meetingId) => `OwnMinutes 会议 ${meetingId}`,
    summarySystemPrompt:
      "你是严谨的简体中文会议纪要助手。只基于逐字稿输出纯 JSON，不要 Markdown，不要代码块，不编造没有依据的信息。即使逐字稿是闲聊、与标题不一致、没有正式决策或内容很短，也必须概括实际谈到的内容，不得返回‘无相关会议内容’、‘暂无内容’或拒绝总结。缺失负责人、截止时间或事实时写‘不确定’。所有面向用户的字段都使用简体中文。",
    asrNoSpeechDiagnostic: "no-speech: 火山会后识别未检测到可用人声；本地音频已保留，可检查麦克风后重新生成纪要。",
    asrIncompleteTranscript: "正式识别尚未完成。音频已保留。",
    fallbackTranscript: "音频已保存，等待正式识别配置完成。",
    summaryProviderFailedDiagnostic: "summary_provider_failed: 纪要模型暂时不可用，已使用本地逐字稿约束总结。",
    unknown: "不确定",
    unnamedDecision: "未命名决策",
    unnamedAction: "未命名待办",
    localSummaryPrefix: "本地保守纪要：",
    noTranscriptSummary: "会议音频已保存，但当前没有可用逐字稿。请配置会后 ASR 和总结模型后重新生成正式纪要。",
    defaultTopics: ["会议录音", "会后识别", "人工复核"],
    conservativeRisk: "当前为本地保守纪要，缺少模型配置时需要人工复核转写与总结质量。",
    setupQuestion: "是否需要补充会后 ASR 和总结模型配置，以生成更完整的正式纪要？",
    knowledgeFallback: "当前结果来自本地保守总结，正式知识沉淀前应先完成 ASR 和总结模型配置。",
    noSpeech: {
      summary: "本次录音未检测到可用人声。音频已安全保留，可检查麦克风后重新生成。",
      topics: ["录音质量检查"],
      risks: ["录音中未检测到可用人声，可能是环境静音、麦克风距离过远或输入设备不正确。"],
      openQuestions: ["是否需要检查麦克风并重新录制？"],
      knowledgePoints: ["本次录音未形成可沉淀的会议知识。"],
    },
    markdown: {
      summary: "会议摘要",
      decisions: "决策记录",
      actions: "待办事项",
      action: "事项",
      owner: "负责人",
      due: "截止时间",
      status: "状态",
      confirmed: "已确认",
      candidate: "候选",
      risks: "风险与阻塞",
      knowledge: "可沉淀知识点",
      topics: "主题",
      speakerViews: "发言人观点",
      openQuestions: "未解决问题",
      transcript: "逐字稿",
      separator: "：",
    },
    due: { today: "今天", tomorrow: "明天", thisWeek: "本周", nextWeek: "下周", monthEnd: "月底" },
  },
  "zh-Hant": {
    outputLanguage: "繁體中文",
    defaultTitle: (meetingId) => `OwnMinutes 會議 ${meetingId}`,
    summarySystemPrompt:
      "你是嚴謹的繁體中文會議紀要助理。只根據逐字稿輸出純 JSON，不要 Markdown、不要程式碼區塊，也不要捏造沒有依據的資訊。即使逐字稿是閒聊、與標題不一致、沒有正式決策或內容很短，也必須概括實際談到的內容，不得回傳「沒有相關會議內容」、「暫無內容」或拒絕總結。若負責人、截止時間或事實缺失，請寫「不確定」。所有面向使用者的欄位都使用繁體中文。",
    asrNoSpeechDiagnostic: "no-speech: 火山會後辨識未偵測到可用人聲；音訊已保留，可檢查麥克風後重新產生紀要。",
    asrIncompleteTranscript: "正式辨識尚未完成。音訊已保留。",
    fallbackTranscript: "音訊已儲存，等待完成正式辨識設定。",
    summaryProviderFailedDiagnostic: "summary_provider_failed: 紀要模型暫時無法使用，已改用受逐字稿約束的本機摘要。",
    unknown: "不確定",
    unnamedDecision: "未命名決策",
    unnamedAction: "未命名待辦",
    localSummaryPrefix: "本機保守紀要：",
    noTranscriptSummary: "會議音訊已儲存，但目前沒有可用逐字稿。請設定會後 ASR 與摘要模型後重新產生正式紀要。",
    defaultTopics: ["會議錄音", "會後辨識", "人工複核"],
    conservativeRisk: "目前為本機保守紀要；缺少模型設定時，需要人工複核轉寫與摘要品質。",
    setupQuestion: "是否需要補充會後 ASR 與摘要模型設定，以產生更完整的正式紀要？",
    knowledgeFallback: "目前結果來自本機保守摘要；正式沉澱知識前，應先完成 ASR 與摘要模型設定。",
    noSpeech: {
      summary: "本次錄音未偵測到可用人聲。音訊已安全保留，可檢查麥克風後重新產生紀要。",
      topics: ["錄音品質檢查"],
      risks: ["錄音中未偵測到可用人聲，可能是環境靜音、麥克風距離過遠或輸入裝置不正確。"],
      openQuestions: ["是否需要檢查麥克風並重新錄製？"],
      knowledgePoints: ["本次錄音未形成可沉澱的會議知識。"],
    },
    markdown: {
      summary: "會議摘要",
      decisions: "決策記錄",
      actions: "待辦事項",
      action: "事項",
      owner: "負責人",
      due: "截止時間",
      status: "狀態",
      confirmed: "已確認",
      candidate: "候選",
      risks: "風險與阻塞",
      knowledge: "可沉澱知識點",
      topics: "主題",
      speakerViews: "發言人觀點",
      openQuestions: "未解決問題",
      transcript: "逐字稿",
      separator: "：",
    },
    due: { today: "今天", tomorrow: "明天", thisWeek: "本週", nextWeek: "下週", monthEnd: "月底" },
  },
};

export function getMeetingContentCopy(locale: MeetingContentLocale = DEFAULT_MEETING_CONTENT_LOCALE): MeetingContentCopy {
  return COPY[locale] ?? COPY[DEFAULT_MEETING_CONTENT_LOCALE];
}
