import { NextResponse } from "next/server";
import { AuthError, updateAdminEntitlementGrantStatus, type EntitlementGrantStatus } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { getCurrentUser } from "@/lib/server/current-user";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

const validStatuses = new Set<Exclude<EntitlementGrantStatus, "active">>(["revoked", "refunded"]);

export async function POST(request: Request, context: RouteContext<"/api/admin/entitlement-grants/[id]/status">) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }

  if (currentUser.role !== "admin") {
    return NextResponse.json({ ok: false, error: "当前账号没有后台权限。" }, { status: 403 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  const params = await context.params;

  try {
    const body = requirePlainRecord(await readBoundedJson(request, 4 * 1024));
    const status = boundedString(body.status, {
      field: "status",
      maxLength: 16,
    }) as Exclude<EntitlementGrantStatus, "active">;
    if (!validStatuses.has(status)) {
      return NextResponse.json({ ok: false, error: "未知权益状态。" }, { status: 400 });
    }

    const reason = boundedString(body.reason, { field: "reason", maxLength: 160 });

    const grant = await updateAdminEntitlementGrantStatus({
      changedByUserId: currentUser.id,
      grantId: params.id,
      reason,
      status,
    });

    return NextResponse.json({ ok: true, grant });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof AuthError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }

    console.error(error);
    return NextResponse.json({ ok: false, error: "处理权益状态失败。" }, { status: 500 });
  }
}
