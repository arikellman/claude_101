"use client";

import { useRef, useState } from "react";

/**
 * Delete-with-undo. The frictionless principle rules out a blocking "are you sure?"
 * dialog on every delete, but three places in the app (Today list, weight log,
 * Shabbat "skipped") were deleting permanently on a single tap with no way back at
 * all. This is the middle ground: the delete happens immediately from the user's
 * perspective (the row disappears), but the actual destructive call is deferred a few
 * seconds, and tapping Undo cancels it before it ever reaches the database.
 *
 * The caller is responsible for hiding `pending` from its own rendered list - this
 * hook only owns the timer, not the list state, so it stays reusable across
 * differently-shaped lists (entries, weights, reconciliation rows).
 */
export function useDeferredDelete<T>(commit: (item: T) => Promise<void>, delayMs = 5000) {
  const [pending, setPending] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<T | null>(null);

  function stage(item: T) {
    // A second delete arriving before the first one's window closes must not silently
    // cancel the first - commit whatever was pending immediately, then start fresh.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      if (pendingRef.current !== null) void commit(pendingRef.current);
    }
    pendingRef.current = item;
    setPending(item);
    timerRef.current = setTimeout(() => {
      pendingRef.current = null;
      timerRef.current = null;
      setPending(null);
      void commit(item);
    }, delayMs);
  }

  function undo() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    setPending(null);
  }

  return { pending, stage, undo };
}
