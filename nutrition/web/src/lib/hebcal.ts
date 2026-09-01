/**
 * Hebcal zmanim lookup (plan 10.2). Free, no key, no rate limit worth worrying about.
 *
 * Plain `fetch` only - no browser-only APIs - so this runs identically from a client
 * component (immediate display) and from the cron route (server-side, no browser,
 * needs to fire the Friday-prep notification even if the user never opens the app
 * that week). Both paths write into the same `shabbat_plans` row.
 */

const HEBCAL_BASE = "https://www.hebcal.com/shabbat";

export interface Zmanim {
  /** The Friday this window starts on, as YYYY-MM-DD (local). */
  weekStart: string;
  candleLighting: Date | null;
  havdalah: Date | null;
  /**
   * True if this window is a yom tov rather than an ordinary Shabbat, or adjoins one.
   * Per plan 10.5, Hebcal returns yom tov candle/havdalah events through the same
   * `category: 'candles' | 'havdalah'` items, so the same machinery covers chag -
   * this flag exists only so the app can treat these as maintenance weeks (plan 3.3)
   * rather than deficit weeks.
   */
  isYomTov: boolean;
}

interface HebcalItem {
  title: string;
  category: string; // 'candles' | 'havdalah' | 'holiday' | ...
  date: string; // ISO with offset
  yomtov?: boolean;
}

/**
 * Fetch candle-lighting and havdalah for the week containing `friday`.
 *
 * Hebcal's `/shabbat` endpoint takes a specific Gregorian date as three separate
 * numeric fields - `gy`/`gm`/`gd` - not a combined `d=YYYY-MM-DD` string, and there is
 * no `gs` parameter at all. Both were wrong in the original version of this function and
 * it was never caught, because every local test exercised `dueNotification()` against a
 * fixture `Zmanim` object, never a live Hebcal response - confirmed by hand with a direct
 * curl once this was deployed: the bad query returned HTTP 400 ("Gregorian day must be
 * numeric"), silently failing prep/reconcile notifications for every user, every week.
 * Passing `gy`/`gm`/`gd` for the target Friday reliably resolves to that week's
 * Friday/Saturday pair.
 */
export async function fetchZmanim(geonameid: number, friday: string): Promise<Zmanim> {
  const [gy, gm, gd] = friday.split("-").map(Number);
  const url = `${HEBCAL_BASE}?cfg=json&geonameid=${geonameid}&M=on&gy=${gy}&gm=${gm}&gd=${gd}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hebcal API returned ${res.status}`);
  const data = (await res.json()) as { items?: HebcalItem[] };

  const items = data.items ?? [];
  const candlesItem = items.find((i) => i.category === "candles");
  const havdalahItem = items.find((i) => i.category === "havdalah");
  const isYomTov = items.some((i) => i.yomtov === true);

  return {
    weekStart: friday,
    candleLighting: candlesItem ? new Date(candlesItem.date) : null,
    havdalah: havdalahItem ? new Date(havdalahItem.date) : null,
    isYomTov,
  };
}

/** The Friday (YYYY-MM-DD, local) of the week containing `date`. */
export function fridayOf(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const daysToFriday = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + daysToFriday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Whether `now` falls inside the Shabbat/yom-tov window described by `z`.
 *
 * Used to suppress in-app pressure (plan 10.2: "the app must never be a source of
 * pressure during Shabbat"). This governs UI nudges only - real OS notifications are
 * scheduled server-side by the cron job, which is the only thing that can reach the
 * user while the app itself is closed.
 */
export function isWithinShabbat(z: Zmanim, now: Date): boolean {
  if (!z.candleLighting || !z.havdalah) return false;
  return now >= z.candleLighting && now <= z.havdalah;
}
