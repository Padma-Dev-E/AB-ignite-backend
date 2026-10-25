import argon2 from "argon2";
export function hashPassword(password) {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
    });
}
export async function verifyPassword(passwordHash, password) {
    try {
        return await argon2.verify(passwordHash, password);
    }
    catch {
        return false;
    }
}
