import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { articles, feedbackCampaigns, pointRules } from "../../db/schema";

export function ensureArticleCatalogue() {
  return db.transaction((tx) => {
    const examples = [
      { title: "Letters of credit: how the documentary principle protects both sides", summary: "Why banks pay against documents rather than goods, and what makes a presentation compliant.", body: "A documentary credit is an undertaking governed by its terms and applicable rules. Banks examine the documents presented, rather than the goods themselves. Teams should check the credit terms, document consistency, deadlines and discrepancies, and escalate unclear cases through the bank's approved trade finance process.", category: "banking", topic: "banking-fundamentals", publisher: "AB Ignite Learning", difficulty: "intermediate", readingMinutes: 7, contentType: "internal" as const },
      { title: "Bank guarantees: performance, advance payment and bid bonds", summary: "The main types of guarantee, who they protect and how a claim works.", body: "A bank guarantee can support contractual obligations, advance payments or tender commitments. Before issuance or payment, teams should identify the parties, obligation, expiry, claim conditions and applicable rules. Follow the bank's approval and legal review process for each transaction.", category: "banking", topic: "banking-fundamentals", publisher: "AB Ignite Learning", difficulty: "intermediate", readingMinutes: 5, contentType: "internal" as const },
      { title: "KYC in practice: from identity to expected activity", summary: "How onboarding checks connect customer identity, purpose and expected account activity.", body: "Know your customer work combines identity verification, ownership information and an understanding of the customer's expected activity. Keep records current, use approved risk assessment procedures and escalate inconsistencies through the bank's financial crime controls.", category: "banking", topic: "banking-fundamentals", publisher: "AB Ignite Learning", difficulty: "beginner", readingMinutes: 6, contentType: "internal" as const },
      { title: "Building a culture of continuous improvement", summary: "Practical ways to identify friction and improve everyday banking work.", body: "Continuous improvement starts by observing a process, listening to colleagues and customers, and testing small changes with clear controls. Measure the baseline, involve the people who do the work, and review outcomes before scaling.", category: "transformation", topic: "transformation-fundamentals", publisher: "AB Ignite Learning", difficulty: "beginner", readingMinutes: 5, contentType: "internal" as const },
      { title: "Designing safer digital services", summary: "A guide to balancing customer experience, resilience and responsible controls.", body: "Safe digital services make controls part of the design. Map data flows, limit access, test failure modes and provide clear recovery paths. Validate changes with representative users and monitor outcomes after release.", category: "technology", topic: "technology-fundamentals", publisher: "AB Ignite Learning", difficulty: "intermediate", readingMinutes: 7, contentType: "internal" as const },
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
