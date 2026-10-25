import { registerAiJob } from "../registry";
import { ideaDecisionPackJob } from "./idea-decision-pack";
import { ideaEnrichJob } from "./idea-enrich";
import { ideaEstimateJob } from "./idea-estimate";
import { ideaImpactPlanJob } from "./idea-impact-plan";
import { ideaPreflightJob } from "./idea-preflight";
import { ideaQuestionsJob } from "./idea-questions";
import { ideaRiskJob } from "./idea-risk";
import { ideaRouteJob } from "./idea-route";
import { ideaSimilarJob } from "./idea-similar";
import { ideaValidateJob } from "./idea-validate";
export const ideaJobs = [
    ideaPreflightJob,
    ideaValidateJob,
    ideaEnrichJob,
    ideaQuestionsJob,
    ideaRiskJob,
    ideaRouteJob,
    ideaSimilarJob,
    ideaEstimateJob,
    ideaDecisionPackJob,
    ideaImpactPlanJob,
];
for (const job of ideaJobs)
    registerAiJob(job);
export { ideaDecisionPackJob, ideaEnrichJob, ideaEstimateJob, ideaImpactPlanJob, ideaPreflightJob, ideaQuestionsJob, ideaRiskJob, ideaRouteJob, ideaSimilarJob, ideaValidateJob, };
