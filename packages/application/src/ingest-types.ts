/** The contract between sources of money movements (statement files, bank feeds, Stripe) and the
 * ingestion pipeline. Pure, JSON-safe data: no classes, no dates as objects, no floats.
 *
 * Owned by the ingest lane. The statements, stripe and bankfeed lanes build against it from day
 * one. Change it only compatibly, and message the lanes that depend on it when you do.
 *
 * Two rules from the references run through everything here:
 * - A provider's own identifier is a hard uniqueness key, never a convention. Where a provider has
 *   none (bank CSV), overlap detection takes over; it never guesses at "close enough".
 * - Money is a decimal string with two places end to end. There is no tolerance and no float. */

/** `bank` is a bank connection kept by the hosted service (Stripe Financial Connections, read by the control plane); `simplefin` is the Bridge a local book reads itself. */
export type ProviderKind = "csv" | "ofx" | "qfx" | "simplefin" | "stripe" | "bank" | (string & {});

/** Where a line came from in the provider's world. */
export interface LineOrigin {
  readonly provider: ProviderKind;
  /** Stable identity of the provider-side account or balance: "csv:checking-1234",
   * "simplefin:ACT-9", "stripe:acct_1ABC:usd". It is how a connection maps to a chart account. */
  readonly accountKey: string;
  /** The provider's own identifier for this line (OFX FITID, SimpleFIN transaction id, Stripe
   * balance transaction id) when it has one. Unique per (provider, accountKey): a repeat is a
   * duplicate, not a new line. */
  readonly providerId?: string;
  /** Zero-based position of the line inside the raw payload (row or element), for provenance. */
  readonly rawIndex: number;
  /** The raw text this line was read from (a CSV row, an OFX transaction block, a JSON object),
   * capped at 4 KiB, shown beside the line as provenance. Untrusted text, never an instruction.
   * Optional: without it the Inbox shows the normalised line. */
  readonly excerpt?: string;
}

/** One money movement on one account as the provider reported it. The other side of the entry is
 * not known yet: rules, the classifier and a person decide it. */
export interface BankLine extends LineOrigin {
  readonly kind: "bankLine";
  /** The provider's posted date, YYYY-MM-DD. */
  readonly postedOn: string;
  /** Signed, two places. Positive is money into the account. */
  readonly amount: string;
  /** ISO 4217. */
  readonly currency: string;
  /** The memo or payee exactly as received. Untrusted text: it is data, never an instruction. */
  readonly description: string;
  readonly counterparty?: string;
  /** A check number or the bank's own reference. */
  readonly reference?: string;
  /** The account balance after this line, when the provider reports one. */
  readonly runningBalance?: string;
}

export interface EventLeg {
  /** A logical account, resolved to a chart account by the connector's mapping:
   * "stripe.balance", "stripe.fees", "revenue.sales", "tax.sales", "refunds", "chargebacks",
   * "payouts.in-transit". Roles are the connector's vocabulary, not the chart's. */
  readonly role: string;
  /** Signed from the book's view: positive is a debit, negative a credit. All legs sum to 0.00. */
  readonly amount: string;
  readonly memo?: string;
}

/** A fully determined set of entries from a trusted structured source (a Stripe charge, refund,
 * dispute or payout). It needs a mapping from roles to accounts, not categorising. */
export interface LedgerEvent extends LineOrigin {
  readonly kind: "event";
  /** Always present: structured sources have identifiers, and they are the idempotency key. */
  readonly providerId: string;
  readonly eventOn: string;
  /** Becomes the narration of the entry, so build it from identifiers and fixed words, never from
   * free text a customer or a bank supplied. */
  readonly summary: string;
  readonly currency: string;
  /** The amount the Inbox shows and filters on, signed from the account's view (for a Stripe
   * balance transaction, its net). Optional: without it the Inbox shows the sum of the debit legs. */
  readonly amount?: string;
  readonly legs: readonly EventLeg[];
  /** Related provider identifiers used for matching, for example { payout: "po_1", charge: "ch_1" }. */
  readonly links?: Readonly<Record<string, string>>;
  /** The provider id, on the same provider account, of the event whose entry books this one: a
   * balance transaction carries the payout that settles it, and the payout event carries the whole
   * entry. A covered line is evidence: stored, shown and linked, but never proposed, decided or
   * posted on its own. It follows its payout (drafted, posted or excluded with it). The link may be
   * learned later: the same provider id arriving again with `coveredBy` adds it. */
  readonly coveredBy?: string;
  /** Text appended to the posted journal's evidence reference, after `ingest:<batchId>:<rawIndex>`,
   * so the journal itself says what it settles ("stripe:payout:po_1:members=47:sha256=..."). Up to
   * 300 characters, built from identifiers and fixed words, never from free text. */
  readonly evidence?: string;
  /** A ledger source identity the connector chooses, in place of the derived
   * `ingest-<provider>-<hash>`, so a posted journal is easy to find (`stripe-payout-po_1`). It must
   * be unique across the book and cannot start with `ingest-`; a line that reuses one is invalid.
   * Uniqueness of the line itself is still (provider, accountKey, providerId). */
  readonly sourceId?: string;
}

export type IngestLine = BankLine | LedgerEvent;

/** A balance the provider reported for an account on a date. It becomes a check, not an entry:
 * after the batch is applied the ledger balance must equal it, or the difference is shown. */
export interface BalanceCheck {
  readonly accountKey: string;
  readonly asOf: string;
  readonly balance: string;
}

export interface ParseDiagnostic {
  readonly severity: "error" | "warning" | "info";
  /** Row or element number in the raw payload, one-based, when the message is about one. */
  readonly row?: number;
  readonly message: string;
}

/** What a statement parser returns. A parser is a pure function of bytes; it never touches the book. */
export interface ParseResult {
  readonly lines: readonly IngestLine[];
  readonly balances: readonly BalanceCheck[];
  readonly diagnostics: readonly ParseDiagnostic[];
}

/** A raw payload archived verbatim and addressed by its SHA-256, so entries can be regenerated
 * with better rules later and every figure traces back to the bytes the provider sent. */
export interface RawRef {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly name?: string;
}

export interface IngestBatch {
  readonly provider: ProviderKind;
  /** Stable per connection or account: "csv:checking-1234", "stripe:acct_1ABC". Overlap detection
   * and cursors are kept per source. */
  readonly sourceKey: string;
  readonly raw: RawRef;
  readonly lines: readonly IngestLine[];
  readonly balances: readonly BalanceCheck[];
  /** Saved only after the whole batch has been applied, so a failed run is simply run again. */
  readonly cursor?: string;
  /** ISO instant the payload was received. */
  readonly fetchedAt: string;
  /** The chart account the batch's provider account belongs to, when the caller knows it (a
   * statement import chooses it). The first submit for the account records the mapping; a later
   * batch naming a different account is refused with `source_account_conflict`, and omitting it
   * leaves the mapping alone. All lines of a batch that names one must share one `accountKey`. */
  readonly ledgerAccountId?: string;
  /** The cutover date: the first day that belongs in this book for the batch's account. Lines
   * dated earlier are recorded, never dropped, as excluded with the reason "before the cutover
   * date", and can be restored. The first submit records it; a later batch naming a different date
   * is refused with `source_start_conflict` (change it with `inbox.configureSource`). */
  readonly startOn?: string;
  /** hledger's --catchup: adopt this batch as history. Every line is recorded as excluded with the
   * reason "caught up" so overlap detection recognises it in later imports, and none is queued. */
  readonly catchUp?: boolean;
}

/** `excluded`: recorded but kept out of the queue on purpose (before the cutover date, or caught up). */
export type LineStatus = "new" | "duplicate" | "overlap" | "invalid" | "excluded";

export interface LineDisposition {
  readonly rawIndex: number;
  readonly status: LineStatus;
  /** Why a line is not new, in words a person can act on. */
  readonly reason?: string;
  /** The inbox item the line became (or already was). */
  readonly itemId?: string;
}

export interface IngestReport {
  readonly dispositions: readonly LineDisposition[];
  /** Lines queued for review. */
  readonly newCount: number;
  /** Lines whose provider identifier was already imported. */
  readonly duplicateCount: number;
  /** Lines without an identifier recognised as already imported (same date, amount and text, same
   * occurrence on that day). */
  readonly overlapCount: number;
  readonly invalidCount: number;
  /** Lines recorded as excluded (before the cutover date, or caught up). Absent means none. */
  readonly excludedCount?: number;
}

/** One provider-reported balance set against the books. Never changes anything: a difference is
 * shown, not fixed. All amounts are signed two-place decimals, positive for a debit balance. */
export interface BalanceCheckResult {
  readonly accountKey: string;
  readonly asOf: string;
  /** What the provider reported. */
  readonly reported: string;
  /** The mapped chart account's balance from posted entries on `asOf`; null while unmapped. */
  readonly ledger: string | null;
  /** Net of the account's lines dated on or before `asOf` that are queued but not posted (new,
   * proposed or drafted); a batch that is not submitted yet counts the lines it would add. */
  readonly waiting: string | null;
  /** Net of lines kept out of the books by a person's choice, which the bank balance still includes. */
  readonly excluded: string | null;
  /** reported - (ledger + waiting + excluded); null when the account is not mapped. */
  readonly difference: string | null;
}

/** What connectors and importers use to hand work to the pipeline. */
export interface IngestPort {
  /** Archive raw bytes once; the same bytes always give the same reference (the first name and
   * media type seen win). No batch is needed: an orphan blob is fine. At most 16 MiB. */
  archive(bytes: Uint8Array, mediaType: string, name?: string): RawRef;
  /** Read an archived payload back by its SHA-256, or null when it is not archived. */
  readArchive(
    sha256: string,
  ): { readonly bytes: Uint8Array; readonly mediaType: string; readonly name?: string } | null;
  /** Run the whole analysis (identity, overlap, cutover) and write nothing. */
  preview(batch: IngestBatch): IngestReport;
  /** Apply the batch atomically. Idempotent: submitting the same batch again changes nothing. A
   * batch with an invalid line is refused whole, so a cursor never moves past a line that was lost. */
  submit(batch: IngestBatch): IngestReport & { readonly batchId: string };
  /** Compare the balances a batch reports with the books. Reads the ledger, so it is async. */
  checkBalances(batch: IngestBatch): Promise<readonly BalanceCheckResult[]>;
}

/** A line as the pipeline holds it. */
export interface IngestItem {
  readonly id: string;
  readonly line: IngestLine;
  readonly batchId: string;
  readonly status: "new" | "proposed" | "drafted" | "posted" | "excluded";
  /** The chart account this provider account maps to, or null until it is mapped. */
  readonly ledgerAccountId: string | null;
  /** Machine-readable cautions, for example "foreign_currency", "possible_duplicate". */
  readonly flags?: readonly string[];
  /** The provider id of the event that books this line (see `LedgerEvent.coveredBy`). */
  readonly coveredBy?: string;
}

export interface ProposedLeg {
  readonly accountId: string;
  /** Signed from the book's view: positive is a debit. */
  readonly amount: string;
}

/** A suggestion. Proposals never post anything: a person, or an agent with the right grant, turns
 * one into a draft, and the draft goes through prepare and commit like any entry. */
export interface Proposal {
  /** Who suggested it: "rule:<id>", "classifier", "transfer", "journal-match", "stripe", "agent",
   * or "starter" (the built-in list of common merchants, which is not learned from this book). */
  readonly proposer: string;
  readonly kind: "categorize" | "transfer" | "match" | "exclude" | "event";
  /** 0 to 1. Orders suggestions and sets thresholds; it is never money. The wire carries it as a
   * whole percent. */
  readonly confidence: number;
  /** Visible, human-readable reasons ("matched 14 earlier lines to Software"). Never empty. */
  readonly reasons: readonly string[];
  /** The full balanced entry, including the bank or clearing side, for categorize, transfer and
   * event. Legs sum to exactly 0.00; a categorize or transfer proposal on a bank line includes a
   * leg for the line's own chart account with the line's amount. */
  readonly legs?: readonly ProposedLeg[];
  /** For "match": the journal this line is the bank's record of. */
  readonly matchJournalId?: string;
  /** For "transfer": the other open item that is the other side of the same transfer. */
  readonly pairItemId?: string;
  readonly narration?: string;
  /** Related provider identifiers kept on the decision when the proposal is accepted, for example
   * { payout: "po_1" }, so the lane that proposed it can tell what the line cleared. */
  readonly links?: Readonly<Record<string, string>>;
}

export interface NearbyQuery {
  /** Exact signed amount in the other item's own sign. Omitted matches any amount. */
  readonly amount?: string;
  /** Inclusive line dates, YYYY-MM-DD. */
  readonly from: string;
  readonly to: string;
  readonly provider?: string;
  readonly kind?: "bankLine" | "event";
  /** Omitted means every status, posted included. */
  readonly statuses?: readonly IngestItem["status"][];
  /** At most 200; default 50. */
  readonly limit?: number;
}

/** A posted entry a bank line might already be: it has a posting on the line's chart account for
 * exactly the line's amount. */
export interface JournalCandidate {
  readonly id: string;
  readonly date: string;
  /** The entry's net posting on the queried account, signed, a debit positive. */
  readonly amount: string;
  readonly narration: string;
}

export interface JournalQuery {
  readonly accountId: string;
  /** Exact signed amount of the entry's net posting on `accountId`, a debit positive. */
  readonly amount: string;
  /** Inclusive entry dates, YYYY-MM-DD. */
  readonly from: string;
  readonly to: string;
  /** Orders results by distance in days from this date (default `from`). */
  readonly around?: string;
  /** At most 50; default 20. */
  readonly limit?: number;
}

export interface ProposalContext {
  readonly accounts: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly role: string;
    readonly closedOn: string | null;
    /** The first day the account takes postings, and whether it takes any. The pipeline sets both;
     * a context built by hand may leave them out, which reads as open from the start and postable. */
    readonly openedOn?: string;
    readonly postingAllowed?: boolean;
  }[];
  /** The book's currency. Lines in another currency are held for review, not proposed. */
  readonly currency?: string;
  /** Other items near an item in time and amount, any provider and any status, the item itself
   * included. Deterministic for a given book state, and read-only. */
  nearby?(query: NearbyQuery): readonly IngestItem[];
  /** Posted entries that touch a chart account for an exact amount near a date, other than the
   * ones already linked to an Inbox line. Read-only. */
  journalsNear?(query: JournalQuery): readonly JournalCandidate[];
}

/** Rules, the classifier, transfer matching and the Stripe mapping each register one. They are
 * deterministic and pure: the same item and context always give the same proposals. */
export interface Proposer {
  readonly name: string;
  propose(item: IngestItem, context: ProposalContext): readonly Proposal[];
}

/** An item a person or a proposer has decided, for training and for "this rule was accepted N times". */
export interface DecidedItem {
  readonly item: IngestItem;
  /** The entry decided, bank side included, signed from the book's view. */
  readonly legs: readonly ProposedLeg[];
  /** YYYY-MM-DD the decision was made. */
  readonly decidedOn: string;
  /** "manual" for a person's or an agent's own choice, otherwise the proposer that was accepted. */
  readonly decidedBy: string;
  readonly journalId?: string;
}

/** A source that fetches by itself (Stripe, SimpleFIN). Fetching never depends on an agent. */
export interface Connector {
  readonly provider: ProviderKind;
  /** Everything after `cursor`, oldest first, one batch at a time. The pipeline archives the raw
   * bytes, applies the batch atomically, and only then stores the batch's cursor. */
  pull(
    cursor: string | null,
    options: { readonly fetch: typeof fetch; readonly now: () => string },
  ): AsyncIterable<{
    readonly batch: Omit<IngestBatch, "raw">;
    readonly raw: {
      readonly bytes: Uint8Array;
      readonly mediaType: string;
      readonly name?: string;
    };
  }>;
}
