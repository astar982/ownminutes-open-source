"use client";

import type { ProviderHealthResult } from "@/lib/provider-health";
import { chooseSupportedMimeType } from "@/lib/recording";
import type { ProviderCredentialSummary } from "@/lib/server/auth-repository";
import { CheckCircle2, ExternalLink, Eye, EyeOff, FileAudio, KeyRound, LockKeyhole, Mic, RefreshCw, Save, ShieldCheck, Square, Trash2, TriangleAlert, UploadCloud } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

type ProviderSetupWizardProps = {
  userEmail: string | null;
  providerCredentials: ProviderCredentialSummary[];
  providerHealth: ProviderHealthResult[];
};

export function ProviderSetupWizard({
  userEmail,
  providerCredentials: initialProviderCredentials,
  providerHealth: initialProviderHealth,
}: ProviderSetupWizardProps) {
  const [providerId, setProviderId] = useState("volcano-asr");
  const [appId, setAppId] = useState("");
  const [asrResourceId, setAsrResourceId] = useState("volc.bigasr.auc_turbo");
  const [realtimeAsrResourceId, setRealtimeAsrResourceId] = useState("volc.seedasr.sauc.duration");
  const [asrToken, setAsrToken] = useState("");
  const [asrWsUrl, setAsrWsUrl] = useState("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [arkBaseUrl, setArkBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [checkingAsr, setCheckingAsr] = useState(false);
  const [checkingAsrTranscript, setCheckingAsrTranscript] = useState(false);
  const [checkingRealtimeAsr, setCheckingRealtimeAsr] = useState(false);
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [healthMessage, setHealthMessage] = useState<string | null>(null);
  const [asrTestMessage, setAsrTestMessage] = useState<string | null>(null);
  const [asrTranscriptMessage, setAsrTranscriptMessage] = useState<string | null>(null);
  const [realtimeAsrTestMessage, setRealtimeAsrTestMessage] = useState<string | null>(null);
  const [asrSampleFile, setAsrSampleFile] = useState<File | null>(null);
  const [recordingSample, setRecordingSample] = useState(false);
  const [sampleRecordingMessage, setSampleRecordingMessage] = useState<string | null>(null);
  const [providerCredentials, setProviderCredentials] = useState(initialProviderCredentials);
  const [providerHealth, setProviderHealth] = useState(initialProviderHealth);
  const sampleRecorderRef = useRef<MediaRecorder | null>(null);
  const sampleStreamRef = useRef<MediaStream | null>(null);
  const sampleChunksRef = useRef<Blob[]>([]);
  const sampleStopTimerRef = useRef<number | null>(null);

  const isArk = providerId === "volcano-ark";
  const canSave = isArk ? Boolean(apiKey.trim() && model.trim()) : Boolean(apiKey.trim() || (appId.trim() && asrToken.trim()));
  const readyCount = providerHealth.filter((item) => item.status === "ready").length;

  function selectProvider(nextProviderId: string) {
    if (nextProviderId === providerId) return;
    setProviderId(nextProviderId);
    setApiKey("");
    setAsrToken("");
    setMessage(null);
  }

  useEffect(() => {
    return () => {
      if (sampleStopTimerRef.current) window.clearTimeout(sampleStopTimerRef.current);
      sampleRecorderRef.current = null;
      sampleStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/account/provider-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          label: isArk ? "火山方舟" : "火山语音识别",
          fields: {
            VOLCANO_ASR_APP_ID: isArk ? "" : appId,
            VOLCANO_ASR_RESOURCE_ID: isArk ? "" : asrResourceId,
            VOLCANO_REALTIME_ASR_RESOURCE_ID: isArk ? "" : realtimeAsrResourceId,
            VOLCANO_ASR_WS_URL: isArk ? "" : asrWsUrl,
            ARK_CHAT_MODEL: isArk ? model : "",
            ARK_BASE_URL: isArk ? arkBaseUrl : "",
          },
          secrets: {
            VOLCANO_ASR_API_KEY: isArk ? "" : apiKey,
            VOLCANO_ASR_TOKEN: isArk ? "" : asrToken,
            ARK_API_KEY: isArk ? apiKey : "",
          },
          removeSecrets: isArk ? [] : apiKey.trim() ? ["VOLCANO_ASR_TOKEN"] : ["VOLCANO_ASR_API_KEY"],
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "保存失败。");
        return;
      }

      setApiKey("");
      setAsrToken("");
      setMessage("已加密保存。页面不会回显密钥原文。");
      await Promise.all([refreshCredentials(), refreshProviderHealth(false)]);
    } catch {
      setMessage("保存请求失败，请确认本地服务正在运行。");
    } finally {
      setSaving(false);
    }
  }

  async function refreshCredentials() {
    const response = await fetch("/api/account/provider-credentials", { cache: "no-store" });
    const payload = await response.json();
    if (response.ok && payload.ok) {
      setProviderCredentials(payload.providerCredentials || []);
    }
  }

  async function refreshProviderHealth(live: boolean) {
    setCheckingHealth(true);
    setHealthMessage(null);

    try {
      const response = await fetch(live ? "/api/account/provider-health?providerId=volcano-ark&live=1" : "/api/account/provider-health", { cache: "no-store" });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setHealthMessage(payload.error || "健康检查失败。");
        return;
      }

      const nextHealth = payload.health || [];
      setProviderHealth(live ? mergeProviderHealth(providerHealth, nextHealth) : nextHealth);
      setHealthMessage(live ? "真实连通测试已完成。" : "健康状态已刷新。");
    } catch {
      setHealthMessage("健康检查请求失败。");
    } finally {
      setCheckingHealth(false);
    }
  }

  async function runAsrLiveTest() {
    setCheckingAsr(true);
    setAsrTestMessage(null);

    try {
      const response = await fetch("/api/account/provider-health/asr-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: true }),
      });
      const payload = await response.json();
      const result = payload.result;

      if (!result) {
        setAsrTestMessage(payload.error || "ASR 测试失败。");
        return;
      }

      setAsrTestMessage(
        [
          result.ok ? result.title : `${result.title}：${result.detail}`,
          result.verificationLevel ? `验证层级：${result.verificationLevel}` : "",
          result.requestId ? `请求 ${result.requestId}` : "",
          result.transcriptPreview ? `识别预览：${result.transcriptPreview}` : "",
          result.nextAction ? `下一步：${result.nextAction}` : "",
        ]
          .filter(Boolean)
          .join("。"),
      );
      await refreshProviderHealth(false);
    } catch {
      setAsrTestMessage("ASR 测试请求失败，请确认本地服务正在运行。");
    } finally {
      setCheckingAsr(false);
    }
  }

  async function runRealtimeAsrTest() {
    setCheckingRealtimeAsr(true);
    setRealtimeAsrTestMessage(null);

    try {
      const response = await fetch("/api/account/provider-health/realtime-test", { method: "POST" });
      const payload = await response.json();
      const result = payload.result;
      if (!result) {
        setRealtimeAsrTestMessage(payload.error || "实时识别连接测试失败。");
        return;
      }
      setRealtimeAsrTestMessage(`${result.title}：${result.detail}`);
      await refreshProviderHealth(false);
    } catch {
      setRealtimeAsrTestMessage("实时识别连接测试请求失败，请确认服务正在运行。");
    } finally {
      setCheckingRealtimeAsr(false);
    }
  }

  async function runAsrTranscriptTest() {
    setCheckingAsrTranscript(true);
    setAsrTranscriptMessage(null);

    try {
      if (!asrSampleFile) {
        setAsrTranscriptMessage("请先选择一段 3-30 秒真实中文语音样本。");
        return;
      }

      if (asrSampleFile.size > 1_500_000) {
        setAsrTranscriptMessage("样本文件过大。请截取 3-30 秒清晰中文语音，建议控制在 1.5MB 以内。");
        return;
      }

      const audioBase64 = await fileToBase64(asrSampleFile);
      const response = await fetch("/api/account/provider-health/asr-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          fileName: asrSampleFile.name,
          live: true,
          mimeType: asrSampleFile.type || "audio/wav",
          mode: "transcribe",
        }),
      });
      const payload = await response.json();
      const result = payload.result;

      if (!result) {
        setAsrTranscriptMessage(payload.error || "ASR 完整识别测试失败。");
        return;
      }

      setAsrTranscriptMessage(formatAsrTestResult(result));
      await refreshProviderHealth(false);
    } catch {
      setAsrTranscriptMessage("ASR 完整识别测试请求失败，请确认本地服务正在运行。");
    } finally {
      setCheckingAsrTranscript(false);
    }
  }

  function selectAsrSample(file: File | undefined) {
    setAsrTranscriptMessage(null);
    setSampleRecordingMessage(null);
    if (!file) {
      setAsrSampleFile(null);
      return;
    }

    setAsrSampleFile(file);
  }

  async function startAsrSampleRecording() {
    setAsrTranscriptMessage(null);
    setSampleRecordingMessage(null);

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setSampleRecordingMessage("当前浏览器不支持直接录制测试样本，请上传音频文件。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const mimeType = chooseSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      sampleChunksRef.current = [];
      sampleStreamRef.current = stream;
      sampleRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) sampleChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        if (sampleStopTimerRef.current) {
          window.clearTimeout(sampleStopTimerRef.current);
          sampleStopTimerRef.current = null;
        }

        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(sampleChunksRef.current, { type });
        sampleStreamRef.current?.getTracks().forEach((track) => track.stop());
        sampleStreamRef.current = null;
        sampleRecorderRef.current = null;
        setRecordingSample(false);

        if (blob.size <= 0) {
          setSampleRecordingMessage("录制样本为空，请确认麦克风权限和输入音量。");
          return;
        }

        const file = new File([blob], `ownminutes-asr-sample-${Date.now()}.${audioExtensionForMime(type)}`, { type });
        setAsrSampleFile(file);
        setSampleRecordingMessage(`已录制测试样本：${formatFileSize(file.size)}。可以运行完整识别测试。`);
      };

      recorder.onerror = () => {
        setSampleRecordingMessage("录制测试样本失败，请改用上传音频文件。");
        setRecordingSample(false);
      };

      recorder.start(1000);
      setRecordingSample(true);
      setSampleRecordingMessage("正在录制测试样本，请说一段普通话。10 秒后会自动停止。");
      sampleStopTimerRef.current = window.setTimeout(() => stopAsrSampleRecording(), 10_000);
    } catch (error) {
      setSampleRecordingMessage(error instanceof Error ? `无法录制测试样本：${error.message}` : "无法录制测试样本，请检查麦克风权限。");
      setRecordingSample(false);
    }
  }

  function stopAsrSampleRecording() {
    if (sampleStopTimerRef.current) {
      window.clearTimeout(sampleStopTimerRef.current);
      sampleStopTimerRef.current = null;
    }

    const recorder = sampleRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }

    sampleStreamRef.current?.getTracks().forEach((track) => track.stop());
    sampleStreamRef.current = null;
    setRecordingSample(false);
  }

  async function deleteProvider(providerIdToDelete: string) {
    const credential = providerCredentials.find((item) => item.providerId === providerIdToDelete);
    const confirmed = window.confirm(`确认删除 ${credential?.label || providerIdToDelete} 配置？删除后该模型不会再用于会议处理。`);
    if (!confirmed) return;

    setDeletingProviderId(providerIdToDelete);
    setMessage(null);

    try {
      const response = await fetch(`/api/account/provider-credentials?providerId=${encodeURIComponent(providerIdToDelete)}`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "删除失败。");
        return;
      }

      setProviderCredentials(payload.providerCredentials || []);
      setMessage("Provider 配置已删除。");
      await refreshProviderHealth(false);
    } catch {
      setMessage("删除请求失败，请确认本地服务正在运行。");
    } finally {
      setDeletingProviderId(null);
    }
  }

  if (!userEmail) {
    return (
      <section className="rounded-[1.5rem] border border-[#e4e8e5] bg-white p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#eef6f1] text-[#1f6f55]">
            <KeyRound className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-[#111827]">登录后配置自己的模型</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">OwnMinutes 的低成本模式依赖账号级 BYOK。登录后可以保存火山 ASR 和方舟 Key。</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Link className="app-primary-button" href="/login">
            登录
          </Link>
          <Link className="app-secondary-button" href="/register">
            注册
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form autoComplete="off" className="min-w-0 rounded-lg border border-[#e4e8e5] bg-white p-5 shadow-sm" onSubmit={saveProvider}>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#eef6f1] text-[#1f6f55]">
            <KeyRound className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#738078]">自带模型配置</p>
            <h2 className="mt-1 text-lg font-semibold text-[#111827]">配置自己的模型</h2>
            <p className="mt-1 truncate text-sm leading-6 text-[#667085]" title={userEmail}>
              当前账号：{userEmail}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-semibold text-[#344054]">我要配置</span>
            <select className="auth-input" value={providerId} onChange={(event) => selectProvider(event.target.value)}>
              <option value="volcano-asr">会议转写：火山语音识别</option>
              <option value="volcano-ark">会议总结：火山方舟</option>
            </select>
          </label>

          {isArk ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-[#344054]">模型 / Endpoint ID</span>
                <input className="auth-input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 ep-xxxxxxxx" />
              </label>
              <SecretInput key="ark-api-key" label="Ark API Key" name="ark-api-key" onChange={setApiKey} placeholder="保存后只显示掩码" value={apiKey} />
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-[#344054]">Base URL（可选）</span>
                <input className="auth-input" value={arkBaseUrl} onChange={(event) => setArkBaseUrl(event.target.value)} placeholder="https://ark.cn-beijing.volces.com/api/v3" />
              </label>
            </>
          ) : (
            <>
              <SecretInput key="asr-api-key" label="ASR API Key" name="asr-api-key" onChange={setApiKey} placeholder="推荐填写，保存后只显示掩码" value={apiKey} />
              <details className="rounded-2xl border border-[#e4e8e5] bg-[#fbfcfb] p-3">
                <summary className="cursor-pointer text-xs font-semibold text-[#344054]">改用 AppID + Token</summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-[#344054]">ASR AppID</span>
                    <input className="auth-input" value={appId} onChange={(event) => setAppId(event.target.value)} />
                  </label>
                  <SecretInput label="ASR Token" name="asr-token" onChange={setAsrToken} value={asrToken} />
                </div>
              </details>
              <details className="rounded-2xl border border-[#e4e8e5] bg-[#fbfcfb] p-3">
                <summary className="cursor-pointer text-xs font-semibold text-[#344054]">实时草稿参数（可选）</summary>
                <p className="mt-1 text-xs leading-5 text-[#667085]">用于会议中实时草稿。正式纪要仍以完整音频会后重新识别为准。</p>
                <div className="mt-3 grid gap-3">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-[#344054]">实时 ASR WebSocket URL</span>
                    <input className="auth-input" value={asrWsUrl} onChange={(event) => setAsrWsUrl(event.target.value)} placeholder="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async" />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-semibold text-[#344054]">实时 Resource ID</span>
                    <input className="auth-input" value={realtimeAsrResourceId} onChange={(event) => setRealtimeAsrResourceId(event.target.value)} placeholder="volc.seedasr.sauc.duration" />
                  </label>
                </div>
              </details>
              <label className="block">
                <span className="mb-1.5 block text-sm font-semibold text-[#344054]">会后文件识别 Resource ID</span>
                <input className="auth-input" value={asrResourceId} onChange={(event) => setAsrResourceId(event.target.value)} placeholder="volc.bigasr.auc_turbo" />
              </label>
            </>
          )}
        </div>

        {message ? <p className="mt-3 rounded-2xl border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">{message}</p> : null}

        <button className="app-primary-button mt-4 w-full" disabled={saving || !canSave} type="submit">
          <Save className="h-4 w-4" />
          {saving ? "保存中" : "加密保存配置"}
        </button>

        <div className="mt-4 rounded-2xl bg-[#f7faf8] p-3 text-xs leading-5 text-[#667085]">
          <div className="flex gap-2">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-[#1f6f55]" />
            <span>密钥只用于当前账号的会议处理，不会返回到页面，也不会写入手机本地。</span>
          </div>
        </div>
      </form>

      <aside className="min-w-0 space-y-4">
        <section className="min-w-0 rounded-lg border border-[#e4e8e5] bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#111827]">配置状态</h2>
              <p className="mt-1 text-sm text-[#667085]">已保存 {providerCredentials.length} 组，{readyCount} 组可用。</p>
            </div>
            <button className="app-icon-button" disabled={checkingHealth} onClick={() => void refreshProviderHealth(false)} type="button" title="刷新健康检查">
              <RefreshCw className={checkingHealth ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {providerHealth.map((item) => (
              <div key={item.providerId} className="rounded-2xl border border-[#e7ece8] bg-[#fbfcfb] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#111827]">{item.label}</p>
                    <p className="mt-1 text-xs text-[#667085]">{item.canUseFor.length ? item.canUseFor.map(providerUseLabel).join(" / ") : "暂不可用"}</p>
                  </div>
                  <HealthBadge status={item.status} />
                </div>
                {item.nextActions[0] ? <p className="mt-3 text-xs leading-5 text-[#667085]">{item.nextActions[0]}</p> : null}
              </div>
            ))}
          </div>

          <details className="mt-4 rounded-2xl border border-[#dbe7df] bg-[#f7fbf8] p-3">
            <summary className="cursor-pointer text-sm font-semibold text-[#344054]">连接测试</summary>
            <p className="mt-2 text-xs leading-5 text-[#667085]">配置保存后再测试。普通使用不需要反复运行。</p>
            <button className="app-secondary-button mt-3 w-full" disabled={checkingAsr} type="button" onClick={() => void runAsrLiveTest()}>
              <ShieldCheck className="h-4 w-4" />
              ASR 小音频真实测试
            </button>
            {asrTestMessage ? <p className="mt-3 rounded-2xl bg-white px-3 py-2 text-center text-xs leading-5 text-[#667085]">{asrTestMessage}</p> : null}

            <button className="app-secondary-button mt-3 w-full" disabled={checkingRealtimeAsr} type="button" onClick={() => void runRealtimeAsrTest()}>
              <Mic className="h-4 w-4" />
              {checkingRealtimeAsr ? "连接中" : "实时识别连接测试"}
            </button>
            {realtimeAsrTestMessage ? <p className="mt-3 rounded-2xl bg-white px-3 py-2 text-center text-xs leading-5 text-[#667085]">{realtimeAsrTestMessage}</p> : null}

            <div className="mt-3 rounded-2xl border border-[#dbe7df] bg-white p-3">
              <div className="flex items-start gap-2">
                <FileAudio className="mt-0.5 h-4 w-4 shrink-0 text-[#1f6f55]" />
                <div>
                  <h3 className="text-sm font-semibold text-[#111827]">ASR 完整识别测试</h3>
                  <p className="mt-1 text-xs leading-5 text-[#667085]">上传或直接录制真实中文样本，确认 provider 能返回可读逐字稿。</p>
                </div>
              </div>
              <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-[#b9d8c9] bg-[#fbfdfb] px-3 py-3 text-sm font-semibold text-[#1f6f55] hover:bg-[#effaf3]">
                <UploadCloud className="h-4 w-4" />
                选择音频样本
                <input
                  accept="audio/*,.wav,.mp3,.m4a,.aac,.webm"
                  className="sr-only"
                  type="file"
                  onChange={(event) => selectAsrSample(event.target.files?.[0])}
                />
              </label>
              <button
                className="app-secondary-button mt-2 w-full"
                type="button"
                onClick={() => (recordingSample ? stopAsrSampleRecording() : void startAsrSampleRecording())}
              >
                {recordingSample ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {recordingSample ? "停止测试录音" : "录 10 秒测试样本"}
              </button>
              <p className="mt-2 truncate text-center text-xs text-[#667085]" title={asrSampleFile?.name || ""}>
                {asrSampleFile ? `${asrSampleFile.name} · ${formatFileSize(asrSampleFile.size)}` : "建议 3-30 秒、普通话、环境安静、1.5MB 以内。"}
              </p>
              {sampleRecordingMessage ? <p className="mt-2 rounded-2xl bg-[#f7faf8] px-3 py-2 text-center text-xs leading-5 text-[#667085]">{sampleRecordingMessage}</p> : null}
              <button className="app-primary-button mt-3 w-full" disabled={checkingAsrTranscript || !asrSampleFile} type="button" onClick={() => void runAsrTranscriptTest()}>
                <ShieldCheck className="h-4 w-4" />
                {checkingAsrTranscript ? "识别中" : "运行完整识别测试"}
              </button>
              {asrTranscriptMessage ? <p className="mt-3 rounded-2xl bg-[#f7faf8] px-3 py-2 text-center text-xs leading-5 text-[#667085]">{asrTranscriptMessage}</p> : null}
            </div>

            <button className="app-secondary-button mt-3 w-full" disabled={checkingHealth} type="button" onClick={() => void refreshProviderHealth(true)}>
              <ShieldCheck className="h-4 w-4" />
              方舟真实连通测试
            </button>
            {healthMessage ? <p className="mt-3 text-center text-xs leading-5 text-[#667085]">{healthMessage}</p> : null}

            <div className="mt-3 space-y-2 border-t border-[#dbe7df] pt-3 text-xs leading-5 text-[#475467]">
              <p className="font-semibold text-[#111827]">ASR 测试判定</p>
              <AsrTestMeaning status="not_configured" detail="还没保存 ASR 运行时 Key，不能验收真实转写。" />
              <AsrTestMeaning status="preflight_pass" detail="字段足够发起测试，但没有调用外部 ASR。" />
              <AsrTestMeaning status="submitted" detail="火山已接受测试音频，请记录 request id；这还不代表文本质量通过。" />
              <AsrTestMeaning status="transcribed" detail="火山返回了可读逐字稿，才算完成识别链路测试。" />
              <AsrTestMeaning status="completed_empty" detail="provider 完成但没有可读文本，通常要换真实中文语音样本。" />
              <AsrTestMeaning status="failed" detail="按返回诊断排查 Key、Endpoint、额度或网络。" />
            </div>
          </details>
        </section>

        <section className="min-w-0 rounded-lg border border-[#e4e8e5] bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-[#111827]">已保存 Provider</h2>
          <div className="mt-4 space-y-3">
            {providerCredentials.length ? (
              providerCredentials.map((credential) => (
                <div key={credential.id} className="rounded-2xl bg-[#f7faf8] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#111827]">{credential.label}</p>
                      <p className="mt-1 font-mono text-xs text-[#667085]">{credential.providerId}</p>
                    </div>
                    <button
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#ead3ce] bg-white text-[#a43d2d] hover:bg-[#fff4f1]"
                      disabled={deletingProviderId === credential.providerId}
                      onClick={() => void deleteProvider(credential.providerId)}
                      title="删除 Provider 配置"
                      type="button"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {credential.configuredSecrets.map((secret) => (
                      <span key={secret} className="rounded-full bg-white px-2 py-1 text-xs font-semibold text-[#1f6f55]">
                        {secret}: {credential.secretPreviews[secret] || "已保存"}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <p className="rounded-2xl border border-dashed border-[#ccd3ce] p-3 text-sm leading-6 text-[#667085]">还没有保存 Provider。先保存 ASR 和方舟，才能长期用自己的成本跑会议。</p>
            )}
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-[#e4e8e5] bg-[#fff9e8] p-4">
          <div className="flex gap-2 text-[#76530a]">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs leading-5">火山账号 AK/SK 不是语音识别运行时 Key。请在对应产品里复制 ASR Key/Token 或方舟 API Key。</p>
          </div>
        </section>

        <section className="min-w-0 rounded-lg border border-[#e4e8e5] bg-white p-4">
          <h2 className="text-base font-semibold text-[#111827]">开通入口</h2>
          <div className="mt-3 grid gap-2">
            <a className="app-secondary-button w-full" href="https://console.volcengine.com/" rel="noreferrer" target="_blank">
              火山控制台
              <ExternalLink className="h-4 w-4" />
            </a>
            <a className="app-secondary-button w-full" href="https://console.volcengine.com/ark/" rel="noreferrer" target="_blank">
              方舟控制台
              <ExternalLink className="h-4 w-4" />
            </a>
          </div>
        </section>
      </aside>
    </section>
  );
}

function SecretInput({
  label,
  name,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  name: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  const inputId = useId();
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="block">
      <label className="mb-1.5 block text-sm font-semibold text-[#344054]" htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className={`auth-input min-h-11 pr-12 ${revealed ? "font-mono" : "ownminutes-secret-input"}`}
          data-1p-ignore
          data-form-type="other"
          data-lpignore="true"
          id={inputId}
          name={name}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          type={revealed ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={`${revealed ? "隐藏" : "显示"}${label}`}
          aria-pressed={revealed}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[#667085] hover:text-[#1f6f55] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#1f6f55]"
          onClick={() => setRevealed((current) => !current)}
          title={`${revealed ? "隐藏" : "显示"}${label}`}
          type="button"
        >
          {revealed ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function HealthBadge({ status }: { status: ProviderHealthResult["status"] }) {
  const label = status === "ready" ? "可用" : status === "failed" ? "失败" : status === "incomplete" ? "待补" : "未配置";
  const className =
    status === "ready"
      ? "bg-[#effaf3] text-[#1f6f55]"
      : status === "failed"
        ? "bg-[#fff4f1] text-[#9f3124]"
        : "bg-[#fff9e8] text-[#76530a]";

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${className}`}>
      {status === "ready" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
      {label}
    </span>
  );
}

function providerUseLabel(use: ProviderHealthResult["canUseFor"][number]) {
  if (use === "file_asr") return "会后识别";
  if (use === "realtime_asr") return "实时草稿";
  if (use === "summary") return "纪要总结";
  return use;
}

function AsrTestMeaning({ status, detail }: { status: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-[#e1e8e3] bg-white px-3 py-2">
      <p className="font-mono text-[11px] font-semibold text-[#1f6f55]">{status}</p>
      <p className="mt-1">{detail}</p>
    </div>
  );
}

function formatAsrTestResult(result: {
  detail?: string;
  nextAction?: string;
  ok?: boolean;
  requestId?: string;
  title?: string;
  transcriptPreview?: string;
  verificationLevel?: string;
}) {
  return [
    result.ok ? result.title : `${result.title || "ASR 测试失败"}：${result.detail || ""}`,
    result.verificationLevel ? `验证层级：${result.verificationLevel}` : "",
    result.requestId ? `请求 ${result.requestId}` : "",
    result.transcriptPreview ? `识别预览：${result.transcriptPreview}` : "",
    result.nextAction ? `下一步：${result.nextAction}` : "",
  ]
    .filter(Boolean)
    .join("。");
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error("读取音频样本失败。"));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
  if (size >= 1024) return `${Math.round(size / 1024)}KB`;
  return `${size}B`;
}

function audioExtensionForMime(mimeType: string) {
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function mergeProviderHealth(current: ProviderHealthResult[], updates: ProviderHealthResult[]) {
  const updateMap = new Map(updates.map((item) => [item.providerId, item]));
  const merged = current.map((item) => updateMap.get(item.providerId) || item);
  for (const item of updates) {
    if (!merged.some((existing) => existing.providerId === item.providerId)) {
      merged.push(item);
    }
  }
  return merged;
}
