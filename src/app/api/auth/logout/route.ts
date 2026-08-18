import { NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE_NAME } from "@/lib/server/auth-repository";
import { getRequestSessionToken } from "@/lib/server/current-user";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;
  const token = await getRequestSessionToken();
  await destroySession(token);

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE_NAME);
  return response;
}
