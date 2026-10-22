import { useCallback, useEffect, useRef, useState } from "react";

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export interface Paged<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  more: () => void;
}

interface PageResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/** Load a list a page at a time; reloads from the start whenever `key` changes. */
export function usePaged<T>(load: (offset: number) => Promise<PageResult<T>>, key: string): Paged<T> {
  const [state, setState] = useState<{ items: T[]; total: number; hasMore: boolean; loading: boolean; error: string | null }>({
    items: [],
    total: 0,
    hasMore: false,
    loading: true,
    error: null,
  });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const fetchPage = useCallback((offset: number) => {
    const id = ++seq.current;
    setState((s) => ({ ...(offset === 0 ? { items: [], total: 0, hasMore: false } : s), loading: true, error: null }));
    loadRef
      .current(offset)
      .then((page) => {
        if (id !== seq.current) return;
        setState((s) => ({
          items: offset === 0 ? page.items : [...s.items, ...page.items],
          total: page.total,
          hasMore: page.hasMore,
          loading: false,
          error: null,
        }));
      })
      .catch((e: unknown) => {
        if (id === seq.current) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
  }, []);

  useEffect(() => {
    const latest = seq;
    fetchPage(0);
    // A reply that lands after the list changed (or unmounted) is dropped.
    return () => {
      latest.current++;
    };
  }, [key, fetchPage]);

  const { items, loading } = state;
  const more = useCallback(() => {
    if (!loading) fetchPage(items.length);
  }, [loading, items.length, fetchPage]);
  return { ...state, more };
}