import { z } from "zod";

const priorityKeys = ["minimum_priority_score", "priority_point_rules", "priority_level_rules", "priority_recommendation_rules", "priority_kpis", "priority_bands", "sla_days", "required_controls", "departments", "demo_access", "roles"] as const;

export const adminSettingsPatchSchema = z.strictObject({
  reason: z.unknown(),
  priority: z.partialRecord(z.enum(priorityKeys), z.string().max(4000)).optional(),
  pointRules: z.array(z.strictObject({ code: z.string().trim().min(1).max(80), points: z.number().int().min(0).max(100000), active: z.boolean() })).max(100).optional(),
  recommendationRules: z.array(z.strictObject({ topic: z.string().trim().min(1).max(120), thresholdPercent: z.number().int().min(0).max(100), reasonTemplate: z.string().trim().min(1).max(500), active: z.boolean() })).max(200).optional(),
  levels: z.array(z.strictObject({ id: z.number().int().positive(), name: z.string().trim().min(1).max(120), description: z.string().max(500).nullable(), minimumPoints: z.number().int().min(0).max(10000000), sortOrder: z.number().int().min(0).max(100) })).max(100).optional(),
});
