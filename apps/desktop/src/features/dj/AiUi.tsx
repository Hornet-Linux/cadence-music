import type { ReactNode } from "react";
import { useSettingsModal } from "@/features/settings/settingsStore";
import { describeAiError, NoProviderError } from "./ask";
import { useAiReady } from "./useAiReady";
import "./ai.css";

/** The line the AI features show when nothing is set up. Points to Settings → AI DJ. */
export function NoProviderNotice() {
  const showSettings = useSettingsModal((s) => s.show);
  return (
    <div className="ai-empty" role="status">
      <strong>Connect an AI first</strong>
      <p className="muted">
        These features use the same AI as the DJ: a model on your computer (Ollama, LM Studio), a provider your server owner set up, or
        your own API key.
      </p>
      <button className="btn primary" onClick={() => showSettings("dj")}>
        Open Settings → AI DJ
      </button>
    </div>
  );
}

/** Shows the empty state or a setup problem above `children`; children render only when an AI can be asked. */
export function AiGate({ children, allowProblem = true }: { children: ReactNode; allowProblem?: boolean }) {
  const ready = useAiReady();
  const showSettings = useSettingsModal((s) => s.show);
  if (ready.state === "checking") return <p className="muted ai-checking">Checking your AI provider…</p>;
  if (ready.state === "none") return <NoProviderNotice />;
  return (
    <>
      {ready.state === "problem" && (
        <div className="notice warn ai-problem" role="alert">
          <span>{ready.message}</span>
          <span className="ai-actions">
            <button className="btn" onClick={ready.recheck}>
              Check again
            </button>
            <button className="btn" onClick={() => showSettings("dj")}>
              Open Settings → AI DJ
            </button>
          </span>
        </div>
      )}
      {(ready.state === "ready" || allowProblem) && children}
    </>
  );
}

/** An error from an AI request, with a way to fix settings problems. */
export function AiError({ error }: { error: unknown }) {
  const showSettings = useSettingsModal((s) => s.show);
  if (!error) return null;
  if (error instanceof DOMException && error.name === "AbortError") return null;
  return (
    <div className="notice error ai-problem" role="alert">
      <span>{describeAiError(error)}</span>
      <span className="ai-actions">
        <button className="btn" onClick={() => showSettings("dj")}>
          {error instanceof NoProviderError ? "Open Settings → AI DJ" : "AI settings"}
        </button>
      </span>
    </div>
  );
}
