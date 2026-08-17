import { test } from "node:test";
import assert from "node:assert/strict";
const { decodeBandDataDay } = await import("./zepp.ts");

function fakeDay(dateTime, summary) {
  return { date_time: dateTime, summary: Buffer.from(JSON.stringify(summary)).toString("base64") };
}

test("decodes steps, calories, sleep, and resting HR from a normal day", () => {
  const day = fakeDay("2026-07-19", {
    stp: { ttl: 6939, cal: 415 },
    slp: { lt: 229, dp: 84, rhr: 62 },
  });
  const r = decodeBandDataDay(day);
  assert.equal(r.date, "2026-07-19");
  assert.equal(r.steps, 6939);
  assert.equal(r.activeCalories, 415);
  assert.equal(r.sleepMinutes, 313);
  assert.equal(r.deepSleepMinutes, 84);
  assert.equal(r.restingHr, 62);
});

test("a day with no sleep recorded (e.g. Shabbat) reports restingHr null, not 0", () => {
  const day = fakeDay("2026-07-25", {
    stp: { ttl: 0, cal: 0 },
    slp: { lt: 0, dp: 0, rhr: 0 },
  });
  const r = decodeBandDataDay(day);
  assert.equal(r.sleepMinutes, 0);
  assert.equal(r.restingHr, null, "0 bpm is not a real reading - must be reported as absent");
});

test("missing stp/slp keys entirely default to zero/null rather than throwing", () => {
  const r = decodeBandDataDay(fakeDay("2026-01-01", {}));
  assert.equal(r.steps, 0);
  assert.equal(r.activeCalories, 0);
  assert.equal(r.sleepMinutes, 0);
  assert.equal(r.restingHr, null);
});
