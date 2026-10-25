export const SESSION_COOKIE_NAME = process.env.AUTH_SESSION_COOKIE_NAME ?? "ab_ignite_session";
export const REFRESH_COOKIE_NAME = process.env.AUTH_REFRESH_COOKIE_NAME ?? "ab_ignite_refresh";
function positiveSeconds(name, fallback) {
    const value = Number(process.env[name] ?? fallback);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
export const accessTokenTtlSeconds = positiveSeconds("AUTH_ACCESS_TOKEN_TTL_SECONDS", 900);
export const refreshTokenTtlSeconds = positiveSeconds("AUTH_REFRESH_TOKEN_TTL_SECONDS", 2_592_000);
export const sessionIdleSeconds = positiveSeconds("AUTH_SESSION_IDLE_SECONDS", 1_800);
export const sessionAbsoluteSeconds = positiveSeconds("AUTH_SESSION_ABSOLUTE_SECONDS", 43_200);
export const demoSessionSeconds = Math.min(positiveSeconds("DEMO_SESSION_TTL_SECONDS", 2_592_000), 2_592_000);
export const authSecret = process.env.AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "local-development-secret-change-me");
export const secureCookies = process.env.NODE_ENV === "production";
