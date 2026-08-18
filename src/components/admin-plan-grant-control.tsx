"use client";

import type { BillingPlanId } from "@/lib/server/auth-repository";
import { CheckCircle2, CircleDollarSign } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AdminPlanGrantControlProps = {
  currentPlan: BillingPlanId;
  userId: string;
};

const plans: BillingPlanId[] = ["free", "plus", "pro"];

export function AdminPlanGrantControl({ currentPlan, userId }: AdminPlanGrantControlProps) {
  const router = useRouter();
  const [plan, setPlan] = useState<BillingPlanId>(currentPlan);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submitGrant() {
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/users/${userId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, reason }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "人工发放失败。");
        return;
      }

      setMessage("已发放");
      router.refresh();
    } catch {
      setMessage("请求失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-w-[220px] flex-col gap-2">
      <div className="flex gap-2">
        <select
          className="h-9 flex-1 rounded-md border border-[#d9ded8] bg-white px-2 text-xs font-semibold text-[#111827] outline-none focus:border-[#1f6f55]"
          value={plan}
          onChange={(event) => setPlan(event.target.value as BillingPlanId)}
        >
          {plans.map((item) => (
            <option key={item} value={item}>
              {item.toUpperCase()}
            </option>
          ))}
        </select>
        <button
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[#1f6f55] px-3 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#9ca9a2]"
          disabled={saving}
          type="button"
          onClick={submitGrant}
        >
          <CircleDollarSign className="h-3.5 w-3.5" />
          {saving ? "保存" : "发放"}
        </button>
      </div>
      <input
        className="h-9 rounded-md border border-[#d9ded8] bg-white px-2 text-xs text-[#111827] outline-none focus:border-[#1f6f55]"
        maxLength={120}
        placeholder="原因：测试补偿 / 人工订单"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      {message ? (
        <p className={`inline-flex items-center gap-1 text-xs font-semibold ${message === "已发放" ? "text-[#1f6f55]" : "text-[#9f3124]"}`}>
          {message === "已发放" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          {message}
        </p>
      ) : null}
    </div>
  );
}
