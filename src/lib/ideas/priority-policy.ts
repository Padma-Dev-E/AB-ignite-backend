import { z } from "zod";

const keys = ["turnaround", "volume", "value"] as const;
export type PriorityMetricKey = typeof keys[number];
export type PriorityMetrics = Record<PriorityMetricKey, number>;
export type PriorityBand = "Watch" | "Quality" | "Priority";

const kpiSchema = z.strictObject({
  key: z.enum(keys),
  question: z.string().trim().min(1).max(500),
  hint: z.string().trim().min(1).max(500),
  weight: z.number().finite().min(0).max(1),
});
const bandSchema = z.strictObject({
  name: z.enum(["Watch", "Quality", "Priority"]),
  minimum: z.number().finite().min(0).max(3),
});

export type PriorityKpi = z.infer<typeof kpiSchema>;
export type PriorityBandThreshold = z.infer<typeof bandSchema>;
export type PriorityPolicy = { kpis: PriorityKpi[]; bands: PriorityBandThreshold[] };

export const defaultPriorityPolicy: PriorityPolicy = {
  kpis: [
    { key: "turnaround", question: "How much turnaround time improves?", hint: "Estimate the time saved.", weight: 0.3 },
    { key: "volume", question: "How many cases or customers are affected?", hint: "Estimate the volume affected.", weight: 0.3 },
    { key: "value", question: "What savings or revenue are expected?", hint: "Estimate the financial impact.", weight: 0.4 },
  ],
  bands: [
    { name: "Watch", minimum: 0 },
    { name: "Quality", minimum: 1.5 },
    { name: "Priority", minimum: 2.5 },
  ],
};

function parseRecords<T>(raw: string | undefined, schema: z.ZodType<T>, label: string): T[] | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${label} setting is invalid JSON`); }
  const records = z.array(schema).max(10).parse(parsed);
  return records.length ? records : null;
}

/** Reject malformed saved policy so a configuration error never silently changes a bank decision. */
export function resolvePriorityPolicy(raw: { priority_kpis?: string; priority_bands?: string }): PriorityPolicy {
  const kpis = parseRecords(raw.priority_kpis, kpiSchema, "Priority KPI") ?? defaultPriorityPolicy.kpis;
  const bandsRaw = raw.priority_bands?.replaceAll('"Qualify"', '"Quality"');
  const bands = parseRecords(bandsRaw, bandSchema, "Priority band") ?? defaultPriorityPolicy.bands;
  if (kpis.length !== keys.length || keys.some((key) => kpis.filter((kpi) => kpi.key === key).length !== 1)) {
    throw new Error("Priority KPIs must configure turnaround, volume, and value exactly once");
  }
  const totalWeight = kpis.reduce((sum, kpi) => sum + kpi.weight, 0);
  if (Math.abs(totalWeight - 1) > 0.000001) throw new Error("Priority KPI weights must total 1");
  if (bands.length !== 3 || ["Watch", "Quality", "Priority"].some((name) => bands.filter((band) => band.name === name).length !== 1)) {
    throw new Error("Priority bands must configure Watch, Quality, and Priority exactly once");
  }
  const sortedBands = [...bands].sort((left, right) => left.minimum - right.minimum);
  if (sortedBands[0].name !== "Watch" || sortedBands[0].minimum !== 0 || sortedBands[1].name !== "Quality" || sortedBands[2].name !== "Priority" || sortedBands[1].minimum === 0 || sortedBands[2].minimum <= sortedBands[1].minimum) {
    throw new Error("Priority band thresholds must increase from Watch at zero through Quality to Priority");
  }
  return { kpis, bands: sortedBands };
}

export function scorePriority(metrics: PriorityMetrics, policy: PriorityPolicy) {
  for (const key of keys) if (!Number.isFinite(metrics[key]) || metrics[key] < 0 || metrics[key] > 3) throw new Error(`Invalid ${key} priority answer`);
  const breakdown = policy.kpis.map(({ key, question, hint, weight }) => ({
    key, question, hint, score: metrics[key], weight,
    contribution: Math.round(metrics[key] * weight * 100) / 100,
  }));
  const score = Math.round(policy.kpis.reduce((sum, kpi) => sum + metrics[kpi.key] * kpi.weight, 0) * 100) / 100;
  const band = [...policy.bands].reverse().find((entry) => score >= entry.minimum)?.name;
  if (!band) throw new Error("No priority band matches the calculated score");
  return { score, band, breakdown };
}
