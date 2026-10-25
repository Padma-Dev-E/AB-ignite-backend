import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "../../db/connection";
import { ideaSettings } from "../../db/schema";
import { resolvePriorityPolicy, scorePriority, type PriorityMetrics } from "./priority-policy";

/** Read the policy for each request; no process cache can leave an admin edit stale. */
export function loadPriorityPolicy() {
  const rows = db.select({ key: ideaSettings.key, value: ideaSettings.value })
    .from(ideaSettings).where(inArray(ideaSettings.key, ["priority_kpis", "priority_bands"])).all();
  return resolvePriorityPolicy(Object.fromEntries(rows.map(({ key, value }) => [key, value])));
}

export function scoreIdeaWithCurrentPriorityPolicy(metrics: PriorityMetrics) {
  return scorePriority(metrics, loadPriorityPolicy());
}
