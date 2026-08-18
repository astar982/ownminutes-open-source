export type TranscriptQualityStatus = "usable" | "low_confidence" | "empty";

export type TranscriptQualityInput = {
  speaker: string;
  text: string;
};

export type TranscriptQualityReport = {
  status: TranscriptQualityStatus;
  usableSegments: number;
  totalSegments: number;
  totalCharacters: number;
  reasons: string[];
};

export function diagnoseTranscriptQuality(transcript: TranscriptQualityInput[]): TranscriptQualityReport {
  const totalSegments = transcript.length;
  const usable = transcript.filter((segment) => {
    const text = cleanupSentence(segment.text);
    if (!text) return false;
    if (segment.speaker === "System") return false;
    return !isPlaceholderTranscriptText(text);
  });
  const totalCharacters = usable.reduce((sum, segment) => sum + cleanupSentence(segment.text).length, 0);
  const reasons: string[] = [];

  if (totalSegments === 0) reasons.push("no transcript segments");
  if (usable.length === 0 && totalSegments > 0) reasons.push("no human speech segments");
  if (transcript.some((segment) => isPlaceholderTranscriptText(segment.text))) reasons.push("placeholder transcript text");
  if (totalCharacters > 0 && totalCharacters < 8) reasons.push("too little transcript text");

  if (totalSegments === 0 || totalCharacters === 0) {
    return {
      status: "empty",
      usableSegments: usable.length,
      totalSegments,
      totalCharacters,
      reasons: reasons.length > 0 ? reasons : ["empty transcript"],
    };
  }

  if (usable.length === 0 || totalCharacters < 8 || reasons.includes("placeholder transcript text")) {
    return {
      status: "low_confidence",
      usableSegments: usable.length,
      totalSegments,
      totalCharacters,
      reasons,
    };
  }

  return {
    status: "usable",
    usableSegments: usable.length,
    totalSegments,
    totalCharacters,
    reasons: [],
  };
}

export function formatTranscriptQualityDiagnostic(report: TranscriptQualityReport) {
  return `Transcript quality ${report.status}: ${report.usableSegments}/${report.totalSegments} usable segments, ${report.totalCharacters} chars${
    report.reasons.length > 0 ? ` (${report.reasons.join("; ")})` : ""
  }.`;
}

export function isPlaceholderTranscriptText(text: string) {
  return /(正式识别尚未完成|等待正式识别配置完成|没有可解析|没有可用逐字稿|音频已保存|fallback transcript|using fallback|未完成)/i.test(text);
}

function cleanupSentence(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
