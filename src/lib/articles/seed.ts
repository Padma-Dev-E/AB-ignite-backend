import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { articles, feedbackCampaigns, pointRules } from "../../db/schema";

export function ensureArticleCatalogue() {
  return db.transaction((tx) => {
    const examples = [
      {
        title: "Pause, Verify, Escalate: Safer Corporate Payment Instructions",
        summary: "A practical walkthrough for checking changed beneficiary details, urgent requests, and unusual corporate payment instructions.",
        body: `Corporate payment services support businesses with important day-to-day activity, from account information and cash management to payables, receivables, reconciliation, and trade finance. Arab Bank publicly describes ArabiConnect as its corporate online platform for transaction-banking needs. Because these services move funds and sensitive instructions, every unusual request deserves careful attention.

Start with the request, not the urgency. A last-minute change to beneficiary details, a new contact address, an unfamiliar account, or pressure to skip a second review can be a warning sign. None of these details alone proves fraud, but together they are a reason to pause and check.

Verify changes using contact details and channels already established for the customer. Do not rely on a phone number, link, or reply address supplied only in the message requesting the change. Compare the instruction with the supporting information available through approved systems. If information conflicts or cannot be independently confirmed, do not release the payment while the question remains open.

Use the applicable authorization steps. Keep the people who prepare an instruction separate from the people who review or approve it wherever the approved process requires that separation. Check that the beneficiary, amount, currency, timing, and supporting documentation are consistent. A familiar customer name or plausible invoice is not, by itself, proof that an instruction is genuine.

If the request remains suspicious, preserve the relevant records and promptly escalate through the approved fraud, financial-crime, or information-security reporting route. Share only the information needed with authorized colleagues. Do not warn a suspected sender by replying to the questionable message, and do not investigate beyond your assigned access.

These examples are learning scenarios, not a replacement for Arab Bank policy, customer mandates, local requirements, or role-specific procedures. Always follow the current approved controls and escalation channels for your location and responsibility.

Public context: Arab Bank's Corporate Solutions & Channels page describes ArabiConnect and corporate payment services: https://www.arabbank.com/smartmenu/banking-solutions/corporate-institutional-banking/corporate-solutions`,
        category: "banking",
        topic: "corporate-payment-safeguards",
        publisher: "AB Ignite Learning",
        difficulty: "intermediate",
        readingMinutes: 8,
        contentType: "internal" as const,
        url: "https://www.arabbank.com/smartmenu/banking-solutions/corporate-institutional-banking/corporate-solutions",
      },
      {
        title: "Spot the Phish: Protect Customer and Colleague Information",
        summary: "Recognize deceptive messages, protect credentials and personal data, and respond promptly when something looks wrong.",
        body: `Phishing messages try to persuade people to disclose information, open harmful content, or visit a deceptive website. They can imitate a bank, a customer, a supplier, or a colleague. A familiar logo or display name does not establish that a message is genuine.

Look for mismatched sender addresses, unexpected attachments, unusual links, requests for credentials, sudden changes to payment instructions, or pressure to act before checking. Treat these as reasons to slow down. Do not click a link or open an attachment just to find out where it leads. If a request could be legitimate, verify it through a known, approved channel that is independent of the message.

Protect passwords, one-time codes, customer identifiers, account information, and identity documents. Use only approved systems and secure delivery methods for customer information. Send only the information needed for the task, and check the intended recipient before sharing. Never move sensitive work data into a personal mailbox, personal cloud drive, or unapproved messaging service.

If a message claims to be from Arab Bank and requests personal or banking information through a link, do not reply or use the link. Arab Bank's public security guidance advises recipients to avoid responding to suspicious messages or clicking their links and to report them through the appropriate official channel. For employee incidents, use the currently approved internal security-reporting process for your location.

If you have already clicked, opened a file, or shared information, report it promptly. Stop interacting with the message or file, preserve relevant details, and follow the instructions of the authorized security response team. Quick reporting helps the right people assess what happened and decide whether further action is needed. Do not delete evidence or attempt unapproved cleanup.

These are general awareness examples. Apply current Arab Bank information-security, privacy, and incident-response requirements for your role and location.

Public context: Arab Bank Security Statement: https://www.arabbank.com/footer-navigation/security-statement`,
        category: "technology",
        topic: "phishing-and-data-protection",
        publisher: "AB Ignite Learning",
        difficulty: "beginner",
        readingMinutes: 7,
        contentType: "internal" as const,
        url: "https://www.arabbank.com/footer-navigation/security-statement",
      },
    ];
    for (const item of examples) {
      const [existing] = tx.select({ id: articles.id, category: articles.category, categoryCode: articles.categoryCode }).from(articles).where(and(eq(articles.title, item.title), eq(articles.publisher, item.publisher))).limit(1).all();
      if (!existing) tx.insert(articles).values({ ...item, categoryCode: item.category, published: true, publishedLabel: "Curated learning", updatedAt: new Date() }).run();
      else if (existing.category === item.category && existing.categoryCode === "general") tx.update(articles).set({ categoryCode: item.category, updatedAt: new Date() }).where(eq(articles.id, existing.id)).run();
    }
    const [campaign] = tx.select({ id: feedbackCampaigns.id }).from(feedbackCampaigns).where(eq(feedbackCampaigns.title, "Improve AB Ignite")).limit(1).all();
    if (!campaign) tx.insert(feedbackCampaigns).values({ title: "Improve AB Ignite", description: "Tell us what is working well and what would make the platform better.", active: true, pinned: true }).run();
    const [rule] = tx.select({ id: pointRules.id }).from(pointRules).where(eq(pointRules.code, "article_read")).limit(1).all();
    if (!rule) tx.insert(pointRules).values({ code: "article_read", name: "Article completed", points: 10, active: true, description: "Complete an article", updatedAt: new Date() }).run();
    return { articles: examples.length, feedbackCampaign: true };
  });
}
