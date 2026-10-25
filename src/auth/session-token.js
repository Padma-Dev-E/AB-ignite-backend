export function createSessionTokenPayload(user, sessionId, sessionVersion, accessTokenExpires) {
    return {
        sub: String(user.id),
        name: user.name,
        email: user.email,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        sessionId: String(sessionId),
        sessionVersion,
        accessTokenExpires,
    };
}
