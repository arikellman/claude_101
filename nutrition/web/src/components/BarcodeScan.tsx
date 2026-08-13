"use client";

import { useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { lookupBarcode } from "@/lib/openfoodfacts";

// Structural type for BarcodeDetector - not yet in TypeScript's DOM lib as of the
// version this project pins (tsconfig lib: ES2022 + dom, no experimental additions).
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

/**
 * Live barcode scanner (plan 5.1, Path A - the highest-accuracy path, tried first).
 *
 * This is the one capture mode that genuinely needs a live camera feed rather than the
 * native-camera-app file input the rest of Capture.tsx uses: a barcode has to be found
 * across a moving frame, which a single still photo from the OS camera app can't do.
 * Everything else in this app deliberately avoids getUserMedia for speed and reliability
 * (plan 4.1) - this component is the documented exception.
 *
 * On a hit: looks up Open Food Facts and, if found, logs directly with zero AI cost or
 * latency - this data is already exact. On a miss (expected often for Israeli products,
 * per plan 5.1) or on browsers without BarcodeDetector (Safari), falls through to Label
 * mode with a prompt to photograph the panel instead.
 */
export default function BarcodeScan({
  userId,
  onLogged,
  onFallbackToLabel,
}: {
  userId: string;
  onLogged: () => void;
  onFallbackToLabel: (reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"starting" | "scanning" | "checking" | "unsupported">(
    "starting"
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
      .BarcodeDetector;
    if (!Detector) {
      setStatus("unsupported");
      onFallbackToLabel("Barcode scanning isn't supported in this browser.");
      return;
    }

    const detector = new Detector({
      formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
    });

    let stream: MediaStream | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    async function run() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus("scanning");

        interval = setInterval(async () => {
          if (!videoRef.current || stopped) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes.length > 0) {
              await handleHit(codes[0].rawValue);
            }
          } catch {
            // Transient decode errors on a bad frame are routine - just try the next frame.
          }
        }, 350);
      } catch {
        setError("Camera access denied. Allow camera access, or use Label instead.");
        onFallbackToLabel("Camera access was denied.");
      }
    }

    async function handleHit(barcode: string) {
      if (stopped) return;
      stopped = true;
      if (interval) clearInterval(interval);
      stream?.getTracks().forEach((t) => t.stop());
      setStatus("checking");

      try {
        const db = browserClient();

        // Cache hit: this barcode has been scanned before by this user.
        const { data: cached } = await db
          .from("products")
          .select("*")
          .eq("barcode", barcode)
          .or(`user_id.eq.${userId},user_id.is.null`)
          .maybeSingle();

        const product = cached ?? (await fetchAndCache(db, barcode));

        if (!product) {
          onFallbackToLabel(
            `Barcode ${barcode} isn't in Open Food Facts - point at the nutrition label instead.`
          );
          return;
        }

        await logProduct(db, product);
        onLogged();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        stopped = false;
        setStatus("scanning");
      }
    }

    async function fetchAndCache(
      db: ReturnType<typeof browserClient>,
      barcode: string
    ): Promise<{ id: string; per_100g: object; serving_grams: number | null; name: string } | null> {
      const off = await lookupBarcode(barcode);
      if (!off) return null;

      const { data, error } = await db
        .from("products")
        .insert({
          user_id: userId,
          barcode,
          name: off.name,
          brand: off.brand,
          per_100g: off.per100g,
          source: "openfoodfacts",
        })
        .select("id, per_100g, serving_grams, name")
        .single();

      if (error) throw new Error(`Caching product failed: ${error.message}`);
      return data;
    }

    async function logProduct(
      db: ReturnType<typeof browserClient>,
      product: { id: string; per_100g: object; serving_grams: number | null; name: string }
    ) {
      // Default portion: the label's declared serving if known, else a flat 100g. Either
      // way this is a starting point the user corrects with the same portion chips used
      // everywhere else in the app (plan 4.2) - not a new interaction to learn.
      const grams = product.serving_grams || 100;
      const per100g = product.per_100g as Record<string, number>;
      const scale = grams / 100;

      await db.from("entries").insert({
        user_id: userId,
        source: "barcode",
        mode: null, // no AI call was made - there's nothing to re-baseline here
        product_id: product.id,
        status: "estimated", // exact data, not an estimate - no analysing spinner needed
        confidence: "high",
        name: product.name,
        calories: Math.round((per100g.calories ?? 0) * scale),
        protein_g: Math.round((per100g.protein_g ?? 0) * scale),
        carbs_g: Math.round((per100g.carbs_g ?? 0) * scale),
        fat_g: Math.round((per100g.fat_g ?? 0) * scale),
        fiber_g: Math.round((per100g.fiber_g ?? 0) * scale),
      });

      await db
        .from("products")
        .update({ times_logged: 1, last_logged_at: new Date().toISOString() })
        .eq("id", product.id);
    }

    void run();
    return () => {
      stopped = true;
      if (interval) clearInterval(interval);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (status === "unsupported") return null; // parent already switched to Label

  return (
    <div className="space-y-3">
      <div className="relative aspect-square w-full overflow-hidden rounded-3xl bg-black">
        <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
        {status !== "scanning" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-neutral-300">
            {status === "starting" ? "Starting camera…" : "Checking product…"}
          </div>
        )}
      </div>
      <p className="text-center text-xs text-neutral-500">
        Hold steady over the barcode. Falls back to Label automatically if it isn&apos;t
        in the database.
      </p>
      {error && (
        <p className="rounded-xl bg-red-950/60 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
