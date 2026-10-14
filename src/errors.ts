/** Base class of every error thrown by the SDK. */
export class PayGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Your input was rejected before any request was made. */
export class InvalidArgumentError extends PayGateError {}

/** The request never completed: DNS, TLS, timeout, connection reset. */
export class TransportError extends PayGateError {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** PayGate.to answered with an error, a non-2xx status or a body that is not JSON. */
export class ApiError extends PayGateError {
  constructor(
    message: string,
    /** HTTP status code (0 if no response). */
    readonly statusCode: number = 0,
    /** Raw response body. */
    readonly responseBody: string = '',
    /** Request URL without its query string. */
    readonly url: string = '',
  ) {
    super(message);
  }
}
