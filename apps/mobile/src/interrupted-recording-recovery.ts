export type InterruptedRecordingProbe = {
  exists: boolean;
  firstBytes: number;
  secondBytes: number;
  loaded: boolean;
  durationSeconds: number;
  playbackError?: string | null;
};

export type InterruptedRecordingRecoveryAssessment = {
  recoverable: boolean;
  durationMs?: number;
  reason: "ready" | "missing" | "empty" | "still-growing" | "unreadable" | "duration-missing";
  message: string;
};

const minimumRecoverableBytes = 1024;
const minimumRecoverableDurationSeconds = 0.5;

export function isInterruptedRecordingState(input: {
  activeRecording?: boolean;
  recordingLifecycleBusy: boolean;
}) {
  // A normal stop enters `processing` before the durable index flips
  // activeRecording to false. Treating that brief hand-off as a crash makes
  // the UI offer recovery while the same file is still being finalized.
  return input.activeRecording === true && !input.recordingLifecycleBusy;
}

export function assessInterruptedRecordingRecovery(
  probe: InterruptedRecordingProbe,
): InterruptedRecordingRecoveryAssessment {
  if (!probe.exists) {
    return {
      recoverable: false,
      reason: "missing",
      message: "异常中断录音文件不存在。请勿卸载 App，并联系支持检查本地录音目录。",
    };
  }

  if (probe.firstBytes < minimumRecoverableBytes || probe.secondBytes < minimumRecoverableBytes) {
    return {
      recoverable: false,
      reason: "empty",
      message: "异常中断录音文件过小，暂不上传。原文件会继续保留在设备中。",
    };
  }

  if (probe.firstBytes !== probe.secondBytes) {
    return {
      recoverable: false,
      reason: "still-growing",
      message: "录音文件仍在变化，暂不上传。请稍后再次检查恢复。",
    };
  }

  if (!probe.loaded || probe.playbackError) {
    return {
      recoverable: false,
      reason: "unreadable",
      message: "异常中断录音暂时无法读取，已停止自动上传并保留原文件。可先导出音频留存。",
    };
  }

  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds < minimumRecoverableDurationSeconds) {
    return {
      recoverable: false,
      reason: "duration-missing",
      message: "异常中断录音没有可确认的有效时长，已停止自动上传并保留原文件。",
    };
  }

  return {
    recoverable: true,
    durationMs: Math.max(1_000, Math.round(probe.durationSeconds * 1000)),
    reason: "ready",
    message: "异常中断录音已确认可读取，可以继续上传并生成纪要。",
  };
}
