import assert from "node:assert/strict";
import test from "node:test";
import { hashAuditValue } from "./redaction-core";
import { csvForSafeAudit } from "./export";

const baseRow = {
  id: 42,
  createdAt: new Date("2026-10-23T12:00:00.000Z"),
  actorUserId: 7,
  sessionId: 9,
  action: "auth.login.succeeded",
  targetType: "session",
  targetId: "9",
  reason: null,
  metadata: { status: "ok" },
};

test("audit CSV includes the pseudonymized IP hash without the source IP", () => {
  const ip = "203.0.113.42";
  const ipHash = hashAuditValue(ip);
  assert.match(ipHash ?? "", /^[a-f0-9]{64}$/);

  const csv = csvForSafeAudit([{ ...baseRow, ipHash }]);
  assert.match(csv, /^id,createdAt,actorUserId,sessionId,action,targetType,targetId,reason,metadata,ipHash\r\n/);
  assert.ok(csv.includes(`,${ipHash}\r\n`));
  assert.ok(!csv.includes(ip));
});

test("audit CSV drops malformed or raw IP values from the hash column", () => {
  for (const unsafe of ["203.0.113.42", "=HYPERLINK(\"https://example.invalid\")", "f".repeat(63), "F".repeat(64)]) {
    const csv = csvForSafeAudit([{ ...baseRow, ipHash: unsafe }]);
    assert.ok(!csv.includes(unsafe));
    assert.ok(csv.endsWith(",\r\n"));
  }
});
