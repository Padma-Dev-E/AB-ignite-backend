import "dotenv/config";

import { eq } from "drizzle-orm";
import { db } from "./connection";
import { users, type UserRole } from "./schema";
import { hashPassword } from "../auth/password-core";
import { ensureQuizCatalogue } from "../lib/quizzes/seed";
import { ensureArticleCatalogue } from "../lib/articles/seed";
import { ensureAiPromptCatalogue } from "../lib/ai/prompts/catalog";

type SeedAccount = {
  name: string;
  email: string;
  role: UserRole;
  department: string;
  jobTitle: string;
  businessProfile?: string;
};

const adminEmail = (process.env.DEFAULT_ADMIN_EMAIL ?? "admin@admin.com").trim().toLowerCase();
const defaultAdminPassword = process.env.DEFAULT_ADMIN_PASSWORD ?? "Test@123";

const additionalSeedAccounts: SeedAccount[] = [
  {
    name: "Nour Haddad",
    email: "seed.employee@example.test",
    role: "employee",
    department: "Retail Banking",
    jobTitle: "Customer Service Officer",
  },
  {
    name: "Tareq Mansour",
    email: "seed.maintainer@example.test",
    role: "maintainer",
    department: "Business Transformation",
    jobTitle: "Idea Portfolio Maintainer",
  },
  {
    name: "Layla Haddad",
    email: "owner.retail@example.test",
    role: "business_owner",
    department: "Retail Banking",
    jobTitle: "Retail Digital Banking Director",
    businessProfile: "Arab Bank seed profile (synthetic demo data). Accountable for retail customer journeys across account opening, onboarding, deposits, cards, mobile and online banking, branch-to-digital service, and routine customer servicing. Strong fit for ideas that improve customer access, reduce onboarding friction, increase self-service, improve card or payment experiences, and lower avoidable service contacts. Can sponsor retail product and channel changes with operations, technology, and compliance partners. Does not own corporate banking, treasury, credit policy, or regulatory control decisions; flag ideas centered on those areas for another owner.",
  },
  {
    name: "Omar Nasser",
    email: "owner.corporate@example.test",
    role: "business_owner",
    department: "Corporate and Institutional Banking",
    jobTitle: "Corporate Banking Operations Director",
    businessProfile: "Arab Bank seed profile (synthetic demo data). Accountable for corporate and institutional client servicing, corporate onboarding coordination, cash management, trade finance servicing, payment instructions, and client-facing operational processes. Strong fit for ideas that simplify corporate client setup, improve trade document handling, make cash-management services easier to use, reduce payment exceptions, or improve relationship-team workflows. Coordinates with product, operations, technology, legal, and risk teams to deliver changes. Does not own retail branch journeys, enterprise cyber controls, or independent credit and compliance policy decisions.",
  },
  {
    name: "Rana Khalil",
    email: "owner.operations@example.test",
    role: "business_owner",
    department: "Banking Operations",
    jobTitle: "Payments and Service Operations Director",
    businessProfile: "Arab Bank seed profile (synthetic demo data). Accountable for operational execution across payment processing, settlement and reconciliation, exception handling, service quality, branch support processes, and operational capacity. Strong fit for ideas that remove repetitive manual work, reduce processing delays or errors, improve reconciliation and case routing, strengthen operational controls, or provide useful workload and service-level visibility. Can sponsor process redesign with retail, corporate, technology, and risk partners. Does not own customer product strategy, enterprise architecture, or approval of regulatory policy exceptions.",
  },
  {
    name: "Samir Mansour",
    email: "owner.risk-compliance@example.test",
    role: "business_owner",
    department: "Risk and Compliance",
    jobTitle: "Financial Crime and Compliance Director",
    businessProfile: "Arab Bank seed profile (synthetic demo data). Accountable for risk and compliance operations involving customer due diligence, KYC process quality, AML and sanctions controls, fraud-risk coordination, regulatory obligations, and evidence of control execution. Strong fit for ideas that improve review quality, identify missing evidence, make case handling clearer, reduce avoidable false positives, or improve auditability while preserving required controls. Works with business, operations, technology, legal, and information-security teams. A proposed idea must not bypass required checks or be treated as approval to change policy; route policy decisions through the appropriate governance process.",
  },
  {
    name: "Dima Farouk",
    email: "owner.digital-technology@example.test",
    role: "business_owner",
    department: "Digital Banking and Technology",
    jobTitle: "Digital Platforms Director",
    businessProfile: "Arab Bank seed profile (synthetic demo data). Accountable for digital platform capabilities and delivery coordination across mobile and online banking, APIs and integrations, data-enabled services, platform reliability, and secure technology change. Strong fit for ideas requiring channel or platform changes, reusable integrations, improved digital availability, better service observability, or safe automation. Partners with retail and corporate product owners, operations, architecture, cybersecurity, and risk. Does not own banking product policy, credit decisions, or authorization to weaken security or privacy controls.",
  },
];

async function ensureSeedAccount(account: SeedAccount, passwordHash: string) {
  const [existing] = await db.select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, account.email))
    .limit(1);

  if (existing) {
    if (account.role !== "admin" && existing.role !== account.role) {
      throw new Error(`Seed account ${account.email} already exists with role ${existing.role}; expected ${account.role}.`);
    }

    const values = account.role === "admin"
      ? { name: account.name, role: account.role, updatedAt: new Date() }
      : {
          name: account.name,
          role: account.role,
          department: account.department,
          jobTitle: account.jobTitle,
          businessProfile: account.businessProfile ?? null,
          updatedAt: new Date(),
        };
    await db.update(users).set(values).where(eq(users.id, existing.id));
    console.log(`Seed account ensured for ${account.email} (${account.role}).`);
    return;
  }

  await db.insert(users).values({
    name: account.name,
    email: account.email,
    role: account.role,
    department: account.department,
    jobTitle: account.jobTitle,
    businessProfile: account.businessProfile ?? null,
    passwordHash,
    mustChangePassword: true,
  });
  console.log(`Seed account created for ${account.email} (${account.role}).`);
}

async function main() {
  ensureQuizCatalogue();
  ensureArticleCatalogue();
  ensureAiPromptCatalogue();

  const initialPasswordHash = await hashPassword(defaultAdminPassword);

  await ensureSeedAccount({
    name: "Platform Admin",
    email: adminEmail,
    role: "admin",
    department: "Technology",
    jobTitle: "Platform Admin",
  }, initialPasswordHash);

  for (const account of additionalSeedAccounts) {
    await ensureSeedAccount(account, initialPasswordHash);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
