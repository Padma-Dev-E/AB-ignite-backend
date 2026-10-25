import test from "node:test";
import assert from "node:assert/strict";
import { parsePage, csvForAudit, csvForRecords } from "./query";

test("page parsing rejects unbounded and malformed requests", () => {
  assert.deepEqual(parsePage(new URL("https://example.test/?limit=25&after=7"), 100), { limit: 25, after: 7 });
  assert.deepEqual(parsePage(new URL("https://example.test/"), 100), { limit: 50, after: null });
  assert.throws(() => parsePage(new URL("https://example.test/?limit=101"), 100));
  assert.throws(() => parsePage(new URL("https://example.test/?limit=0"), 100));
  assert.throws(() => parsePage(new URL("https://example.test/?after=1x"), 100));
});

test("directory query accepts bounded search and rejects blank or excessive text", async () => {
  const { directoryQuery } = await import("./query");
  assert.equal(directoryQuery(new URL("https://example.test/?q=Alice%20Smith")), "Alice Smith");
  assert.equal(directoryQuery(new URL("https://example.test/")), null);
  assert.throws(() => directoryQuery(new URL("https://example.test/?q=%20%20")));
  assert.throws(() => directoryQuery(new URL(`https://example.test/?q=${"a".repeat(121)}`)));
});

test("audit CSV escapes formulas, quotes, and line breaks", () => {
  const csv = csvForAudit([{ id: 1, createdAt: new Date("2026-10-23T12:00:00Z"), actorUserId: 2, sessionId: 3, action: "=SUM(1)", targetType: "user", targetId: "4", reason: "a\"b\nnext", metadata: { status: "ok" }, ipHash: "deadbeef" }]);
  assert.match(csv, /^id,createdAt,actorUserId,sessionId,action,targetType,targetId,reason,metadata,ipHash\r\n/);
  assert.match(csv, /'\=SUM\(1\)/);
  assert.match(csv, /"a""b\nnext"/);
  assert.match(csv, /deadbeef/);
  assert.doesNotMatch(csv, /userAgentHash|tokenHash/);
});

test("admin dataset CSV includes its declared columns and escapes formula-like cells", () => {
  const csv = csvForRecords(["reference", "benefits", "ipHash"], [["=1+1", "a,\"b\"", null]]);
  assert.equal(csv, 'reference,benefits,ipHash\r\n\'=1+1,"a,""b""",\r\n');
});
