import { NextResponse } from "next/server";
import {
  AppleIapInputError,
  assertAppleIapRuntimeEnvironmentAllowed,
  fetchAppStoreTransactionInfo,
  isLocalAppleIapMockRequest,
  requireAppleIapReady,
  resolveAppleIapEntitlement,
  validateAppleTransactionInput,
} from "@/lib/apple-iap";
import { getCurrentUser } from "@/lib/server/current-user";
import { AuthError, recordAppleIapPurchase } from "@/lib/server/auth-repository";
import { consumeAppleIapVerificationAttempt } from "@/lib/server/iap-rate-limit";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  let transaction;
  try {
    transaction = validateAppleTransactionInput(await readLimitedJson(request, 16 * 1024));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ ok: false, code: "request_body_too_large", error: "请求体过大。" }, { status: 413 });
    }
    if (error instanceof AppleIapInputError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "请求体不是有效 JSON。" }, { status: 400 });
  }

  const allowLocalMock = isLocalAppleIapMockRequest(request, transaction.transactionId);
  const rateLimit = consumeAppleIapVerificationAttempt(user.id);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, code: "apple_iap_rate_limited", error: "交易校验请求过于频繁，请稍后重试。" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }
  const guard = requireAppleIapReady({ allowLocalMock });
  if (!guard.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: guard.code,
        error: "Apple IAP 交易校验尚未配置完成，不能发放付费权益。",
        missing: guard.missing,
      },
      { status: guard.status },
    );
  }

  try {
    const lookup = await fetchAppStoreTransactionInfo(transaction.transactionId, {
      allowLocalMock,
      productId: transaction.productId,
      userId: user.id,
    });
    assertAppleIapRuntimeEnvironmentAllowed(lookup.environment);
    const verifiedTransaction = lookup.transaction;
    const entitlement = resolveAppleIapEntitlement(verifiedTransaction?.productId || transaction.productId);
    const purchase = await recordAppleIapPurchase({
      // Apple-signed (priceMilliunits, currency) is authoritative. The legacy
      // cents field stays unset because currencies do not share one exponent.
      amountCents: verifiedTransaction?.price === undefined ? entitlement.amountCents : undefined,
      appAccountToken: verifiedTransaction?.appAccountToken,
      currency: verifiedTransaction?.currency || entitlement.currency,
      environment: verifiedTransaction?.environment || lookup.environment,
      externalTransactionId: verifiedTransaction?.transactionId || transaction.transactionId,
      idempotencyKey: lookup.idempotencyKey,
      originalTransactionId: verifiedTransaction?.originalTransactionId,
      periodStartAt: verifiedTransaction?.purchaseDate,
      periodEndAt: verifiedTransaction?.expiresDate,
      priceMilliunits: verifiedTransaction?.price,
      plan: entitlement.plan,
      productId: entitlement.productId,
      storefront: verifiedTransaction?.storefront,
      offerType: verifiedTransaction?.offerType,
      offerIdentifier: verifiedTransaction?.offerIdentifier,
      signedDate: verifiedTransaction?.signedDate,
      userId: user.id,
    });

    return NextResponse.json(
      {
        ok: true,
        duplicate: purchase.duplicate,
        entitlementGranted: true,
        code: purchase.duplicate ? "apple_iap_transaction_already_recorded" : "apple_iap_transaction_recorded",
        message: purchase.duplicate ? "该 Apple 交易已处理过，本次未重复发放权益。" : "Apple 交易已完成服务端查询、订单落账和权益发放。",
        idempotencyKey: purchase.order.idempotencyKey,
        order: purchase.order,
        transaction: lookup.transaction,
        environment: lookup.environment,
        user: purchase.user,
      },
      { status: purchase.duplicate ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof AppleIapInputError) {
      const status = appleIapErrorStatus(error.code);
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, code: "apple_iap_transaction_owner_conflict", error: error.message }, { status: error.status });
    }

    return NextResponse.json(
      {
        ok: false,
        code: "app_store_server_api_error",
        error: "App Store Server API 交易查询失败，当前不会发放权益。",
      },
      { status: 502 },
    );
  }
}

class RequestBodyTooLargeError extends Error {}

async function readLimitedJson(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RequestBodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

function appleIapErrorStatus(code: string) {
  if (["missing_product_id", "unknown_product_id", "invalid_entitlement_mapping", "product_id_mismatch", "transaction_id_mismatch", "bundle_id_mismatch", "environment_mismatch"].includes(code)) {
    return 400;
  }
  if (["transaction_revoked", "subscription_expired", "transaction_superseded"].includes(code)) {
    return 422;
  }
  if (code === "production_purchase_blocked_during_sandbox_acceptance") return 503;
  if (code === "apple_iap_environment_not_allowed") return 403;
  if (code === "app_account_token_mismatch") return 403;
  if (["invalid_signed_transaction_signature", "apple_iap_transaction_verifier_missing_config", "apple_iap_account_binding_missing"].includes(code)) return 503;
  if (code === "app_store_server_api_timeout") return 504;
  return 502;
}
