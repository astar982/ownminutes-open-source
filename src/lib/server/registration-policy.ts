export function roleForPublicRegistration(activeUserCount: number): "admin" | "user" {
  const developmentBootstrapEnabled = process.env.NODE_ENV !== "production" && process.env.OWNMINUTES_ALLOW_FIRST_USER_ADMIN === "1";
  return developmentBootstrapEnabled && activeUserCount === 0 ? "admin" : "user";
}
