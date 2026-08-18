import crypto from "crypto";
import { NextResponse } from "next/server";
import {
  AppleIapInputError,
  assertAppleIapRuntimeEnvironmentAllowed,
  findAppleIapEntitlement,
  isLocalAppleIapNotificationMockRequest,
  makeAppleIapIdempotencyKey,
  previewAppleNotificationSignedPayload,
  requireAppleIapReady,
  resolveAppleIapEntitlement,
  verifyAppleNotificationSignedPayload,
} from "@/lib/apple-iap";
import { AuthError, recordAppleIapNotification } from "@/lib/server/auth-repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await readLimitedJson(request, 256 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ ok: false, code: "request_body_too_large", error: "请求体过大。" }, { status: 413 });
    }
    return NextResponse.json({ ok: false, error: "请求体不是有效 JSON。" }, { status: 400 });
  }

  const signedPayload = extractSignedPayload(body);
  if (!signedPayload) {
    return NextResponse.json({ ok: false, code: "missing_signed_payload", error: "缺少 App Store Server Notifications signedPayload。" }, { status: 400 });
  }

  let preview;
  try {
    preview = previewAppleNotificationSignedPayload(signedPayload);
  } catch (error) {
    if (error instanceof AppleIapInputError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "signedPayload 解析失败。" }, { status: 400 });
  }

  const allowLocalMock = isLocalAppleIapNotificationMockRequest(request, preview);
  if (allowLocalMock) {
    try {
      const entitlement = notificationRequiresEntitlementMapping(preview.notificationType, preview.subtype)
        ? resolveAppleIapEntitlement(preview.productId || "")
        : findAppleIapEntitlement(preview.productId);
      await recordAppleIapNotification({
        amountCents: preview.price === undefined ? entitlement?.amountCents : undefined,
        appAccountToken: preview.appAccountToken,
        autoRenewStatus: preview.autoRenewStatus,
        currency: preview.currency || entitlement?.currency,
        environment: preview.environment,
        expiresDate: preview.expiresDate,
        graceExpiresDate: preview.graceExpiresDate,
        idempotencyKey:
          preview.transactionId && preview.productId
            ? makeAppleIapIdempotencyKey({
                originalTransactionId: preview.originalTransactionId,
                productId: preview.productId,
                transactionId: preview.transactionId,
              })
            : undefined,
        isUpgraded: preview.isUpgraded,
        notificationUUID: `local_${crypto.createHash("sha256").update(signedPayload).digest("hex")}`,
        notificationType: preview.notificationType,
        originalTransactionId: preview.originalTransactionId,
        offerIdentifier: preview.offerIdentifier,
        offerType: preview.offerType,
        payloadSha256: crypto.createHash("sha256").update(signedPayload).digest("hex"),
        plan: entitlement?.plan,
        priceMilliunits: preview.price,
        productId: entitlement?.productId || preview.productId,
        purchaseDate: preview.purchaseDate,
        reason: `local Apple notification ${preview.notificationType}${preview.subtype ? `/${preview.subtype}` : ""}`,
        signedDate: preview.signedDate,
        status: preview.status,
        storefront: preview.storefront,
        subtype: preview.subtype,
        transactionId: preview.transactionId,
      });

      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof AppleIapInputError) {
        return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: 400 });
      }
      if (error instanceof AuthError) {
        return NextResponse.json({ ok: false, code: "apple_iap_notification_apply_failed", error: error.message }, { status: error.status });
      }
      return NextResponse.json({ ok: false, code: "apple_iap_notification_apply_failed", error: "Apple notification 处理失败。" }, { status: 500 });
    }
  }

  const guard = requireAppleIapReady({ requireNotifications: true, requireRefundHandling: true });
  if (!guard.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: guard.code,
        error: "Apple IAP 服务端通知处理尚未配置完成，当前不会写订单或变更权益。",
      },
      { status: guard.status },
    );
  }

  try {
    const verified = await verifyAppleNotificationSignedPayload(signedPayload);
    const verifiedPreview = verified.preview;
    assertAppleIapRuntimeEnvironmentAllowed(verifiedPreview.environment);
    const entitlement = notificationRequiresEntitlementMapping(verifiedPreview.notificationType, verifiedPreview.subtype)
      ? resolveAppleIapEntitlement(verifiedPreview.productId || "")
      : findAppleIapEntitlement(verifiedPreview.productId);
    await recordAppleIapNotification({
      amountCents: verifiedPreview.price === undefined ? entitlement?.amountCents : undefined,
      appAccountToken: verifiedPreview.appAccountToken,
      autoRenewStatus: verifiedPreview.autoRenewStatus,
      currency: verifiedPreview.currency || entitlement?.currency,
      environment: verifiedPreview.environment,
      expiresDate: verifiedPreview.expiresDate,
      graceExpiresDate: verifiedPreview.graceExpiresDate,
      idempotencyKey:
        verifiedPreview.transactionId && verifiedPreview.productId
          ? makeAppleIapIdempotencyKey({
              originalTransactionId: verifiedPreview.originalTransactionId,
              productId: verifiedPreview.productId,
              transactionId: verifiedPreview.transactionId,
            })
          : undefined,
      isUpgraded: verifiedPreview.isUpgraded,
      notificationUUID: verified.notificationUUID,
      notificationType: verifiedPreview.notificationType,
      originalTransactionId: verifiedPreview.originalTransactionId,
      offerIdentifier: verifiedPreview.offerIdentifier,
      offerType: verifiedPreview.offerType,
      payloadSha256: crypto.createHash("sha256").update(signedPayload).digest("hex"),
      plan: entitlement?.plan,
      priceMilliunits: verifiedPreview.price,
      productId: entitlement?.productId || verifiedPreview.productId,
      purchaseDate: verifiedPreview.purchaseDate,
      reason: `verified Apple notification ${verifiedPreview.notificationType}${verifiedPreview.subtype ? `/${verifiedPreview.subtype}` : ""}${
        verified.notificationUUID ? ` uuid=${verified.notificationUUID}` : ""
      }`,
      signedDate: verified.signedDate,
      status: verifiedPreview.status,
      storefront: verifiedPreview.storefront,
      subtype: verifiedPreview.subtype,
      transactionId: verifiedPreview.transactionId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppleIapInputError) {
      const status = ["unknown_product_id", "missing_product_id", "invalid_entitlement_mapping"].includes(error.code) ? 400 : 401;
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status });
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, code: "apple_iap_notification_apply_failed", error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, code: "apple_iap_notification_apply_failed", error: "Apple notification 处理失败。" }, { status: 500 });
  }
}

function extractSignedPayload(body: unknown) {
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>).signedPayload;
  return typeof value === "string" ? value.trim() : "";
}

function notificationRequiresEntitlementMapping(notificationType?: string, subtype?: string) {
  if (notificationType === "OFFER_REDEEMED") return subtype !== "DOWNGRADE";
  if (notificationType === "DID_CHANGE_RENEWAL_PREF") return subtype === "UPGRADE";
  return notificationType === "SUBSCRIBED";
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
