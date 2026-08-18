import { NextResponse } from "next/server";
import { getSafeRequestOrigin } from "@/lib/server/request-origin";

type CooldownEntry = {
  expiresAt: number;
};

type RequestOriginPolicy = "authenticated" | "public";

const cooldownsKey = Symbol.for("ownminutes.sensitive-action-cooldowns");
const globalCooldowns = globalThis as typeof globalThis & { [cooldownsKey]?: Map<string, CooldownEntry> };

export class RequestOriginGuardError extends Error {
  constructor() {
    super("请求来源校验失败，已拒绝可能的跨站操作。");
    this.name = "RequestOriginGuardError";
  }
}

export { RequestOriginGuardError as SensitiveActionOriginError };

export function assertSensitiveActionOrigin(request: Request, options: { requireBrowserEvidenceForGet?: boolean } = {}) {
  assertTrustedRequestOrigin(request, {
    allowSameOriginFetchMetadata: Boolean(options.requireBrowserEvidenceForGet),
    policy: "authenticated",
  });
}

export function assertAuthenticatedMutationOrigin(request: Request) {
  assertTrustedRequestOrigin(request, {
    allowSameOriginFetchMetadata: true,
    policy: "authenticated",
  });
}

export function assertPublicMutationOrigin(request: Request) {
  assertTrustedRequestOrigin(request, {
    allowSameOriginFetchMetadata: true,
    policy: "public",
  });
}

export function authenticatedMutationOriginResponse(request: Request) {
  try {
    assertAuthenticatedMutationOrigin(request);
    return null;
  } catch (error) {
    return requestOriginErrorResponse(error);
  }
}

export function publicMutationOriginResponse(request: Request) {
  try {
    assertPublicMutationOrigin(request);
    return null;
  } catch (error) {
    return requestOriginErrorResponse(error);
  }
}

function assertTrustedRequestOrigin(
  request: Request,
  options: {
    allowSameOriginFetchMetadata: boolean;
    policy: RequestOriginPolicy;
  },
) {
  const origin = request.headers.get("origin")?.trim();
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") throw new RequestOriginGuardError();

  if (origin) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new RequestOriginGuardError();
    }
    if (parsedOrigin.origin !== getSafeRequestOrigin(request)) throw new RequestOriginGuardError();
    return;
  }

  if (fetchSite === "same-site") throw new RequestOriginGuardError();
  if (options.allowSameOriginFetchMetadata && fetchSite === "same-origin") return;
  if (options.policy === "public" && !fetchSite) return;
  if (hasBearerAuthorization(request)) return;
  throw new RequestOriginGuardError();
}

export function consumeSensitiveActionCooldown(
  userId: string,
  action: string,
  cooldownMs: number,
  now = Date.now(),
) {
  const cooldowns = globalCooldowns[cooldownsKey] ?? new Map<string, CooldownEntry>();
  globalCooldowns[cooldownsKey] = cooldowns;
  pruneCooldowns(cooldowns, now);
  const key = `${userId}\u0000${action}`;
  const existing = cooldowns.get(key);
  if (existing && existing.expiresAt > now) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
    };
  }
  cooldowns.set(key, { expiresAt: now + cooldownMs });
  return {
    allowed: true as const,
    retryAfterSeconds: 0,
  };
}

export function requestOriginErrorResponse(error: unknown) {
  if (error instanceof RequestOriginGuardError) {
    return NextResponse.json(
      { ok: false, code: "request_origin_forbidden", error: error.message },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return null;
}

export const sensitiveActionErrorResponse = requestOriginErrorResponse;

export function sensitiveActionCooldownResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      ok: false,
      code: "provider_probe_cooldown",
      error: "真实 Provider 检查刚刚执行过，请稍后再试。",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(Math.max(1, retryAfterSeconds)),
      },
    },
  );
}

function pruneCooldowns(cooldowns: Map<string, CooldownEntry>, now: number) {
  if (cooldowns.size < 1_000) return;
  for (const [key, entry] of cooldowns) {
    if (entry.expiresAt <= now) cooldowns.delete(key);
  }
}

function hasBearerAuthorization(request: Request) {
  return /^Bearer\s+[A-Za-z0-9._~-]{16,512}$/i.test(
    request.headers.get("authorization")?.trim() || "",
  );
}
