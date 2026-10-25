import { and, desc, eq, inArray, notExists, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/connection";
import { articles, articleCompletions, auditEvents, feedbackCampaigns, feedbackResponses, notifications, pointRules, pointsLedger, quizRecommendations } from "../../db/schema";
import { relatedQuizIdsForArticles } from "../quizzes/service";
import { evaluateBadgeAwards } from "../rewards/service";
import { appendLedgerEntry } from "../rewards/repository";
import { createGeminiProvider } from "../ai/gemini-provider-core";
import { getAiConfig } from "../ai/config-core";
import { hashAuditValue, serializeAuditMetadata } from "../audit/redaction-core";

export class LibraryError extends Error { constructor(message: string, public code: string, public status = 400) { super(message); } }
export type RequestContext = { userId: number; sessionId: number; ipAddress?: string | null; userAgent?: string | null; requestId?: string | null };
const textSchema = z.string().trim().min(1).max(4000);
function audit(ctx: RequestContext, action: string, type: string, targetId: number, metadata: unknown) {
  const details = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : { details: metadata };
  return { actorUserId: ctx.userId, sessionId: ctx.sessionId, action, targetType: type, targetId: String(targetId), reason: null, metadataJson: serializeAuditMetadata({ ...(details as Record<string, unknown>), requestId: ctx.requestId }), ipHash: hashAuditValue(ctx.ipAddress), userAgentHash: hashAuditValue(ctx.userAgent), createdAt: new Date() };
}
function sourceUrl(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch { return null; }
}
type PublicLibraryArticle = ReturnType<typeof publicArticle> & { completed?: boolean; recommendation?: { id: number; topic: string; scorePercent: number; thresholdPercent: number; reason: string } };
export async function listLibrary(userId: number, category?: string, recommended = false): Promise<{ items: PublicLibraryArticle[]; emptyMessage: string | null }> {
  if (recommended) {
    const recs = await db.select().from(quizRecommendations).where(and(eq(quizRecommendations.userId, userId), eq(quizRecommendations.status, "open"))).orderBy(desc(quizRecommendations.createdAt)).all();
    const result = new Map<number, ReturnType<typeof publicArticle> & { recommendation: { id: number; topic: string; scorePercent: number; thresholdPercent: number; reason: string } }>();
    const exactMatches = new Set<number>();
    for (const rec of recs) {
      const matches = await db.select().from(articles).where(and(
        eq(articles.published, true),
        or(eq(articles.topic, rec.topic), eq(articles.categoryCode, rec.categoryCode)),
        notExists(db.select({ id: articleCompletions.id }).from(articleCompletions).where(and(eq(articleCompletions.userId, userId), eq(articleCompletions.articleId, articles.id)))),
      )).all();
      for (const article of matches) {
        if (article.contentType === "external" && !sourceUrl(article.url)) continue;
        const exact = article.topic === rec.topic;
        if (!result.has(article.id) || (exact && !exactMatches.has(article.id))) result.set(article.id, { ...publicArticle(article), recommendation: { id: rec.id, topic: rec.topic, scorePercent: rec.scorePercent, thresholdPercent: rec.thresholdPercent, reason: rec.reason } });
        if (exact) exactMatches.add(article.id);
      }
    }
    return { items: Array.from(result.values()), emptyMessage: result.size ? null : "Complete a quiz to get reading recommendations for your learning gaps." };
  }
  const conditions = [eq(articles.published, true)];
  if (category) conditions.push(eq(articles.categoryCode, category));
  const rows = await db.select().from(articles).where(and(...conditions)).orderBy(desc(articles.updatedAt)).all();
  const completions = rows.length ? await db.select({ articleId: articleCompletions.articleId }).from(articleCompletions).where(and(eq(articleCompletions.userId, userId), inArray(articleCompletions.articleId, rows.map((row) => row.id)))).all() : [];
  const completedIds = new Set(completions.map((row) => row.articleId));
  return { items: rows.filter((row) => row.contentType !== "external" || sourceUrl(row.url)).map((row) => ({ ...publicArticle(row), completed: completedIds.has(row.id) })), emptyMessage: null };
}
function publicArticle(article: typeof articles.$inferSelect) {
  return { id: article.id, publisher: article.publisher, title: article.title, summary: article.summary, category: article.categoryCode, topic: article.topic, difficulty: article.difficulty, readingMinutes: article.readingMinutes, contentType: article.contentType, body: article.contentType === "internal" ? article.body : null, sourceUrl: article.contentType === "external" ? sourceUrl(article.url) : null };
}
export async function getLibraryArticle(articleId: number, userId?: number) {
  const [row] = await db.select().from(articles).where(and(eq(articles.id, articleId), eq(articles.published, true))).limit(1).all();
  if (!row) throw new LibraryError("Article not found.", "ARTICLE_NOT_FOUND", 404);
  const [completion] = userId ? await db.select({ id: articleCompletions.id }).from(articleCompletions).where(and(eq(articleCompletions.userId, userId), eq(articleCompletions.articleId, articleId))).limit(1).all() : [];
  const relatedQuizIds = await relatedQuizIdsForArticles([{ id: row.id, categoryCode: row.categoryCode, topic: row.topic }]);
  return { ...publicArticle(row), completed: Boolean(completion), relatedQuizId: relatedQuizIds.get(row.id) ?? null };
}
export async function listRecommendations(userId: number) { return listLibrary(userId, undefined, true); }
export async function completeArticle(ctx: RequestContext, articleId: number, idempotencyKey: string) {
  const key = z.string().trim().min(8).max(200).parse(idempotencyKey);
  const ledgerKey = `article:${articleId}:user:${ctx.userId}:read`;
  return db.transaction((tx) => {
    const [article] = tx.select().from(articles).where(and(eq(articles.id, articleId), eq(articles.published, true))).limit(1).all();
    if (!article) throw new LibraryError("Article not found.", "ARTICLE_NOT_FOUND", 404);
    if (article.contentType === "external" && !sourceUrl(article.url)) throw new LibraryError("The article source is unavailable.", "SOURCE_UNAVAILABLE", 409);
    const [keyUse] = tx.select().from(articleCompletions).where(and(eq(articleCompletions.userId, ctx.userId), eq(articleCompletions.idempotencyKey, key))).limit(1).all();
    if (keyUse && keyUse.articleId !== articleId) throw new LibraryError("Idempotency key was already used for another article.", "IDEMPOTENCY_CONFLICT", 409);
    const [existing] = tx.select().from(articleCompletions).where(and(eq(articleCompletions.userId, ctx.userId), eq(articleCompletions.articleId, articleId))).limit(1).all();
    if (existing) {
      if (existing.recommendationId) {
        const [recommendation] = tx.select({ status: quizRecommendations.status }).from(quizRecommendations).where(eq(quizRecommendations.id, existing.recommendationId)).limit(1).all();
        if (recommendation?.status === "open") {
          const [noted] = tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.actorUserId, ctx.userId), eq(auditEvents.action, "article.recommendation_closure_pending"), eq(auditEvents.targetId, String(articleId)))).limit(1).all();
          if (!noted) tx.insert(auditEvents).values(audit(ctx, "article.recommendation_closure_pending", "article", articleId, { status: "pending_schema_constraint", reasonCode: "RECOMMENDATION_STATUS_UNIQUE_CONFLICT", resourceType: "article_completion", resourceId: existing.id })).run();
        }
      }
      if (existing.pointsAwarded < 0) {
        const plannedPoints = -existing.pointsAwarded;
        const [priorAward] = tx.select().from(pointsLedger).where(eq(pointsLedger.idempotencyKey, ledgerKey)).limit(1).all();
        appendLedgerEntry(tx, { userId: ctx.userId, amount: plannedPoints, eventType: "article_read", sourceType: "article", sourceId: String(articleId), idempotencyKey: ledgerKey, actorUserId: ctx.userId, sessionId: ctx.sessionId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
        const badgeAwards = evaluateBadgeAwards(tx, ctx.userId);
        tx.update(articleCompletions).set({ pointsAwarded: plannedPoints }).where(eq(articleCompletions.id, existing.id)).run();
        tx.insert(auditEvents).values(audit(ctx, "article.award_recovered", "article", articleId, { status: "recovered", resourceType: "article_completion", resourceId: existing.id })).run();
        return { completionId: existing.id, alreadyCompleted: Boolean(priorAward), completed: true, recovered: true, pointsAwarded: priorAward ? 0 : plannedPoints, badgeAwards: priorAward ? [] : badgeAwards };
      }
      return { completionId: existing.id, alreadyCompleted: true, completed: true, pointsAwarded: 0, badgeAwards: [] };
    }
    const matchingRecommendations = tx.select().from(quizRecommendations).where(and(eq(quizRecommendations.userId, ctx.userId), eq(quizRecommendations.status, "open"), or(eq(quizRecommendations.topic, article.topic ?? ""), eq(quizRecommendations.categoryCode, article.categoryCode)))).orderBy(desc(quizRecommendations.createdAt)).all();
    const recommendation = matchingRecommendations.find((candidate) => article.topic !== null && candidate.topic === article.topic) ?? matchingRecommendations[0];
    const [earlierCompletionForTopic] = recommendation ? tx.select({ id: quizRecommendations.id }).from(quizRecommendations).where(and(eq(quizRecommendations.userId, ctx.userId), eq(quizRecommendations.topic, recommendation.topic), eq(quizRecommendations.status, "completed"))).limit(1).all() : [];
    const recommendationClosure = !recommendation ? "none" : earlierCompletionForTopic ? "pending_schema_constraint" : "closed";
    const [rule] = tx.select().from(pointRules).where(and(eq(pointRules.code, "article_read"), eq(pointRules.active, true))).limit(1).all();
    const [priorAward] = tx.select().from(pointsLedger).where(eq(pointsLedger.idempotencyKey, ledgerKey)).limit(1).all();
    if (priorAward && (priorAward.userId !== ctx.userId || priorAward.sourceType !== "article" || priorAward.sourceId !== String(articleId) || priorAward.eventType !== "article_read" || priorAward.amount < 1)) throw new LibraryError("The article points key is already used for a different award.", "IDEMPOTENCY_CONFLICT", 409);
    const plannedPoints = priorAward?.amount ?? (rule && rule.points > 0 ? rule.points : 0);
    const [completion] = tx.insert(articleCompletions).values({ userId: ctx.userId, articleId, recommendationId: recommendation?.id ?? null, idempotencyKey: key, pointsAwarded: plannedPoints, completedAt: new Date() }).returning().all();
    if (recommendation && recommendationClosure === "closed") tx.update(quizRecommendations).set({ status: "completed", updatedAt: new Date() }).where(eq(quizRecommendations.id, recommendation.id)).run();
    let badgeAwards: ReturnType<typeof evaluateBadgeAwards> = [];
    if (plannedPoints > 0) {
      appendLedgerEntry(tx, { userId: ctx.userId, amount: plannedPoints, eventType: "article_read", sourceType: "article", sourceId: String(articleId), idempotencyKey: ledgerKey, actorUserId: ctx.userId, sessionId: ctx.sessionId, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
      badgeAwards = evaluateBadgeAwards(tx, ctx.userId);
    }
    tx.insert(auditEvents).values(audit(ctx, "article.completed", "article", articleId, { status: recommendationClosure, resourceType: "article_completion", resourceId: completion.id, reasonCode: recommendationClosure === "pending_schema_constraint" ? "RECOMMENDATION_STATUS_UNIQUE_CONFLICT" : undefined })).run();
    return { completionId: completion.id, alreadyCompleted: Boolean(priorAward), completed: true, recommendationId: recommendation?.id ?? null, recommendationClosure, pointsAwarded: priorAward ? 0 : plannedPoints, badgeAwards: priorAward ? [] : badgeAwards };
  });
}
export async function articleInsight(ctx: RequestContext, articleId: number, recommendationId: number) {
  if (!Number.isInteger(articleId) || articleId < 1 || !Number.isInteger(recommendationId) || recommendationId < 1) throw new LibraryError("Invalid article insight request.", "VALIDATION_ERROR", 400);
  const [recommendation] = await db.select().from(quizRecommendations).where(and(eq(quizRecommendations.id, recommendationId), eq(quizRecommendations.userId, ctx.userId), inArray(quizRecommendations.status, ["open", "completed"]))).limit(1).all();
  if (!recommendation) throw new LibraryError("Recommendation not found.", "RECOMMENDATION_NOT_FOUND", 404);
  const [article] = await db.select().from(articles).where(and(eq(articles.id, articleId), eq(articles.published, true))).limit(1).all();
  if (!article) throw new LibraryError("Article not found.", "ARTICLE_NOT_FOUND", 404);
  if (article.topic !== recommendation.topic && article.categoryCode !== recommendation.categoryCode) throw new LibraryError("Article is not part of this recommendation.", "RECOMMENDATION_MISMATCH", 403);
  const fallback = recommendation.reason.slice(0, 240);
  try {
    const config = getAiConfig();
    if (!config.apiKey) {
      await db.insert(auditEvents).values(audit(ctx, "article.insight.generated", "article", articleId, { recommendationId, source: "rule" })).run();
      return { insight: fallback, source: "rule" as const };
    }
    const provider = createGeminiProvider(config);
    const response = await provider.generateStructured({ model: config.model, systemPrompt: "Write one brief, factual sentence connecting a bank employee's learning gap to this article. Use only supplied information. Do not infer personal traits or disclose sensitive data.", userContent: JSON.stringify({ topic: recommendation.topic, scorePercent: recommendation.scorePercent, recommendationReason: recommendation.reason, articleTitle: article.title, articleSummary: article.summary }), responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: { insight: { type: "string", minLength: 1, maxLength: 240 } }, required: ["insight"], additionalProperties: false }, maxOutputTokens: 120, temperature: 0, timeoutMs: config.timeoutMs });
    const parsed = z.object({ insight: z.string().trim().min(1).max(240) }).safeParse(JSON.parse(response.text));
    const source = parsed.success ? "gemini" as const : "rule" as const;
    await db.insert(auditEvents).values(audit(ctx, "article.insight.generated", "article", articleId, { recommendationId, source })).run();
    return parsed.success ? { insight: parsed.data.insight, source } : { insight: fallback, source };
  } catch {
    await db.insert(auditEvents).values(audit(ctx, "article.insight.generated", "article", articleId, { recommendationId, source: "rule" })).run();
    return { insight: fallback, source: "rule" as const };
  }
}

export async function getFeedback(userId: number) {
  const now = new Date();
  const campaigns = await db.select().from(feedbackCampaigns).where(eq(feedbackCampaigns.active, true)).orderBy(desc(feedbackCampaigns.pinned), desc(feedbackCampaigns.updatedAt)).all();
  const active = campaigns.find((campaign) => (!campaign.startsAt || campaign.startsAt <= now) && (!campaign.endsAt || campaign.endsAt >= now)) ?? null;
  const responses = active ? await db.select().from(feedbackResponses).where(and(eq(feedbackResponses.userId, userId), eq(feedbackResponses.campaignId, active.id))).orderBy(desc(feedbackResponses.createdAt)).all() : [];
  return { campaign: active ? { id: active.id, title: active.title, description: active.description, pinned: active.pinned } : null, responses: responses.map((r) => ({ id: r.id, category: r.category, message: r.message, response: r.response, respondedAt: r.respondedAt, createdAt: r.createdAt })) };
}
export async function submitFeedback(ctx: RequestContext, input: { category: string; message: string; idempotencyKey: string }) {
  const data = z.object({ category: z.enum(["experience", "ideas", "content", "technical", "other"]), message: textSchema, idempotencyKey: z.string().trim().min(8).max(200) }).parse(input);
  return db.transaction((tx) => {
    const now = new Date();
    const [campaign] = tx.select().from(feedbackCampaigns).where(and(eq(feedbackCampaigns.active, true), eq(feedbackCampaigns.pinned, true))).orderBy(desc(feedbackCampaigns.updatedAt)).limit(1).all();
    if (!campaign || (campaign.startsAt && campaign.startsAt > now) || (campaign.endsAt && campaign.endsAt < now)) throw new LibraryError("There is no active feedback campaign.", "CAMPAIGN_CLOSED", 409);
    const [existing] = tx.select().from(feedbackResponses).where(and(eq(feedbackResponses.userId, ctx.userId), eq(feedbackResponses.idempotencyKey, data.idempotencyKey))).limit(1).all();
    if (existing) return { id: existing.id, duplicate: true };
    const [row] = tx.insert(feedbackResponses).values({ campaignId: campaign.id, userId: ctx.userId, category: data.category, message: data.message, idempotencyKey: data.idempotencyKey, createdAt: now, updatedAt: now }).returning().all();
    tx.insert(auditEvents).values(audit(ctx, "feedback.submitted", "feedback", row.id, { campaignId: campaign.id, category: row.category })).run();
    tx.insert(notifications).values({ userId: ctx.userId, type: "feedback_received", title: "Feedback received", body: "Thank you for helping improve the platform.", link: "/private/feedback", createdAt: now, updatedAt: now }).run();
    return { id: row.id, duplicate: false };
  });
}
export async function respondToFeedback(ctx: RequestContext, responseId: number, message: string) {
  const body = textSchema.max(2000).parse(message);
  return db.transaction((tx) => {
    const [row] = tx.select().from(feedbackResponses).where(eq(feedbackResponses.id, responseId)).limit(1).all();
    if (!row) throw new LibraryError("Feedback not found.", "FEEDBACK_NOT_FOUND", 404);
    if (row.respondedAt) throw new LibraryError("Feedback has already been answered.", "ALREADY_RESPONDED", 409);
    const now = new Date();
    tx.update(feedbackResponses).set({ respondedBy: ctx.userId, response: body, respondedAt: now, updatedAt: now }).where(eq(feedbackResponses.id, responseId)).run();
    tx.insert(auditEvents).values(audit(ctx, "feedback.responded", "feedback", responseId, { status: "responded" })).run();
    tx.insert(notifications).values({ userId: row.userId, type: "feedback_response", title: "A response to your feedback", body, link: "/private/feedback", createdAt: now, updatedAt: now }).run();
    return { id: responseId, respondedAt: now };
  });
}
