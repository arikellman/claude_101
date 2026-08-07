"use client";

import { useRef, useState } from "react";
import { prepareImage } from "@/lib/image";
import { browserClient } from "@/lib/supabase/client";
import type { Mode } from "@/lib/prompts";

const MODES: { id: Mode; label: string }[] = [
  { id: "food", label: "Food" },
  { id: "label", label: "Label" },
  { id: "recipe", label: "Recipe" },
  { id: "voice", label: "Voice" },
];

/**
 * Camera-first capture. The design contract (plan 4.1): snap, see the entry appear
 * within ~200ms, lock the phone and walk away. Nothing blocks on the AI call.
 *
 * The two-taps promise is why this uses a hidden file input with `capture="environment"`
 * rather than a getUserMedia viewfinder: it opens the native camera, which is faster,
 * handles focus and exposure properly, and needs no permission dance.
 */
export default function Capture({ userId, onLogged }: { userId: string; onLogged: () => void }) {
  const [mode, setMode] = useState<Mode>("food");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [voiceText, setVoiceText] = useState("");

  async function submit(file: File | Blob | null, text?: string) {
    setError(null);
    setBusy(true);
    const db = browserClient();

    try {
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
          source: mode === "voice" ? "voice" : mode === "food" ? "photo" : mode,
          mode,
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
        body: JSON.stringify({ entryId: entry.id, userId, mode, photoPath, text }),
        keepalive: true, // survives the page being backgrounded
      }).catch(() => {
        // The row stays `pending`; the Today list offers a retry.
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`flex-1 rounded-full px-3 py-2 text-sm transition-colors ${
              mode === m.id
                ? "bg-neutral-100 font-semibold text-ink"
                : "bg-ink-soft text-neutral-400"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "voice" ? (
        <div className="space-y-3">
          <textarea
            value={voiceText}
            onChange={(e) => setVoiceText(e.target.value)}
            placeholder="two eggs, two slices of whole wheat toast with butter, black coffee"
            rows={3}
            className="w-full rounded-2xl border border-ink-line bg-ink-soft p-4 text-base
                       placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <button
            disabled={busy || !voiceText.trim()}
            onClick={() => submit(null, voiceText)}
            className="w-full rounded-2xl bg-neutral-100 py-4 text-lg font-semibold
                       text-ink disabled:opacity-40"
          >
            {busy ? "Logging…" : "Log it"}
          </button>
          <p className="text-center text-xs text-neutral-500">
            Often faster than a photo for familiar food, and it captures what a photo
            can&apos;t — cooking method, hidden oil, &ldquo;half of it&rdquo;.
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

      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
