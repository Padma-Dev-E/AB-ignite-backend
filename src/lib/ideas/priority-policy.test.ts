import assert from "node:assert/strict";
import test from "node:test";
import { defaultPriorityPolicy, resolvePriorityPolicy, scorePriority } from "./priority-policy";

test("default policy preserves the published 30/30/40 score and thresholds", () => {
  const result = scorePriority({ turnaround: 3, volume: 2, value: 1 }, resolvePriorityPolicy({}));
  assert.equal(result.score, 1.9);
  assert.equal(result.band, "Quality");
  assert.deepEqual(result.breakdown.map((item) => item.contribution), [0.9, 0.6, 0.4]);
});

test("persisted KPI questions, hints, weights and bands change the actual score", () => {
  const kpis = defaultPriorityPolicy.kpis.map((item) => ({ ...item, question: `${item.key} policy question`, hint: `${item.key} policy hint`, weight: item.key === "turnaround" ? 0.6 : 0.2 }));
  const bands = [{ name: "Priority", minimum: 2 }, { name: "Watch", minimum: 0 }, { name: "Quality", minimum: 1 }];
  const policy = resolvePriorityPolicy({ priority_kpis: JSON.stringify(kpis), priority_bands: JSON.stringify(bands) });
  const result = scorePriority({ turnaround: 3, volume: 2, value: 1 }, policy);
  assert.equal(result.score, 2.4);
  assert.equal(result.band, "Priority");
  assert.equal(result.breakdown[0].question, "turnaround policy question");
  assert.equal(result.breakdown[0].hint, "turnaround policy hint");
});

test("legacy saved Qualify policy resolves as Quality", () => {
  const legacy = JSON.stringify([{ name: "Watch", minimum: 0 }, { name: "Qualify", minimum: 1.5 }, { name: "Priority", minimum: 2.5 }]);
  assert.deepEqual(resolvePriorityPolicy({ priority_bands: legacy }).bands.map(({ name }) => name), ["Watch", "Quality", "Priority"]);
});

test("invalid configuration fails closed", () => {
  assert.throws(() => resolvePriorityPolicy({ priority_kpis: JSON.stringify([{ ...defaultPriorityPolicy.kpis[0] }]) }), /exactly once/);
  assert.throws(() => resolvePriorityPolicy({ priority_kpis: JSON.stringify(defaultPriorityPolicy.kpis.map((item) => ({ ...item, weight: 0.5 }))) }), /total 1/);
  assert.throws(() => resolvePriorityPolicy({ priority_bands: JSON.stringify([{ name: "Watch", minimum: 0 }, { name: "Quality", minimum: 2 }, { name: "Priority", minimum: 1 }]) }), /thresholds/);
  assert.throws(() => resolvePriorityPolicy({ priority_bands: "not json" }), /invalid JSON/);
  assert.throws(() => scorePriority({ turnaround: Number.NaN, volume: 1, value: 1 }, defaultPriorityPolicy), /Invalid turnaround/);
});
