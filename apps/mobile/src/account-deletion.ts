export type AccountDeletionServerStatus = "active" | "pending_cleanup" | "deleted";

export type AccountDeletionReceipt = {
  expiresAt: string;
  ticket: string;
  userId: string;
  version: 1;
};

export type AccountDeletionResponse = {
  deletedMeetings?: number;
  ok: boolean;
  status?: AccountDeletionServerStatus;
};

export type AccountDeletionResolution =
  | {
      confirmedBy: "response" | "retry" | "status";
      deletion: AccountDeletionResponse;
      receipt: AccountDeletionReceipt;
      status: "deleted";
    }
  | {
      error?: unknown;
      receipt: AccountDeletionReceipt;
      serverStatus?: "active" | "pending_cleanup";
      status: "pending_confirmation";
    }
  | {
      error: unknown;
      receipt?: AccountDeletionReceipt;
      status: "failed";
    };

export type AccountDeletionReconciliation =
  | { receipt: AccountDeletionReceipt; status: AccountDeletionServerStatus }
  | { receipt: AccountDeletionReceipt; status: "expired" | "unknown"; error?: unknown };

export async function deleteAccountWithConfirmation(input: {
  checkStatus: (ticket: string) => Promise<AccountDeletionServerStatus>;
  persistReceipt: (receipt: AccountDeletionReceipt) => Promise<void>;
  prepareTicket: () => Promise<Omit<AccountDeletionReceipt, "userId" | "version">>;
  requestDelete: () => Promise<AccountDeletionResponse>;
  userId: string;
}): Promise<AccountDeletionResolution> {
  let receipt: AccountDeletionReceipt;
  try {
    // The receipt must be durable before the destructive request begins. A
    // process kill or lost response can then be reconciled on the next launch.
    const prepared = await input.prepareTicket();
    receipt = {
      expiresAt: prepared.expiresAt,
      ticket: prepared.ticket,
      userId: input.userId,
      version: 1,
    };
    if (!parseAccountDeletionReceipt(JSON.stringify(receipt))) {
      throw new Error("invalid account deletion receipt");
    }
    await input.persistReceipt(receipt);
  } catch (error) {
    return { error, status: "failed" };
  }

  const errors: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const deletion = await input.requestDelete();
      if (deletion.status === "deleted") {
        return {
          confirmedBy: attempt === 0 ? "response" : "retry",
          deletion,
          receipt,
          status: "deleted",
        };
      }
      // HTTP 2xx/202 and ok:true do not prove cleanup completed. Keep the
      // receipt and the local originals until the server explicitly reports
      // deleted.
      return {
        receipt,
        serverStatus: deletion.status === "active" ? "active" : "pending_cleanup",
        status: "pending_confirmation",
      };
    } catch (error) {
      errors.push(error);
    }
  }

  const lastError = errors.at(-1);
  try {
    const serverStatus = await input.checkStatus(receipt.ticket);
    if (serverStatus === "deleted") {
      return {
        confirmedBy: "status",
        deletion: { ok: true, status: "deleted" },
        receipt,
        status: "deleted",
      };
    }
    if (serverStatus === "pending_cleanup") {
      return { error: lastError, receipt, serverStatus, status: "pending_confirmation" };
    }
    return errors.length > 0 && errors.every(isDeterministicDeleteRejection)
      ? { error: lastError, receipt, status: "failed" }
      : { error: lastError, receipt, serverStatus, status: "pending_confirmation" };
  } catch (error) {
    // Unknown is not failure and, critically, is not authority to remove local
    // audio. The durable receipt will be checked again on the next launch.
    return { error, receipt, status: "pending_confirmation" };
  }
}

export async function reconcileAccountDeletionReceipt(input: {
  checkStatus: (ticket: string) => Promise<AccountDeletionServerStatus>;
  nowMs?: number;
  receipt: AccountDeletionReceipt;
}): Promise<AccountDeletionReconciliation> {
  const nowMs = input.nowMs ?? Date.now();
  if (Date.parse(input.receipt.expiresAt) <= nowMs) {
    return { receipt: input.receipt, status: "expired" };
  }
  try {
    return {
      receipt: input.receipt,
      status: await input.checkStatus(input.receipt.ticket),
    };
  } catch (error) {
    return { error, receipt: input.receipt, status: "unknown" };
  }
}

export function serializeAccountDeletionReceipt(receipt: AccountDeletionReceipt) {
  return JSON.stringify(receipt);
}

export function parseAccountDeletionReceipt(value: string | null): AccountDeletionReceipt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AccountDeletionReceipt>;
    if (
      parsed.version !== 1 ||
      typeof parsed.ticket !== "string" ||
      parsed.ticket.length < 20 ||
      parsed.ticket.length > 4096 ||
      typeof parsed.userId !== "string" ||
      !/^[A-Za-z0-9_-]{1,192}$/.test(parsed.userId) ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.expiresAt))
    ) return null;
    return parsed as AccountDeletionReceipt;
  } catch {
    return null;
  }
}

function isDeterministicDeleteRejection(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
