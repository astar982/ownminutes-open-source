import { parseMobileJsonResponse } from "./mobile-http";
import type { DeleteAccountResponse } from "./types";

export async function readAccountDeletionResponse(response: Response, language: string) {
  const payload = await parseMobileJsonResponse<DeleteAccountResponse>(response, language);
  if (!response.ok || !payload.ok) {
    throw Object.assign(
      new Error(payload.error || `Account deletion failed: ${response.status}`),
      { status: response.status },
    );
  }
  return payload;
}
