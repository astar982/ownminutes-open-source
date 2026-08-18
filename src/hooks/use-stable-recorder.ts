"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordedAudioChunk } from "@/lib/audio-pipeline";
import { chooseSupportedMimeType, type RecorderHealth, type RecorderStats } from "@/lib/recording";
import type { MeetingStatus } from "@/lib/meeting";

type StableRecorderState = {
  status: MeetingStatus;
  health: RecorderHealth;
  seconds: number;
  level: number;
  audioUrl: string | null;
  error: string | null;
  warning: string | null;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string;
  stats: RecorderStats;
  diagnostics: RecorderDiagnostics;
};

const initialStats: RecorderStats = {
  chunks: 0,
  bytes: 0,
  mimeType: "",
  lastChunkAt: null,
  sampleRate: null,
};

export type RecorderDiagnostics = {
  checkedAt: string | null;
  pageUrl: string;
  secureContext: boolean;
  hasMediaDevices: boolean;
  hasGetUserMedia: boolean;
  hasMediaRecorder: boolean;
  supportedMimeType: string;
  permissionState: PermissionState | "unsupported" | "unknown";
  fallbackUsed: boolean;
  lastErrorName: string | null;
  lastErrorMessage: string | null;
};

export type RecorderSelfTestResult = {
  checkedAt: string;
  ok: boolean;
  message: string;
  mimeType: string;
  sampleRate: number | null;
  bytes: number;
  chunks: number;
  durationMs: number;
  permissionState: RecorderDiagnostics["permissionState"];
  errorName: string | null;
  errorMessage: string | null;
};

const initialDiagnostics: RecorderDiagnostics = {
  checkedAt: null,
  pageUrl: "",
  secureContext: false,
  hasMediaDevices: false,
  hasGetUserMedia: false,
  hasMediaRecorder: false,
  supportedMimeType: "",
  permissionState: "unknown",
  fallbackUsed: false,
  lastErrorName: null,
  lastErrorMessage: null,
};

export function useStableRecorder(options?: { onChunk?: (chunk: RecordedAudioChunk) => void | Promise<void> }) {
  const [state, setState] = useState<StableRecorderState>({
    status: "idle",
    health: "ready",
    seconds: 0,
    level: 0,
    audioUrl: null,
    error: null,
    warning: null,
    devices: [],
    selectedDeviceId: "",
    stats: initialStats,
    diagnostics: initialDiagnostics,
  });

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioUrlRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const suppressStopRef = useRef(false);
  const chunkSequenceRef = useRef(0);
  const onChunkRef = useRef(options?.onChunk);

  const canRecord = useMemo(() => typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia), []);

  useEffect(() => {
    onChunkRef.current = options?.onChunk;
  }, [options?.onChunk]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((device) => device.kind === "audioinput");

    setState((current) => ({
      ...current,
      devices: audioInputs,
      selectedDeviceId: current.selectedDeviceId || audioInputs[0]?.deviceId || "",
    }));
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const stopLevelMeter = useCallback(() => {
    if (animationRef.current) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setState((current) => ({ ...current, level: 0 }));
  }, []);

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopLevelMeter();
  }, [stopLevelMeter]);

  const buildAudioConstraints = useCallback((deviceId: string): MediaStreamConstraints => {
    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };

    if (deviceId) {
      audio.deviceId = { exact: deviceId };
    }

    return { audio };
  }, []);

  const startLevelMeter = useCallback((stream: MediaStream) => {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    const data = new Uint8Array(analyser.fftSize);

    source.connect(analyser);
    audioContextRef.current = audioContext;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;

      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }

      const rms = Math.sqrt(sum / data.length);
      setState((current) => ({ ...current, level: Math.min(1, rms * 3) }));
      animationRef.current = window.requestAnimationFrame(tick);
    };

    tick();
    return audioContext.sampleRate;
  }, []);

  const reset = useCallback(() => {
    if (recorderRef.current?.state === "recording" || recorderRef.current?.state === "paused") {
      suppressStopRef.current = true;
      recorderRef.current.stop();
    }

    cleanupStream();
    chunksRef.current = [];
    chunkSequenceRef.current = 0;
    recorderRef.current = null;

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    setState((current) => ({
      ...current,
      status: "idle",
      health: "ready",
      seconds: 0,
      level: 0,
      audioUrl: null,
      error: null,
      warning: null,
      stats: initialStats,
      diagnostics: initialDiagnostics,
    }));
  }, [cleanupStream]);

  const restoreFromBlob = useCallback((blob: Blob, input: { chunks: number; bytes: number; durationMs: number; mimeType: string }) => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    const audioUrl = URL.createObjectURL(blob);
    audioUrlRef.current = audioUrl;
    setState((current) => ({
      ...current,
      status: "complete",
      health: "complete",
      seconds: Math.max(0, Math.round(input.durationMs / 1000)),
      audioUrl,
      error: null,
      warning: "已从浏览器本地存储恢复录音。",
      stats: {
        ...current.stats,
        chunks: input.chunks,
        bytes: input.bytes,
        mimeType: input.mimeType,
      },
    }));
  }, []);

  const start = useCallback(async () => {
    const initialEnvironment = buildRecorderEnvironmentSnapshot();

    setState((current) => ({
      ...current,
      status: "requesting",
      health: "requesting",
      error: null,
      diagnostics: initialEnvironment,
      warning: "已收到开始录音指令，正在检查浏览器麦克风能力。",
    }));

    const environment = await inspectRecorderEnvironment();

    if (!canRecord) {
      setState((current) => ({
        ...current,
        status: "idle",
        health: "error",
        warning: null,
        diagnostics: environment,
        error: `当前浏览器不支持麦克风录音。请用 Chrome/Safari 或 Edge 打开 ${currentOrigin()}，并确认麦克风权限。`,
      }));
      return false;
    }

    try {
      setState((current) => ({
        ...current,
        diagnostics: environment,
        warning: "正在请求麦克风权限。如果浏览器弹出权限提示，请选择允许。",
      }));

      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }

      const mimeType = chooseSupportedMimeType();
      const media = await getAudioStreamWithFallback(buildAudioConstraints(state.selectedDeviceId));
      const stream = media.stream;
      let sampleRate: number | null = null;
      let meterWarning: string | null = null;

      try {
        sampleRate = startLevelMeter(stream);
      } catch (error) {
        meterWarning = `录音已启动，但音量监控初始化失败：${errorName(error)}`;
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      chunksRef.current = [];
      chunkSequenceRef.current = 0;
      streamRef.current = stream;
      recorderRef.current = recorder;

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          setState((current) => ({
            ...current,
            status: current.status === "recording" ? "paused" : current.status,
            health: "warning",
            warning: "麦克风输入中断，请检查设备连接后继续录制。",
          }));
        };
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) return;

        chunkSequenceRef.current += 1;
        const sequence = chunkSequenceRef.current;
        const effectiveMimeType = recorder.mimeType || mimeType || event.data.type || "audio/webm";

        chunksRef.current.push(event.data);
        setState((current) => ({
          ...current,
          stats: {
            ...current.stats,
            chunks: current.stats.chunks + 1,
            bytes: current.stats.bytes + event.data.size,
            lastChunkAt: Date.now(),
          },
        }));

        void onChunkRef.current?.({
          blob: event.data,
          sequence,
          mimeType: effectiveMimeType,
          recordedAt: Date.now(),
          durationMs: 1000,
        });
      };

      recorder.onerror = () => {
        setState((current) => ({
          ...current,
          health: "error",
          error: "录音器出现错误，本次音频分片已保留，请结束会议后重新开始。",
        }));
      };

      recorder.onstop = () => {
        if (suppressStopRef.current) {
          suppressStopRef.current = false;
          return;
        }

        const outputMimeType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: outputMimeType });
        const audioUrl = URL.createObjectURL(blob);

        audioUrlRef.current = audioUrl;
        cleanupStream();

        setState((current) => ({
          ...current,
          status: "complete",
          audioUrl,
          health: current.health === "error" ? "error" : "complete",
          stats: {
            ...current.stats,
            mimeType: outputMimeType,
          },
        }));
      };

      recorder.start(1000);

      setState((current) => ({
        ...current,
        status: "recording",
        health: "recording",
        seconds: 0,
        audioUrl: null,
        error: null,
        warning: meterWarning,
        diagnostics: {
          ...environment,
          fallbackUsed: media.fallbackUsed,
          lastErrorName: null,
          lastErrorMessage: null,
        },
        stats: {
          ...initialStats,
          mimeType: recorder.mimeType || mimeType || "browser default",
          sampleRate,
        },
      }));

      await refreshDevices();
      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        status: "idle",
        health: "error",
        warning: null,
        diagnostics: {
          ...environment,
          lastErrorName: errorName(error),
          lastErrorMessage: errorMessage(error),
        },
        error: microphoneErrorMessage(error),
      }));
      return false;
    }
  }, [buildAudioConstraints, canRecord, cleanupStream, refreshDevices, startLevelMeter, state.selectedDeviceId]);

  const runSelfTest = useCallback(async (): Promise<RecorderSelfTestResult> => {
    const checkedAt = new Date().toLocaleTimeString();

    if (state.status === "recording" || state.status === "paused" || state.status === "requesting") {
      return {
        checkedAt,
        ok: false,
        message: "当前正在录音，结束会议后再做麦克风自检。",
        mimeType: state.stats.mimeType,
        sampleRate: state.stats.sampleRate,
        bytes: 0,
        chunks: 0,
        durationMs: 0,
        permissionState: state.diagnostics.permissionState,
        errorName: null,
        errorMessage: null,
      };
    }

    const environment = await inspectRecorderEnvironment();

    if (!canRecord) {
      return {
        checkedAt,
        ok: false,
        message: "当前浏览器不支持麦克风录音，请改用 Chrome、Safari 或 Edge。",
        mimeType: "",
        sampleRate: null,
        bytes: 0,
        chunks: 0,
        durationMs: 0,
        permissionState: environment.permissionState,
        errorName: "UnsupportedBrowser",
        errorMessage: null,
      };
    }

    setState((current) => ({
      ...current,
      warning: "正在做麦克风自检，请在浏览器权限提示中允许麦克风。",
      error: null,
      diagnostics: environment,
    }));

    const startedAt = Date.now();
    let stream: MediaStream | null = null;

    try {
      const mimeType = chooseSupportedMimeType();
      const media = await getAudioStreamWithFallback(buildAudioConstraints(state.selectedDeviceId));
      stream = media.stream;
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      const sampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? null;

      const stopped = new Promise<void>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => reject(new Error("SELF_TEST_RECORDER_ERROR"));
        recorder.onstop = () => resolve();
      });

      recorder.start(500);
      await delay(1400);
      if (recorder.state !== "inactive") {
        recorder.requestData();
        recorder.stop();
      }
      await stopped;

      const bytes = chunks.reduce((total, chunk) => total + chunk.size, 0);
      const durationMs = Date.now() - startedAt;
      const ok = bytes > 0;

      setState((current) => ({
        ...current,
        warning: ok ? null : "麦克风自检未拿到音频分片，请检查系统输入设备。",
        diagnostics: {
          ...environment,
          fallbackUsed: media.fallbackUsed,
          lastErrorName: null,
          lastErrorMessage: null,
        },
      }));

      await refreshDevices();

      return {
        checkedAt,
        ok,
        message: ok ? "麦克风可用，浏览器已成功生成音频分片。" : "麦克风权限可能已允许，但没有生成有效音频分片。",
        mimeType: recorder.mimeType || mimeType || "browser default",
        sampleRate,
        bytes,
        chunks: chunks.length,
        durationMs,
        permissionState: environment.permissionState,
        errorName: null,
        errorMessage: null,
      };
    } catch (error) {
      setState((current) => ({
        ...current,
        warning: null,
        diagnostics: {
          ...environment,
          lastErrorName: errorName(error),
          lastErrorMessage: errorMessage(error),
        },
      }));

      return {
        checkedAt,
        ok: false,
        message: microphoneErrorMessage(error),
        mimeType: chooseSupportedMimeType(),
        sampleRate: null,
        bytes: 0,
        chunks: 0,
        durationMs: Date.now() - startedAt,
        permissionState: environment.permissionState,
        errorName: errorName(error),
        errorMessage: errorMessage(error),
      };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }, [buildAudioConstraints, canRecord, refreshDevices, state.diagnostics.permissionState, state.selectedDeviceId, state.stats.mimeType, state.stats.sampleRate, state.status]);

  const pause = useCallback(() => {
    if (recorderRef.current?.state !== "recording") return;
    recorderRef.current.pause();
    setState((current) => ({ ...current, status: "paused", health: "paused" }));
  }, []);

  const resume = useCallback(() => {
    if (recorderRef.current?.state !== "paused") return;
    recorderRef.current.resume();
    setState((current) => ({ ...current, status: "recording", health: "recording", warning: null }));
  }, []);

  const stop = useCallback(() => {
    if (!recorderRef.current || recorderRef.current.state === "inactive") return;
    recorderRef.current.requestData();
    recorderRef.current.stop();
    setState((current) => ({ ...current, status: "processing" }));
  }, []);

  const selectDevice = useCallback((deviceId: string) => {
    setState((current) => ({ ...current, selectedDeviceId: deviceId }));
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;

    const handleDeviceChange = () => {
      void refreshDevices();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refreshDevices]);

  useEffect(() => {
    if (state.status !== "recording") return;

    const timer = window.setInterval(() => {
      setState((current) => ({ ...current, seconds: current.seconds + 1 }));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [state.status]);

  useEffect(() => {
    if (state.status !== "recording") return;

    const watchdog = window.setInterval(() => {
      setState((current) => {
        if (!current.stats.lastChunkAt) return current;
        if (Date.now() - current.stats.lastChunkAt < 7000) return current;

        return {
          ...current,
          health: "warning",
          warning: "超过7秒没有收到新的音频分片，请检查浏览器是否挂起或麦克风是否断开。",
        };
      });
    }, 3000);

    return () => window.clearInterval(watchdog);
  }, [state.status]);

  useEffect(() => {
    return () => {
      cleanupStream();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [cleanupStream]);

  return {
    ...state,
    canRecord,
    start,
    pause,
    resume,
    stop,
    reset,
    restoreFromBlob,
    runSelfTest,
    refreshDevices,
    selectDevice,
  };
}

async function getUserMediaWithTimeout(constraints: MediaStreamConstraints) {
  return await Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("MICROPHONE_PERMISSION_TIMEOUT"));
      }, 15000);
    }),
  ]);
}

async function getAudioStreamWithFallback(constraints: MediaStreamConstraints) {
  try {
    return {
      stream: await getUserMediaWithTimeout(constraints),
      fallbackUsed: false,
    };
  } catch (error) {
    if (!shouldRetryWithSimpleAudio(error)) throw error;

    return {
      stream: await getUserMediaWithTimeout({ audio: true }),
      fallbackUsed: true,
    };
  }
}

function shouldRetryWithSimpleAudio(error: unknown) {
  if (error instanceof DOMException) {
    return error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError" || error.name === "NotReadableError";
  }

  return error instanceof TypeError;
}

async function inspectRecorderEnvironment(): Promise<RecorderDiagnostics> {
  const snapshot = buildRecorderEnvironmentSnapshot();
  let permissionState: RecorderDiagnostics["permissionState"] = "unknown";

  try {
    if (navigator.permissions?.query) {
      const status = await withTimeout(navigator.permissions.query({ name: "microphone" as PermissionName }), 1000);
      permissionState = status.state;
    } else {
      permissionState = "unsupported";
    }
  } catch {
    permissionState = "unsupported";
  }

  return {
    ...snapshot,
    permissionState,
  };
}

function buildRecorderEnvironmentSnapshot(): RecorderDiagnostics {
  return {
    checkedAt: new Date().toLocaleTimeString(),
    pageUrl: typeof window === "undefined" ? "" : window.location.href,
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    hasMediaDevices: Boolean(navigator.mediaDevices),
    hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
    supportedMimeType: chooseSupportedMimeType(),
    permissionState: "unknown",
    fallbackUsed: false,
    lastErrorName: null,
    lastErrorMessage: null,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("DIAGNOSTICS_TIMEOUT")), timeoutMs);
    }),
  ]);
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, timeoutMs);
  });
}

function currentOrigin() {
  return typeof window === "undefined" ? "http://127.0.0.1:3003" : window.location.origin;
}

function errorName(error: unknown) {
  if (error instanceof DOMException) return error.name;
  if (error instanceof Error) return error.name;
  return typeof error;
}

function errorMessage(error: unknown) {
  if (error instanceof DOMException || error instanceof Error) return error.message;
  return String(error);
}

function microphoneErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "麦克风权限被拒绝。请在浏览器地址栏左侧权限设置里允许麦克风，然后刷新页面重试。";
  }

  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "没有检测到可用麦克风。请检查设备连接后刷新页面。";
  }

  if (error instanceof DOMException && error.name === "NotReadableError") {
    return "麦克风正被其他应用占用，或系统拒绝访问。请关闭占用麦克风的应用后重试。";
  }

  if (error instanceof DOMException && error.name === "OverconstrainedError") {
    return "当前浏览器无法满足指定麦克风参数。系统已尝试降级到默认录音，如果仍失败，请刷新页面并选择默认麦克风。";
  }

  if (error instanceof Error && error.message === "MICROPHONE_PERMISSION_TIMEOUT") {
    return `请求麦克风权限超时。请检查浏览器顶部或地址栏附近是否有权限弹窗；建议刷新 ${currentOrigin()} 后重试。`;
  }

  return `无法访问麦克风。请确认浏览器权限、设备连接，或者改用 ${currentOrigin()} 打开。`;
}
