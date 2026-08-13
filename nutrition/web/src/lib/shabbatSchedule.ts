/**
 * Pure scheduling logic for the four Shabbat notifications (plan 10.2):
 *   - Prep: ~3 hours before candle lighting
 *   - Reconciliation: havdalah + 30 minutes
 *   - Re-fire: havdalah + 2 hours, if still unreconciled
 *   - Fallback: Sunday 8am, tied to the weigh-in reminder
 *
 * Kept separate from the cron route (which does the actual sending and DB I/O) so the
 * "should this fire right now" decision is unit-testable without mocking web-push,
 * Supabase, or the clock via a live cron invocation.
 */

export const PREP_LEAD_HOURS = 3;
export const RECONCILE_DELAY_MIN = 30;
export const RECONCILE_REFIRE_HOURS = 2;

export interface NotificationState {
  candleLighting: Date | null;
  havdalah: Date | null;
  reconciledAt: Date | null;
  notifiedPrepAt: Date | null;
  notifiedRecon1At: Date | null;
  notifiedRecon2At: Date | null;
  notifiedRecon3At: Date | null;
}

export type DueNotification = "prep" | "recon1" | "recon2" | "recon3";

/**
 * Which (if any) notification is due right now, given the current state and `now`.
 * Returns at most one - the cron job runs frequently enough (every 15 min) that two
 * conditions becoming true in the same tick would be unusual, and sending the earliest
 * one and letting the next tick catch the other is simpler and safer than sending both.
 */
export function dueNotification(s: NotificationState, now: Date): DueNotification | null {
  if (!s.candleLighting || !s.havdalah) return null;

  const prepStart = new Date(s.candleLighting.getTime() - PREP_LEAD_HOURS * 3_600_000);
  if (!s.notifiedPrepAt && now >= prepStart && now < s.candleLighting) {
    return "prep";
  }

  // Everything past here is about reconciliation, which stops mattering once it's done.
  if (s.reconciledAt) return null;

  const recon1At = new Date(s.havdalah.getTime() + RECONCILE_DELAY_MIN * 60_000);
  const recon2At = new Date(s.havdalah.getTime() + RECONCILE_REFIRE_HOURS * 3_600_000);
  const recon3At = sundayEightAmAfter(s.havdalah);

  if (!s.notifiedRecon1At && now >= recon1At) {
    // Only the *first* reconciliation nudge is time-boxed to before the re-fire point -
    // if the cron job was down for a stretch and now >= recon2At too, jump straight to
    // recon2 rather than sending a stale "just finished Shabbat" nudge hours late.
    if (now < recon2At) return "recon1";
  }
  if (!s.notifiedRecon2At && now >= recon2At && now < recon3At) {
    return "recon2";
  }
  if (!s.notifiedRecon3At && now >= recon3At) {
    return "recon3";
  }

  return null;
}

/** The Sunday 8am immediately following `havdalah`. */
function sundayEightAmAfter(havdalah: Date): Date {
  const d = new Date(havdalah);
  const daysToSunday = (7 - d.getDay()) % 7 || 7; // havdalah is always Saturday (day 6) -> +1
  d.setDate(d.getDate() + daysToSunday);
  d.setHours(8, 0, 0, 0);
  return d;
}

export interface NotificationCopy {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export function copyFor(which: DueNotification): NotificationCopy {
  switch (which) {
    case "prep":
      return {
        title: "Shabbat Prep",
        body: "Build tonight's menu now, while you can still use your phone.",
        url: "/shabbat/prep",
        tag: "shabbat-prep",
      };
    case "recon1":
    case "recon2":
      return {
        title: "Shabbat wrap-up",
        body: "Confirm what you actually ate — most of it defaults to the plan, one tap.",
        url: "/shabbat/reconcile",
        tag: "shabbat-reconcile",
      };
    case "recon3":
      return {
        title: "Still open from Shabbat",
        body: "Quick reconciliation before today's log starts fresh.",
        url: "/shabbat/reconcile",
        tag: "shabbat-reconcile",
      };
  }
}
