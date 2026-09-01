import { test } from "node:test";
import assert from "node:assert/strict";
const { dueNotification } = await import("./shabbatSchedule.ts");

// A representative Friday/Saturday: candle lighting 2026-08-07 19:00, havdalah
// 2026-08-08 20:15 local. Times are constructed as plain Date objects (local time in
// whatever timezone the test runner uses) - the logic under test only ever compares
// Dates to Dates, never to a timezone-sensitive string, so this is safe regardless of
// which timezone CI runs in.
const candleLighting = new Date("2026-08-07T19:00:00");
const havdalah = new Date("2026-08-08T20:15:00");

function state(overrides = {}) {
  return {
    candleLighting,
    havdalah,
    reconciledAt: null,
    notifiedPrepAt: null,
    notifiedRecon1At: null,
    notifiedRecon2At: null,
    notifiedRecon3At: null,
    ...overrides,
  };
}

test("no zmanim cached yet -> nothing due", () => {
  assert.equal(
    dueNotification(state({ candleLighting: null, havdalah: null }), new Date()),
    null
  );
});

test("prep fires inside the 3-hour window before candle lighting", () => {
  const now = new Date("2026-08-07T17:00:00"); // 2h before candles
  assert.equal(dueNotification(state(), now), "prep");
});

test("prep does not fire more than 3 hours early", () => {
  const now = new Date("2026-08-07T15:00:00"); // 4h before candles
  assert.equal(dueNotification(state(), now), null);
});

test("prep does not fire after candle lighting", () => {
  const now = new Date("2026-08-07T19:30:00");
  assert.equal(dueNotification(state(), now), null);
});

test("prep does not re-fire once sent", () => {
  const now = new Date("2026-08-07T17:00:00");
  assert.equal(dueNotification(state({ notifiedPrepAt: new Date() }), now), null);
});

test("recon1 fires at havdalah + 30 minutes", () => {
  const now = new Date("2026-08-08T20:46:00"); // havdalah + 31 min
  assert.equal(dueNotification(state(), now), "recon1");
});

test("recon1 does not fire before havdalah + 30 minutes", () => {
  const now = new Date("2026-08-08T20:20:00"); // havdalah + 5 min
  assert.equal(dueNotification(state(), now), null);
});

test("recon2 re-fires at havdalah + 2 hours if still unreconciled", () => {
  const now = new Date("2026-08-08T22:20:00"); // havdalah + ~2h05
  assert.equal(dueNotification(state({ notifiedRecon1At: new Date() }), now), "recon2");
});

test("recon2 does not fire if recon1 already covers this tick", () => {
  const now = new Date("2026-08-08T20:46:00");
  assert.equal(dueNotification(state(), now), "recon1", "recon1 takes priority, not recon2");
});

test("a long cron outage skips stale recon1 and jumps straight to recon2", () => {
  // Cron didn't run for hours; by the time it wakes up we're already past the re-fire
  // point. Sending "just finished Shabbat" at this point would be a stale, confusing nudge.
  const now = new Date("2026-08-08T23:00:00"); // well past havdalah+2h
  assert.equal(dueNotification(state(), now), "recon2");
});

test("recon3 fires at the Sunday 8am fallback if still unreconciled", () => {
  const now = new Date("2026-08-09T08:05:00");
  assert.equal(
    dueNotification(state({ notifiedRecon1At: new Date(), notifiedRecon2At: new Date() }), now),
    "recon3"
  );
});

test("nothing fires once reconciled, even past every threshold", () => {
  const now = new Date("2026-08-09T09:00:00");
  assert.equal(dueNotification(state({ reconciledAt: new Date() }), now), null);
});

test("no double-send: each stage only fires once its own flag is set", () => {
  const now = new Date("2026-08-08T20:46:00");
  assert.equal(dueNotification(state({ notifiedRecon1At: new Date() }), now), null);
});
