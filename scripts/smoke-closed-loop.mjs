#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `smoke-closed-loop-${timestamp}`;
const email = `closed-loop-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

async function main() {
  const meetingDetailActionsSource = readFileSync("src/components/meeting-detail-actions.tsx", "utf8");
  const register = await postJson(`${baseUrl}/api/auth/register`, {
    name: "Closed Loop Smoke",
    email,
    password,
  }, null, "POST", { "x-forwarded-for": testIp });
  const cookie = extractCookie(register.response);
  const account = await getJson(`${baseUrl}/api/auth/me`, cookie);
  const audio = new Blob([buildSilentWav(16_000, 1)], {
    type: "audio/wav",
  });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, "chunk-000001.wav");

  const upload = await postForm(`${baseUrl}/api/meetings/${meetingId}/chunks`, form, cookie);
  const final = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/finalize`,
    {
      title: "OwnMinutes 闭环烟测",
      expectedLastSequence: upload.totalChunks,
      totalBytes: upload.totalBytes,
    },
    cookie,
  );
  await writeSpeakerRenameFixture(meetingId, "OwnMinutes 闭环烟测");
  const detailApi = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const metadata = await postJson(
    `${baseUrl}/api/meetings/${meetingId}`,
    {
      title: "OwnMinutes 移动归档烟测",
      project: "OwnMinutes Smoke",
      participants: ["王鹏远", "产品同事"],
      tags: ["smoke", "obsidian"],
    },
    cookie,
    "PATCH",
  );
  const detailAfterMetadata = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const speakerRename = await postJson(
    `${baseUrl}/api/meetings/${meetingId}`,
    {
      speakerNames: {
        "Speaker 1": "王鹏远",
        "Speaker 2": "产品同事",
      },
    },
    cookie,
    "PATCH",
  );
  const detailAfterSpeakerRename = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const transcriptSpeakerCorrection = await postJson(
    `${baseUrl}/api/meetings/${meetingId}`,
    {
      transcriptSpeakerAssignments: {
        "speaker-rename-3": "产品同事",
      },
    },
    cookie,
    "PATCH",
  );
  const detailAfterTranscriptSpeakerCorrection = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const staleTranscriptSpeakerCorrectionResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      Cookie: cookie,
    },
    body: JSON.stringify({
      transcriptSpeakerAssignments: {
        "stale-segment-id": "王鹏远",
      },
    }),
  });
  const staleTranscriptSpeakerCorrection = {
    response: staleTranscriptSpeakerCorrectionResponse,
    ...(await staleTranscriptSpeakerCorrectionResponse.json()),
  };
  const summaryEdit = await postJson(
    `${baseUrl}/api/meetings/${meetingId}`,
    {
      summaryPatch: {
        summary: "人工修订摘要：王鹏远和产品同事确认纪要编辑后必须同步分享页、导出文件和 Obsidian Markdown。",
        topics: ["人工修订纪要", "分享与知识库一致性"],
        speakerViews: [
          {
            speaker: "王鹏远",
            view: "强调人工修订后的发言人观点也必须进入正式纪要。",
          },
          {
            speaker: "产品同事",
            view: "确认分享页和 Obsidian Markdown 要使用同一版发言人观点。",
          },
        ],
        decisions: [
          {
            id: "manual-decision-smoke",
            title: "采用人工确认后的纪要版本",
            detail: "会后发布和知识库沉淀前，会议所有者可以修订摘要、决策和待办。",
            status: "confirmed",
          },
        ],
        actionItems: [
          {
            id: "manual-action-smoke",
            task: "验收人工修订内容是否同步到分享和 Markdown。",
            owner: "王鹏远",
            due: "本周",
            status: "confirmed",
          },
        ],
        risks: ["未人工复核的 AI 纪要不能直接作为正式事实。"],
        openQuestions: ["是否需要后续增加逐字稿局部编辑？"],
        knowledgePoints: ["OwnMinutes 的正式输出应以人工确认版本为准。"],
      },
    },
    cookie,
    "PATCH",
  );
  const detailAfterSummaryEdit = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const detailPage = await fetch(`${baseUrl}/meetings/${meetingId}`, {
    headers: { Cookie: cookie },
  });
  const detailPageText = await detailPage.text();
  const projectsPage = await fetch(`${baseUrl}/projects`, {
    headers: { Cookie: cookie },
  });
  const projectsPageText = await projectsPage.text();
  const projectDetailPage = await fetch(`${baseUrl}/projects/${encodeURIComponent("OwnMinutes Smoke")}`, {
    headers: { Cookie: cookie },
  });
  const projectDetailPageText = await projectDetailPage.text();
  const projectExportResponse = await fetch(`${baseUrl}/api/projects/${encodeURIComponent("OwnMinutes Smoke")}/export`, {
    headers: { Cookie: cookie },
  });
  const projectMarkdown = await projectExportResponse.text();
  const filteredMeetingsPage = await fetch(`${baseUrl}/meetings?project=${encodeURIComponent("OwnMinutes Smoke")}`, {
    headers: { Cookie: cookie },
  });
  const filteredMeetingsPageText = await filteredMeetingsPage.text();
  const exportResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}/export`, {
    headers: { Cookie: cookie },
  });
  const exportedMarkdown = await exportResponse.text();
  const privateShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const privateShareText = await privateShare.text();
  const publishBeforeHumanReviewResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      Cookie: cookie,
    },
    body: JSON.stringify({
      visibility: "public",
      includeTranscript: false,
      confirmUnverified: true,
    }),
  });
  const publishBeforeHumanReview = {
    response: publishBeforeHumanReviewResponse,
    ...(await publishBeforeHumanReviewResponse.json()),
  };
  const confirmHumanReview = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/review`,
    { confirmed: true },
    cookie,
  );
  const detailAfterHumanReview = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const publish = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/share`,
    {
      visibility: "public",
      includeTranscript: false,
      confirmUnverified: true,
    },
    cookie,
  );
  const share = await fetch(`${baseUrl}/share/${meetingId}`);
  const shareText = await share.text();
  const publicMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const publicMarkdown = await publicMarkdownResponse.text();
  const summaryEditAfterPublish = await postJson(
    `${baseUrl}/api/meetings/${meetingId}`,
    {
      summaryPatch: {
        summary: "人工修订摘要：王鹏远和产品同事确认纪要编辑后必须同步分享页、导出文件和 Obsidian Markdown。复核后更新。",
      },
    },
    cookie,
    "PATCH",
  );
  const detailAfterPublishedSummaryEdit = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const staleReviewShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const staleReviewShareText = await staleReviewShare.text();
  const staleReviewMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const confirmHumanReviewAfterEdit = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/review`,
    { confirmed: true },
    cookie,
  );
  const detailAfterHumanReviewReconfirm = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const shortExpiry = new Date(Date.now() + 1_000).toISOString();
  const expireShare = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/share`,
    {
      visibility: "public",
      includeTranscript: false,
      expiresAt: shortExpiry,
      confirmUnverified: true,
    },
    cookie,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const expiredShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const expiredShareText = await expiredShare.text();
  const expiredMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const republish = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/share`,
    {
      visibility: "public",
      includeTranscript: false,
      confirmUnverified: true,
    },
    cookie,
  );
  const publishTranscript = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/share`,
    {
      visibility: "public",
      includeTranscript: true,
      confirmUnverified: true,
    },
    cookie,
  );
  const transcriptShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const transcriptShareText = await transcriptShare.text();
  const transcriptMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const transcriptMarkdown = await transcriptMarkdownResponse.text();
  const meetings = await getJson(`${baseUrl}/api/meetings`, cookie);
  const listedMeeting = meetings.meetings?.find((meeting) => meeting.meetingId === meetingId);
  const revokeHumanReview = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/review`,
    { confirmed: false },
    cookie,
  );
  const detailAfterHumanReviewRevoke = await getJson(`${baseUrl}/api/meetings/${meetingId}`, cookie);
  const humanReviewRevokedShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const humanReviewRevokedShareText = await humanReviewRevokedShare.text();
  const humanReviewRevokedMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const revoke = await postJson(
    `${baseUrl}/api/meetings/${meetingId}/share`,
    {
      visibility: "private",
      includeTranscript: false,
    },
    cookie,
  );
  const revokedShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const revokedShareText = await revokedShare.text();
  const revokedMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  const deleteMeeting = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const deletePayload = await readJsonResponse(deleteMeeting, `${baseUrl}/api/meetings/${meetingId}`);
  const repeatDeleteMeeting = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const repeatDeletePayload = await readJsonResponse(repeatDeleteMeeting, `${baseUrl}/api/meetings/${meetingId}`);
  const meetingsAfterDelete = await getJson(`${baseUrl}/api/meetings`, cookie);
  const deletedShare = await fetch(`${baseUrl}/share/${meetingId}`);
  const deletedShareText = await deletedShare.text();
  const deletedMarkdownResponse = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
  await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });

  const result = final.result;
  const summary = {
    meetingId,
    uploadOk: upload.ok === true,
    savedBytes: upload.savedBytes,
    totalChunks: upload.totalChunks,
    uploadProvider: upload.provider,
    uploadAdapter: upload.adapter,
    accountOk: account.ok === true && Boolean(account.user?.id),
    finalizeOk: final.ok === true,
    finalProvider: result?.provider,
    finalAdapter: result?.adapter,
    transcriptCount: result?.transcript?.length ?? 0,
    summaryPreview: result?.summary?.summary?.slice(0, 120) ?? "",
    summaryAvoidsDemoDecisions:
      !JSON.stringify(result?.summary ?? {}).includes("采用混合处理架构") &&
      !JSON.stringify(result?.summary ?? {}).includes("第一版不做完整会议软件") &&
      !JSON.stringify(result?.summary ?? {}).includes("确认实时录音工作台的MVP字段"),
    markdownAvoidsDemoBody:
      !exportedMarkdown.includes("本次会议确认 OwnMinutes 第一版以实时录音工作台为核心") &&
      !exportedMarkdown.includes("采用混合处理架构") &&
      !exportedMarkdown.includes("确认实时录音工作台的MVP字段"),
    diagnostics: result?.diagnostics ?? [],
    detailApiOk: detailApi.ok === true && detailApi.meeting?.meetingId === meetingId,
    metadataOk: metadata.ok === true,
    metadataProject: detailAfterMetadata.meeting?.metadata?.project,
    metadataTitleUpdated: detailAfterMetadata.meeting?.title === "OwnMinutes 移动归档烟测" && detailAfterMetadata.meeting?.result?.title === "OwnMinutes 移动归档烟测",
    metadataHasParticipants:
      detailAfterMetadata.meeting?.metadata?.participants?.includes("王鹏远") &&
      detailAfterMetadata.meeting?.metadata?.participants?.includes("产品同事"),
    metadataHasTags: Array.isArray(detailAfterMetadata.meeting?.metadata?.tags) && detailAfterMetadata.meeting.metadata.tags.includes("smoke") && detailAfterMetadata.meeting.metadata.tags.includes("obsidian"),
    metadataMarkdownUpdated:
      exportedMarkdown.includes("# OwnMinutes 移动归档烟测") &&
      exportedMarkdown.includes("项目：OwnMinutes Smoke") &&
      exportedMarkdown.includes("参会人：王鹏远、产品同事") &&
      exportedMarkdown.includes("participants:\n  - 王鹏远\n  - 产品同事"),
    speakerRenameOk: speakerRename.ok === true,
    speakerRenameMapping: speakerRename.speakerNames,
    speakerRenameTranscriptUpdated:
      detailAfterSpeakerRename.meeting?.result?.transcript?.some((segment) => segment.speaker === "王鹏远") &&
      detailAfterSpeakerRename.meeting?.result?.transcript?.some((segment) => segment.speaker === "产品同事") &&
      !detailAfterSpeakerRename.meeting?.result?.transcript?.some((segment) => segment.speaker === "Speaker 1" || segment.speaker === "Speaker 2"),
    speakerRenameSummaryUpdated:
      JSON.stringify(detailAfterSpeakerRename.meeting?.result?.summary ?? {}).includes("王鹏远") &&
      JSON.stringify(detailAfterSpeakerRename.meeting?.result?.summary ?? {}).includes("产品同事") &&
      !JSON.stringify(detailAfterSpeakerRename.meeting?.result?.summary ?? {}).includes("Speaker 1"),
    speakerRenameMarkdownUpdated:
      typeof detailAfterSpeakerRename.meeting?.obsidianMarkdown === "string" &&
      detailAfterSpeakerRename.meeting.obsidianMarkdown.includes("王鹏远") &&
      detailAfterSpeakerRename.meeting.obsidianMarkdown.includes("产品同事") &&
      !detailAfterSpeakerRename.meeting.obsidianMarkdown.includes("Speaker 1"),
    transcriptSpeakerCorrectionOk: transcriptSpeakerCorrection.ok === true,
    transcriptSpeakerCorrectionMapping: transcriptSpeakerCorrection.speakerAssignments,
    transcriptSpeakerCorrectionResultUpdated:
      detailAfterTranscriptSpeakerCorrection.meeting?.result?.transcript?.some(
        (segment) => segment.id === "speaker-rename-3" && segment.speaker === "产品同事" && segment.text.includes("逐段校正"),
      ) &&
      detailAfterTranscriptSpeakerCorrection.meeting?.result?.transcript?.some(
        (segment) => segment.id === "speaker-rename-1" && segment.speaker === "王鹏远",
      ),
    transcriptSpeakerCorrectionMarkdownUpdated:
      typeof detailAfterTranscriptSpeakerCorrection.meeting?.obsidianMarkdown === "string" &&
      detailAfterTranscriptSpeakerCorrection.meeting.obsidianMarkdown.includes("**00:16 产品同事**：这段发言归属需要逐段校正。"),
    transcriptSpeakerCorrectionAudited:
      detailAfterTranscriptSpeakerCorrection.meeting?.result?.diagnostics?.some(
        (item) => item === "manual_speaker_assignment: 1 transcript segment(s) corrected; review summary attribution and action owners.",
      ),
    staleTranscriptSpeakerCorrectionRejected:
      staleTranscriptSpeakerCorrection.response.status === 409 &&
      staleTranscriptSpeakerCorrection.ok === false &&
      staleTranscriptSpeakerCorrection.error === "逐字稿已变化，请刷新后重新校正。",
    summaryEditOk: summaryEdit.ok === true,
    summaryEditDetailUpdated:
      detailAfterSummaryEdit.meeting?.result?.summary?.summary?.includes("人工修订摘要") &&
      detailAfterSummaryEdit.meeting?.result?.summary?.speakerViews?.some((item) => item.view === "强调人工修订后的发言人观点也必须进入正式纪要。") &&
      detailAfterSummaryEdit.meeting?.result?.summary?.decisions?.some((item) => item.title === "采用人工确认后的纪要版本") &&
      detailAfterSummaryEdit.meeting?.result?.summary?.actionItems?.some((item) => item.task === "验收人工修订内容是否同步到分享和 Markdown。"),
    summaryEditMarkdownUpdated:
      typeof detailAfterSummaryEdit.meeting?.obsidianMarkdown === "string" &&
      detailAfterSummaryEdit.meeting.obsidianMarkdown.includes("人工修订摘要") &&
      detailAfterSummaryEdit.meeting.obsidianMarkdown.includes("强调人工修订后的发言人观点也必须进入正式纪要") &&
      detailAfterSummaryEdit.meeting.obsidianMarkdown.includes("采用人工确认后的纪要版本") &&
      detailAfterSummaryEdit.meeting.obsidianMarkdown.includes("验收人工修订内容是否同步到分享和 Markdown。"),
    detailPageStatus: detailPage.status,
    detailPageVisible: detailPageText.includes("会议详情") || detailPageText.includes("会议纪要"),
    detailPageHasSummaryEditor:
      detailPageText.includes("人工修订纪要") &&
      detailPageText.includes("保存修订版纪要") &&
      detailPageText.includes("分享页和 Obsidian Markdown"),
    detailPageShowsSpeakerViews:
      detailPageText.includes("发言人观点") &&
      detailPageText.includes("强调人工修订后的发言人观点也必须进入正式纪要"),
    detailPageHasSpeakerEditor:
      detailPageText.includes("发言人校正") &&
      detailPageText.includes("保存发言人名称") &&
      detailPageText.includes("单设备混合录音无法承诺 100% 自动区分说话人") &&
      detailPageText.includes("人工确认发言人标签和待办负责人") &&
      detailPageText.includes("王鹏远") &&
      detailPageText.includes("产品同事"),
    detailPageHasTranscriptSpeakerCorrection:
      detailPageText.includes("逐字稿") &&
      detailPageText.includes("发现某一段被分给了错误的人时") &&
      detailPageText.includes("这里不会自动改写会议纪要的观点归因或待办负责人") &&
      detailPageText.includes("这段发言归属需要逐段校正") &&
      detailPageText.includes("没有待保存校正"),
    detailPageHasOutputStatus:
      detailPageText.includes("会后输出状态") &&
      detailPageText.includes("正式纪要") &&
      detailPageText.includes("分享链接") &&
      detailPageText.includes("Obsidian Markdown") &&
      detailPageText.includes("会议信息与归档"),
    detailPageHasUnifiedMobileShell:
      detailPageText.includes("ownminutes-mobile-shell") &&
      detailPageText.includes("bg-[#f8f7f3]") &&
      detailPageText.includes('data-meeting-detail-ui="progressive-v30"') &&
      detailPageText.includes('data-meeting-detail-section="summary"') &&
      detailPageText.includes('data-meeting-primary-notes="summary-decisions-actions"') &&
      detailPageText.includes('data-meeting-disclosure="share"') &&
      detailPageText.includes('data-meeting-disclosure="archive"') &&
      detailPageText.includes('data-meeting-disclosure="edit"') &&
      detailPageText.includes('data-meeting-disclosure="transcript"') &&
      detailPageText.includes('data-meeting-disclosure="output"') &&
      detailPageText.includes("app-icon-button-dark") &&
      detailPageText.includes('data-app-primary-nav="record-meetings-account"') &&
      detailPageText.includes('aria-current="page"') &&
      !detailPageText.includes("rounded-[1.75rem] bg-[#16261f]") &&
      !detailPageText.includes("bg-[#16261f] p-5 text-white"),
    detailPageHasShareExportPanel:
      detailPageText.includes("分享与知识库") &&
      detailPageText.includes("复制分享链接") &&
      detailPageText.includes("复制 Obsidian Markdown") &&
      detailPageText.includes("保存到 Obsidian") &&
      detailPageText.includes("下载 Markdown"),
    sharePublishWarnsBeforeUnverified:
      meetingDetailActionsSource.includes('quality.status !== "verified"') &&
      meetingDetailActionsSource.includes("结果质量：") &&
      meetingDetailActionsSource.includes("质量提示：当前结果是") &&
      meetingDetailActionsSource.includes("发布前请人工复核") &&
      meetingDetailActionsSource.includes("请确认你已经人工复核") &&
      meetingDetailActionsSource.includes("仍可能把内容当作会议事实传播"),
    detailPageHasArchiveEditor:
      detailPageText.includes("会议信息与归档") &&
      detailPageText.includes("标题、参会人、项目和标签会同步到会议历史、分享与 Obsidian Markdown") &&
      detailPageText.includes("OwnMinutes 移动归档烟测") &&
      detailPageText.includes("王鹏远") &&
      detailPageText.includes("OwnMinutes Smoke") &&
      detailPageText.includes("smoke") &&
      detailPageText.includes("obsidian"),
    projectsPageStatus: projectsPage.status,
    projectsPageVisible: projectsPageText.includes("项目目录") && projectsPageText.includes("OwnMinutes Smoke"),
    projectsPageHasUnifiedMobileShell:
      projectsPageText.includes("ownminutes-mobile-shell") &&
      projectsPageText.includes("bg-[#f8f7f3]") &&
      projectsPageText.includes("rounded-lg border border-[#e2ddd2] bg-white") &&
      projectsPageText.includes("app-icon-button-dark") &&
      projectsPageText.includes('data-app-primary-nav="record-meetings-account"') &&
      projectsPageText.includes('aria-current="page"') &&
      !projectsPageText.includes("rounded-[1.5rem] bg-[#16261f]") &&
      !projectsPageText.includes("bg-[#16261f] p-5 text-white"),
    projectDetailPageStatus: projectDetailPage.status,
    projectDetailPageVisible: projectDetailPageText.includes("项目知识库") && projectDetailPageText.includes("OwnMinutes Smoke") && projectDetailPageText.includes("导出项目"),
    projectDetailHasUnifiedMobileShell:
      projectDetailPageText.includes("ownminutes-mobile-shell") &&
      projectDetailPageText.includes("bg-[#f8f7f3]") &&
      projectDetailPageText.includes("rounded-lg border border-[#e2ddd2] bg-white") &&
      projectDetailPageText.includes("app-icon-button-dark") &&
      projectDetailPageText.includes('data-app-primary-nav="record-meetings-account"') &&
      projectDetailPageText.includes('aria-current="page"') &&
      !projectDetailPageText.includes("rounded-[1.5rem] bg-[#16261f]") &&
      !projectDetailPageText.includes("bg-[#16261f] p-5 text-white"),
    projectDetailHasKnowledgeHub:
      projectDetailPageText.includes("项目知识摘要") &&
      projectDetailPageText.includes("决策汇总") &&
      projectDetailPageText.includes("待办汇总") &&
      projectDetailPageText.includes("可沉淀知识点"),
    projectExportStatus: projectExportResponse.status,
    projectExportHasMarkdown:
      projectMarkdown.includes("type: project-meeting-index") &&
      projectMarkdown.includes("project: OwnMinutes Smoke") &&
      projectMarkdown.includes("OwnMinutes 移动归档烟测"),
    projectExportHasKnowledgeSections:
      projectMarkdown.includes("## 项目知识摘要") &&
      projectMarkdown.includes("## 决策汇总") &&
      projectMarkdown.includes("## 待办汇总") &&
      projectMarkdown.includes("## 可沉淀知识点"),
    projectFilterPageStatus: filteredMeetingsPage.status,
    projectFilterVisible:
      filteredMeetingsPageText.includes("项目：") &&
      filteredMeetingsPageText.includes("OwnMinutes Smoke") &&
      filteredMeetingsPageText.includes("OwnMinutes 移动归档烟测"),
    meetingsPageHasUnifiedMobileShell:
      filteredMeetingsPageText.includes("ownminutes-mobile-shell") &&
      filteredMeetingsPageText.includes('data-primary-tab-header="meetings"') &&
      !filteredMeetingsPageText.includes("返回录音") &&
      !filteredMeetingsPageText.includes(">Library<") &&
      filteredMeetingsPageText.includes("bg-[#f8f7f3]") &&
      filteredMeetingsPageText.includes('data-meetings-summary="compact-v30"') &&
      filteredMeetingsPageText.includes('data-meeting-history-ui="compact-list-v30"') &&
      filteredMeetingsPageText.includes('data-meeting-list-row="compact"') &&
      filteredMeetingsPageText.includes("app-icon-button-dark") &&
      filteredMeetingsPageText.includes('data-app-primary-nav="record-meetings-account"') &&
      filteredMeetingsPageText.includes('aria-current="page"') &&
      !filteredMeetingsPageText.includes("rounded-[1.5rem] bg-[#16261f]") &&
      !filteredMeetingsPageText.includes("bg-[#16261f] p-5 text-white"),
    exportStatus: exportResponse.status,
    exportHasMarkdown: exportedMarkdown.includes("# OwnMinutes 移动归档烟测") && exportedMarkdown.includes("人工修订摘要"),
    exportHasQualityWarning:
      exportedMarkdown.includes("质量提示") &&
      exportedMarkdown.includes("尚未通过正式识别验收") &&
      exportedMarkdown.includes("请勿作为正式会议事实归档"),
    exportHasMetadata: exportedMarkdown.includes("project: OwnMinutes Smoke") && exportedMarkdown.includes("  - smoke") && exportedMarkdown.includes("  - obsidian"),
    privateShareStatus: privateShare.status,
    privateShareHidden: privateShareText.includes("尚未公开"),
    privateShareMetadataSafe:
      privateShareText.includes("会议纪要尚未公开 - OwnMinutes") &&
      !privateShareText.includes("OwnMinutes 移动归档烟测 - OwnMinutes 会议纪要"),
    publishBeforeHumanReviewRejected:
      publishBeforeHumanReview.response.status === 409 &&
      publishBeforeHumanReview.ok === false &&
      publishBeforeHumanReview.code === "human_review_required" &&
      publishBeforeHumanReview.humanReview?.status === "pending",
    humanReviewConfirmOk:
      confirmHumanReview.ok === true &&
      confirmHumanReview.humanReview?.status === "confirmed" &&
      confirmHumanReview.humanReview?.needsReconfirmation === false,
    humanReviewConfirmedInDetail:
      detailAfterHumanReview.meeting?.humanReview?.status === "confirmed" &&
      detailAfterHumanReview.meeting?.humanReview?.needsReconfirmation === false,
    humanReviewFingerprintNotExposed: !JSON.stringify(detailAfterHumanReview).includes("resultFingerprint"),
    publishOk: publish.ok === true,
    shareStatus: share.status,
    shareIsPublic:
      shareText.includes("公开分享的会议纪要") &&
      shareText.includes("人工修订摘要") &&
      shareText.includes("强调人工修订后的发言人观点也必须进入正式纪要"),
    shareMetadataHasTitle: shareText.includes("OwnMinutes 移动归档烟测 - OwnMinutes 会议纪要"),
    shareHasCopyActions: shareText.includes("复制链接") && shareText.includes("复制公开 Markdown"),
    shareShowsQualityWarning:
      shareText.includes("质量提示") &&
      shareText.includes("尚未通过正式识别验收") &&
      shareText.includes("请勿作为正式会议事实归档"),
    sharePageHasUnifiedMobileShell:
      shareText.includes("ownminutes-mobile-shell") &&
      shareText.includes("bg-[#f8f7f3]") &&
      shareText.includes("rounded-lg border border-[#e2ddd2] bg-white") &&
      shareText.includes("免费注册，记录我的会议") &&
      shareText.includes("复制公开 Markdown") &&
      !shareText.includes("rounded-[30px] bg-[#17241e]") &&
      !shareText.includes("bg-[#17241e] p-5 text-white"),
    transcriptHidden: shareText.includes("逐字稿未公开"),
    publicMarkdownStatus: publicMarkdownResponse.status,
    publicMarkdownHasTitle:
      publicMarkdown.includes("# OwnMinutes 移动归档烟测") &&
      publicMarkdown.includes("人工修订摘要") &&
      publicMarkdown.includes("强调人工修订后的发言人观点也必须进入正式纪要"),
    publicMarkdownHasQualityWarning:
      publicMarkdown.includes("质量提示") &&
      publicMarkdown.includes("尚未通过正式识别验收") &&
      publicMarkdown.includes("请勿作为正式会议事实归档"),
    publicMarkdownHidesTranscript: publicMarkdown.includes("逐字稿未公开") && !publicMarkdown.includes("Speaker 1"),
    publicMarkdownContentType: publicMarkdownResponse.headers.get("content-type"),
    editAfterPublishOk:
      summaryEditAfterPublish.ok === true &&
      summaryEditAfterPublish.result?.summary?.summary?.includes("复核后更新"),
    editInvalidatesHumanReview:
      detailAfterPublishedSummaryEdit.meeting?.humanReview?.status === "pending" &&
      detailAfterPublishedSummaryEdit.meeting?.humanReview?.needsReconfirmation === true,
    editRevokesPublicShare: detailAfterPublishedSummaryEdit.meeting?.share?.visibility === "private",
    staleReviewShareHidden: staleReviewShareText.includes("尚未公开"),
    staleReviewMarkdownHidden: staleReviewMarkdownResponse.status === 404,
    reconfirmAfterEditOk:
      confirmHumanReviewAfterEdit.ok === true &&
      confirmHumanReviewAfterEdit.humanReview?.status === "confirmed" &&
      detailAfterHumanReviewReconfirm.meeting?.humanReview?.status === "confirmed" &&
      detailAfterHumanReviewReconfirm.meeting?.humanReview?.needsReconfirmation === false,
    expireShareOk: expireShare.ok === true,
    expiredShareHidden: expiredShareText.includes("尚未公开"),
    expiredMarkdownHidden: expiredMarkdownResponse.status === 404,
    republishOk: republish.ok === true,
    publishTranscriptOk: publishTranscript.ok === true,
    transcriptShareStatus: transcriptShare.status,
    transcriptShareShowsRenamedSpeakers: transcriptShareText.includes("王鹏远") && transcriptShareText.includes("产品同事") && transcriptShareText.includes("这段发言归属需要逐段校正") && transcriptShareText.includes("人工修订摘要") && !transcriptShareText.includes("Speaker 1"),
    transcriptMarkdownStatus: transcriptMarkdownResponse.status,
    transcriptMarkdownShowsRenamedSpeakers: transcriptMarkdown.includes("王鹏远") && transcriptMarkdown.includes("产品同事") && transcriptMarkdown.includes("**00:16 产品同事**：这段发言归属需要逐段校正。") && transcriptMarkdown.includes("人工修订摘要") && !transcriptMarkdown.includes("Speaker 1"),
    listedInHistory: Boolean(listedMeeting),
    listedShareVisibility: listedMeeting?.share?.visibility,
    humanReviewRevokeOk:
      revokeHumanReview.ok === true &&
      revokeHumanReview.humanReview?.status === "pending" &&
      revokeHumanReview.share?.visibility === "private" &&
      detailAfterHumanReviewRevoke.meeting?.humanReview?.status === "pending" &&
      detailAfterHumanReviewRevoke.meeting?.humanReview?.needsReconfirmation === false,
    humanReviewRevokeHidesShare:
      detailAfterHumanReviewRevoke.meeting?.share?.visibility === "private" &&
      humanReviewRevokedShareText.includes("尚未公开") &&
      humanReviewRevokedMarkdownResponse.status === 404,
    revokeOk: revoke.ok === true,
    revokedShareHidden: revokedShareText.includes("尚未公开"),
    revokedMarkdownHidden: revokedMarkdownResponse.status === 404,
    deleteOk: deletePayload.ok === true && deletePayload.cleanupPending === false,
    repeatDeleteIsIdempotent: repeatDeletePayload.ok === true && repeatDeletePayload.cleanupPending === false,
    deletedFromHistory: !meetingsAfterDelete.meetings?.some((meeting) => meeting.meetingId === meetingId),
    deletedShareHidden: deletedShareText.includes("尚未公开"),
    deletedMarkdownHidden: deletedMarkdownResponse.status === 404,
    shareUrl: `${baseUrl}/share/${meetingId}`,
    resultPath: `.data/meetings/${meetingId}/result.json`,
    obsidianPath: `.data/meetings/${meetingId}/obsidian.md`,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.uploadOk ||
    !summary.accountOk ||
    !summary.finalizeOk ||
    !summary.summaryAvoidsDemoDecisions ||
    !summary.markdownAvoidsDemoBody ||
    !summary.detailApiOk ||
    !summary.metadataOk ||
    summary.metadataProject !== "OwnMinutes Smoke" ||
    !summary.metadataTitleUpdated ||
    !summary.metadataHasParticipants ||
    !summary.metadataHasTags ||
    !summary.metadataMarkdownUpdated ||
    !summary.speakerRenameOk ||
    summary.speakerRenameMapping?.["Speaker 1"] !== "王鹏远" ||
    summary.speakerRenameMapping?.["Speaker 2"] !== "产品同事" ||
    !summary.speakerRenameTranscriptUpdated ||
    !summary.speakerRenameSummaryUpdated ||
    !summary.speakerRenameMarkdownUpdated ||
    !summary.transcriptSpeakerCorrectionOk ||
    summary.transcriptSpeakerCorrectionMapping?.["speaker-rename-3"] !== "产品同事" ||
    !summary.transcriptSpeakerCorrectionResultUpdated ||
    !summary.transcriptSpeakerCorrectionMarkdownUpdated ||
    !summary.transcriptSpeakerCorrectionAudited ||
    !summary.staleTranscriptSpeakerCorrectionRejected ||
    !summary.summaryEditOk ||
    !summary.summaryEditDetailUpdated ||
    !summary.summaryEditMarkdownUpdated ||
    detailPage.status !== 200 ||
    !summary.detailPageVisible ||
    !summary.detailPageHasSummaryEditor ||
    !summary.detailPageShowsSpeakerViews ||
    !summary.detailPageHasSpeakerEditor ||
    !summary.detailPageHasTranscriptSpeakerCorrection ||
    !summary.detailPageHasOutputStatus ||
    !summary.detailPageHasUnifiedMobileShell ||
    !summary.detailPageHasShareExportPanel ||
    !summary.sharePublishWarnsBeforeUnverified ||
    !summary.detailPageHasArchiveEditor ||
    projectsPage.status !== 200 ||
    !summary.projectsPageVisible ||
    !summary.projectsPageHasUnifiedMobileShell ||
    projectDetailPage.status !== 200 ||
    !summary.projectDetailPageVisible ||
    !summary.projectDetailHasUnifiedMobileShell ||
    !summary.projectDetailHasKnowledgeHub ||
    projectExportResponse.status !== 200 ||
    !summary.projectExportHasMarkdown ||
    !summary.projectExportHasKnowledgeSections ||
    filteredMeetingsPage.status !== 200 ||
    !summary.projectFilterVisible ||
    !summary.meetingsPageHasUnifiedMobileShell ||
    exportResponse.status !== 200 ||
    !summary.exportHasMarkdown ||
    !summary.exportHasQualityWarning ||
    !summary.exportHasMetadata ||
    !summary.privateShareHidden ||
    !summary.privateShareMetadataSafe ||
    !summary.publishBeforeHumanReviewRejected ||
    !summary.humanReviewConfirmOk ||
    !summary.humanReviewConfirmedInDetail ||
    !summary.humanReviewFingerprintNotExposed ||
    !summary.publishOk ||
    share.status !== 200 ||
    !summary.shareIsPublic ||
    !summary.shareMetadataHasTitle ||
    !summary.shareHasCopyActions ||
    !summary.shareShowsQualityWarning ||
    !summary.sharePageHasUnifiedMobileShell ||
    !summary.transcriptHidden ||
    publicMarkdownResponse.status !== 200 ||
    !summary.publicMarkdownHasTitle ||
    !summary.publicMarkdownHasQualityWarning ||
    !summary.publicMarkdownHidesTranscript ||
    !summary.publicMarkdownContentType?.includes("text/markdown") ||
    !summary.editAfterPublishOk ||
    !summary.editInvalidatesHumanReview ||
    !summary.editRevokesPublicShare ||
    !summary.staleReviewShareHidden ||
    !summary.staleReviewMarkdownHidden ||
    !summary.reconfirmAfterEditOk ||
    !summary.expireShareOk ||
    !summary.expiredShareHidden ||
    !summary.expiredMarkdownHidden ||
    !summary.republishOk ||
    !summary.publishTranscriptOk ||
    transcriptShare.status !== 200 ||
    !summary.transcriptShareShowsRenamedSpeakers ||
    transcriptMarkdownResponse.status !== 200 ||
    !summary.transcriptMarkdownShowsRenamedSpeakers ||
    !summary.listedInHistory ||
    summary.listedShareVisibility !== "public" ||
    !summary.humanReviewRevokeOk ||
    !summary.humanReviewRevokeHidesShare ||
    !summary.revokeOk ||
    !summary.revokedShareHidden ||
    !summary.revokedMarkdownHidden ||
    !summary.deleteOk ||
    !summary.repeatDeleteIsIdempotent ||
    !summary.deletedFromHistory ||
    !summary.deletedShareHidden ||
    !summary.deletedMarkdownHidden
  ) {
    process.exitCode = 1;
  }
}

async function postForm(url, body, cookie) {
  const response = await fetch(url, {
    method: "POST",
    headers: cookie
      ? { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" }
      : { Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
    body,
  });
  return readJsonResponse(response, url);
}

async function writeSpeakerRenameFixture(meetingId, title) {
  const root = path.join(process.cwd(), ".data", "meetings", meetingId);
  await mkdir(root, { recursive: true });

  const result = buildSpeakerRenameFixtureResult(meetingId, title);
  await writeFile(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "obsidian.md"), `${result.obsidianMarkdown.trim()}\n`, "utf8");
}

function buildSpeakerRenameFixtureResult(meetingId, title) {
  const transcript = [
    {
      id: "speaker-rename-1",
      speaker: "Speaker 1",
      timestamp: "00:00",
      text: "今天确认发言人改名流程，Speaker 1 负责验收。",
    },
    {
      id: "speaker-rename-2",
      speaker: "Speaker 2",
      timestamp: "00:08",
      text: "Speaker 2 负责检查分享页和 Obsidian Markdown。",
    },
    {
      id: "speaker-rename-3",
      speaker: "Speaker 1",
      timestamp: "00:16",
      text: "这段发言归属需要逐段校正。",
    },
  ];
  const summary = {
    summary: "Speaker 1 和 Speaker 2 确认会后发言人校正需要同步到逐字稿、纪要和 Markdown。",
    topics: ["发言人校正", "分享与知识库同步"],
    speakerViews: [
      { speaker: "Speaker 1", view: "Speaker 1 关注验收流程。" },
      { speaker: "Speaker 2", view: "Speaker 2 关注导出一致性。" },
    ],
    decisions: [
      {
        id: "d-speaker-rename",
        title: "确认发言人改名闭环",
        detail: "Speaker 1 确认保存后需要更新所有会后输出。",
        status: "confirmed",
      },
    ],
    actionItems: [
      {
        id: "a-speaker-rename",
        owner: "Speaker 2",
        task: "检查分享页和 Obsidian Markdown 是否显示改名后的发言人。",
        due: "本周",
        status: "confirmed",
      },
    ],
    risks: ["Speaker 标签未校正时可能影响待办负责人理解。"],
    openQuestions: ["是否需要允许后续继续编辑发言人？"],
    knowledgePoints: ["发言人校正结果必须同步到正式纪要、分享页和知识库导出。"],
  };
  const obsidianMarkdown = buildFixtureMarkdown({ meetingId, title, transcript, summary });

  return {
    meetingId,
    title,
    generatedAt: new Date().toISOString(),
    provider: "mock",
    adapter: "smoke-speaker-rename-fixture",
    transcript,
    summary,
    obsidianMarkdown,
    diagnostics: ["Smoke fixture for speaker rename workflow."],
  };
}

function buildFixtureMarkdown({ meetingId, title, transcript, summary }) {
  return `---
type: meeting
project: OwnMinutes
date: ${new Date().toISOString().slice(0, 10)}
tags:
  - meeting
  - ownminutes
share_url: /share/${meetingId}
---

# ${title}

## 会议摘要

${summary.summary}

## 决策记录

${summary.decisions.map((item) => `- **${item.title}**：${item.detail}`).join("\n")}

## 待办事项

| 事项 | 负责人 | 截止时间 | 状态 |
|---|---|---|---|
${summary.actionItems.map((item) => `| ${item.task} | ${item.owner} | ${item.due} | 已确认 |`).join("\n")}

## 风险与阻塞

${summary.risks.map((item) => `- ${item}`).join("\n")}

## 可沉淀知识点

${summary.knowledgePoints.map((item) => `- ${item}`).join("\n")}

## 主题

${summary.topics.map((topic) => `- ${topic}`).join("\n")}

## 发言人观点

${summary.speakerViews.map((item) => `- **${item.speaker}**：${item.view}`).join("\n")}

## 未解决问题

${summary.openQuestions.map((item) => `- ${item}`).join("\n")}

## 逐字稿

${transcript.map((segment) => `- **${segment.timestamp} ${segment.speaker}**：${segment.text}`).join("\n")}
`;
}

async function postJson(url, body, cookie, method = "POST", extraHeaders = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse(response, url);
  return { response, ...payload };
}

async function getJson(url, cookie) {
  const response = await fetch(url, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  return readJsonResponse(response, url);
}

async function readJsonResponse(response, url) {
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Register response did not set a session cookie.");
  return setCookie.split(";")[0];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
