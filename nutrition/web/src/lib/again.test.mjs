import { test } from "node:test";
import assert from "node:assert/strict";
const { rankFrequent, detectCombos, comboLabel, detectFrequentUnlinkedDishes } =
  await import("./again.ts");

function entry(overrides) {
  return {
    id: crypto.randomUUID(),
    user_id: "u1",
    logged_at: "2026-08-01T08:00:00Z",
    created_at: "2026-08-01T08:00:00Z",
    source: "photo",
    mode: "food",
    photo_path: null,
    raw_input: null,
    status: "estimated",
    product_id: null,
    portion_multiplier: 1,
    meal_slot: null,
    shabbat_plan_id: null,
    reconciled_at: null,
    ai_model: null,
    ai_raw: null,
    confidence: "high",
    low_confidence: false,
    name: "item",
    calories: 100,
    calories_low: null,
    calories_high: null,
    protein_g: 5,
    carbs_g: 5,
    fat_g: 5,
    fiber_g: 0,
    user_corrected: false,
    ...overrides,
  };
}

test("rankFrequent orders by times_logged desc", () => {
  const products = [
    { id: "a", times_logged: 3, last_logged_at: "2026-08-01" },
    { id: "b", times_logged: 10, last_logged_at: "2026-08-01" },
    { id: "c", times_logged: 5, last_logged_at: "2026-08-01" },
  ];
  const ranked = rankFrequent(products);
  assert.deepEqual(ranked.map((p) => p.id), ["b", "c", "a"]);
});

test("rankFrequent breaks ties by recency", () => {
  const products = [
    { id: "old", times_logged: 5, last_logged_at: "2026-07-01" },
    { id: "new", times_logged: 5, last_logged_at: "2026-08-01" },
  ];
  const ranked = rankFrequent(products);
  assert.deepEqual(ranked.map((p) => p.id), ["new", "old"]);
});

test("rankFrequent respects the limit", () => {
  const products = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    times_logged: i,
    last_logged_at: "2026-08-01",
  }));
  assert.equal(rankFrequent(products, 24).length, 24);
});

test("detectCombos finds a pair logged together 3+ times within a session", () => {
  const entries = [];
  for (let day = 1; day <= 4; day++) {
    const ts = `2026-08-0${day}T08:00:00Z`;
    entries.push(entry({ logged_at: ts, product_id: "eggs" }));
    entries.push(entry({
      logged_at: `2026-08-0${day}T08:05:00Z`,
      product_id: "toast",
    }));
  }
  const combos = detectCombos(entries);
  assert.equal(combos.length, 1);
  assert.deepEqual(combos[0].productIds, ["eggs", "toast"]);
  assert.equal(combos[0].occurrences, 4);
});

test("detectCombos requires at least 3 occurrences", () => {
  const entries = [
    entry({ logged_at: "2026-08-01T08:00:00Z", product_id: "eggs" }),
    entry({ logged_at: "2026-08-01T08:05:00Z", product_id: "toast" }),
    entry({ logged_at: "2026-08-02T08:00:00Z", product_id: "eggs" }),
    entry({ logged_at: "2026-08-02T08:05:00Z", product_id: "toast" }),
  ];
  assert.equal(detectCombos(entries).length, 0);
});

test("detectCombos splits sessions more than 45 minutes apart", () => {
  const entries = [
    entry({ logged_at: "2026-08-01T08:00:00Z", product_id: "eggs" }),
    // 60 minutes later - not the same sitting, so this alone is not a pair.
    entry({ logged_at: "2026-08-01T09:00:00Z", product_id: "toast" }),
  ];
  assert.equal(detectCombos(entries).length, 0);
});

test("detectCombos is order-independent within a session", () => {
  const entries = [];
  for (let day = 1; day <= 3; day++) {
    // Alternate the logging order across days.
    const first = day % 2 === 0 ? "eggs" : "toast";
    const second = day % 2 === 0 ? "toast" : "eggs";
    entries.push(entry({ logged_at: `2026-08-0${day}T08:00:00Z`, product_id: first }));
    entries.push(entry({ logged_at: `2026-08-0${day}T08:05:00Z`, product_id: second }));
  }
  const combos = detectCombos(entries);
  assert.equal(combos.length, 1, "one combo, regardless of logging order");
});

test("detectCombos ignores entries without a product_id", () => {
  const entries = [
    entry({ logged_at: "2026-08-01T08:00:00Z", product_id: null }),
    entry({ logged_at: "2026-08-01T08:05:00Z", product_id: null }),
    entry({ logged_at: "2026-08-02T08:00:00Z", product_id: null }),
  ];
  assert.equal(detectCombos(entries).length, 0);
});

test("detectCombos collapses a repeated product within one session to a single id", () => {
  // Two eggs logged separately at the same sitting, plus toast - should key as
  // {eggs, toast}, not require a THIRD distinct item.
  const entries = [];
  for (let day = 1; day <= 3; day++) {
    entries.push(entry({ logged_at: `2026-08-0${day}T08:00:00Z`, product_id: "eggs" }));
    entries.push(entry({ logged_at: `2026-08-0${day}T08:02:00Z`, product_id: "eggs" }));
    entries.push(entry({ logged_at: `2026-08-0${day}T08:05:00Z`, product_id: "toast" }));
  }
  const combos = detectCombos(entries);
  assert.equal(combos.length, 1);
  assert.deepEqual(combos[0].productIds, ["eggs", "toast"]);
});

test("comboLabel joins names with a plus sign", () => {
  assert.equal(comboLabel(["Eggs", "Toast", "Coffee"]), "Eggs + Toast + Coffee");
});

test("detectFrequentUnlinkedDishes promotes a dish logged more than 3 times", () => {
  const entries = [1, 2, 3, 4].map((n) =>
    entry({ name: "Chicken and rice", calories: 500, mode: "food", logged_at: `2026-08-0${n}T08:00:00Z` })
  );
  const dishes = detectFrequentUnlinkedDishes(entries);
  assert.equal(dishes.length, 1);
  assert.equal(dishes[0].name, "Chicken and rice");
  assert.equal(dishes[0].count, 4);
});

test("detectFrequentUnlinkedDishes does not promote at exactly 3 occurrences", () => {
  const entries = [1, 2, 3].map((n) =>
    entry({ name: "Chicken and rice", calories: 500, logged_at: `2026-08-0${n}T08:00:00Z` })
  );
  assert.equal(detectFrequentUnlinkedDishes(entries).length, 0, "'more than 3' means 4+, not 3");
});

test("detectFrequentUnlinkedDishes averages macros across occurrences", () => {
  const entries = [
    entry({ name: "Oatmeal", calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5, fiber_g: 6 }),
    entry({ name: "Oatmeal", calories: 340, protein_g: 12, carbs_g: 55, fat_g: 6, fiber_g: 7 }),
    entry({ name: "Oatmeal", calories: 320, protein_g: 11, carbs_g: 52, fat_g: 5, fiber_g: 6 }),
    entry({ name: "Oatmeal", calories: 360, protein_g: 13, carbs_g: 58, fat_g: 7, fiber_g: 8 }),
  ];
  const [dish] = detectFrequentUnlinkedDishes(entries);
  // (300+340+320+360)/4 = 330
  assert.equal(dish.avg.calories, 330);
});

test("detectFrequentUnlinkedDishes ignores entries that already have a product_id", () => {
  const entries = [1, 2, 3, 4].map((n) =>
    entry({ name: "Chicken and rice", calories: 500, product_id: "p1", logged_at: `2026-08-0${n}T08:00:00Z` })
  );
  assert.equal(detectFrequentUnlinkedDishes(entries).length, 0);
});

test("detectFrequentUnlinkedDishes ignores label and recipe modes (they already link to a product)", () => {
  const entries = [1, 2, 3, 4].map((n) =>
    entry({ name: "Something", calories: 500, mode: "label", logged_at: `2026-08-0${n}T08:00:00Z` })
  );
  assert.equal(detectFrequentUnlinkedDishes(entries).length, 0);
});

test("detectFrequentUnlinkedDishes ignores pending and failed entries", () => {
  const entries = [
    entry({ name: "X", calories: 500, status: "pending" }),
    entry({ name: "X", calories: 500, status: "failed" }),
    entry({ name: "X", calories: 500, status: "estimated" }),
    entry({ name: "X", calories: 500, status: "estimated" }),
  ];
  assert.equal(detectFrequentUnlinkedDishes(entries).length, 0, "only 2 real occurrences, not 4");
});

test("detectFrequentUnlinkedDishes is case- and whitespace-insensitive when grouping", () => {
  const entries = [
    entry({ name: "Chicken and Rice", calories: 500 }),
    entry({ name: "chicken and rice", calories: 500 }),
    entry({ name: "  Chicken and rice  ", calories: 500 }),
    entry({ name: "Chicken and rice", calories: 500 }),
  ];
  const dishes = detectFrequentUnlinkedDishes(entries);
  assert.equal(dishes.length, 1);
  assert.equal(dishes[0].count, 4);
});

test("detectFrequentUnlinkedDishes returns the entry ids for backfilling product_id later", () => {
  const entries = [1, 2, 3, 4].map((n) =>
    entry({ name: "Toast", calories: 200, logged_at: `2026-08-0${n}T08:00:00Z` })
  );
  const [dish] = detectFrequentUnlinkedDishes(entries);
  assert.equal(dish.entryIds.length, 4);
  assert.deepEqual([...dish.entryIds].sort(), [...entries.map((e) => e.id)].sort());
});
