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
  AI_PROMPTS_READ: "ai.prompts.read",
  AI_PROMPTS_MANAGE: "ai.prompts.manage",
  GOVERNANCE_READ: "governance.read",
  GOVERNANCE_MANAGE: "governance.manage",
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];
export type UserRole = "employee" | "admin" | "maintainer" | "business_owner";

const employeeCapabilities: readonly Capability[] = [
  CAPABILITIES.IDEAS_READ,
  CAPABILITIES.IDEAS_WRITE,
  CAPABILITIES.PROFILE_READ,
];
const ownerCapabilities: readonly Capability[] = [
  ...employeeCapabilities,
  CAPABILITIES.GOVERNANCE_READ,
  CAPABILITIES.GOVERNANCE_MANAGE,
];
const adminCapabilities: readonly Capability[] = Object.values(CAPABILITIES);
const maintainerCapabilities: readonly Capability[] = [
  CAPABILITIES.IDEAS_READ,
  CAPABILITIES.PROFILE_READ,
  CAPABILITIES.GOVERNANCE_READ,
  CAPABILITIES.GOVERNANCE_MANAGE,
];

const roleCapabilities: Record<UserRole, readonly Capability[]> = {
  employee: employeeCapabilities,
  business_owner: ownerCapabilities,
  admin: adminCapabilities,
  maintainer: maintainerCapabilities,
};

export function capabilitiesForRole(role: UserRole): readonly Capability[] {
  return [...roleCapabilities[role]];
}

export function hasCapability(role: UserRole, capability: Capability): boolean {
  return roleCapabilities[role].includes(capability);
}
