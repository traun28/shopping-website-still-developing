/**
 * Application error taxonomy.
 *
 * `AppError` and its subclasses carry an HTTP status and a message that is
 * SAFE to show a customer. Anything else thrown inside a request is treated
 * as an internal error — details are logged, never leaked to the client.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status ?? 500;
    this.code = options.code ?? "INTERNAL_ERROR";
  }
}

export class ValidationError extends AppError {
  readonly details?: unknown;

  constructor(message = "Please check the details you entered.", details?: unknown) {
    super(message, { status: 422, code: "VALIDATION_ERROR" });
    this.details = details;
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests. Please try again in a few minutes.") {
    super(message, { status: 429, code: "RATE_LIMITED" });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "We couldn't find what you were looking for.") {
    super(message, { status: 404, code: "NOT_FOUND" });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super(message, { status: 401, code: "UNAUTHORIZED" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have access to this.") {
    super(message, { status: 403, code: "FORBIDDEN" });
  }
}

export class ConflictError extends AppError {
  constructor(message = "This item changed in another request. Refresh and try again.", code = "CONFLICT") {
    super(message, { status: 409, code });
  }
}

export class InsufficientStockError extends ConflictError {
  constructor(message = "There isn't enough stock for that quantity.") {
    super(message, "INSUFFICIENT_STOCK");
  }
}

export class IntegrationError extends AppError {
  constructor(message = "An external service is unavailable right now.", cause?: unknown) {
    super(message, { status: 502, code: "INTEGRATION_ERROR", cause });
  }
}

const INTERNAL_MESSAGE = "Something went wrong on our side. Please try again.";

/**
 * Produce a customer-safe error payload. Internal error messages stay in
 * server logs — clients only ever see `AppError`-approved copy.
 */
export function toPublicError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: INTERNAL_MESSAGE };
}
