export class RewardsError extends Error {
    code;
    status;
    constructor(message, code, status = 409) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = "RewardsError";
    }
}
export function isRewardsError(error) {
    return error instanceof RewardsError;
}
