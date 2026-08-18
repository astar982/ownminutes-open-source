#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.OWNMINUTES_ALLOW_LOCAL_PROVIDER_ENDPOINTS = "1";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.OWNMINUTES_PROVIDER_COST_FENCE_WORKER !== "1") {
  await runWithAliasLoader();
} else {
  await runBehaviorChecks();
}

async function runWithAliasLoader() {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "ownminutes-provider-fence-"));
  const loaderPath = path.join(temporaryDirectory, "typescript-alias-loader.mjs");
  const loaderSource = `
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = process.env.OWNMINUTES_PROVIDER_COST_FENCE_REPO_ROOT;

export async function resolve(specifier, context, nextResolve) {
  let sourcePath;
  if (specifier.startsWith("@/")) {
    sourcePath = path.join(repoRoot, "src", specifier.slice(2));
  } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    sourcePath = fileURLToPath(new URL(specifier, context.parentURL));
  } else {
    return nextResolve(specifier, context);
  }

  for (const candidate of [sourcePath + ".ts", sourcePath + ".tsx", path.join(sourcePath, "index.ts")]) {
    try {
      await access(candidate);
      return { shortCircuit: true, url: pathToFileURL(candidate).href };
    } catch {}
  }

  return nextResolve(specifier, context);
}
`;

  try {
    await writeFile(loaderPath, loaderSource, "utf8");
    const child = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--experimental-strip-types",
        "--experimental-loader",
        loaderPath,
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          OWNMINUTES_PROVIDER_COST_FENCE_REPO_ROOT: repoRoot,
          OWNMINUTES_PROVIDER_COST_FENCE_WORKER: "1",
        },
      },
    );

    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function runBehaviorChecks() {
  process.env.TRANSCRIPTION_PROVIDER = "volcano";
  process.env.VOLCANO_ASR_FLASH_RETRY_MS = "100";
  process.env.OWNMINUTES_SUMMARY_RETRY_DELAY_MS = "0";

  const fixture = await startProviderFixture();
  const { processMeetingAudio } = await import("../src/lib/meeting-processing.ts");

  const runtime = {
    source: "env",
    volcanoAsr: {
      apiKey: "official-fixture-key",
      mode: "flash",
      recognizeUrl: `${fixture.baseUrl}/recognize`,
      resourceId: "fixture-resource",
    },
    ark: {
      apiKey: "official-fixture-key",
      baseUrl: fixture.baseUrl,
      model: "fixture-model",
    },
  };
  const audio = {
    audioUrl: "https://storage.example.test/private/meeting.ogg?signature=fixture",
    delivery: "private-presigned-url",
    durationMs: 60_000,
    fileName: "meeting.ogg",
    mimeType: "audio/ogg",
    transcoded: true,
  };

  try {
    fixture.reset();
    const successfulFence = createDurableFence();
    const concurrent = await Promise.allSettled([
      finalizeWithFence({ audio, fence: successfulFence, meetingId: "concurrent-success", processMeetingAudio, runtime }),
      finalizeWithFence({ audio, fence: successfulFence, meetingId: "concurrent-success", processMeetingAudio, runtime }),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
    assert.deepEqual(fixture.counts(), { asr: 1, summary: 1 });
    assert.deepEqual(successfulFence.settlements(), { asr: 1, summary: 1 });

    await finalizeWithFence({ audio, fence: successfulFence, meetingId: "concurrent-success", processMeetingAudio, runtime });
    assert.deepEqual(fixture.counts(), { asr: 1, summary: 1 });
    assert.deepEqual(successfulFence.settlements(), { asr: 1, summary: 1 });

    for (const failurePoint of ["afterTranscriptCheckpoint", "afterAsrComplete"]) {
      fixture.reset();
      const recoverableFence = createDurableFence({ [failurePoint]: true });
      await assert.rejects(
        finalizeWithFence({ audio, fence: recoverableFence, meetingId: `asr-${failurePoint}`, processMeetingAudio, runtime }),
        new RegExp(`synthetic ${failurePoint} failure`),
      );
      await finalizeWithFence({ audio, fence: recoverableFence, meetingId: `asr-${failurePoint}`, processMeetingAudio, runtime });
      assert.deepEqual(fixture.counts(), { asr: 1, summary: 1 });
      assert.deepEqual(recoverableFence.settlements(), { asr: 1, summary: 1 });
    }

    for (const failurePoint of ["afterSummaryCheckpoint", "afterSummaryComplete"]) {
      fixture.reset();
      const recoverableFence = createDurableFence({ [failurePoint]: true });
      await assert.rejects(
        finalizeWithFence({ audio, fence: recoverableFence, meetingId: `summary-${failurePoint}`, processMeetingAudio, runtime }),
        new RegExp(`synthetic ${failurePoint} failure`),
      );
      await finalizeWithFence({ audio, fence: recoverableFence, meetingId: `summary-${failurePoint}`, processMeetingAudio, runtime });
      assert.deepEqual(fixture.counts(), { asr: 1, summary: 1 });
      assert.deepEqual(recoverableFence.settlements(), { asr: 1, summary: 1 });
    }

    fixture.reset();
    const asrCheckpointFailure = createDurableFence({ failTranscriptCheckpoint: true });
    await assert.rejects(
      finalizeWithFence({ audio, fence: asrCheckpointFailure, meetingId: "asr-checkpoint-failure", processMeetingAudio, runtime }),
      /synthetic transcript checkpoint failure/,
    );
    await assert.rejects(
      finalizeWithFence({ audio, fence: asrCheckpointFailure, meetingId: "asr-checkpoint-failure", processMeetingAudio, runtime }),
      /provider_step_asr_started_without_checkpoint/,
    );
    assert.deepEqual(fixture.counts(), { asr: 1, summary: 0 });
    assert.deepEqual(asrCheckpointFailure.settlements(), { asr: 1, summary: 0 });

    fixture.reset();
    const summaryCheckpointFailure = createDurableFence({ failSummaryCheckpoint: true });
    await assert.rejects(
      finalizeWithFence({ audio, fence: summaryCheckpointFailure, meetingId: "summary-checkpoint-failure", processMeetingAudio, runtime }),
      /synthetic summary checkpoint failure/,
    );
    await assert.rejects(
      finalizeWithFence({ audio, fence: summaryCheckpointFailure, meetingId: "summary-checkpoint-failure", processMeetingAudio, runtime }),
      /provider_step_summary_started_without_checkpoint/,
    );
    assert.deepEqual(fixture.counts(), { asr: 1, summary: 1 });
    assert.deepEqual(summaryCheckpointFailure.settlements(), { asr: 1, summary: 1 });

    for (const asrMode of ["transient", "rate-limit", "server-error"]) {
      fixture.reset({ asrMode });
      const rejectedFence = createDurableFence();
      await assert.rejects(
        finalizeWithFence({
          audio,
          fence: rejectedFence,
          meetingId: `official-asr-${asrMode}`,
          processMeetingAudio,
          runtime,
        }),
        /已重试 1 次|after 1 attempt/,
      );
      assert.deepEqual(rejectedFence.rejections(), { asr: 1, summary: 0 });
      assert.deepEqual(rejectedFence.activeSettlements(), { asr: 0, summary: 0 });

      fixture.reset();
      await finalizeWithFence({
        audio,
        fence: rejectedFence,
        meetingId: `official-asr-${asrMode}`,
        processMeetingAudio,
        runtime,
      });
      assert.deepEqual(fixture.counts(), { asr: 1, summary: 1 });
    }

    fixture.reset();
    const configFailureFence = createDurableFence();
    await assert.rejects(
      finalizeWithFence({
        audio,
        fence: configFailureFence,
        meetingId: "official-asr-invalid-config",
        processMeetingAudio,
        runtime: {
          ...runtime,
          volcanoAsr: { ...runtime.volcanoAsr, recognizeUrl: "https://example.com/recognize" },
        },
      }),
      /runtime endpoint/,
    );
    assert.deepEqual(configFailureFence.settlements(), { asr: 0, summary: 0 });
    assert.deepEqual(fixture.counts(), { asr: 0, summary: 0 });

    const networkFailureFence = createDurableFence();
    await assert.rejects(
      finalizeWithFence({
        audio,
        fence: networkFailureFence,
        meetingId: "official-asr-network-ambiguity",
        processMeetingAudio,
        runtime: {
          ...runtime,
          volcanoAsr: { ...runtime.volcanoAsr, recognizeUrl: "http://127.0.0.1:1/recognize" },
        },
      }),
    );
    assert.deepEqual(networkFailureFence.rejections(), { asr: 0, summary: 0 });
    assert.deepEqual(networkFailureFence.activeSettlements(), { asr: 1, summary: 0 });

    fixture.reset({ asrMode: "query-failure" });
    const queryFailureFence = createDurableFence();
    await assert.rejects(
      finalizeWithFence({
        audio,
        fence: queryFailureFence,
        meetingId: "official-asr-query-ambiguity",
        processMeetingAudio,
        runtime: {
          ...runtime,
          volcanoAsr: {
            ...runtime.volcanoAsr,
            mode: "standard",
            queryUrl: `${fixture.baseUrl}/query`,
            submitUrl: `${fixture.baseUrl}/submit`,
          },
        },
      }),
      /query failed/,
    );
    assert.deepEqual(queryFailureFence.rejections(), { asr: 0, summary: 0 });
    assert.deepEqual(queryFailureFence.activeSettlements(), { asr: 1, summary: 0 });

    for (const asrMode of ["flash-missing-status", "flash-unknown-status"]) {
      fixture.reset({ asrMode });
      const ambiguousFlashFence = createDurableFence();
      await assert.rejects(
        finalizeWithFence({
          audio,
          fence: ambiguousFlashFence,
          meetingId: `official-${asrMode}`,
          processMeetingAudio,
          runtime,
        }),
        /ambiguous response/,
      );
      assert.deepEqual(ambiguousFlashFence.rejections(), { asr: 0, summary: 0 });
      assert.deepEqual(ambiguousFlashFence.activeSettlements(), { asr: 1, summary: 0 });
    }

    for (const asrMode of ["submit-missing-status", "submit-unknown-status"]) {
      fixture.reset({ asrMode });
      const ambiguousSubmitFence = createDurableFence();
      await assert.rejects(
        finalizeWithFence({
          audio,
          fence: ambiguousSubmitFence,
          meetingId: `official-${asrMode}`,
          processMeetingAudio,
          runtime: {
            ...runtime,
            volcanoAsr: {
              ...runtime.volcanoAsr,
              mode: "standard",
              queryUrl: `${fixture.baseUrl}/query`,
              submitUrl: `${fixture.baseUrl}/submit`,
            },
          },
        }),
        /ambiguous response/,
      );
      assert.deepEqual(ambiguousSubmitFence.rejections(), { asr: 0, summary: 0 });
      assert.deepEqual(ambiguousSubmitFence.activeSettlements(), { asr: 1, summary: 0 });
    }

    fixture.reset({ summaryMode: "transient" });
    const summaryAttemptFence = createDurableFence();
    const preferredTranscript = fixture.transcriptCheckpoint();
    summaryAttemptFence.seedTranscript(preferredTranscript);
    await assert.rejects(
      finalizeWithFence({
        audio,
        fence: summaryAttemptFence,
        meetingId: "official-summary-single-attempt",
        processMeetingAudio,
        runtime,
      }),
      /request was rejected: HTTP 503/,
    );
    assert.deepEqual(fixture.counts(), { asr: 0, summary: 1 });
    assert.deepEqual(summaryAttemptFence.settlements(), { asr: 0, summary: 1 });
    assert.deepEqual(summaryAttemptFence.rejections(), { asr: 0, summary: 1 });
    assert.deepEqual(summaryAttemptFence.activeSettlements(), { asr: 0, summary: 0 });

    for (const summaryMode of ["empty", "network"]) {
      fixture.reset({ summaryMode });
      const ambiguousSummaryFence = createDurableFence();
      ambiguousSummaryFence.seedTranscript(preferredTranscript);
      await assert.rejects(
        finalizeWithFence({
          audio,
          fence: ambiguousSummaryFence,
          meetingId: `official-summary-${summaryMode}`,
          processMeetingAudio,
          runtime,
        }),
      );
      assert.deepEqual(ambiguousSummaryFence.rejections(), { asr: 0, summary: 0 });
      assert.deepEqual(ambiguousSummaryFence.activeSettlements(), { asr: 0, summary: 1 });
    }

    console.log(
      JSON.stringify(
        {
          asrCheckpointFailureIsAmbiguousAndNotRetried: true,
          asrCheckpointAndCompletionCrashWindowsRecoverWithoutProviderRecall: true,
          concurrentOfficialFinalizationCallsEachProviderOnce: true,
          durableRetryReusesBothCheckpoints: true,
          officialAsrInternalAttempts: 1,
          explicitAsrRejectionsRefundAndAllowRetry: true,
          localConfigFailureDoesNotStartProviderStep: true,
          networkAndAcceptedQueryFailuresRemainUncertain: true,
          twoHundredUnknownAsrResponsesRemainUncertain: true,
          officialSummaryInternalAttempts: 1,
          explicitSummaryRejectionRefundsAndFailsSafely: true,
          unknownSummaryOutcomesRemainUncertain: true,
          providerStageSettlementOccursOnce: true,
          summaryCheckpointFailureIsAmbiguousAndNotRetried: true,
          summaryCheckpointAndCompletionCrashWindowsRecoverWithoutProviderRecall: true,
        },
        null,
        2,
      ),
    );
  } finally {
    delete process.env.TRANSCRIPTION_PROVIDER;
    delete process.env.VOLCANO_ASR_FLASH_RETRY_MS;
    delete process.env.OWNMINUTES_SUMMARY_RETRY_DELAY_MS;
    await fixture.close();
  }
}

async function finalizeWithFence({ audio, fence, meetingId, processMeetingAudio, runtime }) {
  const checkpoint = fence.checkpoint();
  await fence.reconcileCheckpoint();
  return processMeetingAudio({
    audio,
    meetingId,
    onProviderStageComplete: fence.complete,
    onProviderStageRejected: fence.reject,
    onProviderStageStart: fence.start,
    onSummaryReady: fence.saveSummary,
    onTranscriptReady: fence.saveTranscript,
    preferredSummary: checkpoint.summary
      ? { diagnostic: "Reused durable summary checkpoint in cost-fence fixture.", summary: checkpoint.summary }
      : undefined,
    preferredTranscript: checkpoint.transcript
      ? { diagnostic: "Reused durable transcript checkpoint in cost-fence fixture.", ...checkpoint.transcript }
      : undefined,
    providerPolicy: { asrMaxAttempts: 1, summaryMaxAttempts: 1 },
    runtime,
    title: "Provider cost fence fixture",
  });
}

function createDurableFence(options = {}) {
  const state = new Map();
  const settlementCount = { asr: 0, summary: 0 };
  const activeSettlementCount = { asr: 0, summary: 0 };
  const rejectionCount = { asr: 0, summary: 0 };
  const checkpoint = { providerStages: [], summary: null, transcript: null };
  const pendingFailures = new Set(
    ["afterTranscriptCheckpoint", "afterAsrComplete", "afterSummaryCheckpoint", "afterSummaryComplete"].filter(
      (key) => options[key],
    ),
  );

  const failOnce = (key) => {
    if (!pendingFailures.delete(key)) return;
    throw new Error(`synthetic ${key} failure`);
  };

  return {
    checkpoint: () => structuredClone(checkpoint),
    activeSettlements: () => structuredClone(activeSettlementCount),
    complete: async (stage) => {
      assert.equal(state.get(stage), "started");
      state.set(stage, "completed");
      failOnce(stage === "asr" ? "afterAsrComplete" : "afterSummaryComplete");
    },
    saveSummary: async ({ summary }) => {
      if (options.failSummaryCheckpoint) throw new Error("synthetic summary checkpoint failure");
      checkpoint.summary = structuredClone(summary);
      if (!checkpoint.providerStages.includes("summary")) checkpoint.providerStages.push("summary");
      failOnce("afterSummaryCheckpoint");
    },
    saveTranscript: async (value) => {
      if (options.failTranscriptCheckpoint) throw new Error("synthetic transcript checkpoint failure");
      checkpoint.transcript = structuredClone(value);
      if (!checkpoint.providerStages.includes("asr")) checkpoint.providerStages.push("asr");
      failOnce("afterTranscriptCheckpoint");
    },
    reject: async (stage) => {
      assert.equal(state.get(stage), "started");
      state.set(stage, "released");
      activeSettlementCount[stage] -= 1;
      rejectionCount[stage] += 1;
    },
    rejections: () => structuredClone(rejectionCount),
    reconcileCheckpoint: async () => {
      for (const stage of checkpoint.providerStages) {
        const current = state.get(stage);
        if (current !== "started" && current !== "completed") {
          throw new Error(`provider_step_${stage}_checkpoint_mismatch`);
        }
        state.set(stage, "completed");
      }
    },
    seedTranscript: (value) => {
      checkpoint.transcript = structuredClone(value);
      checkpoint.providerStages.push("asr");
      state.set("asr", "completed");
    },
    settlements: () => structuredClone(settlementCount),
    start: async (stage) => {
      const current = state.get(stage);
      if (current === "completed") throw new Error(`provider_step_${stage}_completed_without_checkpoint_reuse`);
      if (current === "started") throw new Error(`provider_step_${stage}_started_without_checkpoint`);
      state.set(stage, "started");
      settlementCount[stage] += 1;
      activeSettlementCount[stage] += 1;
    },
  };
}

async function startProviderFixture() {
  let asrCount = 0;
  let summaryCount = 0;
  let asrMode = "success";
  let summaryMode = "success";

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");

      if (request.url === "/recognize") {
        asrCount += 1;
        if (asrMode === "transient") {
          response.setHeader("x-api-status-code", "45000000");
          response.end(JSON.stringify({ message: "synthetic transient ASR response" }));
          return;
        }
        if (asrMode === "rate-limit") {
          response.statusCode = 429;
          response.end(JSON.stringify({ message: "synthetic rate limit" }));
          return;
        }
        if (asrMode === "server-error") {
          response.statusCode = 503;
          response.end(JSON.stringify({ message: "synthetic server error" }));
          return;
        }
        if (asrMode === "flash-missing-status") {
          response.end(JSON.stringify({ message: "synthetic missing status" }));
          return;
        }
        if (asrMode === "flash-unknown-status") {
          response.setHeader("x-api-status-code", "unexpected-status");
          response.end(JSON.stringify({ message: "synthetic unknown status" }));
          return;
        }
        response.setHeader("x-api-status-code", "20000000");
        setTimeout(() => {
          response.end(
            JSON.stringify({
              result: {
                utterances: [
                  { speaker_id: 1, start_time: 0, text: "团队确认本周完成稳定性修复，并在发布前复核成本围栏。" },
                  { speaker_id: 2, start_time: 2000, text: "负责人会补齐验证证据，确认没有重复调用后再部署。" },
                ],
              },
            }),
          );
        }, 30);
        return;
      }

      if (request.url === "/submit") {
        asrCount += 1;
        if (asrMode === "submit-missing-status") {
          response.end(JSON.stringify({ accepted: "unknown" }));
          return;
        }
        if (asrMode === "submit-unknown-status") {
          response.setHeader("x-api-status-code", "unexpected-status");
          response.end(JSON.stringify({ accepted: "unknown" }));
          return;
        }
        response.setHeader("x-api-status-code", "20000000");
        response.end(JSON.stringify({ accepted: true }));
        return;
      }

      if (request.url === "/query") {
        if (asrMode === "query-failure") {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "synthetic query failure" }));
          return;
        }
        response.setHeader("x-api-status-code", "20000000");
        response.end(JSON.stringify({ result: { utterances: [] } }));
        return;
      }

      if (request.url === "/chat/completions") {
        summaryCount += 1;
        if (summaryMode === "transient") {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "synthetic transient summary response" }));
          return;
        }
        if (summaryMode === "empty") {
          response.end(JSON.stringify({ choices: [] }));
          return;
        }
        if (summaryMode === "network") {
          request.socket.destroy();
          return;
        }
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    actionItems: [{ due: "发布前", id: "action-1", owner: "负责人", status: "confirmed", task: "复核成本围栏" }],
                    decisions: [{ detail: "验证通过后再部署", id: "decision-1", status: "confirmed", title: "先验证后发布" }],
                    knowledgePoints: ["Provider 阶段采用最多一次调用策略"],
                    openQuestions: [],
                    risks: ["重复调用会侵蚀套餐利润"],
                    speakerViews: [{ speaker: "Speaker 1", view: "应先修复稳定性与成本围栏" }],
                    summary: "团队确认先完成稳定性和成本围栏验证，再执行服务器发布。",
                    topics: ["成本控制", "发布验证"],
                  }),
                },
              },
            ],
            usage: { completion_tokens: 80, prompt_tokens: 120, total_tokens: 200 },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider fixture server did not bind.");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    counts: () => ({ asr: asrCount, summary: summaryCount }),
    reset: (options = {}) => {
      asrCount = 0;
      summaryCount = 0;
      asrMode = options.asrMode ?? "success";
      summaryMode = options.summaryMode ?? "success";
    },
    transcriptCheckpoint: () => ({
      adapter: "volcano-file-asr",
      noSpeech: false,
      transcript: [
        {
          id: "preferred-1",
          speaker: "Speaker 1",
          text: "团队已经有可复用的持久化逐字稿，本次只需要验证摘要阶段的单次调用。",
          timestamp: "00:00",
        },
      ],
    }),
  };
}
