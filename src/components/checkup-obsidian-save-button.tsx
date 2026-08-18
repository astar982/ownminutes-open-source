"use client";

import { Save } from "lucide-react";
import { useState } from "react";

type SaveState = "idle" | "saving" | "success" | "error";

export function CheckupObsidianSaveButton() {
  const [state, setState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("");

  async function saveToObsidian() {
    setState("saving");
    setMessage("");

    try {
      const response = await fetch("/api/checkup/acceptance/obsidian", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "保存验收单到 Obsidian 失败。");
      }

      setState("success");
      setMessage(`已保存到 Obsidian：${payload.saved?.relativePath || "OwnMinutes/验收记录"}`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "保存验收单到 Obsidian 失败。");
    }
  }

  return (
    <div className="mt-3">
      <button className="app-secondary-button min-h-10 w-full px-4 py-2 text-sm" disabled={state === "saving"} type="button" onClick={() => void saveToObsidian()}>
        <Save className="h-4 w-4" />
        {state === "saving" ? "正在保存" : "保存验收单到 Obsidian"}
      </button>
      {message ? <p className={`mt-2 text-xs leading-5 ${state === "success" ? "text-[#9ee8c7]" : "text-[#ffd7d0]"}`}>{message}</p> : null}
    </div>
  );
}
