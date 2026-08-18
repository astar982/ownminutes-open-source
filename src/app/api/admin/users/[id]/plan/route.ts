import { NextResponse } from "next/server";
import { AuthError, adminGrantUserPlan, type BillingPlanId } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { getCurrentUser } from "@/lib/server/current-user";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

const validPlans = new Set<BillingPlanId>(["free", "plus", "pro"]);

export async function POST(request: Request, context: RouteContext<"/api/admin/users/[id]/plan">) {
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
    const plan = boundedString(body.plan, { field: "plan", maxLength: 16 }) as BillingPlanId;
    if (!validPlans.has(plan)) {
      return NextResponse.json({ ok: false, error: "未知会员方案。" }, { status: 400 });
    }

    const reason = boundedString(body.reason, { field: "reason", maxLength: 120 });

    const user = await adminGrantUserPlan({
      grantedByUserId: currentUser.id,
      plan,
      reason,
      userId: params.id,
    });

    return NextResponse.json({ ok: true, user });
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
    return NextResponse.json({ ok: false, error: "人工发放权益失败。" }, { status: 500 });
  }
}
