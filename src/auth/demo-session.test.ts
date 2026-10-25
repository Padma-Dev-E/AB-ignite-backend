import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/connection";
import { refreshTokens, users } from "../db/schema";
import { demoEmail } from "./demo-core";
import { hashRefreshToken, issueRefreshToken, rotateRefreshToken } from "./refresh-core";

test("passwordless demo identities cannot create or rotate sessions", async () => {
  const name = `Demo ${randomUUID()}`;
  const email = demoEmail(name, "a-secure-test-secret-long-enough");
  const user = db.insert(users).values({ name, email, department: "Technology", passwordHash: "invalid" }).returning({ id: users.id }).get();
  try {
    const first = await issueRefreshToken(user.id);
    assert.equal(first, null);
    const legacyRawToken = `legacy-demo-${randomUUID()}`;
    db.insert(refreshTokens).values({ userId: user.id, tokenHash: hashRefreshToken(legacyRawToken), expiresAt: new Date(Date.now() + 60_000) }).run();
    assert.equal(await rotateRefreshToken(legacyRawToken), null);
  } finally {
    db.delete(users).where(eq(users.id, user.id)).run();
  }
});
