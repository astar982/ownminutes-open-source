import crypto from "node:crypto";
import { recordMeetingShareView } from "@/lib/server/meeting-audio-store";

type ShareViewRecorder = typeof recordMeetingShareView;

const analyticsMetricsKey = Symbol.for("ownminutes.meeting-share-analytics-metrics");
const globalAnalyticsMetrics = globalThis as typeof globalThis & {
  [analyticsMetricsKey]?: {
    writeFailures: number;
  };
};

export async function recordMeetingShareViewBestEffort(
  meetingId: string,
  options: {
    record?: ShareViewRecorder;
  } = {},
) {
  try {
    const result = await (options.record ?? recordMeetingShareView)(meetingId);
    return {
      analytics: result.shareAnalytics,
      recorded: result.recorded,
    };
  } catch (error) {
    const metrics = globalAnalyticsMetrics[analyticsMetricsKey] ?? { writeFailures: 0 };
    metrics.writeFailures += 1;
    globalAnalyticsMetrics[analyticsMetricsKey] = metrics;
    console.error("Meeting share analytics write failed.", {
      errorType: error instanceof Error ? error.name : "unknown",
      event: "meeting_share_analytics_write_failed",
      failureCount: metrics.writeFailures,
      meetingRef: crypto.createHash("sha256").update(meetingId).digest("hex").slice(0, 16),
    });
    return {
      analytics: null,
      recorded: false,
    };
  }
}

export function getMeetingShareAnalyticsMetrics() {
  return {
    writeFailures:
      globalAnalyticsMetrics[analyticsMetricsKey]?.writeFailures ?? 0,
  };
}
