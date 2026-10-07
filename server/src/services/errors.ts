export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Not found") => new AppError(404, "not_found", what);
export const forbidden = (why = "You do not have access to this") => new AppError(403, "forbidden", why);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, "bad_request", msg, details);
export const unauthorized = () => new AppError(401, "unauthorized", "Please sign in");
