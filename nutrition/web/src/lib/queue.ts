/**
 * Offline capture queue (plan 8, Phase 2). Capture must never require connectivity -
 * a snap taken with no signal has to survive until the phone reconnects.
 *
 * IndexedDB, not localStorage: the payload can be a multi-hundred-KB photo Blob, which
 * localStorage cannot hold (5MB string quota, and Blobs aren't strings anyway).
 * IndexedDB stores Blobs natively.
 *
 * Flush is foreground-driven: on mount and on the browser `online` event. A service
 * worker `sync` registration is also wired in sw.js as a best-effort enhancement, but it
 * can only ask an already-open tab to flush via postMessage - a service worker has no
 * Supabase session and cannot complete the upload on its own with the page closed. The
 * honest guarantee is "flushes automatically once you reopen the app with a connection",
 * not "flushes silently in the background with the app fully closed".
 */

import { browserClient } from "./supabase/client";
import type { Mode } from "./prompts";

const DB_NAME = "nutrition-queue";
const STORE = "captures";
const DB_VERSION = 1;

export interface QueuedCapture {
  id: string;
  userId: string;
  mode: Mode;
  /** Photo bytes for image modes; null for voice/text. Already downsampled by image.ts. */
  blob: Blob | null;
  /** Voice transcript / free text for voice mode; null for image modes. */
  text: string | null;
  createdAt: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => T
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function enqueue(item: Omit<QueuedCapture, "id" | "createdAt">): Promise<string> {
  const id = crypto.randomUUID();
  await withStore("readwrite", (store) => {
    store.add({ ...item, id, createdAt: new Date().toISOString() } satisfies QueuedCapture);
  });

  // Best-effort: ask the browser to wake the service worker on reconnect even if this
  // tab has since closed. See sw.js for why this can only ask an open tab to flush
  // rather than complete the upload itself - not every browser supports `sync` at all
  // (notably iOS Safari), so this is deliberately wrapped and silent on failure.
  try {
    const reg = await navigator.serviceWorker?.ready;
    await (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } })
      .sync?.register("flush-queue");
  } catch {
    // No background sync support. The foreground triggers (mount + 'online') still cover it.
  }

  return id;
}

/**
 * Deliberately its own transaction rather than routed through `withStore`, which
 * assumes its callback runs to completion synchronously before `tx.oncomplete` fires.
 * A cursor walk is inherently async across multiple `onsuccess` callbacks, so it needs
 * its own promise wired directly to the cursor rather than to the transaction.
 */
export async function listQueued(): Promise<QueuedCapture[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedCapture[]>((resolve, reject) => {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      const out: QueuedCapture[] = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c) {
          out.push(c.value as QueuedCapture);
          c.continue();
        } else {
          resolve(out);
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  } finally {
    db.close();
  }
}

async function remove(id: string): Promise<void> {
  await withStore("readwrite", (store) => {
    store.delete(id);
  });
}

export async function queueLength(): Promise<number> {
  return (await listQueued()).length;
}

/**
 * Replay every queued capture in order. Each item is removed only after it has been
 * durably written (entry row inserted) - a failure partway through (e.g. estimate call
 * times out) leaves the item queued rather than losing it, since the fire-and-forget
 * /api/estimate call degrades to the same "pending, offer retry" state Capture.tsx
 * already handles for the online path.
 */
export async function flushQueue(onProgress?: (done: number, total: number) => void) {
  const items = await listQueued();
  if (!items.length) return;

  const db = browserClient();
  let done = 0;

  for (const item of items) {
    try {
      let photoPath: string | undefined;

      if (item.blob) {
        photoPath = `${item.userId}/${item.id}.jpg`;
        const { error: upErr } = await db.storage
          .from("photos")
          .upload(photoPath, item.blob, { contentType: "image/jpeg" });
        if (upErr) throw new Error(`Queued upload failed: ${upErr.message}`);
      }

      const { data: entry, error: insErr } = await db
        .from("entries")
        .insert({
          user_id: item.userId,
          source: item.mode === "voice" ? "voice" : item.mode === "food" ? "photo" : item.mode,
          mode: item.mode,
          photo_path: photoPath ?? null,
          raw_input: item.text,
          status: "pending",
          // The entry is logged now, not backdated to when it was captured offline -
          // matching plan 4.1's "snap, walk away" contract even when the snap happened
          // out of signal. Shabbat backdating is handled separately (plan 10.2).
        })
        .select("id")
        .single();

      if (insErr || !entry) throw new Error(`Queued insert failed: ${insErr?.message}`);

      fetch("/api/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryId: entry.id,
          userId: item.userId,
          mode: item.mode,
          photoPath,
          text: item.text,
        }),
      }).catch(() => {
        /* row stays pending; Today list offers retry, same as the online path */
      });

      await remove(item.id);
      done++;
      onProgress?.(done, items.length);
    } catch {
      // Stop at the first failure rather than reordering: if connectivity dropped again
      // mid-flush, the remaining items are still queued and will retry as a batch next time.
      break;
    }
  }
}
