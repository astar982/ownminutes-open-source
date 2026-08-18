export type EmailProvider = "none" | "resend";

export type EmailDiagnostics = {
  generatedAt: string;
  provider: EmailProvider;
  productionReady: boolean;
  configured: {
    domainVerified: boolean;
    from: boolean;
    appUrl: boolean;
    resendApiKey: boolean;
  };
  capabilities: {
    canSendEmailVerification: boolean;
    canSendPasswordReset: boolean;
    avoidsDevTokenResponse: boolean;
    requiresEmailVerification: boolean;
  };
  missing: string[];
};

export function getEmailDiagnostics(): EmailDiagnostics {
  const from = getEnv("OWNMINUTES_EMAIL_FROM", "EMAIL_FROM");
  const appUrl = getEnv("OWNMINUTES_APP_URL", "NEXT_PUBLIC_APP_URL");
  const resendApiKey = getEnv("RESEND_API_KEY", "OWNMINUTES_RESEND_API_KEY");
  const provider: EmailProvider = resendApiKey ? "resend" : "none";
  const domainVerified = process.env.OWNMINUTES_EMAIL_DOMAIN_VERIFIED === "1";
  const requiresEmailVerification = process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION === "1";
  const productionReady = provider === "resend" && Boolean(from) && isPublicHttpsUrl(appUrl) && domainVerified && requiresEmailVerification;
  const missing = [];

  if (!resendApiKey) missing.push("RESEND_API_KEY or OWNMINUTES_RESEND_API_KEY");
  if (!from) missing.push("OWNMINUTES_EMAIL_FROM or EMAIL_FROM");
  if (!appUrl) missing.push("OWNMINUTES_APP_URL or NEXT_PUBLIC_APP_URL");
  if (appUrl && !isPublicHttpsUrl(appUrl)) missing.push("public HTTPS app URL");
  if (!domainVerified) missing.push("OWNMINUTES_EMAIL_DOMAIN_VERIFIED=1");
  if (!requiresEmailVerification) missing.push("OWNMINUTES_REQUIRE_EMAIL_VERIFICATION=1");

  return {
    generatedAt: new Date().toISOString(),
    provider,
    productionReady,
    configured: {
      domainVerified,
      from: Boolean(from),
      appUrl: Boolean(appUrl),
      resendApiKey: Boolean(resendApiKey),
    },
    capabilities: {
      canSendEmailVerification: productionReady,
      canSendPasswordReset: productionReady,
      avoidsDevTokenResponse: productionReady,
      requiresEmailVerification,
    },
    missing,
  };
}

function getEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function isPublicHttpsUrl(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
