"use client";

import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/useSession";
import NavPill from "@/components/NavPill";
import SignIn from "@/components/SignIn";
import {
  subscribeToPush, unsubscribeFromPush, isSubscribed, pushSupported,
  type SubscribeResult,
} from "@/lib/push";

/**
 * A few common Israeli cities' Hebcal geonameids, so this isn't a bare numeric field
 * with no way to find the right value. Tel Aviv is the schema default.
 *
 * Modi'in and Hashmonaim aren't in GeoNames' small set of "major city" entries, so they
 * don't turn up through Hebcal's own city search - both IDs here came from Wikidata's
 * GeoNames property (P1566) instead, then confirmed directly against Hebcal's API before
 * being trusted (see chat history 2026-08-09): each returns the expected city name back
 * and a plausible candle-lighting time, not just a 200.
 */
const CITIES = [
  { geonameid: 293397, label: "Tel Aviv" },
  { geonameid: 281184, label: "Jerusalem" },
  { geonameid: 294801, label: "Haifa" },
  { geonameid: 295629, label: "Beer Sheva" },
  { geonameid: 293100, label: "Rehovot" },
  { geonameid: 294751, label: "Herzliya" },
  { geonameid: 295530, label: "Bnei Brak" },
  { geonameid: 6693679, label: "Modi'in" },
  { geonameid: 8199382, label: "Hashmonaim" },
];

/**
 * Settings, scoped to what Phase 2.5 actually needs: WHERE governs every Hebcal
 * candle-lighting/havdalah time (plan 10.2), and the push toggle is what lets the
 * Shabbat prep and reconciliation nudges reach the phone with the app closed.
 * Weight/goal/protein-floor fields live as constants in lib/nutrition.ts for now
 * (plan 4.5's full Settings screen) - not touched here.
 */
export default function SettingsPage() {
  const { userId, loading } = useSession();
  const [geonameid, setGeonameid] = useState(293397);
  const [saved, setSaved] = useState(false);
  const [pushState, setPushState] = useState<"unknown" | "on" | "off">("unknown");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    const db = browserClient();
    db.from("settings").select("geonameid").eq("user_id", userId).maybeSingle()
      .then(({ data: settings }) => { if (settings) setGeonameid(settings.geonameid); });
    (async () => {
      setPushState(pushSupported() && (await isSubscribed()) ? "on" : "off");
    })();
  }, [userId]);

  async function save() {
    if (!userId) return;
    const db = browserClient();
    await db.from("settings").upsert(
      { user_id: userId, geonameid, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function enablePush() {
    if (!userId) return;
    setPushBusy(true);
    setPushError(null);
    const result: SubscribeResult = await subscribeToPush(userId);
    if (result.ok) {
      setPushState("on");
    } else {
      setPushState("off");
      setPushError(
        result.reason === "denied"
          ? "Notification permission was denied - enable it in your browser's site settings to turn this back on."
          : result.reason === "unsupported"
            ? "Push notifications aren't supported in this browser."
            : result.reason === "no-vapid-key"
              ? "Push isn't configured yet (missing VAPID key)."
              : `Couldn't subscribe: ${result.detail ?? "unknown error"}`
      );
    }
    setPushBusy(false);
  }

  async function disablePush() {
    if (!userId) return;
    setPushBusy(true);
    setPushError(null);
    const result = await unsubscribeFromPush(userId);
    if (result.ok) setPushState("off");
    else setPushError(`Couldn't disable: ${result.detail ?? "unknown error"}`);
    setPushBusy(false);
  }

  if (loading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!userId) return <SignIn />;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-safe">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <NavPill href="/" />
      </header>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">Location</h2>
        <p className="text-xs text-neutral-500">
          Drives every candle-lighting and havdalah time. Wrong city, wrong Shabbat
          window, wrong reconciliation nudge - this is the one setting that actually
          matters here.
        </p>
        <select
          value={geonameid}
          onChange={(e) => setGeonameid(Number(e.target.value))}
          className="w-full rounded-2xl border border-ink-line bg-ink-soft p-4"
        >
          {CITIES.map((c) => (
            <option key={c.geonameid} value={c.geonameid}>
              {c.label}
            </option>
          ))}
        </select>
        <button
          onClick={save}
          className="w-full rounded-2xl bg-neutral-100 py-3 font-semibold text-ink"
        >
          {saved ? "Saved" : "Save"}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">
          Shabbat notifications
        </h2>
        <p className="text-xs text-neutral-500">
          Friday prep reminder and Saturday-night reconciliation nudge. Needed because
          neither can reach you while the app is fully closed without this.
        </p>
        <button
          onClick={pushState === "on" ? disablePush : enablePush}
          disabled={pushBusy}
          className={`w-full rounded-2xl py-3 font-semibold disabled:opacity-60 ${
            pushState === "on" ? "bg-ink-line text-neutral-200" : "bg-neutral-100 text-ink"
          }`}
        >
          {pushBusy ? "…" : pushState === "on" ? "Disable notifications" : "Enable notifications"}
        </button>
        {pushError && <p className="text-xs text-red-400">{pushError}</p>}
      </section>
    </div>
  );
}
