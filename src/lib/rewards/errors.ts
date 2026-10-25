export class RewardsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 409,
  ) {
    super(message);
    this.name = "RewardsError";
  }
}

export function isRewardsError(error: unknown): error is RewardsError {
  return error instanceof RewardsError;
}
