export class QuizError extends Error {
  constructor(
    message: string,
    readonly code = "QUIZ_ERROR",
    readonly status = 400,
  ) {
    super(message);
    this.name = "QuizError";
  }
}
