#!/usr/bin/env node

const { filterMeetingHistory } = await import("../apps/mobile/src/meeting-history.ts");

const meetings = [
  meeting("completed", {
    hasResult: true,
    metadata: { participants: ["王鹏远", "产品同事"], project: "OwnMinutes", tags: ["发布", "iOS"] },
    title: "产品周会",
  }),
  meeting("pending", {
    hasResult: false,
    metadata: { participants: ["客服团队"], project: "客户成功", tags: ["访谈"] },
    processing: { status: "failed" },
    title: "用户访谈复盘",
  }),
  meeting("shared", {
    hasResult: true,
    metadata: { participants: ["开发者"], project: "开源", tags: ["Roadmap"] },
    share: { includeTranscript: false, visibility: "public" },
    title: "Open Source Roadmap",
  }),
];

const ids = (items) => items.map((item) => item.meetingId);
const checks = {
  keepsOriginalOrder: ids(filterMeetingHistory(meetings, { filter: "all", query: "" })).join(",") === "completed,pending,shared",
  searchesChineseTitle: ids(filterMeetingHistory(meetings, { filter: "all", query: "产品 周会" })).join(",") === "completed",
  searchesProject: ids(filterMeetingHistory(meetings, { filter: "all", query: "客户成功" })).join(",") === "pending",
  searchesParticipants: ids(filterMeetingHistory(meetings, { filter: "all", query: "产品同事" })).join(",") === "completed",
  searchesTagsCaseInsensitively: ids(filterMeetingHistory(meetings, { filter: "all", query: "roadmap" })).join(",") === "shared",
  filtersCompleted: ids(filterMeetingHistory(meetings, { filter: "completed", query: "" })).join(",") === "completed,shared",
  filtersPendingIncludingFailures: ids(filterMeetingHistory(meetings, { filter: "pending", query: "" })).join(",") === "pending",
  filtersShared: ids(filterMeetingHistory(meetings, { filter: "shared", query: "" })).join(",") === "shared",
  combinesQueryAndFilter: ids(filterMeetingHistory(meetings, { filter: "completed", query: "开源" })).join(",") === "shared",
};

console.log(JSON.stringify(checks, null, 2));

if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function meeting(meetingId, overrides = {}) {
  return {
    durationMs: 60_000,
    hasResult: false,
    meetingId,
    metadata: { participants: [], tags: [] },
    processing: null,
    qualityStatus: "unverified",
    share: { includeTranscript: false, visibility: "private" },
    title: meetingId,
    totalBytes: 1,
    totalChunks: 1,
    transcriptCount: 0,
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}
