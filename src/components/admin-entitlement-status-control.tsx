"use client";

import type { EntitlementGrantStatus } from "@/lib/server/auth-repository";
import { CheckCircle2, RotateCcw, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AdminEntitlementStatusControlProps = {
  grantId: string;
  status: EntitlementGrantStatus;
};

export function AdminEntitlementStatusControl({ grantId, status }: AdminEntitlementStatusControlProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState<Exclude<EntitlementGrantStatus, "active"> | null>(null);

  async function submitStatus(nextStatus: Exclude<EntitlementGrantStatus, "active">) {
    setSavingStatus(nextStatus);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/entitlement-grants/${grantId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, status: nextStatus }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "处理失败。");
        return;
      }

      setMessage(nextStatus === "refunded" ? "已标记退款" : "已撤销");
      router.refresh();
    } catch {
      setMessage("请求失败");
    } finally {
      setSavingStatus(null);
    }
  }

  if (status !== "active") {
    return null;
  }

  return (
    <div className="mt-3 border-t border-[#e1e6e0] pt-3">
      <input
        className="h-8 w-full rounded-md border border-[#d9ded8] bg-white px-2 text-xs text-[#111827] outline-none focus:border-[#1f6f55]"
        maxLength={160}
        placeholder="撤销/退款原因"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#e6d7a3] bg-[#fff9e8] px-2 text-xs font-semibold text-[#76530a] disabled:opacity-60"
          disabled={Boolean(savingStatus)}
          type="button"
          onClick={() => void submitStatus("revoked")}
        >
          <Undo2 className="h-3.5 w-3.5" />
          {savingStatus === "revoked" ? "处理中" : "撤销"}
        </button>
        <button
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#e5b5ad] bg-[#fff4f1] px-2 text-xs font-semibold text-[#9f3124] disabled:opacity-60"
          disabled={Boolean(savingStatus)}
          type="button"
          onClick={() => void submitStatus("refunded")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {savingStatus === "refunded" ? "处理中" : "退款"}
        </button>
      </div>
      {message ? (
        <p className={`mt-2 inline-flex items-center gap-1 text-xs font-semibold ${message.startsWith("已") ? "text-[#1f6f55]" : "text-[#9f3124]"}`}>
          {message.startsWith("已") ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          {message}
        </p>
      ) : null}
    </div>
  );
}
