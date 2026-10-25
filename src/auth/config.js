export const SESSION_COOKIE_NAME = "ab_ignite_session";
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
export const demoAccessEnabled = process.env.DEMO_ACCESS_ENABLED === "true" || (process.env.NODE_ENV !== "production" && process.env.DEMO_ACCESS_ENABLED !== "false");
export const authSecret = process.env.AUTH_SECRET ?? (process.env.NODE_ENV === "production" ? "" : "local-development-secret-change-me");
export const secureCookies = process.env.NODE_ENV === "production";
export function canAccessAdminWorkspace(role) {
    return role === "back_office" || role === "business_owner";
}
export function postLoginPath(role) {
    return role === "employee" ? "/private" : "/private/admin";
}
export function forcedPasswordChangePathAllowed(pathname) {
    return pathname === "/change-password"
        || pathname.startsWith("/api/auth/")
        || pathname === "/api/account/password";
}
export const authConfig = {
    trustHost: true,
    secret: authSecret,
    providers: [],
    pages: { signIn: "/login" },
    session: { strategy: "jwt", maxAge: refreshTokenTtlSeconds },
    cookies: {
        sessionToken: {
            name: SESSION_COOKIE_NAME,
            options: {
                httpOnly: true,
                sameSite: "lax",
                path: "/",
                secure: secureCookies,
            },
        },
    },
    callbacks: {
        jwt({ token, user }) {
            if (user) {
                token.role = user.role;
                token.mustChangePassword = user.mustChangePassword === true;
            }
            return token;
        },
        session({ session, token }) {
            if (token.role)
                session.user.role = token.role;
            session.user.mustChangePassword = token.mustChangePassword === true;
            return session;
        },
        authorized({ auth, request }) {
            const pathname = request.nextUrl.pathname;
            if (pathname === "/" || pathname === "/login")
                return true;
            // Let middleware route invalid and missing sessions to a clean login
            // screen instead of allowing the password-change page to render a form
            // that can only fail after submission.
            if (pathname === "/change-password")
                return true;
            if (pathname.startsWith("/api/"))
                return true;
            if (auth?.user?.mustChangePassword)
                return Boolean(auth.user && auth.isValid !== false);
            if (pathname.startsWith("/private") || pathname.startsWith("/admin"))
                return Boolean(auth?.user && auth.isValid !== false);
            return true;
        },
    },
};
