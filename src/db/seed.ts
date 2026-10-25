import "dotenv/config";

import { eq } from "drizzle-orm";
import { db } from "./connection";
import { users } from "./schema";
import { hashPassword } from "../auth/password-core";
import { ensureQuizCatalogue } from "../lib/quizzes/seed";
import { ensureArticleCatalogue } from "../lib/articles/seed";

const email = (process.env.DEFAULT_ADMIN_EMAIL ?? "admin@admin.com").trim().toLowerCase();
const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD ?? "Test@123";

async function main() {
  ensureQuizCatalogue();
  ensureArticleCatalogue();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

  if (existing) {
    await db.update(users).set({ role: "back_office", name: "Platform Admin", updatedAt: new Date() }).where(eq(users.id, existing.id));
    console.log(`Admin role ensured for ${email}.`);
    return;
  }

  await db.insert(users).values({
    name: "Platform Admin",
    email,
    role: "back_office",
    department: "Technology",
    jobTitle: "Platform Admin",
    passwordHash: await hashPassword(defaultAdminPassword),
  });
  console.log(`Default admin created for ${email}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
