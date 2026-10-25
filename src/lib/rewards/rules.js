export const DEFAULT_LEVELS = [
    { name: "Ignite Starter", minimumPoints: 0, sortOrder: 0 },
    { name: "Idea Spark", minimumPoints: 500, sortOrder: 1 },
    { name: "Innovation Explorer", minimumPoints: 1_000, sortOrder: 2 },
    { name: "Change Catalyst", minimumPoints: 2_000, sortOrder: 3 },
    { name: "Transformation Leader", minimumPoints: 3_500, sortOrder: 4 },
    { name: "Transformation Champion", minimumPoints: 5_000, sortOrder: 5 },
];
export const DEFAULT_BADGES = [
    { code: "first-idea", name: "First Idea", eventTypes: ["idea_submission"] },
    { code: "poc-pioneer", name: "POC Pioneer", eventTypes: ["idea_poc"] },
    { code: "impact-builder", name: "Impact Builder", eventTypes: ["idea_implemented"] },
    { code: "value-creator", name: "Value Creator", eventTypes: ["validated_benefits"] },
];
export function parseBadgeRule(value) {
    try {
        const parsed = JSON.parse(value);
        const eventTypes = Array.isArray(parsed.eventTypes)
            ? parsed.eventTypes.filter((eventType) => typeof eventType === "string")
            : parsed.eventType ? [parsed.eventType] : [];
        if (!eventTypes.length || !Number.isInteger(parsed.minimumCount) || parsed.minimumCount < 1) {
            throw new Error("invalid badge rule");
        }
        return { eventTypes, minimumCount: parsed.minimumCount };
    }
    catch {
        throw new Error("Stored badge rule is invalid.");
    }
}
export const REWARD_KINDS = ["catalogue", "earned"];
