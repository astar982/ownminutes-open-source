import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Mic, Settings2 } from "lucide-react";
import Link from "next/link";
import { AccountDashboard } from "@/components/account-dashboard";
import { buildAccountEntitlements } from "@/lib/account-entitlements";
import { getPaymentDiagnostics } from "@/lib/payment-diagnostics";
import { getUserProviderHealth } from "@/lib/provider-health";
import { getUserUsage, listProviderCredentials } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { listUserMeetings } from "@/lib/server/meeting-audio-store";

export const metadata: Metadata = {
  title: "账号 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [usage, providerCredentials, providerHealth, meetings] = await Promise.all([
    getUserUsage(user.id),
    listProviderCredentials(user.id),
    getUserProviderHealth(user.id),
    listUserMeetings(user.id),
  ]);
  const entitlements = buildAccountEntitlements({ user, usage, providerCredentials });
  const simulatedPlanChangesEnabled = getPaymentDiagnostics().capabilities.usesSimulatedPlanSwitching;

  return (
    <main className="min-h-screen bg-[#eef1f4] text-[#111827]">
      <div className="relative mx-auto min-h-screen w-full max-w-[430px] bg-[#f7f6f2] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:my-8 sm:overflow-hidden sm:rounded-[28px]">
        <header className="sticky top-0 z-20 bg-[#f7f6f2]/95 px-5 pb-3 pt-5 backdrop-blur" data-primary-tab-header="account">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold text-[#111827]">我的账号</h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link className="app-icon-button" href="/settings" title="模型配置">
                <Settings2 className="h-4 w-4" />
              </Link>
              <Link className="app-icon-button bg-[#16261f] text-white hover:bg-[#233b31]" href="/app" title="新会议">
                <Mic className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </header>

        <AccountDashboard
          entitlements={entitlements}
          meetings={meetings}
          providerCredentials={providerCredentials}
          providerHealth={providerHealth}
          simulatedPlanChangesEnabled={simulatedPlanChangesEnabled}
          usage={usage}
          user={user}
        />
      </div>
    </main>
  );
}
