import type { Metadata } from "next";
import { PasswordResetPanel } from "@/components/password-reset-panel";

export const metadata: Metadata = {
  title: "重置密码 - OwnMinutes",
};

export default function ResetPasswordPage() {
  return <PasswordResetPanel />;
}
