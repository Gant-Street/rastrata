/** Structured, actionable errors returned by `@gantstreet/rastrata-plugin-sdk`.
 * Every error carries a stable machine `code`, a plain-English `message`, and an optional `hint`
 * stating the exact fix so developers (and their agents) know what to change immediately. */

export type PluginErrorCode =
  | "invalid_manifest"
  | "invalid_money"
  | "invalid_date"
  | "invalid_line"
  | "unbalanced_event"
  | "undeclared_role"
  | "egress_blocked"
  | "payload_too_large"
  | "auth_error"
  | "rate_limited"
  | "provider_error"
  | "secret_leaked";

export interface PluginErrorOptions {
  readonly code: PluginErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly field?: string;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

export class PluginError extends Error {
  readonly code: PluginErrorCode;
  readonly hint?: string;
  readonly field?: string;
  readonly retryAfterSeconds?: number;

  constructor(options: PluginErrorOptions) {
    const formatted = options.hint ? `${options.message} ${options.hint}` : options.message;
    super(formatted, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PluginError";
    this.code = options.code;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.field !== undefined) this.field = options.field;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isPluginError(value: unknown): value is PluginError {
  return value instanceof PluginError;
}
