export type LevelDefinition = {
  id: number;
  name: string;
  minimumPoints: number;
  sortOrder?: number;
  [key: string]: unknown;
};

export type LevelProgress = {
  pointsIntoLevel: number;
  pointsToNextLevel: number;
  pointsRequired: number;
  percent: number;
};

export function calculateLevelProgress<T extends LevelDefinition>(points: number, definitions: T[]) {
  const safePoints = Number.isFinite(points) ? Math.max(0, Math.floor(points)) : 0;
  const ordered = [...definitions].sort((a, b) =>
    a.minimumPoints - b.minimumPoints ||
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
    a.id - b.id,
  );
  const level = ordered.filter((item) => item.minimumPoints <= safePoints).at(-1) ?? null;
  const nextLevel = ordered.find((item) => item.minimumPoints > safePoints) ?? null;

  if (!nextLevel) return { level, nextLevel: null, progress: null as LevelProgress | null };

  const startPoints = Math.max(0, level?.minimumPoints ?? 0);
  const pointsRequired = Math.max(1, nextLevel.minimumPoints - startPoints);
  const pointsIntoLevel = Math.max(0, safePoints - startPoints);
  return {
    level,
    nextLevel,
    progress: {
      pointsIntoLevel,
      pointsToNextLevel: Math.max(0, nextLevel.minimumPoints - safePoints),
      pointsRequired,
      percent: Math.min(100, Math.round((pointsIntoLevel / pointsRequired) * 100)),
    } satisfies LevelProgress,
  };
}
