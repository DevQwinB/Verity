/** An error whose message is meant for the caller. Anything else that
 * reaches the error handler is logged and answered with a generic 500, so
 * internal details (SQL, stack fragments, upstream bodies) never leak. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}
