import type { Metadata } from "next";
import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "登录 - OwnMinutes",
};

export default function LoginPage() {
  return <AuthPanel mode="login" />;
}
