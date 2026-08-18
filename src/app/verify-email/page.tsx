import type { Metadata } from "next";
import { Suspense } from "react";
import { EmailVerificationPanel } from "@/components/email-verification-panel";

export const metadata: Metadata = {
  title: "验证邮箱 - OwnMinutes",
};

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <EmailVerificationPanel />
    </Suspense>
  );
}
