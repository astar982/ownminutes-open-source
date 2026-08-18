import crypto from "node:crypto";

export function meetingDeletionFenceRef(meetingId: string) {
  return crypto
    .createHash("sha256")
    .update(`ownminutes-meeting-deletion-fence:v1:${meetingId}`)
    .digest("hex");
}

export function meetingDeletionOwnerProofRef(meetingId: string, ownerUserId: string) {
  return crypto
    .createHash("sha256")
    .update(`ownminutes-meeting-deletion-owner-proof:v1:${meetingId}\u0000${ownerUserId}`)
    .digest("hex");
}
