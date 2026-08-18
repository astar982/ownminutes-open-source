import { MeetingAccessError } from "@/lib/server/meeting-errors";
import {
  isUserProcessingMode,
  type MeetingProcessingRoute,
  type UserProcessingMode,
} from "@/lib/processing-route";

export const PROCESSING_MODE_HEADER = "x-ownminutes-processing-mode";

/**
 * Build 11+ clients send an explicit mode captured when recording begins.
 * A missing value is retained only for older clients: the first accepted
 * processing contact freezes the account's current mode, and every later
 * contact, including force-regeneration, reads that frozen route. Missing
 * input must never overwrite an existing binding.
 */
export function parseRequestedMeetingProcessingMode(value: unknown): UserProcessingMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (isUserProcessingMode(value)) return value;
  throw new MeetingAccessError("会议处理方式无效，请重新选择“官方额度”或“自己的模型”。", 400, {
    code: "invalid_meeting_processing_mode",
    retryable: false,
  });
}

export function resolveMeetingProcessingMode(input: {
  accountMode: UserProcessingMode;
  frozenRoute?: MeetingProcessingRoute | null;
  requireFrozenRoute?: boolean;
  requestedMode?: UserProcessingMode;
}): UserProcessingMode {
  if (input.frozenRoute === "hybrid") {
    throw new MeetingAccessError("这场旧会议使用了已停用的混合处理方式，为避免误扣费，请导出录音后新建会议。", 409, {
      code: "legacy_meeting_processing_mode_unavailable",
      retryable: false,
    });
  }

  if (input.frozenRoute) {
    if (input.requestedMode && input.requestedMode !== input.frozenRoute) {
      throw meetingProcessingModeConflict(input.frozenRoute);
    }
    return input.frozenRoute;
  }

  if (input.requireFrozenRoute) {
    throw new MeetingAccessError("这场旧会议缺少可验证的首次处理方式，为避免错误扣费，不能重新生成纪要。请导出录音后新建会议。", 409, {
      code: "meeting_processing_mode_missing",
      retryable: false,
    });
  }

  return input.requestedMode ?? input.accountMode;
}

export function meetingProcessingModeConflict(frozenRoute: UserProcessingMode) {
  const frozenLabel = frozenRoute === "byok" ? "自己的模型" : "官方额度";
  return new MeetingAccessError(`这场会议已固定使用${frozenLabel}，不能在上传或重试中改换处理方式。`, 409, {
    code: "meeting_processing_mode_conflict",
    retryable: false,
  });
}
