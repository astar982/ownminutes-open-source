export function isEmailVerificationRequired() {
  return process.env.OWNMINUTES_REQUIRE_EMAIL_VERIFICATION === "1";
}
