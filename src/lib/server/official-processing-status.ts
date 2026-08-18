import { getProviderDiagnostic } from "@/lib/transcription-adapter";

export type OfficialProcessingStatus = "ready" | "unavailable";

export function getOfficialProcessingStatus(): OfficialProcessingStatus {
  const diagnostic = getProviderDiagnostic();

  if (diagnostic.provider === "mock") {
    return process.env.NODE_ENV === "production" ? "unavailable" : "ready";
  }

  return diagnostic.capabilities?.fileAsrReady === true &&
    diagnostic.capabilities.summaryReady === true
    ? "ready"
    : "unavailable";
}
