import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MeetingRecorder } from "@/components/meeting-recorder";
import { getProviderSetupReport, getUserProviderHealth } from "@/lib/provider-health";
import { getCurrentUser } from "@/lib/server/current-user";

export const metadata: Metadata = {
  title: "工作台 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function AppWorkspacePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const providerSetup = getProviderSetupReport(await getUserProviderHealth(user.id));

  return <MeetingRecorder initialProviderSetup={providerSetup} userId={user.id} />;
}
