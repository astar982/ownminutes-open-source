import { NextResponse } from "next/server";
import { isSimulatedBillingEnabled } from "@/lib/payment-diagnostics";
import { AuthError, updateUserPlan, type BillingPlanId } from "@/lib/server/auth-repository";
import { boundedString, BoundedRequestError, readBoundedJson, requirePlainRecord } from "@/lib/server/bounded-request";
import { getCurrentUser } from "@/lib/server/current-user";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

const validPlans = new Set<BillingPlanId>(["free", "plus", "pro"]);

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const body = requirePlainRecord(await readBoundedJson(request, 4 * 1024));
    const plan = boundedString(body.plan, { field: "plan", maxLength: 16 }) as BillingPlanId;
    if (!validPlans.has(plan)) {
      return NextResponse.json({ ok: false, error: "未知会员方案。" }, { status: 400 });
    }

    if (!isSimulatedBillingEnabled()) {
      return NextResponse.json(
        {
          ok: false,
          code: "simulated_billing_disabled",
          error: "当前环境未启用模拟套餐切换。正式付费需要通过 Apple IAP、后台订单或人工审核发放权益。",
        },
        { status: 402 },
      );
    }

    return NextResponse.json({
      ok: true,
      user: await updateUserPlan(user.id, plan),
    });
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
    return NextResponse.json({ ok: false, error: "方案更新失败。" }, { status: 500 });
  }
}
