import crypto from "node:crypto";
import { MeetingAccessError } from "@/lib/server/meeting-errors";
import { meetingDeletionFenceRef } from "@/lib/server/meeting-deletion-proof";
import {
  getPostgresDatabaseUrl,
  getPostgresRuntimePool,
} from "@/lib/server/postgres-runtime";

export type MeetingObjectTransferKind =
  | "asr_transient"
  | "catalog_manifest"
  | "recording_commit"
  | "recording_staging";

export type MeetingObjectTransferIntent = {
  expiresAt: string;
  intentId: string;
  meetingId: string;
  ownerUserId: string;
  transferKind: MeetingObjectTransferKind;
};

type MeetingObjectTransferIntentRow = {
  expires_at: Date | string;
  intent_id: string;
  meeting_id: string;
  owner_user_id: string;
  transfer_kind: MeetingObjectTransferKind;
};

export function isMeetingObjectTransferIntentEnabled() {
  return (
    process.env.OWNMINUTES_AUTH_REPOSITORY === "postgres" &&
    Boolean(getPostgresDatabaseUrl())
  );
}

export async function beginMeetingObjectTransferIntent(input: {
  meetingId: string;
  ownerUserId: string;
  transferKind: MeetingObjectTransferKind;
}) {
  const meetingId = canonicalMeetingId(input.meetingId);
  if (!isMeetingObjectTransferIntentEnabled()) return null;
  const intentId = `meeting_transfer_${crypto.randomUUID().replaceAll("-", "")}`;
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query<{ intent_id: string }>(
    `insert into meeting_object_transfer_intents (
       intent_id, meeting_id, owner_user_id, transfer_kind, created_at, expires_at
     )
     select $1, $2, $3, $4, now(), now() + ($5::bigint * interval '1 millisecond')
     where exists (
       select 1 from users where id = $3 and deleted_at is null
     )
       and not exists (
         select 1 from meeting_deletion_tombstones where meeting_id = $2
       )
       and not exists (
         select 1 from meeting_deletion_fences where meeting_ref = $6
       )
       and not exists (
         select 1 from meetings
         where id = $2 and owner_user_id <> $3
       )
       and not exists (
         select 1 from meeting_object_transfer_intents
         where meeting_id = $2 and owner_user_id <> $3
       )
     returning intent_id`,
    [
      intentId,
      meetingId,
      input.ownerUserId,
      input.transferKind,
      transferIntentLifetimeMs(input.transferKind),
      meetingDeletionFenceRef(meetingId),
    ],
  );
  if (result.rows[0]?.intent_id !== intentId) {
    throw new MeetingAccessError(
      "This meeting or account was deleted and cannot accept more audio.",
      410,
      { code: "meeting_deleted", retryable: false },
    );
  }
  return intentId;
}

export async function completeMeetingObjectTransferIntent(input: {
  intentId: string | null | undefined;
  meetingId: string;
  ownerUserId: string;
}) {
  if (!input.intentId || !isMeetingObjectTransferIntentEnabled()) return;
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query(
    `delete from meeting_object_transfer_intents
     where intent_id = $1 and meeting_id = $2 and owner_user_id = $3`,
    [input.intentId, canonicalMeetingId(input.meetingId), input.ownerUserId],
  );
  if (result.rowCount !== 1) {
    throw new MeetingAccessError(
      "Meeting transfer ownership changed before publication completed.",
      410,
      { code: "meeting_transfer_intent_lost", retryable: false },
    );
  }
}

export async function listMeetingObjectTransferIdsForOwner(ownerUserId: string) {
  if (!isMeetingObjectTransferIntentEnabled()) return [];
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query<{ meeting_id: string }>(
    `select distinct meeting_id
     from meeting_object_transfer_intents
     where owner_user_id = $1
     order by meeting_id asc`,
    [ownerUserId],
  );
  return result.rows.map((row) => row.meeting_id);
}

export async function hasPendingMeetingObjectTransfersForOwner(ownerUserId: string) {
  if (!isMeetingObjectTransferIntentEnabled()) return false;
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query<{ pending: boolean }>(
    `select exists(
       select 1 from meeting_object_transfer_intents where owner_user_id = $1
     ) as pending`,
    [ownerUserId],
  );
  return result.rows[0]?.pending === true;
}

export async function getMeetingObjectTransferOwner(
  meetingId: string,
  expectedOwnerUserId?: string,
) {
  if (!isMeetingObjectTransferIntentEnabled()) return undefined;
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query<{ owner_user_id: string }>(
    `select owner_user_id
     from meeting_object_transfer_intents
     where meeting_id = $1
       and ($2::text is null or owner_user_id = $2)
     order by created_at asc
     limit 1`,
    [canonicalMeetingId(meetingId), expectedOwnerUserId ?? null],
  );
  return result.rows[0]?.owner_user_id;
}

export async function listMeetingObjectTransferOwnersForMeeting(meetingId: string) {
  if (!isMeetingObjectTransferIntentEnabled()) return [];
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query<{ owner_user_id: string }>(
    `select distinct owner_user_id
     from meeting_object_transfer_intents
     where meeting_id = $1
     order by owner_user_id asc`,
    [canonicalMeetingId(meetingId)],
  );
  return result.rows.map((row) => row.owner_user_id);
}

export async function resolveMeetingObjectTransfersAfterDeletion(
  meetingId: string,
  ownerUserId: string,
) {
  if (!isMeetingObjectTransferIntentEnabled()) return;
  await getPostgresRuntimePool(
    "PostgreSQL meeting object transfer intent",
  ).query(
    `delete from meeting_object_transfer_intents
     where meeting_id = $1 and owner_user_id = $2`,
    [canonicalMeetingId(meetingId), ownerUserId],
  );
}

export async function resolveExpiredMeetingObjectTransfersForDeletion(
  meetingId: string,
  ownerUserId: string,
) {
  if (!isMeetingObjectTransferIntentEnabled()) return { resolved: 0 };
  const result = await getPostgresRuntimePool(
    "PostgreSQL expired meeting object transfer cleanup",
  ).query(
    `delete from meeting_object_transfer_intents
     where meeting_id = $1
       and owner_user_id = $2
       and expires_at <= now()`,
    [canonicalMeetingId(meetingId), ownerUserId],
  );
  return { resolved: result.rowCount ?? 0 };
}

export async function listExpiredMeetingCatalogTransferIntents(limit = 100) {
  if (!isMeetingObjectTransferIntentEnabled()) return [];
  const boundedLimit = Math.max(1, Math.min(500, Math.round(limit)));
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting catalog transfer recovery",
  ).query<MeetingObjectTransferIntentRow>(
    `select intent_id, meeting_id, owner_user_id, transfer_kind, expires_at
     from meeting_object_transfer_intents
     where transfer_kind = 'catalog_manifest' and expires_at <= now()
     order by expires_at asc
     limit $1`,
    [boundedLimit],
  );
  return result.rows.map(mapTransferIntent);
}

export async function getMeetingCatalogTransferIntentCount() {
  if (!isMeetingObjectTransferIntentEnabled()) return 0;
  const result = await getPostgresRuntimePool(
    "PostgreSQL meeting catalog transfer intent",
  ).query<{ count: number | string }>(
    `select count(*) as count
     from meeting_object_transfer_intents
     where transfer_kind = 'catalog_manifest'`,
  );
  return Number(result.rows[0]?.count || 0);
}

function transferIntentLifetimeMs(kind: MeetingObjectTransferKind) {
  if (kind === "catalog_manifest") return 10 * 60_000;
  return 65 * 60_000;
}

function canonicalMeetingId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new MeetingAccessError("Invalid meeting id.", 400, {
      code: "invalid_meeting_id",
      retryable: false,
    });
  }
  return value;
}

function mapTransferIntent(
  row: MeetingObjectTransferIntentRow,
): MeetingObjectTransferIntent {
  return {
    expiresAt: toIsoString(row.expires_at),
    intentId: row.intent_id,
    meetingId: row.meeting_id,
    ownerUserId: row.owner_user_id,
    transferKind: row.transfer_kind,
  };
}

function toIsoString(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
