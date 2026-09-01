"use client";

import { useEffect, useRef, useState } from "react";
import { prepareImage } from "@/lib/image";
import { browserClient } from "@/lib/supabase/client";
import { enqueue, flushQueue, queueLength } from "@/lib/queue";
import { startVoiceRecognition, voiceRecognitionSupported, type VoiceSession } from "@/lib/speech";
import BarcodeScan from "./BarcodeScan";
import type { Mode } from "@/lib/prompts";

type CaptureMode = Mode | "barcode";

const MODES: { id: CaptureMode; label: string }[] = [
  { id: "food", label: "Food" },
  { id: "label", label: "Label" },
  { id: "recipe", label: "Recipe" },
  { id: "voice", label: "Voice" },
  { id: "barcode", label: "Barcode" },
];

/**
 * Camera-first capture. The design contract (plan 4.1): snap, see the entry appear
 * within ~200ms, lock the phone and walk away. Nothing blocks on the AI call.
 *
 * The two-taps promise is why food/label/recipe use a hidden file input with
 * `capture="environment"` rather than a getUserMedia viewfinder: it opens the native
 * camera, which is faster, handles focus and exposure properly, and needs no permission
 * dance. Barcode mode is the one exception - see BarcodeScan.tsx for why.
 */
export default function Capture({ userId, onLogged }: { userId: string; onLogged: () => void }) {
  const [mode, setMode] = useState<CaptureMode>("food");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [voiceText, setVoiceText] = useState("");
  const [listening, setListening] = useState(false);
  const voiceSession = useRef<VoiceSession | null>(null);

  const [queued, setQueued] = useState(0);

  // ---------------------------------------------------------------------
  // Offline queue: flush on mount and whenever connectivity returns (plan 8, Phase 2).
  // ---------------------------------------------------------------------
  useEffect(() => {
    void refreshQueueCount();
    void tryFlush();

    window.addEventListener("online", tryFlush);
    // The service worker asks an open tab to flush when its best-effort background
    // sync registration fires - see sw.js. This is the tab-side half of that handshake.
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    return () => {
      window.removeEventListener("online", tryFlush);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSwMessage(e: MessageEvent) {
    if (e.data?.type === "flush-queue") void tryFlush();
  }

  async function refreshQueueCount() {
    setQueued(await queueLength());
  }

  async function tryFlush() {
    if (!navigator.onLine) return;
    await flushQueue();
    await refreshQueueCount();
    onLogged();
  }

  async function submit(file: File | Blob | null, text?: string) {
    setError(null);
    setNotice(null);
    setBusy(true);

    const captureMode = mode as Mode; // barcode never reaches here - it has its own component

    try {
      // Offline: never even attempt the network round trip. Queue immediately so the
      // capture is durable the instant the shutter is tapped, out of signal or not.
      if (!navigator.onLine) {
        await enqueue({ userId, mode: captureMode, blob: file, text: text ?? null });
        await refreshQueueCount();
        setNotice("No connection - queued. Will send automatically when you're back online.");
        setVoiceText("");
        return;
      }

      const db = browserClient();
      let photoPath: string | undefined;

      if (file) {
        const prepared = await prepareImage(file);
        // Path is prefixed with the user id so the storage RLS policy can scope by folder.
        photoPath = `${userId}/${crypto.randomUUID()}.jpg`;
        const { error: upErr } = await db.storage
          .from("photos")
          .upload(photoPath, prepared.blob, { contentType: "image/jpeg" });
        URL.revokeObjectURL(prepared.previewUrl);
        if (upErr) throw new Error(`Upload failed: ${upErr.message}`);
      }

      // Create the pending row FIRST. This is what makes the log feel instant: Realtime
      // pushes it to the Today list immediately, long before the estimate exists.
      const { data: entry, error: insErr } = await db
        .from("entries")
        .insert({
          user_id: userId,
          source: captureMode === "voice" ? "voice" : captureMode === "food" ? "photo" : captureMode,
          mode: captureMode,
          photo_path: photoPath ?? null,
          raw_input: text ?? null,
          status: "pending",
        })
        .select("id")
        .single();

      if (insErr || !entry) throw new Error(`Could not create entry: ${insErr?.message}`);

      onLogged();
      setVoiceText("");

      // Fire and forget. Deliberately NOT awaited for the UI's benefit - the entry already
      // exists, so a slow or failed estimate degrades to a retry, never to a lost log.
      fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId: entry.id, userId, mode: captureMode, photoPath, text }),
        keepalive: true, // survives the page being backgrounded
      }).catch(() => {
        // The row stays `pending`; the Today list offers a retry.
      });
    } catch (e) {
      // A network-shaped failure (fetch threw, not a validation error from Supabase)
      // gets the same queue treatment as being offline outright - `navigator.onLine`
      // can read true on a flaky connection that then fails the actual request.
      const message = e instanceof Error ? e.message : String(e);
      if (isNetworkError(e)) {
        await enqueue({ userId, mode: captureMode, blob: file, text: text ?? null });
        await refreshQueueCount();
        setNotice("Connection dropped - queued. Will send automatically when it's back.");
        setVoiceText("");
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // ---------------------------------------------------------------------
  // Voice: Web Speech API dictation feeding the same textarea a typed answer would
  // (plan 5.5). Typing remains fully available - this only adds a faster path to it.
  // ---------------------------------------------------------------------
  function toggleListening() {
    if (listening) {
      voiceSession.current?.stop();
      return;
    }
    setError(null);
    const session = startVoiceRecognition(
      (transcript) => setVoiceText(transcript),
      () => setListening(false),
      (message) => {
        setError(message);
        setListening(false);
      }
    );
    if (session) {
      voiceSession.current = session;
      setListening(true);
    }
  }

  return (
    <div className="space-y-4">
      {/* flex-shrink-0 + a fixed min-width, not flex-1: with 5 modes, flex-1 let the
          chips compress to fit the row instead of actually scrolling on a narrow phone,
          even though overflow-x-auto was already there to allow it. */}
      <div className="flex gap-2 overflow-x-auto">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`min-h-11 min-w-20 flex-shrink-0 rounded-full px-3 text-sm transition-colors ${
              mode === m.id
                ? "bg-neutral-100 font-semibold text-ink"
                : "bg-ink-soft text-neutral-400"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "barcode" ? (
        <BarcodeScan
          userId={userId}
          onLogged={() => {
            onLogged();
            setMode("food");
          }}
          onFallbackToLabel={(reason) => {
            setNotice(reason);
            setMode("label");
          }}
        />
      ) : mode === "voice" ? (
        <div className="space-y-3">
          <div className="relative">
            <textarea
              value={voiceText}
              onChange={(e) => setVoiceText(e.target.value)}
              placeholder="two eggs, two slices of whole wheat toast with butter, black coffee"
              rows={3}
              className="w-full rounded-2xl border border-ink-line bg-ink-soft p-4 pr-14 text-base
                         placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
            {voiceRecognitionSupported() && (
              <button
                onClick={toggleListening}
                title={listening ? "Stop listening" : "Dictate"}
                className={`absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center
                           rounded-full text-lg ${
                             listening
                               ? "bg-red-500 text-white animate-pulse"
                               : "bg-ink-line text-neutral-300"
                           }`}
              >
                🎤
              </button>
            )}
          </div>
          <button
            disabled={busy || !voiceText.trim()}
            onClick={() => submit(null, voiceText)}
            className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold
                       text-ink disabled:opacity-40"
          >
            {busy ? "Logging…" : "Log it"}
          </button>
          <p className="text-center text-xs text-neutral-500">
            {listening
              ? "Listening… tap the mic again to stop."
              : "Often faster than a photo for familiar food, and it captures what a photo can't — cooking method, hidden oil, “half of it”."}
          </p>
        </div>
      ) : (
        <>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) submit(f);
            }}
          />
          <button
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="flex aspect-square w-full flex-col items-center justify-center gap-3
                       rounded-3xl border-2 border-dashed border-ink-line bg-ink-soft
                       text-neutral-400 disabled:opacity-40"
          >
            <span className="text-6xl leading-none">{busy ? "…" : "◉"}</span>
            <span className="text-sm">
              {busy ? "Uploading…" : mode === "food" ? "Snap your plate" : `Snap the ${mode}`}
            </span>
          </button>
          {mode === "food" && (
            <p className="text-center text-xs text-neutral-500">
              Include a fork or your hand for scale. Consistent framing matters more than
              a perfect photo.
            </p>
          )}
        </>
      )}

      {queued > 0 && (
        <p className="rounded-xl bg-ink-soft p-3 text-center text-xs text-neutral-400">
          {queued} log{queued === 1 ? "" : "s"} queued — will send automatically when online.
        </p>
      )}
      {notice && (
        <p className="rounded-xl bg-ink-soft p-3 text-sm text-neutral-300" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** True for the kinds of failure connectivity actually causes: fetch's generic TypeError,
 *  and the specific message Supabase's client throws when the request never left the
 *  device. Anything else (a 4xx validation error, an RLS denial) is a real bug and should
 *  surface, not silently queue and hide it. */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /network|fetch failed|Failed to fetch/i.test(message);
}
