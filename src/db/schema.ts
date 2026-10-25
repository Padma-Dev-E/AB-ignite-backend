import { relations } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
};

export const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  email: text().notNull(),
  role: text({ enum: ["employee", "back_office", "business_owner"] }).notNull().default("employee"),
  department: text().notNull().default("Other"),
  jobTitle: text(),
  passwordHash: text().notNull(),
  mustChangePassword: integer({ mode: "boolean" }).notNull().default(false),
  isActive: integer({ mode: "boolean" }).notNull().default(true),
  failedLoginAttempts: integer().notNull().default(0),
  lockedUntil: integer({ mode: "timestamp_ms" }),
  lastFailedLoginAt: integer({ mode: "timestamp_ms" }),
  lastLoginAt: integer({ mode: "timestamp_ms" }),
  lastSeenAt: integer({ mode: "timestamp_ms" }),
  sessionVersion: integer().notNull().default(0),
  deactivatedAt: integer({ mode: "timestamp_ms" }),
  points: integer().notNull().default(0),
  rank: integer(),
  ...timestamps,
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const refreshTokens = sqliteTable("refresh_tokens", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text().notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  idleExpiresAt: integer({ mode: "timestamp_ms" }),
  absoluteExpiresAt: integer({ mode: "timestamp_ms" }),
  ipHash: text(),
  userAgentHash: text(),
  lastSeenAt: integer({ mode: "timestamp_ms" }),
  sessionVersion: integer().notNull().default(0),
  revokedAt: integer({ mode: "timestamp_ms" }),
  revocationReason: text(),
  rotatedFromId: integer(),
  ...timestamps,
}, (table) => [
  uniqueIndex("refresh_tokens_hash_unique").on(table.tokenHash),
  index("refresh_tokens_user_idx").on(table.userId),
  index("refresh_tokens_expiry_idx").on(table.expiresAt),
]);

export const auditEvents = sqliteTable("audit_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  actorUserId: integer().references(() => users.id, { onDelete: "set null" }),
  sessionId: integer().references(() => refreshTokens.id, { onDelete: "set null" }),
  action: text().notNull(),
  targetType: text(),
  targetId: text(),
  reason: text(),
  metadataJson: text(),
  ipHash: text(),
  userAgentHash: text(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("audit_events_actor_idx").on(table.actorUserId, table.createdAt),
  index("audit_events_action_idx").on(table.action, table.createdAt),
  index("audit_events_target_idx").on(table.targetType, table.targetId, table.createdAt),
]);

export const ideas = sqliteTable("ideas", {
  id: integer().primaryKey({ autoIncrement: true }),
  authorId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text({ enum: ["idea", "problem"] }).notNull().default("idea"),
  title: text().notNull(),
  summary: text().notNull(),
  problem: text(),
  solution: text(),
  benefits: text(),
  risks: text(),
  category: text().notNull(),
  status: text({ enum: ["draft", "screening", "returned", "business_review", "control_review", "decision", "poc", "implementation", "implemented", "rejected", "deferred"] }).notNull().default("screening"),
  assignedUserId: integer().references(() => users.id, { onDelete: "set null" }),
  dueAt: integer({ mode: "timestamp_ms" }),
  priorityBand: text({ enum: ["Watch", "Quality", "Priority"] }),
  priorityScore: real(),
  reference: text().notNull(),
  challengeId: integer(),
  buildsOnId: integer(),
  supports: integer().notNull().default(0),
  comments: integer().notNull().default(0),
  ...timestamps,
}, (table) => [
  uniqueIndex("ideas_reference_unique").on(table.reference),
  index("ideas_author_idx").on(table.authorId),
  index("ideas_status_idx").on(table.status),
  index("ideas_assignment_due_idx").on(table.assignedUserId, table.dueAt),
]);

export const ideaVersions = sqliteTable("idea_versions", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  authorId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  kind: text({ enum: ["idea", "problem"] }).notNull(),
  title: text().notNull(),
  summary: text().notNull(),
  problem: text(),
  solution: text(),
  benefits: text(),
  risks: text(),
  category: text().notNull(),
  dataClassification: text({ enum: ["public", "internal", "confidential", "restricted"] }).notNull().default("internal"),
  contentHash: text().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("idea_versions_idea_version_unique").on(table.ideaId, table.version),
  index("idea_versions_idea_idx").on(table.ideaId, table.createdAt),
]);

export const ideaSubmissions = sqliteTable("idea_submissions", {
  ideaId: integer().primaryKey().references(() => ideas.id, { onDelete: "cascade" }),
  answersJson: text().notNull(),
  metricsJson: text().notNull(),
  score: real().notNull(),
  minimumScore: real().notNull(),
  validationPassed: integer({ mode: "boolean" }).notNull().default(false),
  aiValidationScore: real(),
  aiValidationAttempts: integer().notNull().default(0),
  submittedWithLowAiScore: integer({ mode: "boolean" }).notNull().default(false),
  differentiation: text(),
  submittedAt: integer({ mode: "timestamp_ms" }),
  ...timestamps,
});

export const ideaSettings = sqliteTable("idea_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedBy: integer().references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const ideaReferenceSequences = sqliteTable("idea_reference_sequences", {
  year: integer().primaryKey(),
  lastValue: integer().notNull().default(0),
});

export const aiRuns = sqliteTable("ai_runs", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  ideaVersionId: integer().references(() => ideaVersions.id, { onDelete: "set null" }),
  jobKey: text().notNull(),
  jobVersion: text().notNull(),
  promptVersion: text().notNull(),
  model: text().notNull(),
  status: text({ enum: ["queued", "running", "succeeded", "failed", "timed_out", "cancelled"] }).notNull().default("queued"),
  idempotencyKey: text().notNull(),
  correlationId: text().notNull(),
  requestedBy: integer().references(() => users.id, { onDelete: "set null" }),
  inputHash: text().notNull(),
  attemptCount: integer().notNull().default(0),
  resultJson: text(),
  usageJson: text(),
  finishReason: text(),
  errorCode: text(),
  errorMessage: text(),
  workerId: text(),
  availableAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  startedAt: integer({ mode: "timestamp_ms" }),
  completedAt: integer({ mode: "timestamp_ms" }),
  ...timestamps,
}, (table) => [
  uniqueIndex("ai_runs_idempotency_unique").on(table.idempotencyKey),
  index("ai_runs_idea_idx").on(table.ideaId, table.createdAt),
  index("ai_runs_status_available_idx").on(table.status, table.availableAt),
  index("ai_runs_correlation_idx").on(table.correlationId),
]);

export const ideaAiResults = sqliteTable("idea_ai_results", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  ideaVersionId: integer().references(() => ideaVersions.id, { onDelete: "set null" }),
  runId: integer().notNull().references(() => aiRuns.id, { onDelete: "cascade" }),
  jobKey: text().notNull(),
  jobVersion: text().notNull(),
  resultJson: text().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("idea_ai_results_run_unique").on(table.runId),
  index("idea_ai_results_idea_idx").on(table.ideaId, table.createdAt),
]);

export const aiRunEvents = sqliteTable("ai_run_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  runId: integer().notNull().references(() => aiRuns.id, { onDelete: "cascade" }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  ideaVersionId: integer().references(() => ideaVersions.id, { onDelete: "set null" }),
  eventType: text({ enum: ["queued", "running", "succeeded", "failed", "retry"] }).notNull(),
  payloadJson: text().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("ai_run_events_run_created_idx").on(table.runId, table.createdAt, table.id),
  index("ai_run_events_idea_created_idx").on(table.ideaId, table.createdAt, table.id),
]);

export const ideaEvents = sqliteTable("idea_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  ideaVersionId: integer().references(() => ideaVersions.id, { onDelete: "set null" }),
  actorType: text({ enum: ["user", "admin", "system", "ai"] }).notNull(),
  actorId: integer().references(() => users.id, { onDelete: "set null" }),
  eventType: text().notNull(),
  fromStatus: text({ enum: ["screening", "returned", "business_review", "control_review", "decision", "poc", "implementation", "implemented", "rejected", "deferred"] }),
  toStatus: text({ enum: ["screening", "returned", "business_review", "control_review", "decision", "poc", "implementation", "implemented", "rejected", "deferred"] }),
  correlationId: text(),
  metadataJson: text(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index("idea_events_idea_idx").on(table.ideaId, table.createdAt),
  index("idea_events_correlation_idx").on(table.correlationId),
]);

export const ideaReviews = sqliteTable("idea_reviews", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  reviewerId: integer().references(() => users.id, { onDelete: "set null" }),
  decision: text({ enum: ["approved", "returned", "rejected", "deferred"] }).notNull(),
  reason: text().notNull(),
  conflictAcknowledged: integer({ mode: "boolean" }).notNull().default(false),
  ...timestamps,
}, (table) => [index("idea_reviews_idea_idx").on(table.ideaId, table.createdAt)]);

export const ideaComments = sqliteTable("idea_comments", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  authorId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text().notNull(),
  ...timestamps,
}, (table) => [index("idea_comments_idea_idx").on(table.ideaId)]);

export const ideaSupports = sqliteTable("idea_supports", {
  id: integer().primaryKey({ autoIncrement: true }),
  ideaId: integer().notNull().references(() => ideas.id, { onDelete: "cascade" }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("idea_supports_idea_user_unique").on(table.ideaId, table.userId),
  index("idea_supports_idea_idx").on(table.ideaId),
  index("idea_supports_user_idx").on(table.userId),
]);

export const notifications = sqliteTable("notifications", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text().notNull(),
  title: text().notNull(),
  body: text(),
  link: text(),
  isRead: integer({ mode: "boolean" }).notNull().default(false),
  ...timestamps,
}, (table) => [index("notifications_user_idx").on(table.userId, table.isRead)]);

export const notificationEmailDeliveries = sqliteTable("notification_email_deliveries", {
  notificationId: integer().primaryKey().references(() => notifications.id, { onDelete: "cascade" }),
  status: text({ enum: ["pending", "sending", "sent", "failed", "skipped"] }).notNull().default("pending"),
  attempts: integer().notNull().default(0),
  claimToken: text(),
  claimedUntil: integer({ mode: "timestamp_ms" }),
  nextAttemptAt: integer({ mode: "timestamp_ms" }),
  sentAt: integer({ mode: "timestamp_ms" }),
  lastErrorCode: text(),
  ...timestamps,
}, (table) => [index("notification_email_delivery_retry_idx").on(table.status, table.nextAttemptAt)]);

export const articles = sqliteTable("articles", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  summary: text().notNull(),
  body: text().notNull(),
  category: text().notNull(),
  topic: text(),
  publisher: text().notNull(),
  difficulty: text().notNull(),
  readingMinutes: integer().notNull(),
  publishedLabel: text(),
  url: text(),
  published: integer({ mode: "boolean" }).notNull().default(false),
  contentType: text({ enum: ["internal", "external"] }).notNull().default("internal"),
  categoryCode: text().notNull().default("general"),
  ...timestamps,
}, (table) => [index("articles_category_idx").on(table.category)]);

export const articleCompletions = sqliteTable("article_completions", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  articleId: integer().notNull().references(() => articles.id, { onDelete: "cascade" }),
  recommendationId: integer().references(() => quizRecommendations.id, { onDelete: "set null" }),
  idempotencyKey: text().notNull(),
  pointsAwarded: integer().notNull().default(0),
  completedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("article_completions_user_article_unique").on(table.userId, table.articleId),
  uniqueIndex("article_completions_idempotency_unique").on(table.userId, table.idempotencyKey),
  index("article_completions_user_idx").on(table.userId, table.completedAt),
]);

export const feedbackCampaigns = sqliteTable("feedback_campaigns", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  description: text().notNull(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  pinned: integer({ mode: "boolean" }).notNull().default(false),
  startsAt: integer({ mode: "timestamp_ms" }),
  endsAt: integer({ mode: "timestamp_ms" }),
  createdBy: integer().references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [index("feedback_campaigns_active_idx").on(table.active, table.pinned)]);

export const announcements = sqliteTable("announcements", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  body: text().notNull(),
  pinned: integer({ mode: "boolean" }).notNull().default(false),
  published: integer({ mode: "boolean" }).notNull().default(false),
  createdBy: integer().references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [index("announcements_published_pinned_idx").on(table.published, table.pinned)]);

export const feedbackResponses = sqliteTable("feedback_responses", {
  id: integer().primaryKey({ autoIncrement: true }),
  campaignId: integer().notNull().references(() => feedbackCampaigns.id, { onDelete: "cascade" }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  category: text({ enum: ["experience", "ideas", "content", "technical", "other"] }).notNull(),
  message: text().notNull(),
  idempotencyKey: text().notNull(),
  respondedBy: integer().references(() => users.id, { onDelete: "set null" }),
  response: text(),
  respondedAt: integer({ mode: "timestamp_ms" }),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("feedback_responses_user_key_unique").on(table.userId, table.idempotencyKey),
  index("feedback_responses_campaign_idx").on(table.campaignId, table.createdAt),
  index("feedback_responses_user_idx").on(table.userId, table.createdAt),
]);

export const quizzes = sqliteTable("quizzes", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  category: text().notNull(),
  difficulty: text().notNull(),
  objective: text().notNull(),
  passMark: integer().notNull(),
  pointsPerQuestion: integer().notNull(),
  questionCount: integer().notNull(),
  timeLimitSeconds: integer(),
  ...timestamps,
}, (table) => [index("quizzes_category_idx").on(table.category)]);

export const quizCategories = sqliteTable("quiz_categories", {
  id: integer().primaryKey({ autoIncrement: true }),
  code: text().notNull(),
  name: text().notNull(),
  sortOrder: integer().notNull().default(0),
  active: integer({ mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("quiz_categories_code_unique").on(table.code),
  index("quiz_categories_active_idx").on(table.active, table.sortOrder),
]);

export const quizVersions = sqliteTable("quiz_versions", {
  id: integer().primaryKey({ autoIncrement: true }),
  quizId: integer().notNull().references(() => quizzes.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  categoryCode: text().notNull(),
  level: text().notNull(),
  objective: text().notNull(),
  passMark: integer().notNull(),
  pointsPerQuestion: integer().notNull(),
  timeLimitSeconds: integer(),
  published: integer({ mode: "boolean" }).notNull().default(false),
  publishedAt: integer({ mode: "timestamp_ms" }),
  createdBy: integer().references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [
  uniqueIndex("quiz_versions_quiz_version_unique").on(table.quizId, table.version),
  index("quiz_versions_catalogue_idx").on(table.categoryCode, table.level, table.published),
]);

export const quizQuestions = sqliteTable("quiz_questions", {
  id: integer().primaryKey({ autoIncrement: true }),
  quizVersionId: integer().notNull().references(() => quizVersions.id, { onDelete: "cascade" }),
  topic: text().notNull(),
  prompt: text().notNull(),
  sortOrder: integer().notNull(),
  points: integer().notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex("quiz_questions_version_order_unique").on(table.quizVersionId, table.sortOrder),
  index("quiz_questions_version_topic_idx").on(table.quizVersionId, table.topic),
]);

export const quizOptions = sqliteTable("quiz_options", {
  id: integer().primaryKey({ autoIncrement: true }),
  questionId: integer().notNull().references(() => quizQuestions.id, { onDelete: "cascade" }),
  optionKey: text().notNull(),
  label: text().notNull(),
  sortOrder: integer().notNull(),
  isCorrect: integer({ mode: "boolean" }).notNull().default(false),
}, (table) => [
  uniqueIndex("quiz_options_question_key_unique").on(table.questionId, table.optionKey),
  index("quiz_options_question_order_idx").on(table.questionId, table.sortOrder),
]);

export const quizAttempts = sqliteTable("quiz_attempts", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  quizId: integer().notNull().references(() => quizzes.id, { onDelete: "restrict" }),
  quizVersionId: integer().notNull().references(() => quizVersions.id, { onDelete: "restrict" }),
  status: text({ enum: ["in_progress", "submitted", "expired"] }).notNull().default("in_progress"),
  startedAt: integer({ mode: "timestamp_ms" }).notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }),
  submittedAt: integer({ mode: "timestamp_ms" }),
  scorePercent: integer(),
  correctCount: integer(),
  totalQuestions: integer().notNull(),
  passed: integer({ mode: "boolean" }),
  pointsAwarded: integer().notNull().default(0),
  pointsStatus: text({ enum: ["not_applicable", "pending", "awarded", "failed"] }).notNull().default("not_applicable"),
  previousScorePercent: integer(),
  firstAttempt: integer({ mode: "boolean" }).notNull().default(false),
  idempotencyKey: text().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("quiz_attempts_idempotency_unique").on(table.idempotencyKey),
  index("quiz_attempts_user_quiz_idx").on(table.userId, table.quizId, table.createdAt),
  index("quiz_attempts_status_expiry_idx").on(table.status, table.expiresAt),
]);

export const quizAttemptAnswers = sqliteTable("quiz_attempt_answers", {
  id: integer().primaryKey({ autoIncrement: true }),
  attemptId: integer().notNull().references(() => quizAttempts.id, { onDelete: "cascade" }),
  questionId: integer().notNull().references(() => quizQuestions.id, { onDelete: "restrict" }),
  optionKey: text().notNull(),
  answeredAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("quiz_attempt_answers_attempt_question_unique").on(table.attemptId, table.questionId),
  index("quiz_attempt_answers_attempt_idx").on(table.attemptId),
]);

export const quizTopicResults = sqliteTable("quiz_topic_results", {
  id: integer().primaryKey({ autoIncrement: true }),
  attemptId: integer().notNull().references(() => quizAttempts.id, { onDelete: "cascade" }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  categoryCode: text().notNull(),
  topic: text().notNull(),
  correctCount: integer().notNull(),
  totalQuestions: integer().notNull(),
  scorePercent: integer().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("quiz_topic_results_attempt_topic_unique").on(table.attemptId, table.topic),
  index("quiz_topic_results_user_topic_idx").on(table.userId, table.topic, table.createdAt),
]);

export const quizRecommendationRules = sqliteTable("quiz_recommendation_rules", {
  id: integer().primaryKey({ autoIncrement: true }),
  topic: text().notNull(),
  thresholdPercent: integer().notNull().default(70),
  reasonTemplate: text().notNull(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("quiz_recommendation_rules_topic_unique").on(table.topic),
  index("quiz_recommendation_rules_active_idx").on(table.active),
]);

export const quizRecommendations = sqliteTable("quiz_recommendations", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  topic: text().notNull(),
  categoryCode: text().notNull(),
  scorePercent: integer().notNull(),
  thresholdPercent: integer().notNull(),
  reason: text().notNull(),
  status: text({ enum: ["open", "completed", "dismissed"] }).notNull().default("open"),
  sourceAttemptId: integer().notNull().references(() => quizAttempts.id, { onDelete: "cascade" }),
  ...timestamps,
}, (table) => [
  uniqueIndex("quiz_recommendations_user_topic_open_unique").on(table.userId, table.topic, table.status),
  index("quiz_recommendations_user_status_idx").on(table.userId, table.status, table.createdAt),
]);

export const quizChallenges = sqliteTable("quiz_challenges", {
  id: integer().primaryKey({ autoIncrement: true }),
  title: text().notNull(),
  question: text().notNull(),
  deadlineAt: integer({ mode: "timestamp_ms" }).notNull(),
  points: integer().notNull().default(20),
  active: integer({ mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [index("quiz_challenges_open_idx").on(table.active, table.deadlineAt)]);

export const quizChallengeParticipants = sqliteTable("quiz_challenge_participants", {
  id: integer().primaryKey({ autoIncrement: true }),
  challengeId: integer().notNull().references(() => quizChallenges.id, { onDelete: "cascade" }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  idempotencyKey: text().notNull(),
  pointsAwarded: integer().notNull().default(0),
  pointsStatus: text({ enum: ["pending", "awarded", "failed"] }).notNull().default("pending"),
  joinedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("quiz_challenge_participants_unique").on(table.challengeId, table.userId),
  uniqueIndex("quiz_challenge_participants_idempotency_unique").on(table.idempotencyKey),
  index("quiz_challenge_participants_challenge_idx").on(table.challengeId, table.joinedAt),
]);

export const rewards = sqliteTable("rewards", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  description: text(),
  kind: text().notNull(),
  cost: integer().notNull(),
  emoji: text(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const pointRules = sqliteTable("point_rules", {
  id: integer().primaryKey({ autoIncrement: true }),
  code: text().notNull(),
  name: text().notNull(),
  description: text(),
  points: integer().notNull(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("point_rules_code_unique").on(table.code),
  index("point_rules_active_idx").on(table.active),
]);

export const pointsLedger = sqliteTable("points_ledger", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  amount: integer().notNull(),
  eventType: text().notNull(),
  sourceType: text().notNull(),
  sourceId: text(),
  idempotencyKey: text().notNull(),
  metadataJson: text(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("points_ledger_idempotency_unique").on(table.idempotencyKey),
  index("points_ledger_user_created_idx").on(table.userId, table.createdAt),
  index("points_ledger_source_idx").on(table.sourceType, table.sourceId),
]);

export const pointsBalances = sqliteTable("points_balances", {
  userId: integer().primaryKey().references(() => users.id, { onDelete: "cascade" }),
  balance: integer().notNull().default(0),
  totalEarned: integer().notNull().default(0),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const levels = sqliteTable("levels", {
  id: integer().primaryKey({ autoIncrement: true }),
  name: text().notNull(),
  description: text(),
  minimumPoints: integer().notNull(),
  sortOrder: integer().notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("levels_minimum_points_unique").on(table.minimumPoints),
  uniqueIndex("levels_sort_order_unique").on(table.sortOrder),
]);

export const badges = sqliteTable("badges", {
  id: integer().primaryKey({ autoIncrement: true }),
  code: text().notNull(),
  name: text().notNull(),
  description: text().notNull(),
  ruleJson: text().notNull(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("badges_code_unique").on(table.code),
  index("badges_active_idx").on(table.active),
]);

export const userBadges = sqliteTable("user_badges", {
  id: integer().primaryKey({ autoIncrement: true }),
  userId: integer().notNull().references(() => users.id, { onDelete: "cascade" }),
  badgeId: integer().notNull().references(() => badges.id, { onDelete: "cascade" }),
  awardedAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  metadataJson: text(),
}, (table) => [
  uniqueIndex("user_badges_user_badge_unique").on(table.userId, table.badgeId),
  index("user_badges_user_awarded_idx").on(table.userId, table.awardedAt),
]);

export const badgeAdminOperations = sqliteTable("badge_admin_operations", {
  id: integer().primaryKey({ autoIncrement: true }),
  keyHash: text().notNull(),
  actorUserId: integer().notNull().references(() => users.id, { onDelete: "restrict" }),
  badgeId: integer().notNull().references(() => badges.id, { onDelete: "restrict" }),
  action: text({ enum: ["create", "update"] }).notNull(),
  requestHash: text().notNull(),
  responseJson: text().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [uniqueIndex("badge_admin_operations_key_unique").on(table.keyHash)]);

export const rewardVersions = sqliteTable("reward_versions", {
  id: integer().primaryKey({ autoIncrement: true }),
  rewardId: integer().notNull().references(() => rewards.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  name: text().notNull(),
  description: text(),
  kind: text().notNull(),
  cost: integer().notNull(),
  emoji: text(),
  active: integer({ mode: "boolean" }).notNull(),
  createdBy: integer().references(() => users.id, { onDelete: "set null" }),
  createdAt: integer({ mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("reward_versions_reward_version_unique").on(table.rewardId, table.version),
  index("reward_versions_reward_created_idx").on(table.rewardId, table.createdAt),
]);

export const usersRelations = relations(users, ({ many }) => ({
  ideas: many(ideas),
  ideaVersions: many(ideaVersions),
  comments: many(ideaComments),
  notifications: many(notifications),
  supports: many(ideaSupports),
  refreshTokens: many(refreshTokens),
  auditEvents: many(auditEvents),
  aiRuns: many(aiRuns),
  ideaEvents: many(ideaEvents),
  ideaReviews: many(ideaReviews),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] }),
  session: one(refreshTokens, { fields: [auditEvents.sessionId], references: [refreshTokens.id] }),
}));

export const ideasRelations = relations(ideas, ({ one, many }) => ({
  author: one(users, { fields: [ideas.authorId], references: [users.id] }),
  comments: many(ideaComments),
  supports: many(ideaSupports),
  versions: many(ideaVersions),
  aiRuns: many(aiRuns),
  aiRunEvents: many(aiRunEvents),
  aiResults: many(ideaAiResults),
  events: many(ideaEvents),
  reviews: many(ideaReviews),
}));

export const ideaVersionsRelations = relations(ideaVersions, ({ one, many }) => ({
  idea: one(ideas, { fields: [ideaVersions.ideaId], references: [ideas.id] }),
  author: one(users, { fields: [ideaVersions.authorId], references: [users.id] }),
  aiRuns: many(aiRuns),
  aiRunEvents: many(aiRunEvents),
  aiResults: many(ideaAiResults),
  events: many(ideaEvents),
}));

export const aiRunsRelations = relations(aiRuns, ({ one, many }) => ({
  idea: one(ideas, { fields: [aiRuns.ideaId], references: [ideas.id] }),
  ideaVersion: one(ideaVersions, { fields: [aiRuns.ideaVersionId], references: [ideaVersions.id] }),
  requester: one(users, { fields: [aiRuns.requestedBy], references: [users.id] }),
  result: one(ideaAiResults, { fields: [aiRuns.id], references: [ideaAiResults.runId] }),
  events: many(aiRunEvents),
}));

export const aiRunEventsRelations = relations(aiRunEvents, ({ one }) => ({
  run: one(aiRuns, { fields: [aiRunEvents.runId], references: [aiRuns.id] }),
  idea: one(ideas, { fields: [aiRunEvents.ideaId], references: [ideas.id] }),
  ideaVersion: one(ideaVersions, { fields: [aiRunEvents.ideaVersionId], references: [ideaVersions.id] }),
}));

export const ideaAiResultsRelations = relations(ideaAiResults, ({ one }) => ({
  idea: one(ideas, { fields: [ideaAiResults.ideaId], references: [ideas.id] }),
  ideaVersion: one(ideaVersions, { fields: [ideaAiResults.ideaVersionId], references: [ideaVersions.id] }),
  run: one(aiRuns, { fields: [ideaAiResults.runId], references: [aiRuns.id] }),
}));

export const ideaEventsRelations = relations(ideaEvents, ({ one }) => ({
  idea: one(ideas, { fields: [ideaEvents.ideaId], references: [ideas.id] }),
  ideaVersion: one(ideaVersions, { fields: [ideaEvents.ideaVersionId], references: [ideaVersions.id] }),
  actor: one(users, { fields: [ideaEvents.actorId], references: [users.id] }),
}));

export const ideaReviewsRelations = relations(ideaReviews, ({ one }) => ({
  idea: one(ideas, { fields: [ideaReviews.ideaId], references: [ideas.id] }),
  reviewer: one(users, { fields: [ideaReviews.reviewerId], references: [users.id] }),
}));

export const ideaCommentsRelations = relations(ideaComments, ({ one }) => ({
  idea: one(ideas, { fields: [ideaComments.ideaId], references: [ideas.id] }),
  author: one(users, { fields: [ideaComments.authorId], references: [users.id] }),
}));

export const ideaSupportsRelations = relations(ideaSupports, ({ one }) => ({
  idea: one(ideas, { fields: [ideaSupports.ideaId], references: [ideas.id] }),
  user: one(users, { fields: [ideaSupports.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const pointRulesRelations = relations(pointRules, () => ({}));

export const pointsLedgerRelations = relations(pointsLedger, ({ one }) => ({
  user: one(users, { fields: [pointsLedger.userId], references: [users.id] }),
}));

export const pointsBalancesRelations = relations(pointsBalances, ({ one }) => ({
  user: one(users, { fields: [pointsBalances.userId], references: [users.id] }),
}));

export const levelsRelations = relations(levels, () => ({}));

export const badgesRelations = relations(badges, ({ many }) => ({
  userBadges: many(userBadges),
}));

export const userBadgesRelations = relations(userBadges, ({ one }) => ({
  user: one(users, { fields: [userBadges.userId], references: [users.id] }),
  badge: one(badges, { fields: [userBadges.badgeId], references: [badges.id] }),
}));

export const rewardVersionsRelations = relations(rewardVersions, ({ one }) => ({
  reward: one(rewards, { fields: [rewardVersions.rewardId], references: [rewards.id] }),
  creator: one(users, { fields: [rewardVersions.createdBy], references: [users.id] }),
}));

export const quizCategoriesRelations = relations(quizCategories, ({ many }) => ({
  versions: many(quizVersions),
}));

export const quizVersionsRelations = relations(quizVersions, ({ one, many }) => ({
  quiz: one(quizzes, { fields: [quizVersions.quizId], references: [quizzes.id] }),
  creator: one(users, { fields: [quizVersions.createdBy], references: [users.id] }),
  questions: many(quizQuestions),
  attempts: many(quizAttempts),
}));

export const quizQuestionsRelations = relations(quizQuestions, ({ one, many }) => ({
  version: one(quizVersions, { fields: [quizQuestions.quizVersionId], references: [quizVersions.id] }),
  options: many(quizOptions),
  answers: many(quizAttemptAnswers),
}));

export const quizOptionsRelations = relations(quizOptions, ({ one }) => ({
  question: one(quizQuestions, { fields: [quizOptions.questionId], references: [quizQuestions.id] }),
}));

export const quizAttemptsRelations = relations(quizAttempts, ({ one, many }) => ({
  user: one(users, { fields: [quizAttempts.userId], references: [users.id] }),
  quiz: one(quizzes, { fields: [quizAttempts.quizId], references: [quizzes.id] }),
  version: one(quizVersions, { fields: [quizAttempts.quizVersionId], references: [quizVersions.id] }),
  answers: many(quizAttemptAnswers),
  topics: many(quizTopicResults),
  recommendations: many(quizRecommendations),
}));

export const quizAttemptAnswersRelations = relations(quizAttemptAnswers, ({ one }) => ({
  attempt: one(quizAttempts, { fields: [quizAttemptAnswers.attemptId], references: [quizAttempts.id] }),
  question: one(quizQuestions, { fields: [quizAttemptAnswers.questionId], references: [quizQuestions.id] }),
}));

export const quizTopicResultsRelations = relations(quizTopicResults, ({ one }) => ({
  attempt: one(quizAttempts, { fields: [quizTopicResults.attemptId], references: [quizAttempts.id] }),
  user: one(users, { fields: [quizTopicResults.userId], references: [users.id] }),
}));

export const quizRecommendationRulesRelations = relations(quizRecommendationRules, () => ({}));

export const quizRecommendationsRelations = relations(quizRecommendations, ({ one }) => ({
  user: one(users, { fields: [quizRecommendations.userId], references: [users.id] }),
  attempt: one(quizAttempts, { fields: [quizRecommendations.sourceAttemptId], references: [quizAttempts.id] }),
}));

export const quizChallengesRelations = relations(quizChallenges, ({ many }) => ({
  participants: many(quizChallengeParticipants),
}));

export const quizChallengeParticipantsRelations = relations(quizChallengeParticipants, ({ one }) => ({
  challenge: one(quizChallenges, { fields: [quizChallengeParticipants.challengeId], references: [quizChallenges.id] }),
  user: one(users, { fields: [quizChallengeParticipants.userId], references: [users.id] }),
}));

export const schema = {
  users,
  refreshTokens,
  auditEvents,
  ideas,
  ideaSubmissions,
  ideaSettings,
  ideaReferenceSequences,
  ideaVersions,
  aiRuns,
  aiRunEvents,
  ideaAiResults,
  ideaEvents,
  ideaReviews,
  ideaComments,
  ideaSupports,
  notifications,
  notificationEmailDeliveries,
  articles,
  articleCompletions,
  feedbackCampaigns,
  announcements,
  feedbackResponses,
  quizzes,
  quizCategories,
  quizVersions,
  quizQuestions,
  quizOptions,
  quizAttempts,
  quizAttemptAnswers,
  quizTopicResults,
  quizRecommendationRules,
  quizRecommendations,
  quizChallenges,
  quizChallengeParticipants,
  rewards,
  pointRules,
  pointsLedger,
  pointsBalances,
  levels,
  badges,
  userBadges,
  badgeAdminOperations,
  rewardVersions,
};

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserRole = "employee" | "back_office" | "business_owner";
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Idea = typeof ideas.$inferSelect;
export type NewIdea = typeof ideas.$inferInsert;
export type IdeaVersion = typeof ideaVersions.$inferSelect;
export type NewIdeaVersion = typeof ideaVersions.$inferInsert;
export type AiRun = typeof aiRuns.$inferSelect;
export type NewAiRun = typeof aiRuns.$inferInsert;
export type AiRunEvent = typeof aiRunEvents.$inferSelect;
export type IdeaAiResult = typeof ideaAiResults.$inferSelect;
export type IdeaEvent = typeof ideaEvents.$inferSelect;
export type IdeaReview = typeof ideaReviews.$inferSelect;
export type IdeaComment = typeof ideaComments.$inferSelect;
export type IdeaSupport = typeof ideaSupports.$inferSelect;
export type PointRule = typeof pointRules.$inferSelect;
export type PointsLedgerEntry = typeof pointsLedger.$inferSelect;
export type PointsBalance = typeof pointsBalances.$inferSelect;
export type Level = typeof levels.$inferSelect;
export type Badge = typeof badges.$inferSelect;
export type UserBadge = typeof userBadges.$inferSelect;
export type RewardVersion = typeof rewardVersions.$inferSelect;
export type QuizCategory = typeof quizCategories.$inferSelect;
export type QuizVersion = typeof quizVersions.$inferSelect;
export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type QuizOption = typeof quizOptions.$inferSelect;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
export type QuizAttemptAnswer = typeof quizAttemptAnswers.$inferSelect;
export type QuizTopicResult = typeof quizTopicResults.$inferSelect;
export type QuizRecommendation = typeof quizRecommendations.$inferSelect;
export type QuizChallenge = typeof quizChallenges.$inferSelect;
export type QuizChallengeParticipant = typeof quizChallengeParticipants.$inferSelect;
