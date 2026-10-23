import { useEffect, useRef, useState } from "react";
import { MetadataError } from "./client";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; error: MetadataError };

/** Run an async lookup whenever `key` changes; an older answer never overwrites a newer one. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, key: string): Loaded<T> {
  const [result, setResult] = useState<{ key: string; value: Loaded<T> } | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, value: { state: "ready", data } });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const error = err instanceof MetadataError ? err : new MetadataError("failed", "Something went wrong.");
        setResult({ key, value: { state: "error", error } });
      });
    return () => controller.abort();
  }, [key]);

  return result && result.key === key ? result.value : { state: "loading" };
}
