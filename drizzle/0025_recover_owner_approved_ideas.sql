INSERT INTO idea_events (
  ideaId, ideaVersionId, actorType, actorId, eventType,
  fromStatus, toStatus, correlationId, metadataJson, createdAt
)
SELECT
  ideas.id, NULL, 'system', NULL, 'owner_approval_handoff_recovered',
  'control_review', 'decision', NULL,
  json_object('reason', 'Business owner approval was stranded in the hidden control review stage; moved to back-office transformation confirmation.'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM ideas
WHERE ideas.status = 'control_review'
  AND (
    EXISTS (
      SELECT 1 FROM idea_events AS approval
      WHERE approval.ideaId = ideas.id
        AND approval.eventType = 'business_owner_approved'
        AND approval.toStatus = 'control_review'
    )
    OR EXISTS (
      SELECT 1 FROM idea_reviews AS review
      INNER JOIN users AS reviewer ON reviewer.id = review.reviewerId
      WHERE review.ideaId = ideas.id
        AND review.decision = 'approved'
        AND reviewer.role = 'business_owner'
    )
  );
--> statement-breakpoint
UPDATE ideas
SET status = 'decision', assignedUserId = NULL,
    dueAt = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 345600000,
    updatedAt = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE status = 'control_review'
  AND (
    EXISTS (
      SELECT 1 FROM idea_events AS approval
      WHERE approval.ideaId = ideas.id
        AND approval.eventType = 'business_owner_approved'
        AND approval.toStatus = 'control_review'
    )
    OR EXISTS (
      SELECT 1 FROM idea_reviews AS review
      INNER JOIN users AS reviewer ON reviewer.id = review.reviewerId
      WHERE review.ideaId = ideas.id
        AND review.decision = 'approved'
        AND reviewer.role = 'business_owner'
    )
  );
--> statement-breakpoint
INSERT INTO audit_events (
  actorUserId, sessionId, action, targetType, targetId, reason,
  metadataJson, ipHash, userAgentHash, createdAt
)
SELECT
  NULL, NULL, 'system.governance.owner_approval_handoff_recovered', 'idea',
  CAST(ideas.id AS TEXT),
  'Recovered business-owner-approved idea from the hidden control review stage.',
  json_object('reference', ideas.reference, 'fromStatus', 'control_review', 'toStatus', 'decision'),
  NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM ideas
WHERE ideas.status = 'decision'
  AND EXISTS (
    SELECT 1 FROM idea_events AS recovered
    WHERE recovered.ideaId = ideas.id
      AND recovered.eventType = 'owner_approval_handoff_recovered'
  );
