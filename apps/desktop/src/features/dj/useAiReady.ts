import { useCallback, useEffect, useRef, useState } from "react";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { latestOnly } from "./latest";
import { currentOption, providerStatus, useProviders, type ProviderOption } from "./providers";
import { djSetup, setupMessage } from "./setup";

export type AiReady =
  | { state: "checking" }
  /** Nothing to ask: no provider is configured. */
  | { state: "none" }
  /** A provider is chosen but the check failed (not running, bad key, model missing). */
  | { state: "problem"; message: string; option: ProviderOption }
  | { state: "ready"; option: ProviderOption };

/**
 * Whether an AI provider (the one chosen in Settings → AI DJ) can be used right
 * now. Features show a pointer to settings instead of failing on first use.
 */
export function useAiReady(): AiReady & { recheck: () => void } {
  const [ready, setReady] = useState<AiReady>({ state: "checking" });
  const [nonce, setNonce] = useState(0);
  const guard = useRef(latestOnly());
  // Re-run when the chosen provider or the signed-in server change. (Not on `remote`: checking it updates it.)
  const local = useProviders((s) => s.local);
  const selected = useProviders((s) => s.selected);
  const user = useServer((s) => s.user);

  useEffect(() => {
    const latest = guard.current;
    const stillCurrent = latest.begin();
    void (async () => {
      setReady({ state: "checking" });
      await useProviders.getState().refreshRemote().catch(() => undefined);
      const option = currentOption();
      if (!stillCurrent()) return;
      if (!option) return setReady({ state: "none" });
      // A provider on this device is checked through the app's bridge, which a test build may lack.
      if (option.scope === "local" && !window.host?.llm) return setReady({ state: "ready", option });
      const status = await providerStatus(option.ref).catch((e) => ({
        available: false,
        models: [] as string[],
        error: e instanceof Error ? e.message : String(e),
      }));
      if (!stillCurrent()) return;
      const message = setupMessage(djSetup(option, status));
      setReady(message ? { state: "problem", message, option } : { state: "ready", option });
    })();
    return () => latest.cancel();
  }, [local, selected, user, nonce]);

  const recheck = useCallback(() => setNonce((n) => n + 1), []);
  return { ...ready, recheck };
}
