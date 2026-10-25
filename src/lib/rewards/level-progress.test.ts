import test from "node:test";
import assert from "node:assert/strict";

async function loadCalculator() {
  const module = await import("./level-progress.js").catch(() => ({}));
  assert.equal(typeof module.calculateLevelProgress, "function", "level-progress module should expose its calculator");
  return module.calculateLevelProgress;
}

test("level progress reports the next threshold and remaining points", async () => {
  const calculateLevelProgress = await loadCalculator();
  const result = calculateLevelProgress(150, [
    { id: 1, name: "Starter", minimumPoints: 0 },
    { id: 2, name: "Spark", minimumPoints: 100 },
    { id: 3, name: "Flame", minimumPoints: 250 },
  ]);

  assert.equal(result.level?.name, "Spark");
  assert.equal(result.nextLevel?.name, "Flame");
  assert.deepEqual(result.progress, {
    pointsIntoLevel: 50,
    pointsToNextLevel: 100,
    pointsRequired: 150,
    percent: 33,
  });
});

test("level progress handles users below the first configured threshold", async () => {
  const calculateLevelProgress = await loadCalculator();
  const result = calculateLevelProgress(20, [
    { id: 1, name: "Spark", minimumPoints: 50 },
    { id: 2, name: "Flame", minimumPoints: 200 },
  ]);

  assert.equal(result.level, null);
  assert.equal(result.nextLevel?.name, "Spark");
  assert.deepEqual(result.progress, {
    pointsIntoLevel: 20,
    pointsToNextLevel: 30,
    pointsRequired: 50,
    percent: 40,
  });
});

test("level progress reports completion at the highest configured level", async () => {
  const calculateLevelProgress = await loadCalculator();
  const result = calculateLevelProgress(300, [
    { id: 1, name: "Starter", minimumPoints: 0 },
    { id: 2, name: "Spark", minimumPoints: 100 },
  ]);

  assert.equal(result.level?.name, "Spark");
  assert.equal(result.nextLevel, null);
  assert.equal(result.progress, null);
});

test("level progress safely handles an empty level configuration and negative points", async () => {
  const calculateLevelProgress = await loadCalculator();
  const result = calculateLevelProgress(-5, []);

  assert.deepEqual(result, { level: null, nextLevel: null, progress: null });
});
