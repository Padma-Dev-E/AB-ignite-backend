export class QuizError extends Error {
    code;
    status;
    constructor(message, code = "QUIZ_ERROR", status = 400) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = "QuizError";
    }
}
