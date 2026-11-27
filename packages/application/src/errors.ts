export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: readonly { path: string; message: string }[] = [],
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
