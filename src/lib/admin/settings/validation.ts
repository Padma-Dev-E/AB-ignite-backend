import { AdminInputError } from "../query";

export const settingKeys = ["minimum_priority_score", "priority_point_rules", "priority_level_rules", "priority_recommendation_rules", "priority_kpis", "priority_bands", "sla_days", "required_controls", "departments", "demo_access", "roles"] as const;
export type SettingKey = typeof settingKeys[number];

const roles = new Set(["employee", "back_office", "business_owner"]);
// Keep policy keys aligned with the stages consumed by governance/service.ts.
const slaStages = new Set(["screening", "business_review", "control_review", "decision", "poc", "implementation"]);
const priorityRecords = new Set<SettingKey>(["priority_point_rules", "priority_level_rules", "priority_recommendation_rules", "priority_kpis", "priority_bands"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, maximum: number, length: number): value is string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim() || item.length > length)) return false;
  return new Set(value.map((item) => item.trim().toLowerCase())).size === value.length;
}

export function validatePolicySetting(key: string, value: string): void {
  if (!settingKeys.includes(key as SettingKey) || typeof value !== "string" || value.length > 4000) throw new AdminInputError("Unknown or oversized policy setting.");
  if (key === "minimum_priority_score") {
    const score = Number(value);
    if (!value.trim() || !Number.isFinite(score) || score < 0 || score > 3) throw new AdminInputError("Minimum priority score must be between 0 and 3.");
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AdminInputError("Policy settings contain invalid JSON."); }
  if (key === "sla_days") {
    if (!record(parsed) || Object.entries(parsed).some(([stage, days]) => !slaStages.has(stage) || !Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)) throw new AdminInputError("SLA days must map supported workflow stages to whole days from 1 to 365.");
  } else if (key === "required_controls" || key === "departments") {
    if (!stringList(parsed, key === "required_controls" ? 100 : 200, key === "required_controls" ? 500 : 120)) throw new AdminInputError(`${key === "departments" ? "Departments" : "Required controls"} must be a list of unique names.`);
  } else if (key === "roles") {
    if (!stringList(parsed, 3, 40) || parsed.some((item) => !roles.has(item))) throw new AdminInputError("Roles must be a list of unique supported names.");
  } else if (key === "demo_access") {
    if (!record(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.enabled !== "boolean") throw new AdminInputError("Demo access must contain only an enabled boolean.");
  } else if (priorityRecords.has(key as SettingKey)) {
    if (!Array.isArray(parsed) && !record(parsed)) throw new AdminInputError("Priority policy must contain records.");
    if (Array.isArray(parsed) && parsed.length > 200) throw new AdminInputError("Priority policy contains too many records.");
  }
}

/** Governance reads idea_settings.required_controls in its transaction and passes its value here.
 * An absent row retains the legacy mandatory control gate; an explicit [] disables it.
 * A nonempty list requires a separate approval per named function.
 */
export function resolveRequiredControlsPolicy(raw: string | undefined): { configured: boolean; controls: string[]; requiresControlApproval: boolean } {
  if (raw === undefined) return { configured: false, controls: [], requiresControlApproval: true };
  validatePolicySetting("required_controls", raw);
  const controls = JSON.parse(raw) as string[];
  return { configured: true, controls, requiresControlApproval: controls.length > 0 };
}
