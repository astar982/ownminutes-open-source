import type { Metadata } from "next";
import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "注册 - OwnMinutes",
};

type RegisterPageProps = {
  searchParams: Promise<{
    shareId?: string;
    source?: string;
  }>;
};

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const params = await searchParams;
  return (
    <AuthPanel
      attribution={{
        source: params.source,
        shareId: params.shareId,
      }}
      mode="register"
    />
  );
}
