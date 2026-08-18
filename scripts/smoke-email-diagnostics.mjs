#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const diagnosticsSource = fs.readFileSync(path.join(root, "src", "lib", "email-diagnostics.ts"), "utf8");
const deliverySource = fs.readFileSync(path.join(root, "src", "lib", "email-delivery.ts"), "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "app", "api", "auth", "password-reset", "request", "route.ts"), "utf8");
const verificationRequestSource = fs.readFileSync(path.join(root, "src", "app", "api", "auth", "email-verification", "request", "route.ts"), "utf8");
const verificationConfirmSource = fs.readFileSync(path.join(root, "src", "app", "api", "auth", "email-verification", "confirm", "route.ts"), "utf8");
const verificationCodeRequestSource = fs.readFileSync(path.join(root, "src", "app", "api", "auth", "email-verification", "code", "request", "route.ts"), "utf8");
const verificationCodeConfirmSource = fs.readFileSync(path.join(root, "src", "app", "api", "auth", "email-verification", "code", "confirm", "route.ts"), "utf8");
const tokenExposureSource = fs.readFileSync(path.join(root, "src", "lib", "server", "auth-token-exposure.ts"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

const summary = {
  hasDiagnostics: diagnosticsSource.includes("getEmailDiagnostics") && diagnosticsSource.includes("productionReady"),
  supportsResend: deliverySource.includes("https://api.resend.com/emails") && deliverySource.includes("RESEND_API_KEY"),
  requiresPublicAppUrl: diagnosticsSource.includes("isPublicHttpsUrl") && diagnosticsSource.includes("OWNMINUTES_APP_URL"),
  passwordResetSendsEmail: routeSource.includes("sendPasswordResetEmail") && routeSource.includes("delivery"),
  passwordResetIsLocalized:
    routeSource.includes('request.headers.get("accept-language")') &&
    deliverySource.includes("Reset your OwnMinutes password") &&
    deliverySource.includes("重置您的 OwnMinutes 密码") &&
    deliverySource.includes("重設您的 OwnMinutes 密碼") &&
    deliverySource.includes("If you did not request this, ignore this email.") &&
    deliverySource.includes("如果不是您本人操作，请忽略这封邮件。") &&
    deliverySource.includes("若不是您本人操作，請忽略這封郵件。"),
  emailVerificationSendsEmail: verificationRequestSource.includes("sendEmailVerificationEmail") && verificationRequestSource.includes("verificationToken"),
  emailVerificationCreatesSession: verificationConfirmSource.includes("verifyEmailWithToken") && verificationConfirmSource.includes("createSession"),
  emailVerificationCodeFlow:
    verificationCodeRequestSource.includes("requestEmailVerification") &&
    verificationCodeRequestSource.includes("sendEmailVerificationEmail") &&
    verificationCodeConfirmSource.includes("verifyEmailWithCode") &&
    verificationCodeConfirmSource.includes("createSession"),
  emailVerificationIsLocalized:
    verificationCodeRequestSource.includes('request.headers.get("accept-language")') &&
    deliverySource.includes("Your OwnMinutes verification code") &&
    deliverySource.includes("您的 OwnMinutes 邮箱验证码") &&
    deliverySource.includes("您的 OwnMinutes 電子郵件驗證碼"),
  otpAndLegacyLinkShareEmail:
    deliverySource.includes("verificationCode") &&
    deliverySource.includes("verificationUrl") &&
    deliverySource.includes("Verification code") &&
    deliverySource.includes("Older app versions"),
  authLinksKeepTokensOutOfHttpRequests:
    deliverySource.includes("reset-password#token=") &&
    deliverySource.includes("verify-email#token=") &&
    !deliverySource.includes("reset-password?token=") &&
    !deliverySource.includes("verify-email?token="),
  avoidsTokenResponseWhenNotLocal:
    routeSource.includes("canExposeResetToken") &&
    routeSource.includes("canExposeLocalAuthToken") &&
    tokenExposureSource.includes("OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE") &&
    tokenExposureSource.includes("host.startsWith(\"127.0.0.1\")") &&
    routeSource.includes("resetToken: exposeResetToken ? result.resetToken : undefined"),
  envDocumented: envExample.includes("RESEND_API_KEY") && envExample.includes("OWNMINUTES_EMAIL_FROM") && envExample.includes("OWNMINUTES_REQUIRE_EMAIL_VERIFICATION"),
  leaksSecrets: diagnosticsSource.includes("sk-proj") || deliverySource.includes("AKL") || envExample.includes("sk-proj"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.hasDiagnostics ||
  !summary.supportsResend ||
  !summary.requiresPublicAppUrl ||
  !summary.passwordResetSendsEmail ||
  !summary.passwordResetIsLocalized ||
  !summary.emailVerificationSendsEmail ||
  !summary.emailVerificationCreatesSession ||
  !summary.emailVerificationCodeFlow ||
  !summary.emailVerificationIsLocalized ||
  !summary.otpAndLegacyLinkShareEmail ||
  !summary.authLinksKeepTokensOutOfHttpRequests ||
  !summary.avoidsTokenResponseWhenNotLocal ||
  !summary.envDocumented ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}
