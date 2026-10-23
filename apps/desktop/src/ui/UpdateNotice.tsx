import { useEffect, useState } from "react";
import { dismissUpdate, pendingUpdate, type ReleaseInfo } from "@/platform/updateNotice";
import "./updateNotice.css";

/** A small dismissible "newer version" note in the desktop app title bar. Does nothing in the web player or when the version is unknown. */
export function UpdateNotice() {
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    const current = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : null;
    // Only the desktop app: the web player and phone apps are updated with the server or have their own notice.
    if (!current || !window.host || (window.host.platform as string | undefined) === "web") return;
    let live = true;
    void pendingUpdate({ current, store: localStorage }).then((r) => live && setRelease(r));
    return () => {
      live = false;
    };
  }, []);

  if (!release) return null;
  return (
    <div className="update-notice" role="status">
      <span>Cadence {release.tag.replace(/^v/i, "")} is available.</span>
      <a href={release.url} target="_blank" rel="noopener noreferrer">
        Download
      </a>
      <button
        aria-label="Dismiss"
        onClick={() => {
          dismissUpdate(localStorage, release.tag);
          setRelease(null);
        }}
      >
        &times;
      </button>
    </div>
  );
}
