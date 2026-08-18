import { NextRequest, NextResponse } from "next/server";
import { AuthError, deleteProviderCredential, listProviderCredentials, saveProviderCredential } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { getCurrentUser } from "@/lib/server/current-user";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";
import { SecretAuditUnavailableError } from "@/lib/server/secret-audit";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    providerCredentials: await listProviderCredentials(user.id),
  });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const body = requirePlainRecord(await readBoundedJson(request, 64 * 1024));
    const providerId = boundedString(body.providerId, {
      field: "providerId",
      maxLength: 64,
      required: true,
    });
    const label = boundedString(body.label, { field: "label", maxLength: 120 });
    const credential = await saveProviderCredential(user.id, {
      providerId,
      label: label || undefined,
      fields: readBoundedStringRecord(body.fields, "fields", 2_048),
      secrets: readBoundedStringRecord(body.secrets, "secrets", 8_192, false),
      removeSecrets: readBoundedStringList(body.removeSecrets, "removeSecrets"),
    });

    return NextResponse.json({ ok: true, credential });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof SecretAuditUnavailableError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "保存 Provider 配置失败。" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const providerId = boundedString(request.nextUrl.searchParams.get("providerId"), {
      field: "providerId",
      maxLength: 64,
      required: true,
    });
    await deleteProviderCredential(user.id, providerId);
    return NextResponse.json({
      ok: true,
      providerCredentials: await listProviderCredentials(user.id),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof SecretAuditUnavailableError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "删除 Provider 配置失败。" }, { status: 500 });
  }
}

function readBoundedStringRecord(
  value: unknown,
  field: string,
  maxValueLength: number,
  trimValues = true,
) {
  if (value === undefined || value === null) return {};
  const record = requirePlainRecord(value, `${field} 必须是对象。`);
  const entries = Object.entries(record);
  if (entries.length > 16) {
    throw new BoundedRequestError("invalid_request_body", `${field} 字段过多。`);
  }
  return Object.fromEntries(
    entries.map(([key, entryValue]) => {
      const normalizedKey = boundedString(key, { field: `${field} key`, maxLength: 80, required: true });
      const normalizedValue = boundedString(entryValue, {
        field: `${field}.${normalizedKey}`,
        maxLength: maxValueLength,
        trim: trimValues,
      });
      return [normalizedKey, normalizedValue];
    }),
  );
}

function readBoundedStringList(value: unknown, field: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new BoundedRequestError("invalid_request_body", `${field} 必须是长度不超过 16 的文本数组。`);
  }
  return value.map((entry) => boundedString(entry, {
    field,
    maxLength: 80,
    required: true,
  }));
}
