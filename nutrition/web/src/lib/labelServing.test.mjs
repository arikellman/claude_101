import { test } from "node:test";
import assert from "node:assert/strict";
const { suggestLabelServing } = await import("./labelServing.ts");

test("single serve via servings_per_package === 1 defaults to the whole container", () => {
  // A yogurt cup: 100 kcal/100g basis, one 150g cup, package IS the serving.
  const r = suggestLabelServing({ serving_grams: 150, servings_per_package: 1, net_weight_grams: 150 });
  assert.equal(r.isWholeContainer, true);
  assert.equal(r.defaultGrams, 150);
  assert.equal(r.containerGrams, 150);
});

test("single serve inferred from serving ~= net weight, even with no servings_per_package", () => {
  const r = suggestLabelServing({ serving_grams: 148, servings_per_package: 0, net_weight_grams: 150 });
  assert.equal(r.isWholeContainer, true);
  assert.equal(r.defaultGrams, 148);
});

test("multi-serving 500g bag with a declared 100g serving asks in 100g units, not the whole bag", () => {
  const r = suggestLabelServing({ serving_grams: 100, servings_per_package: 5, net_weight_grams: 500 });
  assert.equal(r.isWholeContainer, false);
  assert.equal(r.unitGrams, 100);
  assert.equal(r.defaultGrams, 100, "defaults to one serving, not the whole 500g");
  assert.equal(r.containerGrams, 500, "whole-container option still offered");
});

test("multi-serving derives container weight from serving x count when net weight wasn't read", () => {
  const r = suggestLabelServing({ serving_grams: 100, servings_per_package: 5, net_weight_grams: 0 });
  assert.equal(r.containerGrams, 500);
});

test("net weight takes precedence over the derived figure when both are present", () => {
  // Rounding on the label itself - net weight printed as 480g even though 5x100g=500.
  const r = suggestLabelServing({ serving_grams: 100, servings_per_package: 5, net_weight_grams: 480 });
  assert.equal(r.containerGrams, 480);
});

test("nothing about package size stated falls back to the per-100g basis, not a guess at single-serve", () => {
  const r = suggestLabelServing({ serving_grams: 0, servings_per_package: 0, net_weight_grams: 0 });
  assert.equal(r.isWholeContainer, false);
  assert.equal(r.unitGrams, 100);
  assert.equal(r.defaultGrams, 100);
  assert.equal(r.containerGrams, null);
});

test("only net weight known, no declared serving - not treated as single-serve just because it's small", () => {
  // A 250g bag of chips with no serving column read - defaulting to 'eat the whole
  // bag' would be a much worse guess than the neutral 100g-basis default.
  const r = suggestLabelServing({ serving_grams: 0, servings_per_package: 0, net_weight_grams: 250 });
  assert.equal(r.isWholeContainer, false);
  assert.equal(r.defaultGrams, 100);
  assert.equal(r.containerGrams, 250, "still offered as an option, just not the default");
});

test("servings_per_package of exactly 1 wins even if net weight is missing", () => {
  const r = suggestLabelServing({ serving_grams: 200, servings_per_package: 1, net_weight_grams: 0 });
  assert.equal(r.isWholeContainer, true);
  assert.equal(r.defaultGrams, 200);
});
