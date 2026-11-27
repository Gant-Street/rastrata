/** What the Agents components show. The token shapes are structurally what the service returns for
 * `tokens.list`; the UI package does not import the application, so they are written out here.
 * Nothing in them is a secret: an agent's credential never comes to a page. */
export type TokenPermission = "read" | "draft" | "post" | "configure" | "correct" | "close";
export type TokenStatus = "active" | "revoked" | "expired";
/** `open`: any program on this computer can act as the owner without a token. `key`: the owner must
 * present the owner key. */
export type OwnerAccess = "open" | "key";

export interface AgentTokenRow {
  readonly id: string;
  /** `rst_<id>`: enough to recognise a token, never its secret. */
  readonly prefix: string;
  readonly label: string;
  readonly permissions: readonly TokenPermission[];
  readonly status: TokenStatus;
  /** Instants as the service writes them: ISO 8601, UTC. */
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly lastUsedAt: string | null;
}

/** The three things a person may let an agent do. They are the service's presets, by its names. */
export type AgentChoiceId = "draft" | "read-only" | "bookkeeper";

export interface AgentChoice {
  readonly id: AgentChoiceId;
  readonly permissions: readonly TokenPermission[];
}

/** An agent that is connected, as the list shows it. */
export interface AgentConnectedRow {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly TokenPermission[];
  /** `expired` is one that ran out; one a person disconnected is not listed. */
  readonly status: "active" | "expired";
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  /** Whose it is, where the person reading the list sees other people's too and this one is not their own. */
  readonly owner?: string | undefined;
}
