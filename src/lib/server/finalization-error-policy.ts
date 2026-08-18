export type PublicFinalizationFailure = {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
};

export function classifyFinalizationFailure(error: unknown): PublicFinalizationFailure {
  const message = error instanceof Error ? error.message : String(error || "");

  if (/normalization timed out|transcod(?:e|ing).*timed out|音频时长检测超时/i.test(message)) {
    return failure(
      "audio_processing_temporary_failure",
      "录音处理超时，原始音频仍已保留。请稍后重新生成纪要。",
      true,
      503,
    );
  }

  if (
    /normalization is unavailable|ffmpeg.*(?:ENOENT|not found)|spawn\s+\S+\s+ENOENT|服务端暂时无法校验音频时长/i.test(
      message,
    )
  ) {
    return failure(
      "audio_processing_unavailable",
      "服务器暂时无法处理录音格式，原始音频仍已保留。请稍后重试。",
      false,
      503,
    );
  }

  if (
    /audio file normalization failed|audio.*(?:decode|format).*failed|invalid data found|EBML header parsing failed|normalized audio exceeds|produced an empty file|无法读取音频时长|请确认音频文件完整/i.test(
      message,
    )
  ) {
    return failure(
      "audio_processing_failed",
      "录音文件无法解码或格式不受支持。原始音频仍已保留，可检查录音后重试。",
      false,
      422,
    );
  }

  if (/no audio chunks|stored meeting audio.*(?:manifest|length|assembly)|recording.*(?:incomplete|corrupt)|missing audio/i.test(message)) {
    return failure(
      "recording_incomplete",
      "录音尚未完整保存，暂时不能生成正式纪要。请先完成音频同步后重试。",
      true,
      409,
    );
  }

  if (
    /config is incomplete|unauthori[sz]ed|forbidden|invalid credentials?|credentials? (?:missing|expired)|api key|access token|requested grant|permission denied|HTTP\s+(?:401|403)/i.test(
      message,
    )
  ) {
    return failure(
      "provider_configuration_invalid",
      "语音识别服务配置不可用。原始音频仍已保留，请检查模型配置后重试。",
      false,
      503,
    );
  }

  if (
    /timeout|timed out|abort|network|fetch|ECONN|EAI_AGAIN|ENOENT|not found|HTTP\s+429|HTTP\s+5\d\d|status\s+45000000|quota|concurr|temporar|unavailable/i.test(
      message,
    )
  ) {
    return failure(
      "provider_or_storage_temporary_failure",
      "会后处理服务暂时不可用，原始音频仍已保留。请稍后重新生成纪要。",
      true,
      503,
    );
  }

  return failure(
    "processing_failed",
    "正式纪要生成失败，原始音频仍已保留。请稍后重试。",
    false,
    500,
  );
}

export function sanitizeFinalizationMessage(value: string) {
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/https?:\/\/[^\s,;)'\"]+/gi, "[redacted-url]")
    .replace(/(?:^|\s)(?:\/(?:Users|private|var|tmp|home|app)\/)[^\s,;)'\"]+/g, " [redacted-path]")
    .replace(/[A-Za-z]:\\[^\s,;)'\"]+/g, "[redacted-path]")
    .replace(/AKL[A-Za-z0-9_-]+/g, "[redacted-access-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/(X-Api-(?:Key|Access-Key)[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(X-Amz-(?:Credential|Signature|Security-Token)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function failure(code: string, message: string, retryable: boolean, status: number): PublicFinalizationFailure {
  return { code, message, retryable, status };
}
