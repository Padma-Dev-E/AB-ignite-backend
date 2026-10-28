import { createHash } from "node:crypto";
import { and, asc, desc, eq, max } from "drizzle-orm";
import { db } from "../../../db/connection";
import { aiPromptCatalog, aiPromptVersions, auditEvents } from "../../../db/schema";
import { buildAuditRecord } from "../../audit/service";
import { aiPromptSeeds, type AiPromptSeed } from "./seed-data";

type AiPromptUsage = (typeof aiPromptSeeds)[number]["usage"][number];
const promptByKey = new Map<string, AiPromptSeed>(aiPromptSeeds.map((prompt) => [prompt.jobKey, prompt]));

export type AiPromptSummary = {
  jobKey: string;
  name: string;
  description: string;
  usage: AiPromptUsage[];
  activeVersion: number;
  systemPrompt: string;
  contentHash: string;
  updatedAt: Date;
  versions: Array<{ version: number; schemaVersion: string; isDefault: boolean; createdAt: Date; reason: string | null }>;
};

function contentHash(prompt: string) {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

type PromptTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function insertDefaultVersion(tx: PromptTransaction, input: { jobKey: string; version: number; systemPrompt: string; schemaVersion: string; reason?: string }) {
  tx.insert(aiPromptVersions).values({
    jobKey: input.jobKey,
    version: input.version,
    systemPrompt: input.systemPrompt,
    schemaVersion: input.schemaVersion,
    contentHash: contentHash(input.systemPrompt),
    isDefault: true,
    reason: input.reason ?? "System default prompt",
  }).onConflictDoNothing().run();
}

/** Seeds system defaults as immutable prompt revisions without replacing admin edits. */
export function ensureAiPromptCatalogue() {
  db.transaction((tx) => {
    for (const prompt of aiPromptSeeds) {
      const existingCatalog = tx.select().from(aiPromptCatalog).where(eq(aiPromptCatalog.jobKey, prompt.jobKey)).limit(1).get();
      if (!existingCatalog) {
        tx.insert(aiPromptCatalog).values({ jobKey: prompt.jobKey, name: prompt.name, description: prompt.description, activeVersion: 1 }).run();
        insertDefaultVersion(tx, { jobKey: prompt.jobKey, version: 1, systemPrompt: prompt.systemPrompt, schemaVersion: prompt.schemaVersion });
        continue;
      }

      const active = tx.select().from(aiPromptVersions).where(and(
        eq(aiPromptVersions.jobKey, prompt.jobKey),
        eq(aiPromptVersions.version, existingCatalog.activeVersion),
      )).limit(1).get();
      if (!active) {
        insertDefaultVersion(tx, { jobKey: prompt.jobKey, version: 1, systemPrompt: prompt.systemPrompt, schemaVersion: prompt.schemaVersion });
        tx.update(aiPromptCatalog).set({ activeVersion: 1, updatedAt: new Date() }).where(eq(aiPromptCatalog.jobKey, prompt.jobKey)).run();
        continue;
      }

      // An admin-edited active prompt must not be replaced during db:seed.
      if (!active.isDefault || active.contentHash === contentHash(prompt.systemPrompt)) continue;

      const [maximum] = tx.select({ value: max(aiPromptVersions.version) }).from(aiPromptVersions).where(eq(aiPromptVersions.jobKey, prompt.jobKey)).all();
      const version = Number(maximum?.value ?? 0) + 1;
      insertDefaultVersion(tx, {
        jobKey: prompt.jobKey,
        version,
        systemPrompt: prompt.systemPrompt,
        schemaVersion: prompt.schemaVersion,
        reason: "Updated system default prompt",
      });
      tx.update(aiPromptCatalog).set({ activeVersion: version, updatedAt: new Date() }).where(and(
        eq(aiPromptCatalog.jobKey, prompt.jobKey),
        eq(aiPromptCatalog.activeVersion, existingCatalog.activeVersion),
      )).run();
    }
  });
}

export function isManagedAiPrompt(jobKey: string) {
  return promptByKey.has(jobKey);
}

export function getAiPromptVersion(jobKey: string, versionValue: string | number) {
  const version = Number(versionValue);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return db.select().from(aiPromptVersions).where(and(
    eq(aiPromptVersions.jobKey, jobKey),
    eq(aiPromptVersions.version, version),
  )).limit(1).get() ?? null;
}

export function getActiveAiPromptVersion(jobKey: string) {
  return db.select({ activeVersion: aiPromptCatalog.activeVersion }).from(aiPromptCatalog)
    .where(eq(aiPromptCatalog.jobKey, jobKey)).limit(1).get()?.activeVersion ?? null;
}

export function listAiPromptCatalogue(): AiPromptSummary[] {
  const catalog = db.select().from(aiPromptCatalog).orderBy(asc(aiPromptCatalog.jobKey)).all();
  return catalog.flatMap((entry) => {
    const identity = promptByKey.get(entry.jobKey);
    if (!identity) return [];
    const active = getAiPromptVersion(entry.jobKey, entry.activeVersion);
    if (!active) return [];
    const versions = db.select({ version: aiPromptVersions.version, schemaVersion: aiPromptVersions.schemaVersion, isDefault: aiPromptVersions.isDefault, createdAt: aiPromptVersions.createdAt, reason: aiPromptVersions.reason })
      .from(aiPromptVersions).where(eq(aiPromptVersions.jobKey, entry.jobKey)).orderBy(desc(aiPromptVersions.version)).all();
    return [{ ...entry, usage: identity.usage, systemPrompt: active.systemPrompt, contentHash: active.contentHash, updatedAt: active.createdAt, versions }];
  });
}

export function getAiPromptDetail(jobKey: string) {
  const identity = promptByKey.get(jobKey);
  if (!identity) return null;
  const [entry] = db.select().from(aiPromptCatalog).where(eq(aiPromptCatalog.jobKey, jobKey)).limit(1).all();
  if (!entry) return null;
  const versions = db.select().from(aiPromptVersions).where(eq(aiPromptVersions.jobKey, jobKey)).orderBy(desc(aiPromptVersions.version)).all();
  return { ...entry, usage: identity.usage, versions };
}

export class AiPromptConflictError extends Error {
  constructor() { super("This prompt changed in another session. Reload it before saving."); this.name = "AiPromptConflictError"; }
}

export function activateAiPromptVersion(input: {
  jobKey: string;
  systemPrompt: string;
  expectedVersion: number;
  reason: string;
  actorUserId: number;
  ipAddress?: string;
  userAgent?: string;
}) {
  const prompt = input.systemPrompt.trim();
  return db.transaction((tx) => {
    if (!promptByKey.has(input.jobKey)) return null;
    const [entry] = tx.select().from(aiPromptCatalog).where(eq(aiPromptCatalog.jobKey, input.jobKey)).limit(1).all();
    if (!entry) return null;
    if (entry.activeVersion !== input.expectedVersion) throw new AiPromptConflictError();

    const [maximum] = tx.select({ value: max(aiPromptVersions.version) }).from(aiPromptVersions).where(eq(aiPromptVersions.jobKey, input.jobKey)).all();
    const version = Number(maximum?.value ?? 0) + 1;
    const [created] = tx.insert(aiPromptVersions).values({
      jobKey: input.jobKey,
      version,
      systemPrompt: prompt,
      contentHash: contentHash(prompt),
      createdBy: input.actorUserId,
      reason: input.reason.trim(),
      isDefault: false,
      schemaVersion: getSchemaVersion(input.jobKey),
    }).returning().all();
    if (!created) throw new Error("AI prompt revision was not saved");
    tx.update(aiPromptCatalog).set({ activeVersion: version, updatedAt: new Date() }).where(and(
      eq(aiPromptCatalog.jobKey, input.jobKey),
      eq(aiPromptCatalog.activeVersion, input.expectedVersion),
    )).run();
    tx.insert(auditEvents).values(buildAuditRecord({
      actorUserId: input.actorUserId,
      action: "ai.prompt_activated",
      targetType: "ai_prompt",
      targetId: input.jobKey,
      metadata: { promptKey: input.jobKey, promptVersion: version, previousPromptVersion: input.expectedVersion, contentHash: created.contentHash },
      reason: input.reason,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    })).run();
    return created;
  });
}

function getSchemaVersion(jobKey: string) {
  return promptByKey.get(jobKey)?.schemaVersion ?? "unknown";
}
