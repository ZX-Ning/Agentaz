/**
 * Structured domain error used by HTTP routes to preserve status/code metadata
 * without forcing workspace and presence services to import H3 primitives.
 */
export class AgentazDomainError extends Error {
  readonly data: {
    code: string;
    message: string;
    recoverable: boolean;
  };

  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly recoverable = statusCode < 500,
  ) {
    super(message);
    this.name = new.target.name;
    this.data = { code, message, recoverable };
  }
}

/** The request body or parameters are malformed or incomplete. */
export class BadRequestError extends AgentazDomainError {
  constructor(message: string) {
    super(message, 400, "bad_request");
  }
}

/** The requested loaded session is not present in the process working set. */
export class SessionNotFoundError extends AgentazDomainError {
  constructor(message = "No loaded session is available for this command.") {
    super(message, 404, "session_not_found");
  }
}

/** The requested persisted session file is not available in the current workspace. */
export class PersistedSessionNotFoundError extends AgentazDomainError {
  constructor() {
    super(
      "Persisted session file was not found in the current workspace.",
      404,
      "session_not_found",
    );
  }
}

/** The requested session cannot be removed because work is still in flight. */
export class SessionBusyError extends AgentazDomainError {
  constructor() {
    super("Session is busy and cannot be deleted.", 409, "session_busy");
  }
}

/** No idle loaded session can be evicted to satisfy a load/create request. */
export class SessionLimitReachedError extends AgentazDomainError {
  constructor(maxLoadedSessions: number) {
    super(
      `Loaded session limit reached (${maxLoadedSessions}). Try again after an active session becomes idle.`,
      409,
      "session_limit_reached",
    );
  }
}

/** A different browser client currently owns the session mutation lease. */
export class SessionControlConflictError extends AgentazDomainError {
  constructor() {
    super(
      "Session is controlled by another browser client.",
      409,
      "session_control_conflict",
    );
  }
}

/** The requested model provider/id pair is not registered in the Pi model registry. */
export class UnknownModelError extends AgentazDomainError {
  constructor(provider: string, id: string) {
    super(`Unknown model: ${provider}/${id}`, 400, "unknown_model");
  }
}
