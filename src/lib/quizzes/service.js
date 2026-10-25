import { and, asc, desc, eq, gt, inArray, notExists, or, sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { auditEvents, articleCompletions, articles, notifications, pointRules, pointsLedger, quizAttemptAnswers, quizAttempts, quizChallenges, quizChallengeParticipants, quizOptions, quizQuestions, quizRecommendationRules, quizRecommendations, quizTopicResults, quizVersions, quizzes, users, } from "../../db/schema";
import { hashAuditValue, serializeAuditMetadata } from "../audit/redaction-core";
import { awardPoints } from "../rewards/service";
import { QuizError } from "./errors";
function buildQuizAuditRecord(input, now) {
    const auditContext = input.auditContext ?? {};
    return {
        actorUserId: input.actorUserId,
        sessionId: auditContext.sessionId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: String(input.targetId),
        reason: null,
        metadataJson: serializeAuditMetadata({ ...((input.metadata && typeof input.metadata === "object") ? input.metadata : {}), requestId: auditContext.requestId ?? null }),
        ipHash: hashAuditValue(auditContext.ipAddress),
        userAgentHash: hashAuditValue(auditContext.userAgent),
        createdAt: now,
    };
}
function validId(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new QuizError(`Invalid ${label}.`, "VALIDATION_ERROR");
    return value;
}
function validIdempotency(value) {
    const key = value.trim();
    if (key.length < 8 || key.length > 200)
        throw new QuizError("A valid idempotency key is required.", "VALIDATION_ERROR");
    return key;
}
function percentage(correct, total) {
    return total ? Math.round((correct / total) * 100) : 0;
}
function publicQuestions(versionId) {
    const questions = db.select().from(quizQuestions).where(eq(quizQuestions.quizVersionId, versionId)).orderBy(asc(quizQuestions.sortOrder), asc(quizQuestions.id)).all();
    return questions.map((question) => ({
        id: question.id,
        topic: question.topic,
        prompt: question.prompt,
        sortOrder: question.sortOrder,
        points: question.points,
        options: db.select({ id: quizOptions.id, optionKey: quizOptions.optionKey, label: quizOptions.label, sortOrder: quizOptions.sortOrder })
            .from(quizOptions)
            .where(eq(quizOptions.questionId, question.id))
            .orderBy(asc(quizOptions.sortOrder), asc(quizOptions.id))
            .all(),
    }));
}
function publicAttempt(attempt) {
    return {
        id: attempt.id,
        quizId: attempt.quizId,
        quizVersionId: attempt.quizVersionId,
        status: attempt.status,
        startedAt: attempt.startedAt,
        expiresAt: attempt.expiresAt,
        totalQuestions: attempt.totalQuestions,
        questions: publicQuestions(attempt.quizVersionId),
    };
}
function resultFromAttempt(attempt) {
    return {
        attemptId: attempt.id,
        status: attempt.status,
        scorePercent: attempt.scorePercent ?? 0,
        passed: attempt.passed ?? false,
        passMark: getPassMark(attempt.quizVersionId),
        correctCount: attempt.correctCount ?? 0,
        totalQuestions: attempt.totalQuestions,
        pointsAwarded: attempt.pointsAwarded,
        firstAttempt: attempt.firstAttempt,
        previousScorePercent: attempt.previousScorePercent,
        pointsStatus: attempt.pointsStatus,
        submittedAt: attempt.submittedAt,
    };
}
function getPassMark(versionId) {
    const [version] = db.select({ passMark: quizVersions.passMark }).from(quizVersions).where(eq(quizVersions.id, versionId)).limit(1).all();
    return version?.passMark ?? 0;
}
function previousScore(userId, quizId) {
    const rows = db.select({ id: quizAttempts.id, score: quizAttempts.scorePercent })
        .from(quizAttempts)
        .where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId), inArray(quizAttempts.status, ["submitted", "expired"])))
        .orderBy(desc(quizAttempts.submittedAt), desc(quizAttempts.id))
        .all();
    return rows.find((row) => row.score !== null)?.score ?? null;
}
function completedAttemptCount(tx, userId, quizId) {
    const [row] = tx.select({ count: sql `count(*)` }).from(quizAttempts).where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId), eq(quizAttempts.status, "submitted"))).all();
    return Number(row?.count ?? 0);
}
export async function getQuizDetails(quizId) {
    validId(quizId, "quiz ID");
    const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1).all();
    if (!quiz)
        return null;
    const versions = await db.select().from(quizVersions).where(and(eq(quizVersions.quizId, quizId), eq(quizVersions.published, true))).orderBy(desc(quizVersions.version)).limit(1).all();
    return {
        id: quiz.id,
        title: quiz.title,
        category: quiz.category,
        difficulty: quiz.difficulty,
        objective: quiz.objective,
        versions: versions.map((version) => ({ ...version, questions: publicQuestions(version.id) })),
    };
}
export async function listQuizCatalogue(userId) {
    const rows = await db.select({ quiz: quizzes, version: quizVersions })
        .from(quizzes)
        .innerJoin(quizVersions, eq(quizVersions.quizId, quizzes.id))
        .where(eq(quizVersions.published, true))
        .orderBy(asc(quizVersions.categoryCode), asc(quizVersions.level), asc(quizzes.id), desc(quizVersions.version))
        .all();
    const latest = new Map();
    for (const row of rows)
        if (!latest.has(row.quiz.id))
            latest.set(row.quiz.id, row);
    const preferred = ["banking", "transformation", "technology"].flatMap((category) => ["beginner", "intermediate", "advanced", "expert"].flatMap((level) => {
        const match = Array.from(latest.values()).find(({ version }) => version.categoryCode === category && version.level === level);
        return match ? [match] : [];
    }));
    // Keep the standard category/level sequence first, then append every other
    // published quiz. The employee catalogue paginates this complete list; a
    // fixed limit here silently hid newly created quizzes once all 12 standard
    // category/level slots had been filled.
    const preferredIds = new Set(preferred.map(({ quiz }) => quiz.id));
    const selected = preferred.concat(Array.from(latest.values()).filter(({ quiz }) => !preferredIds.has(quiz.id)));
    const attempted = userId && selected.length ? await db.select({ quizId: quizAttempts.quizId }).from(quizAttempts)
        .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.quizId, selected.map(({ quiz }) => quiz.id)), inArray(quizAttempts.status, ["submitted", "expired"]))).all() : [];
    const attemptedQuizIds = new Set(attempted.map((row) => row.quizId));
    return selected.map(({ quiz, version }) => ({
        id: quiz.id,
        title: quiz.title,
        category: version.categoryCode,
        level: version.level,
        objective: version.objective,
        passMark: version.passMark,
        timeLimitSeconds: version.timeLimitSeconds,
        version: version.version,
        questionCount: quizQuestionsCount(version.id),
        hasAttempted: attemptedQuizIds.has(quiz.id),
    }));
}
function quizQuestionsCount(versionId) {
    const [row] = db.select({ count: sql `count(*)` }).from(quizQuestions).where(eq(quizQuestions.quizVersionId, versionId)).all();
    return Number(row?.count ?? 0);
}
export async function relatedQuizIdsForArticles(items) {
    const result = new Map();
    if (!items.length)
        return result;
    const visible = (await listQuizCatalogue()).filter((quiz) => quiz.questionCount > 0);
    if (!visible.length)
        return new Map(items.map((item) => [item.id, null]));
    const versions = await db.select({ id: quizVersions.id, quizId: quizVersions.quizId, version: quizVersions.version }).from(quizVersions)
        .where(and(eq(quizVersions.published, true), inArray(quizVersions.quizId, visible.map((quiz) => quiz.id)))).all();
    const visibleVersions = versions.filter((version) => visible.some((quiz) => quiz.id === version.quizId && quiz.version === version.version));
    const articleTopics = Array.from(new Set(items.map((item) => item.topic).filter((topic) => Boolean(topic))));
    const topicRows = visibleVersions.length && articleTopics.length ? await db.select({ quizVersionId: quizQuestions.quizVersionId, topic: quizQuestions.topic }).from(quizQuestions)
        .where(and(inArray(quizQuestions.quizVersionId, visibleVersions.map((version) => version.id)), inArray(quizQuestions.topic, articleTopics))).all() : [];
    const topicsByVersion = new Map();
    for (const row of topicRows)
        topicsByVersion.set(row.quizVersionId, (topicsByVersion.get(row.quizVersionId) ?? new Set()).add(row.topic));
    for (const item of items) {
        const preferred = item.preferredQuizId ? visible.find((quiz) => quiz.id === item.preferredQuizId && (quiz.category === item.categoryCode || (item.topic && visibleVersions.some((version) => version.quizId === quiz.id && topicsByVersion.get(version.id)?.has(item.topic))))) : null;
        const exact = item.topic ? visible.find((quiz) => visibleVersions.some((version) => version.quizId === quiz.id && topicsByVersion.get(version.id)?.has(item.topic))) : null;
        result.set(item.id, preferred?.id ?? exact?.id ?? visible.find((quiz) => quiz.category === item.categoryCode)?.id ?? null);
    }
    return result;
}
export async function startQuizAttempt(userId, quizId, idempotencyKey, now = new Date(), auditContext) {
    validId(userId, "user ID");
    validId(quizId, "quiz ID");
    const key = validIdempotency(idempotencyKey);
    const result = db.transaction((tx) => {
        const [existing] = tx.select().from(quizAttempts).where(eq(quizAttempts.idempotencyKey, key)).limit(1).all();
        if (existing) {
            if (existing.userId !== userId || existing.quizId !== quizId)
                throw new QuizError("The idempotency key is already used for another attempt.", "IDEMPOTENCY_CONFLICT", 409);
            return existing;
        }
        const [version] = tx.select().from(quizVersions).where(and(eq(quizVersions.quizId, quizId), eq(quizVersions.published, true))).orderBy(desc(quizVersions.version)).limit(1).all();
        if (!version)
            throw new QuizError("Quiz not found.", "QUIZ_NOT_FOUND", 404);
        const [quiz] = tx.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1).all();
        if (!quiz)
            throw new QuizError("Quiz not found.", "QUIZ_NOT_FOUND", 404);
        const questionCount = Number(tx.select({ count: sql `count(*)` }).from(quizQuestions).where(eq(quizQuestions.quizVersionId, version.id)).all()[0]?.count ?? 0);
        const expiresAt = version.timeLimitSeconds ? new Date(now.getTime() + version.timeLimitSeconds * 1000) : null;
        const [attempt] = tx.insert(quizAttempts).values({
            userId,
            quizId,
            quizVersionId: version.id,
            status: "in_progress",
            startedAt: now,
            expiresAt,
            totalQuestions: questionCount,
            firstAttempt: false,
            pointsStatus: "not_applicable",
            previousScorePercent: null,
            idempotencyKey: key,
            createdAt: now,
            updatedAt: now,
        }).returning().all();
        if (!attempt)
            throw new QuizError("Quiz attempt could not be started.", "ATTEMPT_WRITE_FAILED", 500);
        tx.insert(auditEvents).values(buildQuizAuditRecord({
            actorUserId: userId,
            action: "quiz.attempt.started",
            targetType: "quiz_attempt",
            targetId: attempt.id,
            metadata: { status: "in_progress", resourceType: "quiz_attempt", resourceId: attempt.id },
            auditContext,
        }, now)).run();
        return attempt;
    });
    return { attempt: publicAttempt(result) };
}
export async function getQuizAttempt(userId, attemptId) {
    validId(userId, "user ID");
    validId(attemptId, "attempt ID");
    const [attempt] = await db.select().from(quizAttempts).where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.userId, userId))).limit(1).all();
    if (!attempt)
        throw new QuizError("Quiz attempt not found.", "ATTEMPT_NOT_FOUND", 404);
    if (attempt.status === "in_progress" && attempt.expiresAt && attempt.expiresAt.getTime() <= Date.now()) {
        await submitQuizAttempt(userId, attemptId, [], new Date());
        const [expired] = await db.select().from(quizAttempts).where(eq(quizAttempts.id, attemptId)).limit(1).all();
        if (expired)
            return { attempt: publicAttempt(expired), result: resultFromAttempt(expired) };
    }
    return {
        attempt: publicAttempt(attempt),
        result: attempt.status === "in_progress" ? null : resultFromAttempt(attempt),
    };
}
export async function submitQuizAttempt(userId, attemptId, answers, now = new Date(), auditContext) {
    validId(userId, "user ID");
    validId(attemptId, "attempt ID");
    const graded = db.transaction((tx) => {
        const [attempt] = tx.select().from(quizAttempts).where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.userId, userId))).limit(1).all();
        if (!attempt)
            throw new QuizError("Quiz attempt not found.", "ATTEMPT_NOT_FOUND", 404);
        if (attempt.status !== "in_progress") {
            return { attempt, topicResults: tx.select().from(quizTopicResults).where(eq(quizTopicResults.attemptId, attempt.id)).all() };
        }
        if (attempt.expiresAt && attempt.expiresAt.getTime() <= now.getTime()) {
            const priorScore = previousScore(userId, attempt.quizId);
            const [expired] = tx.update(quizAttempts).set({ status: "expired", scorePercent: 0, correctCount: 0, passed: false, submittedAt: now, firstAttempt: completedAttemptCount(tx, userId, attempt.quizId) === 0, pointsStatus: "not_applicable", previousScorePercent: priorScore, updatedAt: now }).where(and(eq(quizAttempts.id, attempt.id), eq(quizAttempts.status, "in_progress"))).returning().all();
            if (!expired)
                throw new QuizError("Attempt changed; retry the request.", "ATTEMPT_CONFLICT", 409);
            tx.insert(auditEvents).values(buildQuizAuditRecord({
                actorUserId: userId,
                action: "quiz.attempt.expired",
                targetType: "quiz_attempt",
                targetId: attempt.id,
                metadata: { status: "expired", resourceType: "quiz_attempt", resourceId: attempt.id },
                auditContext,
            }, now)).run();
            return { attempt: expired, topicResults: [] };
        }
        const questions = tx.select().from(quizQuestions).where(eq(quizQuestions.quizVersionId, attempt.quizVersionId)).orderBy(asc(quizQuestions.sortOrder), asc(quizQuestions.id)).all();
        const questionMap = new Map(questions.map((question) => [question.id, question]));
        const answerMap = new Map();
        for (const answer of answers) {
            if (!questionMap.has(answer.questionId))
                throw new QuizError("An answer references a question outside this attempt.", "VALIDATION_ERROR");
            if (answerMap.has(answer.questionId))
                throw new QuizError("A question can only be answered once.", "VALIDATION_ERROR");
            const [option] = tx.select({ optionKey: quizOptions.optionKey }).from(quizOptions).where(and(eq(quizOptions.questionId, answer.questionId), eq(quizOptions.optionKey, answer.optionKey))).limit(1).all();
            if (!option)
                throw new QuizError("An answer references an invalid option.", "VALIDATION_ERROR");
            answerMap.set(answer.questionId, answer);
        }
        answerMap.forEach((answer) => tx.insert(quizAttemptAnswers).values({ attemptId: attempt.id, questionId: answer.questionId, optionKey: answer.optionKey, answeredAt: now }).run());
        let correct = 0;
        const topicStats = new Map();
        for (const question of questions) {
            const stats = topicStats.get(question.topic) ?? { correct: 0, total: 0 };
            stats.total += 1;
            const answer = answerMap.get(question.id);
            if (answer) {
                const [correctOption] = tx.select({ id: quizOptions.id }).from(quizOptions).where(and(eq(quizOptions.questionId, question.id), eq(quizOptions.optionKey, answer.optionKey), eq(quizOptions.isCorrect, true))).limit(1).all();
                if (correctOption) {
                    correct += 1;
                    stats.correct += 1;
                }
            }
            topicStats.set(question.topic, stats);
        }
        const scorePercent = percentage(correct, questions.length);
        const [version] = tx.select().from(quizVersions).where(eq(quizVersions.id, attempt.quizVersionId)).limit(1).all();
        if (!version)
            throw new QuizError("Quiz version not found.", "QUIZ_VERSION_NOT_FOUND", 500);
        const passed = scorePercent >= version.passMark;
        const previousScorePercent = previousScore(userId, attempt.quizId);
        const firstCompletedAttempt = completedAttemptCount(tx, userId, attempt.quizId) === 0;
        const pointsStatus = firstCompletedAttempt && correct > 0 ? "pending" : "not_applicable";
        const [submitted] = tx.update(quizAttempts).set({ status: "submitted", scorePercent, correctCount: correct, passed, submittedAt: now, firstAttempt: firstCompletedAttempt, pointsStatus, previousScorePercent, updatedAt: now }).where(and(eq(quizAttempts.id, attempt.id), eq(quizAttempts.status, "in_progress"))).returning().all();
        if (!submitted)
            throw new QuizError("Attempt changed; retry the request.", "ATTEMPT_CONFLICT", 409);
        tx.insert(auditEvents).values(buildQuizAuditRecord({
            actorUserId: userId,
            action: "quiz.attempt.submitted",
            targetType: "quiz_attempt",
            targetId: attempt.id,
            metadata: { status: "submitted", result: scorePercent, resourceType: "quiz_attempt", resourceId: attempt.id },
            auditContext,
        }, now)).run();
        const topicResults = [];
        topicStats.forEach((stats, topic) => {
            const [topicResult] = tx.insert(quizTopicResults).values({ attemptId: attempt.id, userId, categoryCode: version.categoryCode, topic, correctCount: stats.correct, totalQuestions: stats.total, scorePercent: percentage(stats.correct, stats.total), createdAt: now }).returning().all();
            if (topicResult)
                topicResults.push(topicResult);
            const [rule] = tx.select().from(quizRecommendationRules).where(and(eq(quizRecommendationRules.topic, topic), eq(quizRecommendationRules.active, true))).limit(1).all();
            const threshold = rule?.thresholdPercent ?? 70;
            if (percentage(stats.correct, stats.total) < threshold) {
                const reason = rule?.reasonTemplate.replace("{score}", String(percentage(stats.correct, stats.total))) ?? `Your ${topic} score is ${percentage(stats.correct, stats.total)}%; review this topic before your next attempt.`;
                const [openRecommendation] = tx.select().from(quizRecommendations).where(and(eq(quizRecommendations.userId, userId), eq(quizRecommendations.topic, topic), eq(quizRecommendations.status, "open"))).limit(1).all();
                const [recommendation] = tx.insert(quizRecommendations).values({ userId, topic, categoryCode: version.categoryCode, scorePercent: percentage(stats.correct, stats.total), thresholdPercent: threshold, reason, status: "open", sourceAttemptId: attempt.id, createdAt: now, updatedAt: now }).onConflictDoUpdate({
                    target: [quizRecommendations.userId, quizRecommendations.topic, quizRecommendations.status],
                    set: { categoryCode: version.categoryCode, scorePercent: percentage(stats.correct, stats.total), thresholdPercent: threshold, reason, sourceAttemptId: attempt.id, updatedAt: now },
                }).returning().all();
                if (recommendation && !openRecommendation)
                    tx.insert(notifications).values({ userId, type: "learning_recommendation", title: `Recommended learning: ${topic}`, body: reason, link: `/private/knowledge?topic=${encodeURIComponent(topic)}`, createdAt: now, updatedAt: now }).run();
            }
        });
        return { attempt: submitted, previousScorePercent, topicResults };
    });
    let pointsAwarded = graded.attempt.pointsAwarded;
    if (graded.attempt.status === "submitted" && graded.attempt.firstAttempt && ["pending", "failed"].includes(graded.attempt.pointsStatus) && (graded.attempt.correctCount ?? 0) > 0) {
        try {
            const [rule] = await db.select({ points: pointRules.points }).from(pointRules).where(and(eq(pointRules.code, "quiz_correct"), eq(pointRules.active, true))).limit(1).all();
            if (!rule)
                throw new QuizError("Quiz points policy is not configured.", "POINT_RULE_NOT_CONFIGURED", 409);
            const answers = await db.select().from(quizAttemptAnswers).where(eq(quizAttemptAnswers.attemptId, graded.attempt.id)).orderBy(asc(quizAttemptAnswers.questionId)).all();
            for (const answer of answers) {
                const [correct] = await db.select({ id: quizOptions.id }).from(quizOptions).where(and(eq(quizOptions.questionId, answer.questionId), eq(quizOptions.optionKey, answer.optionKey), eq(quizOptions.isCorrect, true))).limit(1).all();
                if (!correct)
                    continue;
                const award = await awardPoints({ userId, amount: rule.points, eventType: "quiz_correct", sourceType: "quiz_attempt", sourceId: `${graded.attempt.id}:${answer.questionId}`, idempotencyKey: `quiz:${graded.attempt.id}:question:${answer.questionId}:points`, actorUserId: userId, sessionId: auditContext?.sessionId ?? null, ipAddress: auditContext?.ipAddress, userAgent: auditContext?.userAgent });
                pointsAwarded += award.ledger.amount;
            }
            await db.update(quizAttempts).set({ pointsAwarded, pointsStatus: "awarded", updatedAt: new Date() }).where(and(eq(quizAttempts.id, graded.attempt.id), inArray(quizAttempts.pointsStatus, ["pending", "failed"]))).run();
        }
        catch (error) {
            await db.update(quizAttempts).set({ pointsStatus: "failed", updatedAt: new Date() }).where(and(eq(quizAttempts.id, graded.attempt.id), inArray(quizAttempts.pointsStatus, ["pending", "failed"]))).run();
            throw error;
        }
    }
    const finalAttempt = (await db.select().from(quizAttempts).where(eq(quizAttempts.id, graded.attempt.id)).limit(1).all())[0] ?? graded.attempt;
    return { result: { ...resultFromAttempt(finalAttempt), pointsAwarded }, topics: graded.topicResults };
}
export async function getJourney(userId) {
    validId(userId, "user ID");
    const results = await db.select().from(quizTopicResults).where(eq(quizTopicResults.userId, userId)).orderBy(desc(quizTopicResults.createdAt), desc(quizTopicResults.id)).limit(1000).all();
    const latestByAttemptTopic = new Map();
    for (const row of results) {
        const key = `${row.attemptId}:${row.topic}`;
        if (!latestByAttemptTopic.has(key))
            latestByAttemptTopic.set(key, row);
    }
    const rows = Array.from(latestByAttemptTopic.values());
    const resultAttemptIds = Array.from(new Set(rows.map((row) => row.attemptId)));
    const attempts = await db.select({ attempt: quizAttempts, quiz: quizzes, version: quizVersions })
        .from(quizAttempts).innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId)).innerJoin(quizVersions, eq(quizVersions.id, quizAttempts.quizVersionId))
        .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.status, ["submitted", "expired"])))
        .orderBy(desc(quizAttempts.submittedAt), desc(quizAttempts.id)).limit(400).all();
    const metadataIds = Array.from(new Set(resultAttemptIds.concat(attempts.map(({ attempt }) => attempt.id))));
    const metadataRows = [];
    for (let offset = 0; offset < metadataIds.length; offset += 800) {
        metadataRows.push(...await db.select({ attempt: quizAttempts, quiz: quizzes, version: quizVersions })
            .from(quizAttempts).innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId)).innerJoin(quizVersions, eq(quizVersions.id, quizAttempts.quizVersionId))
            .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.id, metadataIds.slice(offset, offset + 800)))).all());
    }
    const metadataByAttemptId = new Map(metadataRows.map((row) => [row.attempt.id, row]));
    const topicGroups = new Map();
    for (const row of rows)
        topicGroups.set(row.topic, [...(topicGroups.get(row.topic) ?? []), row]);
    const topics = Array.from(topicGroups.entries()).map(([topic, history]) => {
        const latest = history[0];
        const chronologicalResults = history.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
        const latestByQuiz = new Map();
        const quizMetadata = new Map();
        for (const item of history) {
            const metadata = metadataByAttemptId.get(item.attemptId);
            if (metadata && !latestByQuiz.has(metadata.attempt.quizId))
                latestByQuiz.set(metadata.attempt.quizId, item);
            if (metadata && !quizMetadata.has(metadata.attempt.quizId))
                quizMetadata.set(metadata.attempt.quizId, { level: metadata.version.level, quizTitle: metadata.quiz.title });
        }
        const currentEvidence = Array.from(latestByQuiz.values());
        const weightedCorrect = currentEvidence.reduce((sum, item) => sum + item.correctCount, 0);
        const weightedTotal = currentEvidence.reduce((sum, item) => sum + item.totalQuestions, 0);
        const evidence = Array.from(quizMetadata.values());
        return {
            topic,
            categoryCode: latest.categoryCode,
            scorePercent: percentage(weightedCorrect, weightedTotal),
            correctCount: weightedCorrect,
            totalQuestions: weightedTotal,
            quizCount: currentEvidence.length,
            levels: Array.from(new Set(evidence.map((item) => item.level).filter((value) => Boolean(value)))),
            quizTitles: Array.from(new Set(evidence.map((item) => item.quizTitle).filter((value) => Boolean(value)))),
            limitedEvidence: weightedTotal < 3,
            trend: history.slice(0, 5).map((item) => item.scorePercent),
            improvement: chronologicalResults.length > 1 ? { firstScorePercent: chronologicalResults[0].scorePercent, latestScorePercent: chronologicalResults.at(-1).scorePercent, attempts: chronologicalResults.length } : null,
        };
    }).sort((a, b) => a.scorePercent - b.scorePercent || a.topic.localeCompare(b.topic));
    const latestByQuizTopic = new Map();
    for (const row of rows) {
        const metadata = metadataByAttemptId.get(row.attemptId);
        if (metadata) {
            const key = `${metadata.attempt.quizId}:${row.topic}`;
            if (!latestByQuizTopic.has(key))
                latestByQuizTopic.set(key, row);
        }
    }
    const categoryStats = new Map();
    for (const row of Array.from(latestByQuizTopic.values())) {
        const stats = categoryStats.get(row.categoryCode) ?? { correct: 0, total: 0, quizzes: new Set() };
        stats.correct += row.correctCount;
        stats.total += row.totalQuestions;
        stats.quizzes.add(row.attemptId);
        categoryStats.set(row.categoryCode, stats);
    }
    const categories = Array.from(categoryStats.entries()).map(([categoryCode, stats]) => ({ categoryCode, scorePercent: percentage(stats.correct, stats.total), correctCount: stats.correct, totalQuestions: stats.total, quizCount: stats.quizzes.size }));
    const recommendations = await db.select().from(quizRecommendations).where(and(eq(quizRecommendations.userId, userId), eq(quizRecommendations.status, "open"))).orderBy(desc(quizRecommendations.createdAt), desc(quizRecommendations.id)).all();
    const openRecommendations = recommendations.slice(0, 10);
    const articleCards = new Map();
    for (const recommendation of openRecommendations) {
        const candidates = await db.select({
            id: articles.id, title: articles.title, summary: articles.summary, categoryCode: articles.categoryCode,
            topic: articles.topic, difficulty: articles.difficulty, readingMinutes: articles.readingMinutes,
            contentType: articles.contentType, url: articles.url, updatedAt: articles.updatedAt,
        }).from(articles).where(and(eq(articles.published, true), or(eq(articles.topic, recommendation.topic), eq(articles.categoryCode, recommendation.categoryCode)), notExists(db.select({ id: articleCompletions.id }).from(articleCompletions).where(and(eq(articleCompletions.userId, userId), eq(articleCompletions.articleId, articles.id)))))).orderBy(desc(articles.updatedAt), desc(articles.id)).limit(12).all();
        for (const article of candidates) {
            if (article.contentType === "external" && !safeArticleUrl(article.url))
                continue;
            if (!articleCards.has(article.id))
                articleCards.set(article.id, {
                    id: article.id, title: article.title, summary: article.summary, category: article.categoryCode, topic: article.topic,
                    difficulty: article.difficulty, readingMinutes: article.readingMinutes, contentType: article.contentType,
                    sourceUrl: article.contentType === "external" ? safeArticleUrl(article.url) : null,
                    recommendation,
                });
            if (articleCards.size >= 20)
                break;
        }
        if (articleCards.size >= 20)
            break;
    }
    const articleRows = Array.from(articleCards.values());
    const sourceAttemptIds = Array.from(new Set(articleRows.map((article) => article.recommendation.sourceAttemptId)));
    const sourceAttempts = sourceAttemptIds.length ? await db.select({ id: quizAttempts.id, quizId: quizAttempts.quizId }).from(quizAttempts)
        .where(and(eq(quizAttempts.userId, userId), inArray(quizAttempts.id, sourceAttemptIds))).all() : [];
    const sourceQuizIds = new Map(sourceAttempts.map((attempt) => [attempt.id, attempt.quizId]));
    const relatedQuizIds = await relatedQuizIdsForArticles(articleRows.map((article) => ({ id: article.id, categoryCode: article.category, topic: article.topic, preferredQuizId: sourceQuizIds.get(article.recommendation.sourceAttemptId) })));
    const recommendedArticles = articleRows.map((article) => ({ ...article, relatedQuizId: relatedQuizIds.get(article.id) ?? null }));
    const nextRecommendedStep = recommendations[0] ?? null;
    const nextArticle = nextRecommendedStep ? recommendedArticles.find((item) => item.recommendation.id === nextRecommendedStep.id) ?? recommendedArticles[0] ?? null : recommendedArticles[0] ?? null;
    const recentQuizzes = attempts.slice(0, 10).map(({ attempt, quiz, version }) => ({
        attemptId: attempt.id, quizId: quiz.id, title: quiz.title, categoryCode: version.categoryCode, level: version.level,
        scorePercent: attempt.scorePercent ?? 0, passed: attempt.passed ?? false, status: attempt.status,
        submittedAt: attempt.submittedAt, correctCount: attempt.correctCount ?? 0, totalQuestions: attempt.totalQuestions,
    }));
    const activityDays = new Set(attempts.map(({ attempt }) => attempt.submittedAt?.toISOString().slice(0, 10)).filter((day) => Boolean(day)));
    let streakDays = 0;
    const cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    if (!activityDays.has(cursor.toISOString().slice(0, 10)))
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    while (activityDays.has(cursor.toISOString().slice(0, 10)) && streakDays < 365) {
        streakDays += 1;
        cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return {
        topics, categories, recommendations: openRecommendations, nextRecommendedStep,
        nextRecommendedArticle: nextArticle ? { id: nextArticle.id, title: nextArticle.title, relatedQuizId: nextArticle.relatedQuizId } : null,
        recommendedArticles,
        improvement: topics.flatMap((topic) => topic.improvement ? [{ topic: topic.topic, ...topic.improvement }] : []).slice(0, 10),
        recentQuizzes,
        streakDays,
    };
}
function safeArticleUrl(url) {
    if (!url)
        return null;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && Boolean(parsed.hostname) && !parsed.username && !parsed.password ? parsed.toString() : null;
    }
    catch {
        return null;
    }
}
export async function getRankings(userId, scope = "bank") {
    validId(userId, "user ID");
    const [viewer] = await db.select({ department: users.department }).from(users).where(eq(users.id, userId)).limit(1).all();
    const where = scope === "department" && viewer ? and(eq(users.isActive, true), eq(users.department, viewer.department)) : eq(users.isActive, true);
    const rows = await db.select({ name: users.name, department: users.department, points: sql `coalesce(sum(${pointsLedger.amount}), 0)` })
        .from(users)
        .leftJoin(pointsLedger, eq(pointsLedger.userId, users.id))
        .where(where)
        .groupBy(users.id, users.name, users.department)
        .orderBy(desc(sql `coalesce(sum(${pointsLedger.amount}), 0)`), asc(users.name), asc(users.id))
        .limit(100)
        .all();
    return rows.map((row, index) => ({ ...row, points: Number(row.points), rank: index + 1 }));
}
export async function listChallenges(userId, now = new Date()) {
    validId(userId, "user ID");
    const rows = await db.select({ id: quizChallenges.id, title: quizChallenges.title, question: quizChallenges.question, deadlineAt: quizChallenges.deadlineAt, points: quizChallenges.points, participants: sql `count(${quizChallengeParticipants.id})`, joined: sql `max(case when ${quizChallengeParticipants.userId} = ${userId} then 1 else 0 end)` })
        .from(quizChallenges)
        .leftJoin(quizChallengeParticipants, eq(quizChallengeParticipants.challengeId, quizChallenges.id))
        .where(and(eq(quizChallenges.active, true), gt(quizChallenges.deadlineAt, now)))
        .groupBy(quizChallenges.id)
        .orderBy(asc(quizChallenges.deadlineAt), asc(quizChallenges.id))
        .all();
    return rows.map((row) => ({ ...row, participants: Number(row.participants), joined: Boolean(row.joined) }));
}
export async function joinChallenge(userId, challengeId, idempotencyKey, now = new Date(), auditContext) {
    validId(userId, "user ID");
    validId(challengeId, "challenge ID");
    const key = validIdempotency(idempotencyKey);
    const joined = db.transaction((tx) => {
        const [replayed] = tx.select().from(quizChallengeParticipants).where(eq(quizChallengeParticipants.idempotencyKey, key)).limit(1).all();
        if (replayed) {
            if (replayed.userId !== userId || replayed.challengeId !== challengeId)
                throw new QuizError("The idempotency key is already used for another challenge.", "IDEMPOTENCY_CONFLICT", 409);
            return { participant: replayed, award: replayed.pointsStatus !== "awarded" };
        }
        const [challenge] = tx.select().from(quizChallenges).where(eq(quizChallenges.id, challengeId)).limit(1).all();
        if (!challenge || !challenge.active)
            throw new QuizError("Challenge not found.", "CHALLENGE_NOT_FOUND", 404);
        if (challenge.deadlineAt.getTime() <= now.getTime())
            throw new QuizError("This challenge is closed.", "CHALLENGE_CLOSED", 409);
        const [rule] = tx.select({ points: pointRules.points }).from(pointRules).where(and(eq(pointRules.code, "challenge_join"), eq(pointRules.active, true))).limit(1).all();
        if (!rule)
            throw new QuizError("Challenge points policy is not configured.", "POINT_RULE_NOT_CONFIGURED", 409);
        if (challenge.points !== rule.points)
            throw new QuizError("Challenge points do not match the active points policy.", "CHALLENGE_POINTS_MISMATCH", 409);
        const [existing] = tx.select().from(quizChallengeParticipants).where(and(eq(quizChallengeParticipants.challengeId, challengeId), eq(quizChallengeParticipants.userId, userId))).limit(1).all();
        if (existing)
            return { participant: existing, award: existing.pointsStatus !== "awarded" };
        const [participant] = tx.insert(quizChallengeParticipants).values({ challengeId, userId, idempotencyKey: key, joinedAt: now, pointsAwarded: 0, pointsStatus: "pending" }).returning().all();
        if (!participant)
            throw new QuizError("Challenge join could not be recorded.", "CHALLENGE_WRITE_FAILED", 500);
        tx.insert(auditEvents).values(buildQuizAuditRecord({
            actorUserId: userId,
            action: "quiz.challenge.joined",
            targetType: "quiz_challenge",
            targetId: challengeId,
            metadata: { status: "joined", resourceType: "quiz_challenge", resourceId: challengeId },
            auditContext,
        }, now)).run();
        return { participant, award: true };
    });
    let pointsAwarded = 0;
    if (joined.award && joined.participant.pointsStatus !== "awarded") {
        try {
            const [challenge] = await db.select({ points: quizChallenges.points }).from(quizChallenges).where(eq(quizChallenges.id, challengeId)).limit(1).all();
            const [rule] = await db.select({ points: pointRules.points }).from(pointRules).where(and(eq(pointRules.code, "challenge_join"), eq(pointRules.active, true))).limit(1).all();
            if (!challenge || !rule || challenge.points !== rule.points)
                throw new QuizError("Challenge points do not match the active points policy.", "CHALLENGE_POINTS_MISMATCH", 409);
            const award = await awardPoints({ userId, amount: challenge.points, eventType: "challenge_join", sourceType: "quiz_challenge", sourceId: String(challengeId), idempotencyKey: `challenge:${challengeId}:user:${userId}:points`, actorUserId: userId, sessionId: auditContext?.sessionId ?? null, ipAddress: auditContext?.ipAddress, userAgent: auditContext?.userAgent });
            pointsAwarded = award.ledger.amount;
            await db.update(quizChallengeParticipants).set({ pointsAwarded, pointsStatus: "awarded" }).where(and(eq(quizChallengeParticipants.id, joined.participant.id), inArray(quizChallengeParticipants.pointsStatus, ["pending", "failed"]))).run();
        }
        catch (error) {
            await db.update(quizChallengeParticipants).set({ pointsStatus: "failed" }).where(and(eq(quizChallengeParticipants.id, joined.participant.id), inArray(quizChallengeParticipants.pointsStatus, ["pending", "failed"]))).run();
            throw error;
        }
    }
    return { participant: { ...joined.participant, pointsAwarded: pointsAwarded || joined.participant.pointsAwarded }, pointsAwarded };
}
