/** Core TypeScript types and manifest-driven type inference for `@gantstreet/rastrata-plugin-sdk`.
 *
 * Line shapes (`BankLine`, `LedgerEvent`, `BalanceCheck`) are wire-compatible with Rastrata's
 * ingestion pipeline (`packages/application/src/ingest-types.ts`). */

export type PluginCapability = "ingest";

export type AccountRoleKind = "asset" | "liability" | "equity" | "income" | "expense";

export type AuthSpec =
  | {
      readonly kind: "api_key";
      readonly label: string;
      readonly envVar: string;
      readonly hint?: string;
    }
  | {
      readonly kind: "oauth2";
      readonly provider: string;
      readonly scopes: readonly string[];
    }
  | {
      readonly kind: "file";
      readonly extensions: readonly string[];
    }
  | {
      readonly kind: "none";
    };

export type ConfigField =
  | {
      readonly key: string;
      readonly label: string;
      readonly kind: "date";
      readonly required?: boolean;
      readonly default?: string;
      readonly hint?: string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly kind: "select";
      readonly options: readonly { readonly value: string; readonly label: string }[];
      readonly required?: boolean;
      readonly default?: string;
      readonly hint?: string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly kind: "boolean";
      readonly required?: boolean;
      readonly default?: boolean;
      readonly hint?: string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly kind: "text";
      readonly required?: boolean;
      readonly default?: string;
      readonly pattern?: string;
      readonly hint?: string;
    };

export interface RoleSpec {
  /** Logical account role key, e.g. "revenue.sales", "shopify.fees", "payouts.in-transit". */
  readonly key: string;
  readonly label: string;
  readonly kind: AccountRoleKind;
  readonly required: boolean;
  /** Optional chart roleKey tag to auto-bind if an account on the user's chart carries it. */
  readonly defaultRoleKey?: string;
}

export interface ClearingSpec {
  /** Role key of the clearing/in-transit account whose payout events match bank deposits. */
  readonly role: string;
  /** Maximum days between payout date and bank deposit date (default 7). */
  readonly windowDays?: number;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly PluginCapability[];
  /** Exact HTTPS hostnames the plugin may call. No wildcards, no IP literals. */
  readonly domains: readonly string[];
  readonly auth: AuthSpec;
  readonly fields?: readonly ConfigField[];
  readonly roles?: readonly RoleSpec[];
  readonly clearing?: ClearingSpec;
}

// ---- Compile-time inference from `manifest` (Stripe / Zod-level DX) ----------------------------

/** Union of role keys declared in `M["roles"]` (falls back to `string` when no roles are declared). */
export type InferRoleKeys<M extends PluginManifest> = M["roles"] extends readonly RoleSpec[]
  ? M["roles"][number]["key"]
  : string;

type FieldValueType<F extends ConfigField> = F extends { readonly kind: "boolean" }
  ? boolean
  : F extends {
        readonly kind: "select";
        readonly options: readonly { readonly value: infer V extends string }[];
      }
    ? V
    : string;

type RequiredFieldKeys<F extends ConfigField> = F extends
  | { readonly required: true }
  | { readonly default: string | boolean }
  ? F["key"]
  : never;

type OptionalFieldKeys<F extends ConfigField> = Exclude<F["key"], RequiredFieldKeys<F>>;

type FieldByKey<F extends ConfigField, K extends string> = Extract<F, { readonly key: K }>;

/** Typed config object inferred automatically from `manifest.fields`. */
export type InferConfig<M extends PluginManifest> = M["fields"] extends readonly ConfigField[]
  ? {
      readonly [K in RequiredFieldKeys<M["fields"][number]>]: FieldValueType<
        FieldByKey<M["fields"][number], K>
      >;
    } & {
      readonly [K in OptionalFieldKeys<M["fields"][number]>]?: FieldValueType<
        FieldByKey<M["fields"][number], K>
      >;
    }
  : Readonly<Record<string, never>>;

/** Typed auth credentials object inferred automatically from `manifest.auth.kind`. */
export type InferAuth<M extends PluginManifest> = M["auth"] extends { readonly kind: "api_key" }
  ? { readonly apiKey: string }
  : M["auth"] extends { readonly kind: "oauth2" }
    ? { readonly accessToken: string }
    : Readonly<Record<string, never>>;

// ---- Wire-compatible ingestion shapes ----------------------------------------------------------

export interface LineOrigin {
  readonly provider: string;
  readonly accountKey: string;
  readonly providerId?: string;
  readonly rawIndex: number;
  readonly excerpt?: string;
}

export interface BankLine extends LineOrigin {
  readonly kind: "bankLine";
  /** YYYY-MM-DD */
  readonly postedOn: string;
  /** Signed two-decimal string. Positive is money into the account. */
  readonly amount: string;
  /** ISO 4217 currency code, e.g. "USD". */
  readonly currency: string;
  readonly description: string;
  readonly counterparty?: string;
  readonly reference?: string;
  readonly runningBalance?: string;
}

export interface EventLeg<Role extends string = string> {
  readonly role: Role;
  /** Signed from the book's view: positive is a debit, negative is a credit. All legs sum to 0.00. */
  readonly amount: string;
  readonly memo?: string;
}

export interface LedgerEvent<Role extends string = string> extends LineOrigin {
  readonly kind: "event";
  readonly providerId: string;
  /** YYYY-MM-DD */
  readonly eventOn: string;
  readonly summary: string;
  readonly currency: string;
  readonly amount?: string;
  readonly legs: readonly EventLeg<Role>[];
  readonly links?: Readonly<Record<string, string>>;
  readonly coveredBy?: string;
  readonly evidence?: string;
  readonly sourceId?: string;
}

export type IngestLine<Role extends string = string> = BankLine | LedgerEvent<Role>;

export interface BalanceCheck {
  readonly accountKey: string;
  /** YYYY-MM-DD */
  readonly asOf: string;
  /** Signed two-decimal string, positive for a debit balance. */
  readonly balance: string;
}

export interface OfferedAccount {
  readonly id: string;
  readonly accountKey: string;
  readonly name: string;
  readonly kind: "checking" | "savings" | "credit_card" | "clearing" | "other";
  readonly currency: string;
  readonly mask?: string;
}

export interface RawPayload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly name?: string;
}

export interface PullBatch<Role extends string = string> {
  readonly sourceKey: string;
  readonly raw: RawPayload;
  readonly lines: readonly IngestLine<Role>[];
  readonly balances?: readonly BalanceCheck[];
  readonly cursor?: string;
  readonly accounts?: readonly OfferedAccount[];
}

export interface NormalizeResult<Role extends string = string> {
  readonly lines: readonly IngestLine<Role>[];
  readonly balances?: readonly BalanceCheck[];
}

export interface JsonResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: T;
  /** Verbatim response bytes ready to pass directly into `PullBatch.raw`. */
  readonly raw: RawPayload;
}

export interface GuardedHttp {
  /** Perform an HTTPS request restricted to `manifest.domains` with automatic secret redaction. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Fetch a JSON endpoint while preserving the exact verbatim raw bytes for SHA-256 archiving. */
  getJson<T = unknown>(
    url: string,
    init?: RequestInit & { readonly name?: string },
  ): Promise<JsonResponse<T>>;
}

export interface BankLineInput {
  readonly accountKey: string;
  readonly providerId?: string;
  readonly postedOn: string;
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly counterparty?: string;
  readonly reference?: string;
  readonly runningBalance?: string;
  readonly rawIndex?: number;
  readonly excerpt?: string;
}

export interface LedgerEventInput<Role extends string> {
  readonly accountKey: string;
  readonly providerId: string;
  readonly eventOn: string;
  readonly summary: string;
  readonly currency: string;
  readonly amount?: string;
  readonly legs: readonly EventLeg<Role>[];
  readonly links?: Readonly<Record<string, string>>;
  readonly coveredBy?: string;
  readonly evidence?: string;
  readonly sourceId?: string;
  readonly rawIndex?: number;
  readonly excerpt?: string;
}

export interface EmitHelpers<Role extends string> {
  bankLine(input: BankLineInput): BankLine;
  event(input: LedgerEventInput<Role>): LedgerEvent<Role>;
  balance(input: BalanceCheck): BalanceCheck;
}

export interface PullContext<M extends PluginManifest> {
  readonly cursor: string | null;
  readonly auth: InferAuth<M>;
  readonly config: InferConfig<M>;
  readonly bookCurrency: string;
  readonly timeZone: string;
  readonly http: GuardedHttp;
  readonly now: () => string;
  readonly emit: EmitHelpers<InferRoleKeys<M>>;
}

export interface NormalizeContext<M extends PluginManifest> {
  readonly config: InferConfig<M>;
  readonly bookCurrency: string;
  readonly timeZone: string;
  readonly emit: EmitHelpers<InferRoleKeys<M>>;
}

export interface IngestPlugin<M extends PluginManifest = PluginManifest> {
  readonly manifest: M;
  readonly pull?: (context: PullContext<M>) => AsyncIterable<PullBatch<InferRoleKeys<M>>>;
  readonly normalize?: (
    raw: RawPayload,
    context: NormalizeContext<M>,
  ) => NormalizeResult<InferRoleKeys<M>>;
}
