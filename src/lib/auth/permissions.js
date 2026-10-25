export const CAPABILITIES = {
    IDEAS_READ: "ideas.read",
    IDEAS_WRITE: "ideas.write",
    PROFILE_READ: "profile.read",
    USERS_READ: "users.read",
    USERS_MANAGE: "users.manage",
    AUDIT_READ: "audit.read",
    AUDIT_EXPORT: "audit.export",
    SESSIONS_READ: "sessions.read",
    SESSIONS_REVOKE: "sessions.revoke",
    SETTINGS_MANAGE: "settings.manage",
    REWARDS_MANAGE: "rewards.manage",
    AI_RUNS_READ: "ai.runs.read",
    AI_RUNS_MANAGE: "ai.runs.manage",
    GOVERNANCE_READ: "governance.read",
    GOVERNANCE_MANAGE: "governance.manage",
};
const employeeCapabilities = [
    CAPABILITIES.IDEAS_READ,
    CAPABILITIES.IDEAS_WRITE,
    CAPABILITIES.PROFILE_READ,
];
const ownerCapabilities = [
    ...employeeCapabilities,
    CAPABILITIES.GOVERNANCE_READ,
    CAPABILITIES.GOVERNANCE_MANAGE,
];
const backOfficeCapabilities = Object.values(CAPABILITIES);
const roleCapabilities = {
    employee: employeeCapabilities,
    business_owner: ownerCapabilities,
    back_office: backOfficeCapabilities,
};
export function capabilitiesForRole(role) {
    return [...roleCapabilities[role]];
}
export function hasCapability(role, capability) {
    return roleCapabilities[role].includes(capability);
}
