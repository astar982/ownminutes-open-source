import crypto from "node:crypto";

const ticketVersion = 1;
// A deletion can remain pending while a paid provider call is reconciled or a
// quarantined legacy object is manually audited. The receipt exposes status
// only, so keep it valid long enough for unattended cleanup and later installs.
const ticketLifetimeMs = 90 * 24 * 60 * 60 * 1000;

type AccountDeletionTicketPayload = {
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  userId: string;
  version: 1;
};

export function createAccountDeletionTicket(userId: string, nowMs = Date.now()) {
  const payload: AccountDeletionTicketPayload = {
    expiresAt: nowMs + ticketLifetimeMs,
    issuedAt: nowMs,
    nonce: crypto.randomBytes(16).toString("base64url"),
    userId,
    version: ticketVersion,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    expiresAt: new Date(payload.expiresAt).toISOString(),
    ticket: `${encoded}.${sign(encoded)}`,
  };
}

export function verifyAccountDeletionTicket(ticket: string, nowMs = Date.now()) {
  const [encoded, signature, ...extra] = String(ticket || "").split(".");
  if (!encoded || !signature || extra.length > 0 || encoded.length > 2048 || signature.length > 128) return null;
  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<AccountDeletionTicketPayload>;
    if (
      payload.version !== ticketVersion ||
      typeof payload.userId !== "string" ||
      !/^[A-Za-z0-9_-]{1,192}$/.test(payload.userId) ||
      typeof payload.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce) ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      Number(payload.issuedAt) > nowMs + 60_000 ||
      Number(payload.expiresAt) <= nowMs ||
      Number(payload.expiresAt) - Number(payload.issuedAt) > ticketLifetimeMs
    ) return null;
    return payload as AccountDeletionTicketPayload;
  } catch {
    return null;
  }
}

function sign(encoded: string) {
  return crypto.createHmac("sha256", ticketKey()).update(`account-delete:v1:${encoded}`).digest("base64url");
}

function ticketKey() {
  const secret = process.env.OWNMINUTES_APP_SECRET || process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) return crypto.createHash("sha256").update(`${secret}:account-delete-ticket`).digest();
  if (process.env.NODE_ENV === "production") {
    throw new Error("Account deletion status tickets require OWNMINUTES_APP_SECRET or AUTH_SECRET.");
  }
  return crypto.createHash("sha256").update("ownminutes-local-account-delete-ticket-v1").digest();
}
