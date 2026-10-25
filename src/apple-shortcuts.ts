import type { AiMessage } from "./types";
import { structuredPrompt } from "./subscription-cli";

export const APPLE_CALLBACK = "tps-ai-shortcut-result";
export const APPLE_MAX_INPUT = 12_000;
export const APPLE_MAX_RESULT = 64_000;

interface Pending {
  nonce: string;
  vault: string;
  finish: (value?: string, error?: Error) => void;
}

/** One explicit foreground handoff, held only in memory. No vault jobs or polling. */
export class AppleShortcutConnection {
  private pending: Pending | null = null;
  constructor(private open: (url: string) => void, private nonce: () => string = () => crypto.randomUUID(), private timeoutMs = 180_000) {}

  request(name: string, vault: string, messages: AiMessage[], schema: Record<string, unknown>): Promise<{ text: string; model: string }> {
    if (!name.trim()) return Promise.reject(new Error("Choose an Apple shortcut name in AI settings."));
    if (this.pending) return Promise.reject(new Error("An Apple shortcut is already running. Finish or cancel it first."));
    const prompt = structuredPrompt(messages, schema);
    if (prompt.length > APPLE_MAX_INPUT) return Promise.reject(new Error("This request is too large for the Apple Shortcuts handoff. Use a direct provider."));
    const nonce = this.nonce();
    const callback = (status: string) => `obsidian://${APPLE_CALLBACK}?${new URLSearchParams({ vault, nonce, status })}`;
    const url = `shortcuts://x-callback-url/run-shortcut?${new URLSearchParams({ name: name.trim(), input: "text", text: prompt, "x-success": callback("success"), "x-error": callback("error"), "x-cancel": callback("cancel") })}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.pending?.nonce === nonce && this.pending.finish(undefined, new Error("Apple Shortcuts did not return before the timeout. No backup request was sent.")), this.timeoutMs);
      this.pending = { nonce, vault, finish: (value, error) => {
        clearTimeout(timer); this.pending = null;
        if (error) reject(error); else resolve({ text: value!, model: `Shortcut: ${name.trim()}` });
      } };
      try { this.open(url); } catch { this.pending.finish(undefined, new Error("Apple Shortcuts could not open.")); }
    });
  }

  receive(params: Record<string, string>): void {
    const pending = this.pending;
    if (!pending || params.nonce !== pending.nonce || params.vault !== pending.vault) return;
    if (params.status === "cancel" || params.status === "error") {
      pending.finish(undefined, new Error(params.status === "cancel" ? "Apple Shortcuts was cancelled." : "Apple Shortcuts failed. Check the shortcut and Apple Intelligence availability."));
      return;
    }
    if (params.status !== "success") return;
    if (typeof params.result !== "string" || !params.result.trim() || params.result.length > APPLE_MAX_RESULT) {
      pending.finish(undefined, new Error("Apple Shortcuts returned an empty or oversized result.")); return;
    }
    pending.finish(params.result.trim());
  }

  dispose(): void { this.pending?.finish(undefined, new Error("AI Gateway closed while Apple Shortcuts was running.")); }
}
