#!/usr/bin/env node

import { readFileSync } from "node:fs";

const recorderSource = readFileSync("src/components/meeting-recorder.tsx", "utf8");
const detailSource = readFileSync("src/components/meeting-detail-actions.tsx", "utf8");
const historySource = readFileSync("src/components/meeting-history-panel.tsx", "utf8");
const mobileSource = readFileSync("apps/mobile/App.tsx", "utf8");
const shareRouteSource = readFileSync("src/app/api/meetings/[id]/share/route.ts", "utf8");
const reviewRouteSource = readFileSync("src/app/api/meetings/[id]/review/route.ts", "utf8");
const humanReviewSource = readFileSync("src/lib/server/meeting-human-review.ts", "utf8");
const meetingStoreSource = readFileSync("src/lib/server/meeting-audio-store.ts", "utf8");
const publicShareSource = readFileSync("src/app/share/[id]/page.tsx", "utf8");
const publicMarkdownSource = readFileSync("src/app/api/share/[id]/markdown/route.ts", "utf8");

const checks = {
  recorderConfirmsPublish:
    recorderSource.includes("assessMeetingResultQuality(finalResult)") &&
    recorderSource.includes("确认发布分享链接？当前公开摘要、发言人观点、决策和待办，逐字稿默认隐藏。拥有链接的人可以查看已公开内容。") &&
    recorderSource.includes("质量提示：当前结果是") &&
    recorderSource.includes("发布分享前请人工复核") &&
    recorderSource.includes("请确认你已经人工复核") &&
    recorderSource.includes("仍可能把内容当作会议事实传播") &&
    recorderSource.includes("if (!confirmed) return;") &&
    recorderSource.includes('publishMeetingShare(meetingId, false, quality.status !== "verified")'),
  detailConfirmsPublicShare:
    detailSource.includes("function confirmShareChange(nextShare: ShareState, quality: MeetingResultQuality)") &&
    detailSource.includes("确认发布分享链接？拥有链接的人可以查看摘要、发言人观点、决策和待办，逐字稿默认隐藏。") &&
    detailSource.includes("确认公开分享并包含逐字稿？拥有链接的人可以查看摘要、发言人观点、决策、待办和逐字稿。") &&
    detailSource.includes("质量提示：当前结果是") &&
    detailSource.includes("发布前请人工复核") &&
    detailSource.includes("请确认你已经人工复核") &&
    detailSource.includes("if (!confirmShareChange(nextShare, quality)) return;") &&
    detailSource.includes('confirmUnverified: nextShare.visibility === "public" && quality.status !== "verified"'),
  historyConfirmsPublicShare:
    historySource.includes('function confirmShareChange(meeting: MeetingListItem, visibility: "private" | "public", includeTranscript: boolean)') &&
    historySource.includes("确认发布分享链接？拥有链接的人可以查看摘要、发言人观点、决策和待办，逐字稿默认隐藏。") &&
    historySource.includes("确认公开分享并包含逐字稿？拥有链接的人可以查看摘要、发言人观点、决策、待办和逐字稿。") &&
    historySource.includes("if (!confirmShareChange(meeting, visibility, includeTranscript)) return;") &&
    historySource.includes('confirmUnverified: visibility === "public" && meeting.qualityStatus !== "verified"'),
  mobileConfirmsPublicShare:
    mobileSource.includes('function confirmSelectedMeetingShare(input: { visibility: "private" | "public"; includeTranscript: boolean })') &&
    mobileSource.includes("assessMobileMeetingQuality(selectedMeeting?.result ?? null)") &&
    mobileSource.includes('Alert.alert("发布分享链接", `确认发布分享链接？拥有链接的人可以查看摘要、发言人观点、决策和待办，逐字稿默认隐藏。${qualityWarning}`') &&
    mobileSource.includes('Alert.alert("公开逐字稿", `确认公开分享并包含逐字稿？拥有链接的人可以查看摘要、发言人观点、决策、待办和逐字稿。${qualityWarning}`') &&
    mobileSource.includes("质量提示：当前结果是") &&
    mobileSource.includes("发布分享前请人工复核") &&
    mobileSource.includes("请确认你已经人工复核") &&
    mobileSource.includes("仍可能把内容当作会议事实传播") &&
    mobileSource.includes('onPress={() => confirmSelectedMeetingShare({ visibility: "public", includeTranscript: false })}') &&
    mobileSource.includes('onPress={() => confirmSelectedMeetingShare({ visibility: "public", includeTranscript: !selectedMeeting.share.includeTranscript })}'),
  apiRequiresExplicitUnverifiedConfirmation:
    shareRouteSource.includes('body.confirmUnverified !== true') &&
    shareRouteSource.includes('code: "unverified_result_confirmation_required"') &&
    shareRouteSource.includes("qualityConfirmationRequired: true") &&
    shareRouteSource.includes('code: "meeting_result_required"') &&
    mobileSource.includes('confirmUnverified: input.visibility === "public" && selectedMeetingQuality.status !== "verified"'),
  reviewBindsToExactResultVersion:
    humanReviewSource.includes('resultFingerprint: fingerprintMeetingResult(result)') &&
    humanReviewSource.includes('confirmation.resultFingerprint !== fingerprintMeetingResult(result)') &&
    humanReviewSource.includes('status: "pending", confirmedAt: confirmation.confirmedAt, needsReconfirmation: true') &&
    humanReviewSource.includes('/^[a-f0-9]{64}$/'),
  serverRequiresPersistedHumanReview:
    shareRouteSource.includes('meeting.humanReview.status !== "confirmed"') &&
    shareRouteSource.includes('code: "human_review_required"') &&
    meetingStoreSource.includes('resolveMeetingHumanReview(manifest.reviewConfirmation, result).status !== "confirmed"') &&
    meetingStoreSource.includes('code: "human_review_required"') &&
    reviewRouteSource.includes('typeof body.confirmed !== "boolean"') &&
    reviewRouteSource.includes("updateMeetingHumanReview"),
  editsRevokePublishedVersion:
    meetingStoreSource.includes("function revokeMeetingShare(manifest: AudioManifest)") &&
    meetingStoreSource.includes("manifest.reviewConfirmation = input.confirmed ? createMeetingReviewConfirmation(result) : undefined") &&
    meetingStoreSource.includes("if (!input.confirmed) revokeMeetingShare(manifest)") &&
    meetingStoreSource.includes("humanReview: resolveMeetingHumanReview(manifest.reviewConfirmation, updatedResult)"),
  publicSurfacesRejectStaleReview:
    publicShareSource.includes('access.humanReview.status !== "confirmed"') &&
    publicShareSource.includes('access.humanReview.status === "confirmed"') &&
    publicMarkdownSource.includes('access.humanReview.status !== "confirmed"'),
  webShowsHumanReviewControl:
    recorderSource.includes("confirmMeetingHumanReview") &&
    recorderSource.includes("确认已完成复核") &&
    recorderSource.includes("!humanReviewConfirmed") &&
    detailSource.includes('data-meeting-human-review={humanReview.status}') &&
    detailSource.includes("确认已完成复核") &&
    historySource.includes('meeting.humanReview.status !== "confirmed"'),
  mobileShowsHumanReviewControl:
    mobileSource.includes("updateMeetingHumanReview") &&
    mobileSource.includes("confirmSelectedMeetingHumanReview") &&
    mobileSource.includes("selectedMeeting.humanReview.needsReconfirmation") &&
    mobileSource.includes('selectedMeeting.humanReview.status !== "confirmed"'),
  mobileKeepsRevokeDirect:
    mobileSource.includes('onPress={() => void changeSelectedMeetingShare({ visibility: "private", includeTranscript: false })}') &&
    mobileSource.includes('if (input.visibility !== "public")') &&
    mobileSource.includes("void changeSelectedMeetingShare(input);"),
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) {
  process.exitCode = 1;
}
