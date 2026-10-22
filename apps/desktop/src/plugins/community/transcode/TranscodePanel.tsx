import { useState } from "react";
import { SettingRow } from "@/features/settings/controls";
import { call, explainError, formatBytes, send, useLoad, useServerSession } from "../_serverlib/api";
import { ErrorNotice, Gate } from "../_serverlib/ui";

interface Status {
  ffmpeg: { available: boolean; version: string | null };
  profiles: { id: string; label: string; kbps: number; available: boolean }[];
  defaultProfile: string | null;
  devicePreference: string | null;
  cache: { files: number; bytes: number; maxBytes: number };
}

const CACHE_SIZES = [512, 1024, 2048, 5120, 10240];

function Body() {
  const { isAdmin } = useServerSession();
  const status = useLoad(() => call<Status>("api/transcode/status"), []);
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
          {!s.ffmpeg.available && (
            <p className="notice warn">ffmpeg was not found on the server, so everything streams in its original format.</p>
          )}
          <SettingRow
            title="Quality on this device"
            description="Lower settings use less mobile data. Songs are converted on the server and kept for next time. Takes effect for the next song you play."
          >
            <select
              className="text-input"
              aria-label="Streaming quality on this device"
              value={s.devicePreference ?? ""}
              onChange={(e) => void act(() => send("PUT", "api/transcode/preference", { profile: e.target.value || null }))}
            >
              <option value="">Server default ({s.profiles.find((p) => p.id === s.defaultProfile)?.label ?? "original"})</option>
              <option value="original">Original (no conversion)</option>
              {s.profiles.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}
                  {p.available ? "" : " (not available)"}
                </option>
              ))}
            </select>
          </SettingRow>

          {isAdmin && (
            <>
              <SettingRow title="Default for new devices" description="Used by devices that have not picked a quality.">
                <select
                  className="text-input"
                  aria-label="Default streaming quality"
                  value={s.defaultProfile ?? ""}
                  onChange={(e) =>
                    void act(() => send("PUT", "api/transcode/settings", { defaultProfile: e.target.value || null }))
                  }
                >
                  <option value="">Original</option>
                  {s.profiles.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </SettingRow>
              <SettingRow
                title="Converted songs cache"
                description={`${s.cache.files.toLocaleString()} files, ${formatBytes(s.cache.bytes)} used. The least recently played are removed first.`}
              >
                <div className="row">
                  <select
                    className="text-input"
                    aria-label="Cache size limit"
                    value={String(Math.round(s.cache.maxBytes / 1024 / 1024))}
                    onChange={(e) =>
                      void act(() => send("PUT", "api/transcode/settings", { maxCacheMb: Number(e.target.value) }))
                    }
                  >
                    {[...new Set([...CACHE_SIZES, Math.round(s.cache.maxBytes / 1024 / 1024)])]
                      .sort((a, b) => a - b)
                      .map((mb) => (
                        <option key={mb} value={mb}>
                          Up to {formatBytes(mb * 1024 * 1024)}
                        </option>
                      ))}
                  </select>
                  <button
                    className="btn"
                    disabled={s.cache.files === 0}
                    onClick={() => void act(() => send("DELETE", "api/transcode/cache"))}
                  >
                    Clear
                  </button>
                </div>
              </SettingRow>
            </>
          )}
        </>
      )}
      {status.loading && !s && <p className="empty">LoadingÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦</p>}
    </div>
  );
}

export function TranscodePanel() {
  return (
    <Gate>
      <Body />
    </Gate>
  );
}
