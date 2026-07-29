// ---------------------------------------------------------------------------
// usePersistedState — drop-in replacement for useState that reads/writes
// localStorage so selections survive tab switches and page refreshes.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) return JSON.parse(saved) as T;
    } catch {
      // corrupt entry — fall through to default
    }
    return defaultValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // storage full or private mode — silently ignore
    }
  }, [key, state]);

  return [state, setState];
}
