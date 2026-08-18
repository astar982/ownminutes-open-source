"use client";

import {
  AudioWaveform,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  Copy,
  FileText,
  Link2,
  ListChecks,
  Mic,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Share2,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { useStableRecorder, type RecorderSelfTestResult } from "@/hooks/use-stable-recorder";
import {
  confirmMeetingHumanReview,
  finalizeMeeting,
  initialUploadState,
  publishMeetingShare,
  uploadAudioChunk,
  type AudioChunkAck,
  type FinalizedMeeting,
  type RecordedAudioChunk,
} from "@/lib/audio-pipeline";
import {
  type ActionItem,
  type Decision,
  formatDuration,
  type MeetingStatus,
  type TranscriptSegment,
} from "@/lib/meeting";
import { assessMeetingResultQuality, type MeetingResultQuality } from "@/lib/meeting-result-quality";
import type { ProviderSetupReport } from "@/lib/provider-health";
import { formatBytes } from "@/lib/recording";
import {
  beginBrowserRecordingSession,
  deleteBrowserRecording,
  loadBrowserRecording,
  loadLatestRecoverableBrowserRecording,
  markBrowserAudioChunkUploaded,
  markBrowserRecordingFinalized,
  markBrowserRecordingStopped,
  persistBrowserAudioChunk,
  requestPersistentBrowserStorage,
} from "@/lib/browser-recording-store";

type ViewMode = "live" | "notes";
type NotesTab = "summary" | "actions" | "export";
type StartRecordingOptions = { testMode?: boolean };
type BrowserStorageState = "checking" | "ready" | "recovered" | "error";

type MeetingRecorderProps = {
  initialProviderSetup: ProviderSetupReport;
  userId: string;
};

function statusLabel(status: MeetingStatus) {
  if (status === "requesting") return "请求权限";
  if (status === "recording") return "录制中";
  if (status === "paused") return "已暂停";
  if (status === "processing") return "生成中";
  if (status === "complete") return "已结束";
  return "待开始";
}

function deviceFallbackLabel() {
  return "默认麦克风";
}

function browserRecordingStatus(
  storageState: BrowserStorageState,
  status: MeetingStatus,
  hasLocalAudio: boolean,
) {
  if (storageState === "error") return { label: "本地保存异常", state: "error" } as const;
  if (storageState === "checking") return { label: "检查本地存储", state: "checking" } as const;
  if (storageState === "recovered") return { label: "已恢复本地录音", state: "recovered" } as const;
  if (status === "recording") return { label: "本地录音保存中", state: "recording" } as const;
  if (status === "paused") return { label: "本地录音已暂停", state: "paused" } as const;
  if (hasLocalAudio || status === "complete" || status === "processing") {
    return { label: "本地音频已保存", state: "saved" } as const;
  }
  return { label: "本地保存已就绪", state: "ready" } as const;
}

export function MeetingRecorder({ initialProviderSetup, userId }: MeetingRecorderProps) {
  const [meetingTitle, setMeetingTitle] = useState(createDefaultMeetingTitle);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [copied, setCopied] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [finalResult, setFinalResult] = useState<FinalizedMeeting | null>(null);
  const [finalizeMessage, setFinalizeMessage] = useState<string | null>(null);
  const [autoFinalizeRequested, setAutoFinalizeRequested] = useState(false);
  const [publishingShare, setPublishingShare] = useState(false);
  const [sharePublished, setSharePublished] = useState(false);
  const [humanReviewConfirmed, setHumanReviewConfirmed] = useState(false);
  const [reviewUpdating, setReviewUpdating] = useState(false);
  const [uploadState, setUploadState] = useState(initialUploadState);
  const [meetingId, setMeetingId] = useState(() => createClientMeetingId());
  const [viewMode, setViewMode] = useState<ViewMode>("live");
  const [notesTab, setNotesTab] = useState<NotesTab>("summary");
  const [showSettings, setShowSettings] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [selfTestResult, setSelfTestResult] = useState<RecorderSelfTestResult | null>(null);
  const [showRecordingConsent, setShowRecordingConsent] = useState(false);
  const [pendingRecordingOptions, setPendingRecordingOptions] = useState<StartRecordingOptions>({});
  const [browserStorageState, setBrowserStorageState] = useState<BrowserStorageState>("checking");
  const recoveryStartedRef = useRef(false);
  const browserChunkUploadsInFlightRef = useRef(new Map<string, Promise<AudioChunkAck>>());
  const browserChunkSyncInFlightRef = useRef(new Map<string, Promise<void>>());
  const acknowledgedChunkUploadsRef = useRef(new Set<string>());
  const failedChunkUploadsRef = useRef(new Set<string>());

  const uploadAudioChunkOnce = useCallback((targetMeetingId: string, chunk: RecordedAudioChunk) => {
    const key = browserChunkKey(targetMeetingId, chunk.sequence);
    const existing = browserChunkUploadsInFlightRef.current.get(key);
    if (existing) return existing;
    const request = uploadAudioChunk(targetMeetingId, chunk).finally(() => {
      if (browserChunkUploadsInFlightRef.current.get(key) === request) {
        browserChunkUploadsInFlightRef.current.delete(key);
      }
    });
    browserChunkUploadsInFlightRef.current.set(key, request);
    return request;
  }, []);

  const applyChunkUploadAck = useCallback((targetMeetingId: string, ack: AudioChunkAck) => {
    const key = browserChunkKey(targetMeetingId, ack.sequence);
    const firstAcknowledgement = !acknowledgedChunkUploadsRef.current.has(key);
    const recoveredFailure = failedChunkUploadsRef.current.delete(key);
    acknowledgedChunkUploadsRef.current.add(key);
    setUploadState((current) => ({
      ...current,
      // `totalChunks` is the server's unique manifest count. Never increment
      // this client-side: duplicate recovery acknowledgements must not inflate
      // the audio seal's expected final sequence.
      uploaded: Math.max(current.uploaded, ack.totalChunks),
      pending: firstAcknowledgement ? Math.max(0, current.pending - 1) : current.pending,
      failed: recoveredFailure ? Math.max(0, current.failed - 1) : current.failed,
      savedBytes: ack.totalBytes,
      lastAckAt: ack.receivedAt,
      adapter: ack.adapter,
      provider: ack.provider,
      diagnostic: ack.diagnostic ?? null,
      lastError: null,
    }));
  }, []);

  const applyChunkUploadFailure = useCallback((targetMeetingId: string, sequence: number, error: unknown) => {
    const key = browserChunkKey(targetMeetingId, sequence);
    if (acknowledgedChunkUploadsRef.current.has(key) || failedChunkUploadsRef.current.has(key)) return;
    failedChunkUploadsRef.current.add(key);
    setUploadState((current) => ({
      ...current,
      pending: Math.max(0, current.pending - 1),
      failed: current.failed + 1,
      lastError: error instanceof Error ? error.message : "音频分片上传失败",
    }));
  }, []);

  const handleAudioChunk = useCallback(
    async (chunk: RecordedAudioChunk) => {
      setUploadState((current) => ({
        ...current,
        pending: current.pending + 1,
        lastError: null,
      }));

      try {
        await persistBrowserAudioChunk(meetingId, userId, chunk);
        setBrowserStorageState("ready");
      } catch (error) {
        setBrowserStorageState("error");
        setUploadState((current) => ({
          ...current,
          lastError: error instanceof Error ? error.message : "浏览器本地录音保存失败。",
        }));
      }

      try {
        const ack = await uploadAudioChunkOnce(meetingId, chunk);
        try {
          await markBrowserAudioChunkUploaded(meetingId, chunk.sequence, ack.receivedAt);
        } catch {
          // A duplicate upload after recovery is safe because meeting chunks are idempotent by sequence.
        }

        applyChunkUploadAck(meetingId, ack);

        const transcriptSegment = ack.transcriptSegment;
        if (transcriptSegment) {
          setSegments((current) => {
            if (current.some((segment) => segment.id === transcriptSegment.id)) return current;
            return [...current, transcriptSegment];
          });
        }
      } catch (error) {
        applyChunkUploadFailure(meetingId, chunk.sequence, error);
      }
    },
    [applyChunkUploadAck, applyChunkUploadFailure, meetingId, uploadAudioChunkOnce, userId],
  );

  const recorder = useStableRecorder({ onChunk: handleAudioChunk });
  const restoreRecorderFromBlob = recorder.restoreFromBlob;
  const status = recorder.status;
  const activeMeetingTitle = testMode ? "1 分钟测试会议" : normalizeMeetingTitle(meetingTitle);

  const syncStoredBrowserChunks = useCallback((targetMeetingId: string) => {
    const existing = browserChunkSyncInFlightRef.current.get(targetMeetingId);
    if (existing) return existing;

    const operation = (async () => {
      const stored = await loadBrowserRecording(targetMeetingId);
      if (!stored) return;
      const pendingChunks = stored.chunks.filter((chunk) => !chunk.uploadedAt);
      if (!pendingChunks.length) return;
      for (const chunk of pendingChunks) {
        failedChunkUploadsRef.current.delete(browserChunkKey(targetMeetingId, chunk.sequence));
      }
      setUploadState((current) => ({ ...current, pending: pendingChunks.length, failed: 0, lastError: null }));

      for (const chunk of pendingChunks) {
        try {
          const ack = await uploadAudioChunkOnce(targetMeetingId, chunk);
          await markBrowserAudioChunkUploaded(targetMeetingId, chunk.sequence, ack.receivedAt);
          applyChunkUploadAck(targetMeetingId, ack);
          if (ack.transcriptSegment) {
            setSegments((current) => (current.some((segment) => segment.id === ack.transcriptSegment?.id) ? current : [...current, ack.transcriptSegment!]));
          }
        } catch (error) {
          applyChunkUploadFailure(targetMeetingId, chunk.sequence, error);
        }
      }
    })().finally(() => {
      if (browserChunkSyncInFlightRef.current.get(targetMeetingId) === operation) {
        browserChunkSyncInFlightRef.current.delete(targetMeetingId);
      }
    });
    browserChunkSyncInFlightRef.current.set(targetMeetingId, operation);
    return operation;
  }, [applyChunkUploadAck, applyChunkUploadFailure, uploadAudioChunkOnce]);

  const startRecording = useCallback(
    async (options: StartRecordingOptions = {}) => {
      setCopied(false);
      setFinalResult(null);
      setHumanReviewConfirmed(false);
      setSharePublished(false);
      setFinalizeMessage(null);
      setAutoFinalizeRequested(false);
      setUploadState(initialUploadState);
      acknowledgedChunkUploadsRef.current.clear();
      failedChunkUploadsRef.current.clear();
      setTestMode(Boolean(options.testMode));
      try {
        await requestPersistentBrowserStorage();
        await beginBrowserRecordingSession(meetingId, userId, activeMeetingTitle);
        setBrowserStorageState("ready");
      } catch (error) {
        setBrowserStorageState("error");
        setFinalizeMessage(error instanceof Error ? error.message : "浏览器无法建立本地录音存储。请释放存储空间后重试。");
        return;
      }
      const started = await recorder.start();
      if (started) {
        setSegments([]);
        setViewMode("live");
        setNotesTab("summary");
      } else {
        await deleteBrowserRecording(meetingId).catch(() => undefined);
      }
    },
    [activeMeetingTitle, meetingId, recorder, userId],
  );

  useEffect(() => {
    if (recoveryStartedRef.current) return;
    recoveryStartedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const recovered = await loadLatestRecoverableBrowserRecording(userId);
        if (!recovered || cancelled) {
          if (!cancelled) setBrowserStorageState("ready");
          return;
        }

        const { session, chunks } = recovered;
        const blob = new Blob(chunks.map((chunk) => chunk.blob), { type: session.mimeType || chunks[0]?.mimeType || "audio/webm" });
        setMeetingId(session.meetingId);
        setMeetingTitle(session.title || createDefaultMeetingTitle());
        restoreRecorderFromBlob(blob, {
          chunks: chunks.length,
          bytes: chunks.reduce((sum, chunk) => sum + chunk.blob.size, 0),
          durationMs: chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
          mimeType: blob.type,
        });
        await markBrowserRecordingStopped(session.meetingId);
        if (cancelled) return;

        setBrowserStorageState("recovered");
        setViewMode("notes");
        setNotesTab("summary");
        setFinalizeMessage("已恢复上次未完成的本地录音，正在续传未确认分片。");
        for (const chunk of chunks) {
          const key = browserChunkKey(session.meetingId, chunk.sequence);
          if (chunk.uploadedAt) acknowledgedChunkUploadsRef.current.add(key);
          else failedChunkUploadsRef.current.delete(key);
        }
        setUploadState({
          ...initialUploadState,
          uploaded: chunks.filter((chunk) => Boolean(chunk.uploadedAt)).length,
          pending: chunks.filter((chunk) => !chunk.uploadedAt).length,
          savedBytes: chunks.filter((chunk) => Boolean(chunk.uploadedAt)).reduce((sum, chunk) => sum + chunk.blob.size, 0),
        });

        await syncStoredBrowserChunks(session.meetingId);
        if (!cancelled) setFinalizeMessage("本地录音已恢复。未同步分片已重试，可以生成正式纪要。");
      } catch (error) {
        if (cancelled) return;
        setBrowserStorageState("error");
        setFinalizeMessage(error instanceof Error ? error.message : "浏览器本地录音恢复失败。服务器已确认的分片不受影响。");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [restoreRecorderFromBlob, syncStoredBrowserChunks, userId]);

  useEffect(() => {
    const handleOnline = () => {
      if (uploadState.failed > 0) void syncStoredBrowserChunks(meetingId);
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [meetingId, syncStoredBrowserChunks, uploadState.failed]);

  function requestRecordingStart(options: StartRecordingOptions = {}) {
    setPendingRecordingOptions(options);
    setShowRecordingConsent(true);
  }

  function cancelRecordingConsent() {
    setShowRecordingConsent(false);
    setPendingRecordingOptions({});
  }

  async function confirmRecordingConsent() {
    const options = pendingRecordingOptions;
    setShowRecordingConsent(false);
    setPendingRecordingOptions({});
    await startRecording(options);
  }

  function pauseRecording() {
    recorder.pause();
  }

  function resumeRecording() {
    recorder.resume();
  }

  function stopRecording() {
    setFinalizeMessage("正在整理会议纪要。");
    setAutoFinalizeRequested(true);
    setViewMode("notes");
    setNotesTab("summary");
    recorder.stop();
    void markBrowserRecordingStopped(meetingId).catch(() => setBrowserStorageState("error"));
  }

  function resetMeeting() {
    const completedMeetingId = finalResult ? meetingId : null;
    recorder.reset();
    setSegments([]);
    setUploadState(initialUploadState);
    acknowledgedChunkUploadsRef.current.clear();
    failedChunkUploadsRef.current.clear();
    setCopied(false);
    setFinalResult(null);
    setFinalizeMessage(null);
    setAutoFinalizeRequested(false);
    setPublishingShare(false);
    setSharePublished(false);
    setHumanReviewConfirmed(false);
    setReviewUpdating(false);
    setMeetingId(createClientMeetingId());
    setMeetingTitle(createDefaultMeetingTitle());
    setViewMode("live");
    setNotesTab("summary");
    setTestMode(false);
    setSelfTestResult(null);
    setBrowserStorageState("ready");
    if (completedMeetingId) void deleteBrowserRecording(completedMeetingId).catch(() => undefined);
  }

  async function runRecorderSelfTest() {
    setSelfTestRunning(true);
    setSelfTestResult(null);
    try {
      const result = await recorder.runSelfTest();
      setSelfTestResult(result);
    } finally {
      setSelfTestRunning(false);
    }
  }

  const generateFinalMeeting = useCallback(
    async (mode: "manual" | "automatic" = "manual") => {
      if (uploadState.pending > 0 || uploadState.failed > 0 || uploadState.uploaded <= 0 || uploadState.savedBytes <= 0) {
        setFinalizeMessage("录音尚未完整同步，原始录音仍保存在本机。请先重试同步后再生成纪要。");
        return;
      }
      setFinalizing(true);
      setFinalizeMessage(mode === "automatic" ? "正在整理会议纪要。" : null);

      try {
        const response = await finalizeMeeting(meetingId, activeMeetingTitle, Boolean(finalResult), {
          expectedLastSequence: uploadState.uploaded,
          totalBytes: uploadState.savedBytes,
        });
        const result = response.result;
        const finalTranscript = response.result?.transcript;

        if (result) {
          setFinalResult(result);
          setHumanReviewConfirmed(false);
          setSharePublished(false);
          setViewMode("notes");
          setNotesTab(mode === "automatic" && testMode ? "export" : "summary");
          // Keep the locally persisted chunks until the user explicitly starts a
          // new meeting. A server result alone is not sufficient proof that every
          // browser chunk made it into the sealed audio revision.
          await markBrowserRecordingFinalized(meetingId).catch(() => undefined);
          setBrowserStorageState("ready");
        }

        if (finalTranscript?.length) setSegments(finalTranscript);

        const diagnostics = response.result?.diagnostics || [];
        setFinalizeMessage(
          diagnostics.length > 0
            ? "音频已保存，纪要已生成。当前转写结果需要检查。"
            : "纪要已生成。",
        );
      } catch {
        setFinalizeMessage("纪要生成失败，音频仍已安全保存。请稍后重试。");
      } finally {
        setFinalizing(false);
        if (mode === "automatic") setAutoFinalizeRequested(false);
      }
    },
    [activeMeetingTitle, finalResult, meetingId, testMode, uploadState.failed, uploadState.pending, uploadState.savedBytes, uploadState.uploaded],
  );

  async function copyMarkdown() {
    if (!finalResult?.obsidianMarkdown) {
      setFinalizeMessage("请先生成正式纪要，再复制 Obsidian Markdown。");
      return;
    }

    await navigator.clipboard.writeText(finalResult.obsidianMarkdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function publishShare() {
    if (!finalResult) {
      setFinalizeMessage("请先生成正式纪要，再发布分享链接。");
      return;
    }
    if (!humanReviewConfirmed) {
      setFinalizeMessage("请先核对逐字稿、发言人、摘要、决策和待办，并确认当前版本。");
      setNotesTab("export");
      return;
    }

    const quality = assessMeetingResultQuality(finalResult);
    const qualityWarning =
      quality.status !== "verified"
        ? `\n\n质量提示：当前结果是${quality.publishLabel}，${quality.shareWarningDetail} 发布后拥有链接的人会看到质量提示，但仍可能把内容当作会议事实传播。请确认你已经人工复核。`
        : "";
    const confirmed = window.confirm(`确认发布分享链接？当前公开摘要、发言人观点、决策和待办，逐字稿默认隐藏。拥有链接的人可以查看已公开内容。${qualityWarning}`);
    if (!confirmed) return;

    setPublishingShare(true);
    try {
      await publishMeetingShare(meetingId, false, quality.status !== "verified");
      setSharePublished(true);
      setFinalizeMessage("分享链接已发布。当前公开摘要、发言人观点、决策和待办，逐字稿默认隐藏。");
    } catch (error) {
      setFinalizeMessage(error instanceof Error ? error.message : "分享发布失败。");
    } finally {
      setPublishingShare(false);
    }
  }

  async function confirmCurrentResult() {
    if (!finalResult || reviewUpdating) return;
    const nextConfirmed = !humanReviewConfirmed;
    if (nextConfirmed && !window.confirm("请确认你已核对逐字稿、发言人、会议摘要、决策和待办。确认后才可以发布当前版本。")) return;
    setReviewUpdating(true);
    try {
      const review = await confirmMeetingHumanReview(meetingId, nextConfirmed);
      setHumanReviewConfirmed(review.status === "confirmed");
      if (review.status !== "confirmed") setSharePublished(false);
      setFinalizeMessage(review.status === "confirmed" ? "已确认当前纪要，现在可以发布。" : "已撤销确认，公开分享已同步撤销。");
    } catch (error) {
      setFinalizeMessage(error instanceof Error ? error.message : "人工复核状态保存失败。");
    } finally {
      setReviewUpdating(false);
    }
  }

  useEffect(() => {
    if (!autoFinalizeRequested || finalizing || finalResult || status !== "complete") return;

    if (uploadState.pending > 0) {
      setFinalizeMessage("正在等待音频同步完成。");
      return;
    }

    if (uploadState.failed > 0) {
      setFinalizeMessage(`有 ${uploadState.failed} 个音频分片尚未同步。请先重试同步，原始录音仍保存在本机。`);
      return;
    }

    if (uploadState.uploaded === 0) {
      setFinalizeMessage("没有可处理的音频。请录制超过 1 秒后再结束会议。");
      setAutoFinalizeRequested(false);
      return;
    }

    void generateFinalMeeting("automatic");
  }, [autoFinalizeRequested, finalizing, finalResult, generateFinalMeeting, status, uploadState.failed, uploadState.pending, uploadState.uploaded]);

  const visibleSegments = segments;
  const currentSummary = finalResult?.summary.summary || "";
  const currentDecisions = finalResult?.summary.decisions || [];
  const currentActions = finalResult?.summary.actionItems || [];
  const hasDeviceLabels = recorder.devices.some((device) => Boolean(device.label));
  const selectedDeviceName = recorder.devices.find((device) => device.deviceId === recorder.selectedDeviceId)?.label || deviceFallbackLabel();
  const liveState = status === "recording" || status === "paused" || status === "requesting";
  const canGenerate = uploadState.uploaded > 0 && uploadState.pending === 0 && uploadState.failed === 0 && !finalizing;
  const transcriptCount = finalResult?.transcript.length || visibleSegments.length;
  const shouldShowResultChecklist = status === "complete" || finalizing || Boolean(finalResult);
  const recordingActive = status === "recording" || status === "paused";
  const primaryActionCopy = recordingActive ? "结束会议" : status === "requesting" ? "请求麦克风中" : "开始录音";
  const modelReady = initialProviderSetup.readyCount === initialProviderSetup.requiredCount;
  const finalResultQuality = finalResult ? assessMeetingResultQuality(finalResult) : null;
  const showSecondaryControls = recordingActive || status === "complete" || Boolean(recorder.audioUrl);
  const localRecordingStatus = browserRecordingStatus(browserStorageState, status, Boolean(recorder.audioUrl));

  return (
    <main id="top" className="ownminutes-app-canvas-v25" data-app-workspace-ui="mobile-recorder-v25">
      <div className="ownminutes-mobile-shell-v25">
        <div className="ownminutes-app-frame-v25">
          <header className="app-home-header-v25">
            <Link href="/app" className="app-title-lockup-v25" aria-label="OwnMinutes 录音首页">
              <span>OwnMinutes</span>
              <strong>会议记录</strong>
            </Link>
            <button
              className={`app-header-control-v25 ${showSettings ? "is-active" : ""}`}
              data-provider-nudge={!modelReady ? "compact" : undefined}
              type="button"
              onClick={() => setShowSettings((value) => !value)}
              title="录音设置"
              aria-label={modelReady ? "录音设置" : "录音设置，模型尚未配置完整"}
            >
              <Settings2 className="h-5 w-5" />
              {!modelReady ? <span className="app-settings-dot-v25" aria-hidden="true" /> : null}
            </button>
          </header>

          <div className="app-recorder-scroll-v25">
            <section className="app-recorder-stage-v25" data-recorder-home="focused">
              <div className="app-recorder-status-row-v25">
                <div className="app-recorder-status-v25">
                  <span className="app-live-dot-v25" aria-hidden="true" data-active={recordingActive ? "true" : "false"} />
                  <span>{statusLabel(status)}</span>
                </div>
                <span className="app-local-status-v25" data-local-recording-state={localRecordingStatus.state}>
                  {browserStorageState === "error" ? <TriangleAlert className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  {localRecordingStatus.label}
                </span>
              </div>

              <div className="app-meeting-heading-v25">
                {!recordingActive && !finalResult && status !== "processing" ? (
                  <input
                    aria-label="会议标题"
                    className="app-meeting-title-input-v25"
                    maxLength={80}
                    onChange={(event) => setMeetingTitle(event.target.value)}
                    onBlur={() => setMeetingTitle((value) => normalizeMeetingTitle(value))}
                    value={meetingTitle}
                  />
                ) : (
                  <h1>{activeMeetingTitle}</h1>
                )}
                <p>{recordingActive ? "正在记录会议内容" : finalResult ? "会议内容已整理" : "点击下方按钮开始记录"}</p>
              </div>

              <p className="app-timer-v25">{formatDuration(recorder.seconds)}</p>

              <div className="app-waveform-v25" aria-hidden="true">
                {Array.from({ length: 36 }).map((_, index) => (
                  <span
                    key={index}
                    data-active={recordingActive ? "true" : "false"}
                    style={{ height: `${3 + ((index * 7) % 15) + (liveState ? Math.round(recorder.level * 16) : 0)}px` }}
                  />
                ))}
              </div>

              <div className={`app-recorder-controls-v25 ${recordingActive ? "is-recording" : ""}`}>
                {recordingActive ? (
                  <button
                    className="app-recorder-side-action-v25"
                    type="button"
                    onClick={status === "recording" ? pauseRecording : resumeRecording}
                    aria-label={status === "recording" ? "暂停录音" : "继续录音"}
                    title={status === "recording" ? "暂停录音" : "继续录音"}
                  >
                    {status === "recording" ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                  </button>
                ) : <span className="app-recorder-side-placeholder-v25" aria-hidden="true" />}

                <button
                  className={`app-record-primary-v25 ${recordingActive ? "is-stop" : ""}`}
                  data-testid="primary-record-action"
                  disabled={status === "requesting"}
                  type="button"
                  onClick={recordingActive ? stopRecording : () => requestRecordingStart()}
                  aria-label={recordingActive ? "结束会议" : primaryActionCopy}
                >
                  <span>
                    {recordingActive ? <Square className="h-7 w-7 fill-current" /> : <Mic className="h-8 w-8" />}
                  </span>
                </button>

                {!recordingActive && showSecondaryControls && (status === "complete" || recorder.audioUrl) ? (
                  <button className="app-recorder-side-action-v25" type="button" onClick={resetMeeting} title="新会议" aria-label="新会议">
                    <RotateCcw className="h-5 w-5" />
                  </button>
                ) : <span className="app-recorder-side-placeholder-v25" aria-hidden="true" />}
              </div>
              <p className={`app-recorder-action-label-v25 ${recordingActive ? "is-recording" : ""}`}>
                {recordingActive ? "结束会议" : primaryActionCopy}
              </p>
              <p className="app-recorder-helper-v25">{heroHint(status, Boolean(finalResult))}</p>
            </section>

            <section className="app-meeting-content-v25">
              <div className="app-content-switch-v25" aria-label="会议内容视图">
                <SegmentButton active={viewMode === "live"} icon={<AudioWaveform className="h-4 w-4" />} label="实时转写" onClick={() => setViewMode("live")} />
                <SegmentButton active={viewMode === "notes"} icon={<Sparkles className="h-4 w-4" />} label="会议纪要" onClick={() => setViewMode("notes")} />
              </div>

              <div className="app-notices-v25">
                {recorder.error ? <Notice tone="error">{recorder.error}</Notice> : null}
                {recorder.warning ? <Notice tone="warning">{recorder.warning}</Notice> : null}
                {finalizeMessage ? <Notice tone={finalResult && finalResultQuality?.status === "verified" ? "success" : "warning"}>{finalizeMessage}</Notice> : null}
              </div>

              {viewMode === "live" ? (
                <TranscriptPanel liveState={liveState} segments={visibleSegments} transcriptCount={transcriptCount} />
              ) : (
                <NotesPanel
                  canGenerate={canGenerate}
                  copied={copied}
                  copyMarkdown={copyMarkdown}
                  currentActions={currentActions}
                  currentDecisions={currentDecisions}
                  currentSummary={currentSummary}
                  finalResult={finalResult}
                  finalizing={finalizing}
                  generateFinalMeeting={generateFinalMeeting}
                  humanReviewConfirmed={humanReviewConfirmed}
                  confirmCurrentResult={confirmCurrentResult}
                  meetingId={meetingId}
                  notesTab={notesTab}
                  publishShare={publishShare}
                  publishingShare={publishingShare}
                  reviewUpdating={reviewUpdating}
                  recorderAudioReady={Boolean(recorder.audioUrl)}
                  resultQuality={finalResultQuality}
                  setNotesTab={setNotesTab}
                  sharePublished={sharePublished}
                  shouldShowResultChecklist={shouldShowResultChecklist}
                  uploadState={uploadState}
                />
              )}

              {status === "complete" && !finalResult ? (
                <section className="app-finished-state-v25">
                  <div>
                    <h2>会议已结束</h2>
                    <p>{uploadState.failed > 0 ? "部分音频尚未同步，请先重试；本地录音不会被删除。" : "音频同步完成后会自动整理纪要，也可以手动重试。"}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {uploadState.failed > 0 ? (
                      <button
                        className="app-secondary-button"
                        disabled={uploadState.pending > 0}
                        type="button"
                        onClick={() => void syncStoredBrowserChunks(meetingId)}
                      >
                        <RotateCcw className="h-4 w-4" />
                        重试同步音频
                      </button>
                    ) : null}
                    <button className="app-primary-button" disabled={!canGenerate} onClick={() => void generateFinalMeeting()}>
                      <BookOpenCheck className="h-4 w-4" />
                      生成正式纪要
                    </button>
                  </div>
                </section>
              ) : null}

              {recorder.audioUrl ? (
                <section className="app-audio-playback-v25">
                  <div>
                    <p>原始录音</p>
                    <span>仅保留给你，默认不公开分享</span>
                  </div>
                  <audio controls src={recorder.audioUrl} />
                </section>
              ) : null}
            </section>
          </div>

          {showSettings ? (
            <SettingsSheet
              hasDeviceLabels={hasDeviceLabels}
              onClose={() => setShowSettings(false)}
              recorder={recorder}
              runRecorderSelfTest={runRecorderSelfTest}
              selectedDeviceName={selectedDeviceName}
              setup={initialProviderSetup}
              selfTestResult={selfTestResult}
              selfTestRunning={selfTestRunning}
              status={status}
              uploadState={uploadState}
            />
          ) : null}

          {showRecordingConsent ? (
            <RecordingConsentDialog cancel={cancelRecordingConsent} confirm={() => void confirmRecordingConsent()} />
          ) : null}

          <BottomNav />
        </div>
      </div>
    </main>
  );
}

function ModelReadinessCard({ setup }: { setup: ProviderSetupReport }) {
  if (setup.readyCount === setup.requiredCount) {
    return (
    <section className="mt-4 rounded-[18px] border border-[#cbe7d6] bg-[#f3fbf6] p-3 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[#17664f]">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#13231e]">模型已就绪</p>
            <p className="mt-0.5 text-xs leading-5 text-[#53615a]">可以录制 1-3 分钟真实会议做转写和纪要验收。</p>
          </div>
        </div>
      </section>
    );
  }

  const missingLabels = setup.capabilities.filter((item) => !item.ready).map((item) => item.label);

  return (
    <section className="mt-4 rounded-[18px] border border-[#ead9ba] bg-[#fff9ed] p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-[#a15c00]">
          <TriangleAlert className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#201a12]">模型未配置完整</p>
          <p className="mt-1 text-xs leading-5 text-[#77614a]">
            缺少 {missingLabels.join("、")}。未配齐时可以录音，但正式转写和纪要可能只是兜底结果。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Link className="app-primary-button min-h-10 rounded-md text-sm" href="/settings">
              去配置模型
            </Link>
            <Link className="app-secondary-button min-h-10 rounded-md bg-white text-sm" href="/checkup">
              查看验收
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function heroHint(status: MeetingStatus, hasFinalResult: boolean) {
  if (status === "recording") return "音频正在本地保存，实时内容仅作草稿。";
  if (status === "paused") return "录音已暂停，可以继续或结束会议。";
  if (hasFinalResult) return "纪要已生成，可以分享或导出知识库。";
  return "结束后自动生成转写、摘要和待办。";
}

function createDefaultMeetingTitle() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute} 会议`;
}

function normalizeMeetingTitle(value: string) {
  return value.trim().replace(/\s+/g, " ") || createDefaultMeetingTitle();
}

function TranscriptPanel({
  liveState,
  segments,
  transcriptCount,
}: {
  liveState: boolean;
  segments: TranscriptSegment[];
  transcriptCount: number;
}) {
  return (
    <section className="app-transcript-panel-v25">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#101828]">实时转写</h2>
          <p className="mt-0.5 text-xs text-[#697586]">会议中的识别草稿会显示在这里。</p>
        </div>
        <span className="text-xs font-semibold text-[#6c7772]">{transcriptCount} 条</span>
      </div>

      <div className="max-h-[380px] overflow-y-auto">
        {segments.length === 0 ? (
          <div className="app-empty-transcript-v25">
            <span><AudioWaveform className="h-5 w-5" /></span>
            <div>
              <p>{liveState ? "正在等待识别结果" : "还没有转写内容"}</p>
              <small>开始录音后，内容会按发言顺序出现。</small>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-[#e5e9e6]">
            {segments.map((segment) => (
              <article key={segment.id} className="py-3.5">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-[#202b3c]">{segment.speaker}</p>
                  <p className="font-mono text-[11px] text-[#7b8580]">{segment.timestamp}</p>
                </div>
                <p className="text-[15px] leading-7 text-[#1f2937]">{segment.text}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function NotesPanel({
  canGenerate,
  copied,
  copyMarkdown,
  currentActions,
  currentDecisions,
  currentSummary,
  finalResult,
  finalizing,
  generateFinalMeeting,
  humanReviewConfirmed,
  confirmCurrentResult,
  meetingId,
  notesTab,
  publishShare,
  publishingShare,
  reviewUpdating,
  recorderAudioReady,
  resultQuality,
  setNotesTab,
  sharePublished,
  shouldShowResultChecklist,
  uploadState,
}: {
  canGenerate: boolean;
  copied: boolean;
  copyMarkdown: () => Promise<void>;
  currentActions: ActionItem[];
  currentDecisions: Decision[];
  currentSummary: string;
  finalResult: FinalizedMeeting | null;
  finalizing: boolean;
  generateFinalMeeting: (mode?: "manual" | "automatic") => Promise<void>;
  humanReviewConfirmed: boolean;
  confirmCurrentResult: () => Promise<void>;
  meetingId: string;
  notesTab: NotesTab;
  publishShare: () => Promise<void>;
  publishingShare: boolean;
  reviewUpdating: boolean;
  recorderAudioReady: boolean;
  resultQuality: MeetingResultQuality | null;
  setNotesTab: (tab: NotesTab) => void;
  sharePublished: boolean;
  shouldShowResultChecklist: boolean;
  uploadState: typeof initialUploadState;
}) {
  return (
    <section className="app-notes-panel-v22">
      <div className="app-notes-header-v22">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#101828]">会议纪要</h2>
            <p className="mt-0.5 text-xs text-[#697586]">{finalResult ? "正式版本已生成" : finalizing ? "正在整理会议内容" : "结束会议后生成正式版"}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${finalResult ? "bg-[#ecfdf3] text-[#167052]" : "bg-[#eef2f6] text-[#667085]"}`}>
            {finalResult ? "已生成" : "待生成"}
          </span>
        </div>

        <div className="app-notes-tabs-v22">
          <TabButton active={notesTab === "summary"} onClick={() => setNotesTab("summary")} icon={<FileText className="h-3.5 w-3.5" />}>
            摘要
          </TabButton>
          <TabButton active={notesTab === "actions"} onClick={() => setNotesTab("actions")} icon={<ListChecks className="h-3.5 w-3.5" />}>
            待办
          </TabButton>
          <TabButton active={notesTab === "export"} onClick={() => setNotesTab("export")} icon={<Share2 className="h-3.5 w-3.5" />}>
            输出
          </TabButton>
        </div>
      </div>

      <div className="app-notes-body-v22">
        {notesTab === "summary" ? (
          finalResult ? (
            <div className="space-y-4">
              <p className="text-[15px] leading-7 text-[#1f2937]">{currentSummary}</p>
              <div className="space-y-2">
                <SectionTitle icon={<CheckCircle2 className="h-4 w-4" />}>关键决策</SectionTitle>
                {currentDecisions.length > 0 ? (
                  currentDecisions.slice(0, 3).map((decision) => (
                    <div key={decision.id} className="app-result-row-v22">
                      <h3 className="text-sm font-semibold text-[#111827]">{decision.title}</h3>
                      <p className="mt-1 text-xs leading-5 text-[#667085]">{decision.detail}</p>
                    </div>
                  ))
                ) : (
                  <EmptyInlineState>正式纪要未识别出明确决策。</EmptyInlineState>
                )}
              </div>
            </div>
          ) : (
            <EmptyNotesState finalizing={finalizing} canGenerate={canGenerate} generateFinalMeeting={generateFinalMeeting} />
          )
        ) : null}

        {notesTab === "actions" ? (
          finalResult ? (
            <div className="space-y-2">
              {currentActions.length > 0 ? (
                currentActions.map((item) => (
                  <div key={item.id} className="app-result-row-v22">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-[#111827]">{item.task}</p>
                        <p className="mt-1 text-xs text-[#667085]">{item.owner}</p>
                      </div>
                      <span className="shrink rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-[#44515f]">{item.due}</span>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyInlineState>正式纪要未识别出明确待办。</EmptyInlineState>
              )}
            </div>
          ) : (
            <EmptyNotesState finalizing={finalizing} canGenerate={canGenerate} generateFinalMeeting={generateFinalMeeting} />
          )
        ) : null}

        {notesTab === "export" ? (
          <div className="space-y-3">
            {resultQuality && resultQuality.status !== "verified" ? (
              <div className="rounded-[18px] border border-[#ead28b] bg-[#fff9e8] p-3">
                <p className="text-sm font-semibold text-[#76530a]">结果质量：{resultQuality.publishLabel}</p>
                <p className="mt-1 text-xs leading-5 text-[#7a5a18]">{resultQuality.shareWarningDetail} 发布分享前请人工复核。</p>
              </div>
            ) : null}
            {shouldShowResultChecklist ? (
              <MeetingResultChecklist
                audioReady={recorderAudioReady}
                canGenerate={canGenerate}
                diagnostics={finalResult?.diagnostics || []}
                failed={uploadState.failed}
                finalResultReady={Boolean(finalResult)}
                finalizing={finalizing}
                hasMarkdown={Boolean(finalResult?.obsidianMarkdown)}
                pending={uploadState.pending}
                provider={finalResult?.provider || uploadState.provider}
                sharePublished={sharePublished}
                transcriptCount={finalResult?.transcript.length || 0}
                uploaded={uploadState.uploaded}
              />
            ) : null}
            {finalResult ? (
              <div className={`rounded-[18px] border p-3 ${humanReviewConfirmed ? "border-[#b9d8c9] bg-[#effaf3]" : "border-[#d8dde4] bg-[#f7f8f9]"}`} data-recorder-human-review={humanReviewConfirmed ? "confirmed" : "pending"}>
                <p className={`text-sm font-semibold ${humanReviewConfirmed ? "text-[#1f6f55]" : "text-[#344054]"}`}>{humanReviewConfirmed ? "已人工确认" : "待人工确认"}</p>
                <p className="mt-1 text-xs leading-5 text-[#667085]">{humanReviewConfirmed ? "当前版本已核对。重新生成或修改后需再次确认。" : "请核对逐字稿、发言人、摘要、决策和待办，确认后才能发布。"}</p>
                <button className="app-secondary-button mt-3 w-full" disabled={reviewUpdating} type="button" onClick={() => void confirmCurrentResult()}>
                  <BookOpenCheck className="h-4 w-4" />
                  {reviewUpdating ? "保存中" : humanReviewConfirmed ? "撤销确认" : "确认已完成复核"}
                </button>
              </div>
            ) : null}
            <button className="app-primary-button w-full" disabled={!canGenerate} onClick={() => void generateFinalMeeting()}>
              <BookOpenCheck className="h-4 w-4" />
              {finalizing ? "生成中" : finalResult ? "重新生成纪要" : "生成正式纪要"}
            </button>
            <button className="app-secondary-button w-full" disabled={!finalResult || publishingShare || !humanReviewConfirmed} type="button" onClick={() => void publishShare()}>
              <Link2 className="h-4 w-4" />
              {publishingShare ? "发布中" : sharePublished ? "重新发布分享" : "发布分享链接"}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <Link className={`app-secondary-button ${sharePublished ? "" : "pointer-events-none opacity-50"}`} href={`/share/${meetingId}`}>
                <Share2 className="h-4 w-4" />
                分享页
              </Link>
              <button className="app-secondary-button" disabled={!finalResult?.obsidianMarkdown} type="button" onClick={copyMarkdown}>
                <Copy className="h-4 w-4" />
                Markdown
              </button>
            </div>
            {copied ? <p className="text-center text-sm font-medium text-[#1f6f55]">已复制 Markdown。</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EmptyNotesState({
  canGenerate,
  finalizing,
  generateFinalMeeting,
}: {
  canGenerate: boolean;
  finalizing: boolean;
  generateFinalMeeting: (mode?: "manual" | "automatic") => Promise<void>;
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center rounded-lg bg-[#eef2ef] px-5 py-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-white text-[#1f6f55] shadow-sm">
        <Sparkles className="h-6 w-6" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-[#24332d]">{finalizing ? "正在生成正式纪要" : "还没有正式纪要"}</h3>
      <p className="mt-1 max-w-[290px] text-xs leading-5 text-[#697586]">结束会议并完成音频同步后，这里才会显示真实摘要、决策和待办，不展示示例内容。</p>
      <button className="app-primary-button mt-4 min-h-10 px-4 text-sm" disabled={!canGenerate || finalizing} type="button" onClick={() => void generateFinalMeeting()}>
        <BookOpenCheck className="h-4 w-4" />
        {finalizing ? "生成中" : "生成正式纪要"}
      </button>
    </div>
  );
}

function EmptyInlineState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-[#d9dfdb] bg-[#fbfcfb] px-4 py-5 text-center text-sm text-[#667085]">{children}</div>;
}

function RecordingConsentDialog({ cancel, confirm }: { cancel: () => void; confirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1511]/45 px-3 pb-3 backdrop-blur-sm sm:absolute sm:rounded-2xl" role="dialog" aria-modal="true" aria-labelledby="recording-consent-title">
      <section className="w-full max-w-[398px] rounded-lg bg-white p-5 shadow-[0_24px_64px_rgba(15,35,26,0.3)]">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#e8f3ed] text-[#176b50]">
            <Mic className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="recording-consent-title" className="text-lg font-semibold leading-6 text-[#0f172a]">
              录音前确认
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#5f6b7a]">请确认参会人已经知情并同意录音、转写和会后 AI 处理。请避免录制不应上传或分享的敏感内容。</p>
          </div>
        </div>

        <div className="mt-4 space-y-2 rounded-lg bg-[#f3f6f4] p-3 text-sm leading-6 text-[#475569]">
          <p className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#176b50]" />
            我已确认本次会议可以录音。
          </p>
          <p className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#176b50]" />
            我了解公开分享和导出前需要再次检查内容。
          </p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button className="app-secondary-button" type="button" onClick={cancel}>
            取消
          </button>
          <button className="app-primary-button" type="button" onClick={confirm}>
            确认并开始录音
          </button>
        </div>
      </section>
    </div>
  );
}

function SettingsSheet({
  hasDeviceLabels,
  onClose,
  recorder,
  runRecorderSelfTest,
  selectedDeviceName,
  setup,
  selfTestResult,
  selfTestRunning,
  status,
  uploadState,
}: {
  hasDeviceLabels: boolean;
  onClose: () => void;
  recorder: ReturnType<typeof useStableRecorder>;
  runRecorderSelfTest: () => Promise<void>;
  selectedDeviceName: string;
  setup: ProviderSetupReport;
  selfTestResult: RecorderSelfTestResult | null;
  selfTestRunning: boolean;
  status: MeetingStatus;
  uploadState: typeof initialUploadState;
}) {
  return (
    <div className="fixed inset-x-0 bottom-[86px] z-40 mx-auto w-full max-w-[430px] px-4 sm:absolute">
      <section className="rounded-lg border border-[#d9ddd8] bg-white p-4 shadow-[0_18px_42px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle icon={<Settings2 className="h-4 w-4" />}>录音设置</SectionTitle>
          <div className="flex items-center gap-1">
            <button
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#0f766e] transition-colors hover:bg-[#e7f4f0]"
              type="button"
              onClick={() => void recorder.refreshDevices()}
              aria-label="刷新麦克风设备"
              title="刷新麦克风设备"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              className="flex h-11 w-11 items-center justify-center rounded-full text-[#475569] transition-colors hover:bg-[#eef1ef]"
              type="button"
              onClick={onClose}
              aria-label="关闭录音设置"
              title="关闭录音设置"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <label className="mt-3 flex flex-col gap-2 text-sm font-medium text-[#334155]">
          麦克风选择
          <select
            className="h-11 rounded-md border border-[#d8dfd7] bg-white px-3 text-sm font-normal outline-none focus:border-[#0f766e]"
            disabled={status === "recording" || status === "paused"}
            value={recorder.selectedDeviceId}
            onChange={(event) => recorder.selectDevice(event.target.value)}
          >
            {recorder.devices.length === 0 ? <option value="">默认麦克风</option> : null}
            {recorder.devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || (device.deviceId === "default" ? "默认麦克风" : `麦克风 ${index + 1}`)}
              </option>
            ))}
          </select>
          <span className="text-xs font-normal text-[#64748b]">
            {hasDeviceLabels ? `已检测到 ${recorder.devices.length} 个输入设备` : "授权后显示具体设备名称"} · {selectedDeviceName}
          </span>
        </label>
        <div className="mt-4">
          <ModelReadinessCard setup={setup} />
        </div>
        <div className="mt-4 rounded-lg border border-[#e6ebe7] bg-[#fbfcfb] p-3">
          <p className="text-sm font-semibold text-[#151f19]">音频保存</p>
          <p className="mt-1 text-xs leading-5 text-[#667085]">
            {uploadState.failed > 0
              ? `已有 ${uploadState.failed} 个分片上传失败，正式纪要前需要重试。`
              : uploadState.pending > 0
                ? `正在同步 ${uploadState.pending} 个音频分片。`
                : uploadState.uploaded > 0
                  ? `已同步 ${uploadState.uploaded} 个音频分片。`
                  : "开始录音后先保留本地音频，再同步到服务端处理。"}
          </p>
        </div>
        <div className="mt-3 rounded-lg border border-[#e6ebe7] bg-[#fbfcfb] p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#151f19]">录音自检</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">检查麦克风权限、浏览器格式和首个音频分片。</p>
            </div>
            <button
              className="rounded-md bg-[#0f766e] px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-[#98a2b3]"
              disabled={selfTestRunning || status === "recording" || status === "paused" || status === "requesting"}
              type="button"
              onClick={() => void runRecorderSelfTest()}
            >
              {selfTestRunning ? "自检中" : "自检"}
            </button>
          </div>
          {selfTestResult ? (
            <div className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${selfTestResult.ok ? "border-[#b9d8c9] bg-[#effaf3] text-[#0f766e]" : "border-[#e5b5ad] bg-[#fff4f1] text-[#9f3124]"}`}>
              <p className="font-semibold">{selfTestResult.ok ? "自检通过" : "自检未通过"}</p>
              <p className="mt-1">{selfTestResult.message}</p>
              <p className="mt-1 text-[11px] opacity-80">
                {selfTestResult.chunks} 个分片 · {formatBytes(selfTestResult.bytes)} · {selfTestResult.mimeType || "未知格式"}
              </p>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function BottomNav() {
  return <AppBottomNav active="record" />;
}

function Notice({ tone, children }: { tone: "error" | "warning" | "success"; children: React.ReactNode }) {
  const className =
    tone === "error"
      ? "border-[#e5b5ad] bg-[#fff4f1] text-[#9f3124]"
      : tone === "success"
        ? "border-[#b9d8c9] bg-[#effaf3] text-[#1f6f55]"
        : "border-[#ead28b] bg-[#fff9e8] text-[#76530a]";

  return <div className={`rounded-lg border px-4 py-3 text-sm font-medium ${className}`}>{children}</div>;
}

function TabButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-sm font-semibold ${
        active ? "bg-white text-[#111827] shadow-sm" : "text-[#667085] hover:bg-white/70"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function SegmentButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`app-content-tab-v25 ${
        active ? "is-active" : ""
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-[#344054]">
      <span className="text-[#1f6f55]">{icon}</span>
      {children}
    </div>
  );
}

type ChecklistState = "done" | "attention" | "pending";

type ChecklistItem = {
  detail: string;
  label: string;
  state: ChecklistState;
};

function MeetingResultChecklist({
  audioReady,
  canGenerate,
  diagnostics,
  failed,
  finalResultReady,
  finalizing,
  hasMarkdown,
  pending,
  provider,
  sharePublished,
  transcriptCount,
  uploaded,
}: {
  audioReady: boolean;
  canGenerate: boolean;
  diagnostics: string[];
  failed: number;
  finalResultReady: boolean;
  finalizing: boolean;
  hasMarkdown: boolean;
  pending: number;
  provider: string;
  sharePublished: boolean;
  transcriptCount: number;
  uploaded: number;
}) {
  const uploadReady = uploaded > 0 && pending === 0 && failed === 0;
  const hasAsrWarning = diagnostics.length > 0;
  const checklist: ChecklistItem[] = [
    {
      label: "录音文件",
      state: audioReady ? "done" : "attention",
      detail: audioReady ? "本地音频可回放。" : "未拿到本地音频，请延长录制或检查麦克风权限。",
    },
    {
      label: "音频同步",
      state: uploadReady ? "done" : failed > 0 || uploaded === 0 ? "attention" : "pending",
      detail: uploadReady ? `已同步 ${uploaded} 个分片。` : `已同步 ${uploaded} 个，等待 ${pending} 个，失败 ${failed} 个。`,
    },
    {
      label: "会后纪要",
      state: finalResultReady ? "done" : finalizing || canGenerate ? "pending" : "attention",
      detail: finalResultReady ? "正式摘要、发言人观点、决策和待办已生成。" : finalizing ? "正在生成正式纪要。" : "需要先完成音频同步。",
    },
    {
      label: "ASR 识别",
      state: finalResultReady && !hasAsrWarning ? "done" : finalResultReady && hasAsrWarning ? "attention" : "pending",
      detail: finalResultReady
        ? hasAsrWarning
          ? "当前有识别配置警告，转写质量可能只是兜底结果。"
          : `${provider} 已返回 ${transcriptCount} 条正式转写。`
        : "等待会后处理完成后确认识别质量。",
    },
    {
      label: "分享链接",
      state: sharePublished ? "done" : finalResultReady ? "pending" : "attention",
      detail: sharePublished ? "公开分享页已发布，默认隐藏逐字稿。" : finalResultReady ? "可发布摘要、发言人观点、决策和待办。" : "先生成正式纪要。",
    },
    {
      label: "Obsidian",
      state: hasMarkdown ? "done" : finalResultReady ? "pending" : "attention",
      detail: hasMarkdown ? "Markdown 已生成，可复制到知识库。" : finalResultReady ? "等待 Markdown 输出刷新。" : "正式纪要生成后输出。",
    },
  ];

  return (
    <section className="rounded-lg border border-[#d9ded8] bg-[#fbfcfb] p-3">
      <SectionTitle icon={<CheckCircle2 className="h-4 w-4" />}>结果检查</SectionTitle>
      <div className="mt-3 grid gap-2">
        {checklist.map((item) => (
          <ChecklistRow key={item.label} item={item} />
        ))}
      </div>
    </section>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const tone =
    item.state === "done"
      ? "border-[#b9d8c9] bg-[#effaf3] text-[#1f6f55]"
      : item.state === "attention"
        ? "border-[#e5b5ad] bg-[#fff4f1] text-[#9f3124]"
        : "border-[#e6d7a3] bg-[#fff9e8] text-[#76530a]";
  const icon =
    item.state === "done" ? (
      <CheckCircle2 className="h-4 w-4" />
    ) : item.state === "attention" ? (
      <TriangleAlert className="h-4 w-4" />
    ) : (
      <Clock3 className="h-4 w-4" />
    );

  return (
    <div className="rounded-lg border border-[#e1e6e0] bg-white p-3">
      <div className={`inline-flex h-7 w-fit items-center gap-1.5 rounded-md border px-2 text-xs font-semibold ${tone}`}>
        {icon}
        {item.label}
      </div>
      <p className="mt-2 text-xs leading-5 text-[#667085]">{item.detail}</p>
    </div>
  );
}

function browserChunkKey(meetingId: string, sequence: number) {
  return `${meetingId}:${sequence}`;
}

function createClientMeetingId() {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `meeting-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${random}`;
}
