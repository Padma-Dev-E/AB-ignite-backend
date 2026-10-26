import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { quizCategories, quizOptions, quizQuestions, quizVersions, quizzes } from "../../db/schema";

const CATEGORIES = [
  { code: "banking", name: "Banking", sortOrder: 1 },
  { code: "technology", name: "Technology", sortOrder: 2 },
] as const;

const QUIZ_CATALOGUE = [
  {
    title: "Corporate Payment Safeguards: Verify Before You Release",
    category: "banking",
    difficulty: "intermediate",
    objective: "Practice identifying payment-instruction fraud indicators and applying independent verification, approval, and escalation principles in corporate transaction banking.",
    questions: [
      {
        topic: "payment-instruction-verification",
        prompt: "A corporate customer emails a request to change a beneficiary account and asks for same-day processing. What is the safest next step?",
        options: [
          { label: "Pause the change and verify it through an established, independently sourced customer contact channel before following the approved change and payment controls.", isCorrect: true },
          { label: "Reply to the email address that sent the request and accept its confirmation.", isCorrect: false },
          { label: "Process the payment first because the request came from a known customer domain.", isCorrect: false },
          { label: "Use the telephone number included in the email signature to confirm the change.", isCorrect: false },
        ],
      },
      {
        topic: "fraud-indicators",
        prompt: "Which combination should raise the strongest concern when reviewing an urgent corporate payment request?",
        options: [
          { label: "A familiar invoice reference and a request submitted through the customer's established channel.", isCorrect: false },
          { label: "A new beneficiary, unusual urgency, pressure to bypass a second check, and changed contact details.", isCorrect: true },
          { label: "A payment that matches the approved mandate and normal processing schedule.", isCorrect: false },
          { label: "A request to confirm the payment status through the bank's usual support channel.", isCorrect: false },
        ],
      },
      {
        topic: "secure-corporate-channels",
        prompt: "A colleague receives a message containing a link that claims to open Arab Bank's ArabiConnect service and requests credentials. What should they do?",
        options: [
          { label: "Avoid the message link and credentials form; access the corporate service through its known, approved route and report the suspicious message through the approved channel.", isCorrect: true },
          { label: "Open the link in a private browser window and continue if the page looks familiar.", isCorrect: false },
          { label: "Forward the message to the customer so they can confirm whether it is genuine.", isCorrect: false },
          { label: "Enter only the username to see whether the service recognizes the account.", isCorrect: false },
        ],
      },
      {
        topic: "approval-controls",
        prompt: "A payment instruction appears complete, but the requested beneficiary does not match the approved supporting documents. What is the appropriate response?",
        options: [
          { label: "Do not release it until the discrepancy is resolved through the approved review and authorization process.", isCorrect: true },
          { label: "Release it if the amount is within the customer's normal range.", isCorrect: false },
          { label: "Change the beneficiary details to match the documents without recording the change.", isCorrect: false },
          { label: "Ask another colleague to approve it informally in chat.", isCorrect: false },
        ],
      },
      {
        topic: "escalation-and-evidence",
        prompt: "You suspect a payment request may be fraudulent, but no funds have been released. What should you do next?",
        options: [
          { label: "Pause the activity, preserve relevant records, and promptly escalate through the applicable approved fraud or security reporting route.", isCorrect: true },
          { label: "Delete the message so no one else can act on it.", isCorrect: false },
          { label: "Warn the suspected sender by replying to the message.", isCorrect: false },
          { label: "Wait until the next business day to see whether the customer follows up.", isCorrect: false },
        ],
      },
    ],
  },
  {
    title: "Phishing, Credentials, and Customer Data Protection",
    category: "technology",
    difficulty: "beginner",
    objective: "Recognize common phishing and social-engineering attempts, protect customer and colleague information, and respond safely to a suspected incident.",
    questions: [
      {
        topic: "phishing-recognition",
        prompt: "An email appears to come from a senior colleague and asks you to open an attachment urgently. The sender address differs slightly from the colleague's usual address. What should you do?",
        options: [
          { label: "Do not open the attachment or reply; verify the request through a known channel and report the suspicious email using the approved route.", isCorrect: true },
          { label: "Open it because the display name matches a colleague.", isCorrect: false },
          { label: "Reply asking the sender to confirm, using the same email thread.", isCorrect: false },
          { label: "Forward it to several coworkers to ask whether they recognize it.", isCorrect: false },
        ],
      },
      {
        topic: "credential-protection",
        prompt: "A caller says they are helping with a system issue and asks for your password and one-time code. What is the correct response?",
        options: [
          { label: "Do not disclose either credential; end the interaction and verify the request through the organization's known support channel.", isCorrect: true },
          { label: "Share the one-time code but not the password.", isCorrect: false },
          { label: "Share the password if the caller knows your department.", isCorrect: false },
          { label: "Send the details through a personal messaging app instead.", isCorrect: false },
        ],
      },
      {
        topic: "customer-data-handling",
        prompt: "A customer asks you to send account documents to a new personal email address because they cannot access their usual channel. What should you do?",
        options: [
          { label: "Use the approved identity-verification and secure-delivery process; do not send sensitive information to an unverified address.", isCorrect: true },
          { label: "Send the documents after checking that the email address is spelled correctly.", isCorrect: false },
          { label: "Send a password-protected file and put its password in the same email.", isCorrect: false },
          { label: "Ask the customer to send a copy of an identity document to your personal inbox.", isCorrect: false },
        ],
      },
      {
        topic: "incident-response",
        prompt: "You opened an attachment and then noticed signs that the email may be phishing. What is the best next step?",
        options: [
          { label: "Stop interacting with the file, promptly report what happened through the approved security channel, and follow the response team's instructions.", isCorrect: true },
          { label: "Delete the email and continue working without telling anyone.", isCorrect: false },
          { label: "Forward the attachment to your personal email to inspect it safely.", isCorrect: false },
          { label: "Restart the device and assume the issue is resolved.", isCorrect: false },
        ],
      },
      {
        topic: "safe-reporting",
        prompt: "A message claims to be from Arab Bank and requests personal or banking information through a link. Which action best follows safe phishing practice?",
        options: [
          { label: "Do not click the link or reply; report the message through the currently approved reporting channel and use a known official route for any follow-up.", isCorrect: true },
          { label: "Click the link but do not submit the form unless it shows a security icon.", isCorrect: false },
          { label: "Reply asking the sender to prove they work for the bank.", isCorrect: false },
          { label: "Post a screenshot with the message and customer details in a public group for advice.", isCorrect: false },
        ],
      },
    ],
  },
] as const;

export function ensureQuizCatalogue() {
  return db.transaction((tx) => {
    for (const category of CATEGORIES) {
      tx.insert(quizCategories).values({ code: category.code, name: category.name, sortOrder: category.sortOrder, active: true }).onConflictDoNothing({ target: quizCategories.code }).run();
    }

    for (const item of QUIZ_CATALOGUE) {
      let [quiz] = tx.select().from(quizzes).where(and(eq(quizzes.title, item.title), eq(quizzes.category, item.category))).limit(1).all();
      if (!quiz) {
        [quiz] = tx.insert(quizzes).values({
          title: item.title,
          category: item.category,
          difficulty: item.difficulty,
          objective: item.objective,
          passMark: 70,
          pointsPerQuestion: 10,
          questionCount: item.questions.length,
          timeLimitSeconds: 600,
        }).returning().all();
      }

      const [version] = tx.select().from(quizVersions).where(and(eq(quizVersions.quizId, quiz.id), eq(quizVersions.version, 1))).limit(1).all();
      if (version) {
        if (!version.published) tx.update(quizVersions).set({ published: true, publishedAt: version.publishedAt ?? new Date(), updatedAt: new Date() }).where(eq(quizVersions.id, version.id)).run();
        const [questionCount] = tx.select({ count: sql<number>`count(*)` }).from(quizQuestions).where(eq(quizQuestions.quizVersionId, version.id)).all();
        if (Number(questionCount?.count ?? 0) === 0) addQuestions(tx, version.id, item.questions);
        continue;
      }

      const now = new Date();
      const [createdVersion] = tx.insert(quizVersions).values({
        quizId: quiz.id,
        version: 1,
        categoryCode: item.category,
        level: item.difficulty,
        objective: item.objective,
        passMark: 70,
        pointsPerQuestion: 10,
        timeLimitSeconds: 600,
        published: true,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning().all();
      if (!createdVersion) throw new Error("Quiz version was not created.");
      addQuestions(tx, createdVersion.id, item.questions);
    }
    return { categories: CATEGORIES.length, quizzes: QUIZ_CATALOGUE.length };
  });
}

type SeedQuizQuestion = typeof QUIZ_CATALOGUE[number]["questions"][number];
type QuizTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function addQuestions(tx: QuizTransaction, versionId: number, questions: readonly SeedQuizQuestion[]) {
  const now = new Date();
  questions.forEach((item, index) => {
    const [question] = tx.insert(quizQuestions).values({
      quizVersionId: versionId,
      topic: item.topic,
      prompt: item.prompt,
      sortOrder: index + 1,
      points: 1,
      createdAt: now,
      updatedAt: now,
    }).returning().all();
    if (!question) throw new Error("Quiz question was not created.");
    tx.insert(quizOptions).values(item.options.map((option, optionIndex) => ({
      questionId: question.id,
      optionKey: String.fromCharCode(97 + optionIndex),
      label: option.label,
      sortOrder: optionIndex + 1,
      isCorrect: option.isCorrect,
    }))).run();
  });
}
