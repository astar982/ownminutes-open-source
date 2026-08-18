import { cookies, headers } from "next/headers";
import { getUserBySessionToken, SESSION_COOKIE_NAME } from "@/lib/server/auth-repository";

export async function getCurrentUser() {
  return getUserBySessionToken(await getRequestSessionToken());
}

export async function getRequestSessionToken() {
  const headerStore = await headers();
  const authorization = headerStore.get("authorization")?.trim();
  const bearerToken = authorization?.match(/^Bearer\s+([A-Za-z0-9._~-]{16,512})$/i)?.[1];
  if (bearerToken) return bearerToken;

  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value;
}
