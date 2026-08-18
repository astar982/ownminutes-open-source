#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

process.env.NODE_ENV = "test";

const jiti = createJiti(import.meta.url);
const {
  deleteAccountWithConfirmation,
  parseAccountDeletionReceipt,
  reconcileAccountDeletionReceipt,
  serializeAccountDeletionReceipt,
} = await jiti.import("../apps/mobile/src/account-deletion.ts");
const { readAccountDeletionResponse } = await jiti.import(
  "../apps/mobile/src/account-deletion-transport.ts"
);
const {
  createAccountDeletionTicket,
  verifyAccountDeletionTicket,
} = await jiti.import("../src/lib/server/account-deletion-ticket.ts");

const direct = await runScenario({
  deletes: [{ deletedMeetings: 3, ok: true, status: "deleted" }],
});
assert.equal(direct.resolution.status, "deleted");
assert.equal(direct.resolution.confirmedBy, "response");
assert.deepEqual(direct.order.slice(0, 3), ["prepare", "persist", "delete"]);

const retry = await runScenario({
  deletes: [transportError("lost response"), { ok: true, status: "deleted" }],
});
assert.equal(retry.resolution.status, "deleted");
assert.equal(retry.resolution.confirmedBy, "retry");
assert.equal(retry.deleteCalls, 2);

const status = await runScenario({
  deletes: [transportError("lost response 1"), transportError("lost response 2")],
  serverStatus: "deleted",
});
assert.equal(status.resolution.status, "deleted");
assert.equal(status.resolution.confirmedBy, "status");

const explicitCleanup = await readAccountDeletionResponse(jsonResponse(202, {
  ok: true,
  status: "pending_cleanup",
}), "en");
const pendingCleanup = await runScenario({ deletes: [explicitCleanup] });
assert.equal(pendingCleanup.resolution.status, "pending_confirmation");
assert.equal(pendingCleanup.resolution.serverStatus, "pending_cleanup");
assert.equal(pendingCleanup.deleteCalls, 1);

const bareAccepted = await readAccountDeletionResponse(jsonResponse(202, { ok: true }), "en");
const bareAcceptedResult = await runScenario({ deletes: [bareAccepted] });
assert.equal(bareAcceptedResult.resolution.status, "pending_confirmation");
assert.equal(bareAcceptedResult.resolution.serverStatus, "pending_cleanup");

const unknown = await runScenario({
  deletes: [transportError("timeout 1"), transportError("timeout 2")],
  statusError: transportError("status timeout"),
});
assert.equal(unknown.resolution.status, "pending_confirmation");

const activeAfterTransportLoss = await runScenario({
  deletes: [transportError("timeout 1"), transportError("timeout 2")],
  serverStatus: "active",
});
assert.equal(activeAfterTransportLoss.resolution.status, "pending_confirmation");
assert.equal(activeAfterTransportLoss.resolution.serverStatus, "active");

const forbidden403 = await captureResponseError(jsonResponse(403, { error: "Forbidden", ok: false }));
const unauthorized401 = await captureResponseError(jsonResponse(401, { error: "Unauthorized", ok: false }));
assert.equal(forbidden403.status, 403);
assert.equal(unauthorized401.status, 401);
const deterministicFailure = await runScenario({
  deletes: [forbidden403, unauthorized401],
  serverStatus: "active",
});
assert.equal(deterministicFailure.resolution.status, "failed");

const preparationFailure = await runScenario({
  deletes: [{ ok: true, status: "deleted" }],
  prepareError: transportError("ticket unavailable"),
});
assert.equal(preparationFailure.resolution.status, "failed");
assert.equal(preparationFailure.deleteCalls, 0);
assert.equal(preparationFailure.persistCalls, 0);

const persistenceFailure = await runScenario({
  deletes: [{ ok: true, status: "deleted" }],
  persistError: transportError("secure store unavailable"),
});
assert.equal(persistenceFailure.resolution.status, "failed");
assert.equal(persistenceFailure.deleteCalls, 0);
assert.equal(persistenceFailure.persistCalls, 1);

const nowMs = Date.parse("2026-07-19T10:00:00.000Z");
const signedTicket = createAccountDeletionTicket("user-account-delete", nowMs);
const ticketExpiryMs = Date.parse(signedTicket.expiresAt);
assert.equal(verifyAccountDeletionTicket(signedTicket.ticket, nowMs + 1_000)?.userId, "user-account-delete");
assert.equal(verifyAccountDeletionTicket(signedTicket.ticket, ticketExpiryMs - 1)?.userId, "user-account-delete");
assert.equal(verifyAccountDeletionTicket(`${signedTicket.ticket}x`, nowMs + 1_000), null);
assert.equal(verifyAccountDeletionTicket(signedTicket.ticket, ticketExpiryMs + 1), null);

const durableReceipt = {
  expiresAt: signedTicket.expiresAt,
  ticket: signedTicket.ticket,
  userId: "user-account-delete",
  version: 1,
};
assert.deepEqual(parseAccountDeletionReceipt(serializeAccountDeletionReceipt(durableReceipt)), durableReceipt);
assert.equal(parseAccountDeletionReceipt("{}"), null);

for (const expected of ["active", "pending_cleanup", "deleted"]) {
  const reconciled = await reconcileAccountDeletionReceipt({
    checkStatus: async () => expected,
    nowMs: nowMs + 1_000,
    receipt: durableReceipt,
  });
  assert.equal(reconciled.status, expected);
}
assert.equal(
  (await reconcileAccountDeletionReceipt({
    checkStatus: async () => "deleted",
    nowMs: ticketExpiryMs + 1,
    receipt: durableReceipt,
  })).status,
  "expired",
);
assert.equal(
  (await reconcileAccountDeletionReceipt({
    checkStatus: async () => { throw transportError("offline"); },
    nowMs: nowMs + 1_000,
    receipt: durableReceipt,
  })).status,
  "unknown",
);

// Simulate a process kill after DELETE: the next process receives only the
// SecureStore receipt, server status, local audio IDs and session state.
const coldStartStore = new Map([
  ["receipt", serializeAccountDeletionReceipt(durableReceipt)],
  ["session", "ownminutes_session=old"],
]);
const coldStartLocalAudio = ["meeting-local-1", "meeting-local-2"];
const cleanupInProgress = await runColdStartHarness({
  localAudio: coldStartLocalAudio,
  nowMs: nowMs + 1_000,
  serverStatus: "pending_cleanup",
  store: coldStartStore,
});
assert.deepEqual(cleanupInProgress.localAudio, coldStartLocalAudio);
assert.equal(cleanupInProgress.receiptRetained, true);
assert.equal(cleanupInProgress.sessionRetained, false);

const cleanupConfirmed = await runColdStartHarness({
  localAudio: cleanupInProgress.localAudio,
  nowMs: nowMs + 2_000,
  serverStatus: "deleted",
  store: coldStartStore,
});
assert.deepEqual(cleanupConfirmed.localAudio, []);
assert.equal(cleanupConfirmed.receiptRetained, false);

const expiredStore = new Map([
  ["receipt", serializeAccountDeletionReceipt(durableReceipt)],
  ["session", "ownminutes_session=old"],
]);
const expired = await runColdStartHarness({
  localAudio: coldStartLocalAudio,
  nowMs: ticketExpiryMs + 1,
  serverStatus: "deleted",
  store: expiredStore,
});
assert.equal(expired.status, "expired");
assert.deepEqual(expired.localAudio, coldStartLocalAudio);
assert.equal(expired.receiptRetained, true);
assert.equal(expired.sessionRetained, false);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const deletionSource = readFileSync("apps/mobile/src/account-deletion.ts", "utf8");
const serverRouteSource = readFileSync("src/app/api/auth/delete/route.ts", "utf8");
const serverStateSource = readFileSync("src/lib/server/account-deletion-state.ts", "utf8");
const serverAuthRepositorySource = readFileSync("src/lib/server/auth-repository.ts", "utf8");
const inlineCleanupSource = serverRouteSource.slice(
  serverRouteSource.indexOf("if (!cleanup.scheduled)"),
  serverRouteSource.indexOf("await deleteAccount(user.id)"),
);
const restoreFlow = appSource.slice(
  appSource.indexOf("const restoreSession = useCallback"),
  appSource.indexOf("const clearLocalSession = useCallback"),
);
const deleteFlow = appSource.slice(
  appSource.indexOf("async function deleteCurrentAccount()"),
  appSource.indexOf("async function shareAccountExport()"),
);
assert.ok(restoreFlow.indexOf("pendingAccountDeletionKey") < restoreFlow.indexOf("storedCookie"));
assert.ok(restoreFlow.indexOf('reconciliation.status === "deleted"') < restoreFlow.indexOf("deleteLocalRecordingsForUser"));
assert.ok(deleteFlow.includes("SecureStore.setItemAsync(pendingAccountDeletionKey"));
assert.ok(deleteFlow.includes('if (resolution.status === "pending_confirmation")'));
assert.ok(deleteFlow.includes('if (resolution.status === "failed")'));
assert.ok(deleteFlow.indexOf("deleteLocalRecordingsForUser") > deleteFlow.indexOf('if (resolution.status === "failed")'));
assert.ok(deleteFlow.includes("await clearLocalSession(message)"));
assert.ok(deletionSource.indexOf("await input.persistReceipt(receipt)") < deletionSource.indexOf("await input.requestDelete()"));
assert.ok(deletionSource.includes('deletion.status === "deleted"'));
assert.ok(!deletionSource.includes("if (deletion.ok)"));
assert.ok(serverRouteSource.includes("const status = await resolveAccountDeletionStatus(user.id)"));
assert.ok(serverRouteSource.includes("const cleanup = await scheduleAccountDeletionCleanup(user.id)"));
assert.ok(serverRouteSource.includes("await assertAccountDeletionStorageIntegrity()"));
assert.ok(serverRouteSource.includes("await cancelAccountDeletionCleanupForActiveUser(user.id)"));
assert.ok(serverRouteSource.includes("const existingStatus = await resolveAccountDeletionStatus(user.id)"));
assert.ok(serverRouteSource.includes('if (existingStatus !== "active") return deletionResponse(existingStatus)'));
assert.ok(
  serverRouteSource.indexOf("const existingStatus = await resolveAccountDeletionStatus(user.id)") <
    serverRouteSource.indexOf("const cleanup = await scheduleAccountDeletionCleanup(user.id)"),
);
assert.ok(inlineCleanupSource.startsWith("if (!cleanup.scheduled)"));
assert.ok(inlineCleanupSource.includes("await deleteAllUserMeetings(user.id)"));
assert.ok(inlineCleanupSource.includes("if (inlineCleanup.cleanupPending)"));
assert.ok(inlineCleanupSource.includes("throw new MeetingAccessError"));
assert.ok(inlineCleanupSource.includes('code: "account_object_cleanup_pending"'));
assert.ok(inlineCleanupSource.includes("retryable: true"));
assert.ok(inlineCleanupSource.includes("retryAfterSeconds: 30"));
assert.ok(
  serverRouteSource.indexOf("await scheduleAccountDeletionCleanup(user.id)") <
    serverRouteSource.indexOf("await deleteAccount(user.id)"),
);
assert.ok(
  serverRouteSource.indexOf("await deleteAccount(user.id)") <
    serverRouteSource.indexOf(
      "const status = await resolveAccountDeletionStatus(user.id)",
      serverRouteSource.indexOf("await deleteAccount(user.id)"),
    ),
);
assert.ok(serverRouteSource.includes("{ ok: true, status },"));
assert.ok(!serverRouteSource.includes("...deleted"));
assert.ok(serverRouteSource.includes('status === "pending_cleanup" ? 202 : 200'));
assert.ok(serverRouteSource.includes("return NextResponse.json({ ok: true, status })"));
assert.ok(serverStateSource.includes('export type AccountDeletionStatus = "active" | "pending_cleanup" | "deleted"'));
assert.ok(serverStateSource.includes("delete from account_deletion_cleanup_jobs job"));
assert.ok(serverStateSource.includes("users.deleted_at is null"));
assert.ok(serverAuthRepositorySource.includes("delete from meeting_finalization_jobs where owner_user_id = $1"));

console.log(JSON.stringify({
  acceptedWithoutExplicitDeletedKeepsLocalAudio: true,
  coldStartReconciliationCovered: true,
  deterministicResponseErrorsKeepHttpStatus: true,
  durableReceiptPrecedesDelete: true,
  localCleanupRequiresConfirmedDeletion: true,
  lostResponsesCanUseSignedStatus: true,
  signedTicketRejectsTamperingAndExpiry: true,
  serverAndMobileShareExplicitTriStateContract: true,
}, null, 2));

async function runScenario({
  deletes,
  persistError,
  prepareError,
  serverStatus = "active",
  statusError,
}) {
  let deleteCalls = 0;
  let persistCalls = 0;
  const order = [];
  const resolution = await deleteAccountWithConfirmation({
    async checkStatus() {
      order.push("status");
      if (statusError) throw statusError;
      return serverStatus;
    },
    async persistReceipt() {
      order.push("persist");
      persistCalls += 1;
      if (persistError) throw persistError;
    },
    async prepareTicket() {
      order.push("prepare");
      if (prepareError) throw prepareError;
      return {
        expiresAt: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
        ticket: "signed-account-deletion-ticket-for-smoke-test",
      };
    },
    async requestDelete() {
      order.push("delete");
      const outcome = deletes[deleteCalls];
      deleteCalls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    userId: "user-account-delete",
  });
  return { deleteCalls, order, persistCalls, resolution };
}

async function runColdStartHarness({ localAudio, nowMs, serverStatus, store }) {
  const raw = store.get("receipt") ?? null;
  const receipt = parseAccountDeletionReceipt(raw);
  assert.ok(receipt);
  const reconciliation = await reconcileAccountDeletionReceipt({
    checkStatus: async () => serverStatus,
    nowMs,
    receipt,
  });
  if (reconciliation.status === "deleted") {
    store.delete("receipt");
    store.delete("session");
    return {
      localAudio: [],
      receiptRetained: false,
      sessionRetained: false,
      status: "deleted",
    };
  }
  if (reconciliation.status === "active") store.delete("receipt");
  else store.delete("session");
  return {
    localAudio: [...localAudio],
    receiptRetained: store.has("receipt"),
    sessionRetained: store.has("session"),
    status: reconciliation.status,
  };
}

async function captureResponseError(response) {
  try {
    await readAccountDeletionResponse(response, "en");
    throw new Error("Expected account deletion response to fail");
  } catch (error) {
    return error;
  }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function transportError(message) {
  return new Error(message);
}
