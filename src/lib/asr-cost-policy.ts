export type OfficialTurboFallbackDecision =
  | { allowed: true; maxAudioMinutes: number; reason: "not_turbo_only_route" | "within_cost_cap" }
  | { allowed: false; maxAudioMinutes: number; reason: "disabled" | "duration_exceeds_cap" | "invalid_duration" };

export function isOfficialVolcanoTranscriptionProvider(
  environment: Record<string, string | undefined> = process.env,
) {
  return (environment.TRANSCRIPTION_PROVIDER || "mock").trim().toLowerCase() === "volcano";
}

export function getOfficialTurboFallbackDecision(
  durationMs: number,
  environment: Record<string, string | undefined> = process.env,
): OfficialTurboFallbackDecision {
  const configuredStrategy = environment.OWNMINUTES_ASR_FILE_STRATEGY?.trim();
  const configuredMode = environment.VOLCANO_ASR_MODE?.trim();
  const strategy = configuredStrategy === "standard_then_turbo" ? "standard_then_turbo" : "single";
  const mode = configuredMode === "standard" ? "standard" : "flash";
  const resourceId = environment.VOLCANO_ASR_RESOURCE_ID?.trim().toLowerCase() || "";
  const configuredTurboResourceId = environment.VOLCANO_ASR_TURBO_RESOURCE_ID?.trim().toLowerCase() || "";
  const resourceIsTurbo =
    resourceId.includes("turbo") ||
    Boolean(configuredTurboResourceId && resourceId === configuredTurboResourceId);
  // The flash endpoint is the Turbo-priced route even if a resource ID was
  // omitted or misspelled. A Turbo resource paired with `mode=standard` is
  // also Turbo-priced and must never bypass the duration cap because of an
  // inconsistent deployment configuration.
  const turboOnlyRoute = strategy === "single" && (mode === "flash" || resourceIsTurbo);

  if (!turboOnlyRoute) {
    return { allowed: true, maxAudioMinutes: 0, reason: "not_turbo_only_route" };
  }

  const enabledValue = environment.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED?.trim();
  if (enabledValue !== "1") {
    return { allowed: false, maxAudioMinutes: 0, reason: "disabled" };
  }

  const configuredMax = environment.OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES?.trim() || "30";
  const maxAudioMinutes = /^\d+$/.test(configuredMax) ? Number(configuredMax) : 0;
  if (!Number.isInteger(maxAudioMinutes) || maxAudioMinutes < 1 || maxAudioMinutes > 30) {
    return { allowed: false, maxAudioMinutes: 0, reason: "disabled" };
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { allowed: false, maxAudioMinutes, reason: "invalid_duration" };
  }

  const boundedDurationMs = Math.round(durationMs);
  return boundedDurationMs <= maxAudioMinutes * 60_000
    ? { allowed: true, maxAudioMinutes, reason: "within_cost_cap" }
    : { allowed: false, maxAudioMinutes, reason: "duration_exceeds_cap" };
}
