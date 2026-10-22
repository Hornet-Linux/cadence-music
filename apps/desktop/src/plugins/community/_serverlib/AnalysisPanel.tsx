import { useState } from "react";
import { Segmented, SettingRow, Toggle } from "@/features/settings/controls";
import { call, explainError, pluralize, send, useLoad, useServerSession } from "./api";
import { ErrorNotice, Gate, Progress } from "./ui";

export interface AnalysisStatus {
  ffmpeg: boolean;
  config: { auto: boolean; pauseMs: number };
  run: { running: boolean; total: number; done: number; failed: number; current: string | null; lastError: string | null };
  total: number;
  analysed: number;
  failed: number;
  pending: number;
}

type Pace = "gentle" | "normal" | "fast";
const PACE_MS: Record<Pace, number> = { gentle: 4000, normal: 1500, fast: 0 };
const paceOf = (ms: number): Pace => (ms >= 3000 ? "gentle" : ms > 0 ? "normal" : "fast");

/**
 * Status and controls for a background analysis job on the server (loudness, tempo and key).
 * Everyone sees progress; the admin can start, stop and tune it.
 */
function Body({ base, noun, what }: { base: string; noun: string; what: string }) {
  const { isAdmin } = useServerSession();
  const status = useLoad(
    () => call<AnalysisStatus>(`${base}/status`),
    [base],
    (s) => (s?.run.running ? 2000 : null),
  );
  const [error, setError] = useState<string | null>(null);
  const s = status.data;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(explainError(err));
    }
    status.reload();
  };

  return (
    <div className="stack sl-page">
      <ErrorNotice error={status.error} />
      {error && <p className="notice error">{error}</p>}
      {s && (
        <>
          {!s.ffmpeg && (
            <p className="notice warn">
              ffmpeg was not found on the server, so {noun} cannot run. The official server image includes it.
            </p>
          )}
          <div className="stack">
            <Progress value={s.analysed + s.failed} max={s.total} label={`${noun} progress`} />
            <div className="muted small">
              {pluralize(s.analysed, "track")} analysed of {s.total.toLocaleString()}
              {s.failed > 0 ? ` Ãƒâ€šÃ‚Â· ${pluralize(s.failed, "file")} could not be read` : ""}
              {s.run.running && s.run.current ? ` Ãƒâ€šÃ‚Â· now: ${s.run.current}` : ""}
            </div>
            {s.run.lastError && s.run.running && <div className="muted small">Last problem: {s.run.lastError}</div>}
          </div>
          <p className="muted small">{what}</p>
          {isAdmin && (
            <>
              <div className="sl-actions">
                {s.run.running ? (
                  <button className="btn" onClick={() => void act(() => send("POST", `${base}/stop`))}>
                    Pause
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    disabled={!s.ffmpeg || s.pending === 0}
                    onClick={() => void act(() => send("POST", `${base}/start`))}
                  >
                    {s.pending === 0 ? "All done" : s.analysed > 0 ? "Resume" : "Start"}
                  </button>
                )}
              </div>
              <SettingRow
                title="Run by itself"
                description="Keep analysing new music in the background, with pauses so the server stays responsive."
              >
                <Toggle
                  on={s.config.auto}
                  label={`Run ${noun} by itself`}
                  onChange={(auto) => void act(() => send("PUT", `${base}/settings`, { auto }))}
                />
              </SettingRow>
              <SettingRow title="Pace" description="Gentle leaves the most room for streaming and other apps.">
                <Segmented<Pace>
                  label="Pace"
                  value={paceOf(s.config.pauseMs)}
                  options={[
                    { value: "gentle", label: "Gentle" },
                    { value: "normal", label: "Normal" },
                    { value: "fast", label: "Fast" },
                  ]}
                  onChange={(pace) => void act(() => send("PUT", `${base}/settings`, { pauseMs: PACE_MS[pace] }))}
                />
              </SettingRow>
            </>
          )}
        </>
      )}
      {status.loading && !s && <p className="empty">LoadingÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦</p>}
    </div>
  );
}

export function AnalysisPanel(props: { base: string; noun: string; what: string }) {
  return (
    <Gate>
      <Body {...props} />
    </Gate>
  );
}
