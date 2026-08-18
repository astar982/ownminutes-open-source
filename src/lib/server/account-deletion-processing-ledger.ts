import crypto from "node:crypto";

type AccountDeletionProcessingLedgerClient = {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: T[] }>;
};

export async function archiveAndDeletePostgresProcessingLedger(
  client: AccountDeletionProcessingLedgerClient,
  userId: string,
) {
  await client.query("select id from users where id = $1 for update", [userId]);
  const totals = await client.query<{
    free_trial_minutes_settled: number | string;
    official_minutes_settled: number | string;
    provider_steps: number | string;
  }>(
    `select count(*) as provider_steps,
            coalesce(sum(official_minutes_settled), 0) as official_minutes_settled,
            coalesce(sum(free_trial_minutes_settled), 0) as free_trial_minutes_settled
     from meeting_processing_provider_steps
     where user_id = $1`,
    [userId],
  );
  const aggregate = totals.rows[0];
  if (Number(aggregate?.provider_steps || 0) > 0) {
    await client.query(
      `insert into account_deletion_provider_cost_aggregates (
         id, source_ref, provider_steps, official_minutes_settled,
         free_trial_minutes_settled, recorded_at
       ) values ($1, $2, $3, $4, $5, now())
       on conflict (source_ref) where source_ref is not null do nothing`,
      [
        `account-delete-cost-${crypto.randomUUID()}`,
        providerCostSourceRef("account", userId),
        Number(aggregate.provider_steps),
        Number(aggregate.official_minutes_settled),
        Number(aggregate.free_trial_minutes_settled),
      ],
    );
  }
  await client.query("delete from meeting_processing_reservations where user_id = $1", [userId]);
}

export async function archiveAndDeletePostgresMeetingProcessingLedger(
  client: AccountDeletionProcessingLedgerClient,
  userId: string,
  meetingId: string,
) {
  // Every account-wide and meeting-scoped archive serializes on the same user
  // row. Whichever transaction wins removes its covered provider steps; the
  // later transaction observes only the remainder, so settled cost is counted
  // exactly once across concurrent deletion workers.
  await client.query("select id from users where id = $1 for update", [userId]);
  const totals = await client.query<{
    free_trial_minutes_settled: number | string;
    official_minutes_settled: number | string;
    provider_steps: number | string;
  }>(
    `select count(*) as provider_steps,
            coalesce(sum(step.official_minutes_settled), 0) as official_minutes_settled,
            coalesce(sum(step.free_trial_minutes_settled), 0) as free_trial_minutes_settled
     from meeting_processing_provider_steps step
     join meeting_processing_reservations reservation on reservation.id = step.reservation_id
     where reservation.user_id = $1 and reservation.meeting_id = $2`,
    [userId, meetingId],
  );
  const aggregate = totals.rows[0];
  if (Number(aggregate?.provider_steps || 0) > 0) {
    await client.query(
      `insert into account_deletion_provider_cost_aggregates (
         id, source_ref, provider_steps, official_minutes_settled,
         free_trial_minutes_settled, recorded_at
       ) values ($1, $2, $3, $4, $5, now())
       on conflict (source_ref) where source_ref is not null do nothing`,
      [
        `meeting-delete-cost-${crypto.randomUUID()}`,
        providerCostSourceRef("meeting", userId, meetingId),
        Number(aggregate.provider_steps),
        Number(aggregate.official_minutes_settled),
        Number(aggregate.free_trial_minutes_settled),
      ],
    );
  }
  const usagePrefix = `Finalized meeting:${meetingId} `;
  await client.query(
    `update usage_events
     set note = 'Deleted meeting usage retained without meeting identity.',
         processing_reservation_id = null
     where user_id = $1
       and type = 'meeting_finalize'
       and (
         left(note, char_length($3::text)) = $3
         or exists (
           select 1
           from meeting_processing_reservations reservation
           where reservation.id = usage_events.processing_reservation_id
             and reservation.user_id = $1
             and reservation.meeting_id = $2
         )
       )`,
    [userId, meetingId, usagePrefix],
  );
  await client.query(
    "delete from meeting_processing_reservations where user_id = $1 and meeting_id = $2",
    [userId, meetingId],
  );
}

function providerCostSourceRef(scope: "account" | "meeting", userId: string, meetingId = "") {
  return crypto
    .createHash("sha256")
    .update("ownminutes-provider-cost-source:v1\u0000")
    .update(scope)
    .update("\u0000")
    .update(userId)
    .update("\u0000")
    .update(meetingId)
    .digest("hex");
}
