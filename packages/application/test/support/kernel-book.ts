import {
  CHAIN_HEAD_STATE_COMMITMENT_PROFILE,
  accountId,
  actorId,
  bookId,
  commandId,
  commodityId,
  createBookProtocolState,
  createBookState,
  derivationId,
  evidenceId,
  executeBookCommand,
  ExactDecimal,
  ExactRational,
  fiscalCalendarId,
  fiscalPeriodId,
  hashCanonical,
  identifier,
  instant,
  journalId,
  localDate,
  openingBoundaryId,
  policyCapabilityId,
  policyId,
  postingId,
  quantizationPolicyId,
  resolveJournal,
  sealCommand,
  semanticVersion,
  type AccountSnapshot,
  type BookCommand,
  type BookProtocolState,
  type BookState,
  type BookingPolicy,
  type FiscalPeriod,
  type JournalTransaction,
  type QuantizationPolicy,
  type ResolvedTransaction,
} from "@rastrata/kernel";
import { closePeriodCommand, reopenPeriodCommand } from "../../src/calendar/commands.ts";

/** A book built straight from the kernel, in memory: the same commands the ledger executes, with no
 * database and no application service. It exists so report tests can use books of several fiscal
 * years (and non-calendar fiscal years) without depending on any operation that creates them. */
export type Role = AccountSnapshot["role"];

export interface AccountSpec {
  readonly code: string;
  readonly role: Role;
  readonly name?: string;
  readonly parent?: string;
}

export interface KernelBookOptions {
  readonly basis?: "accrual" | "cash";
  /** The calendar year in which the first fiscal year starts. */
  readonly firstYear: number;
  /** Month the fiscal year starts, 1 to 12 (default 1). */
  readonly startMonth?: number;
  readonly years: number;
  readonly periodModel?: "monthly" | "quarterly";
  readonly accounts: readonly AccountSpec[];
  /** Make the book with the state commitment every book the application sets up has, whose commands
   * cost the same at any size (the default since 2026-10-29: a fixture is then the book the application
   * keeps, and a three-year one builds in a fraction of the time). `false` gives the legacy commitment,
   * under which a command re-hashes every journal, for the tests of that commitment. */
  readonly chainHead?: boolean;
}

const version = semanticVersion("1.0.0");
const NOW = "2020-01-01T00:00:00.000Z";

const pad = (value: number) => String(value).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The periods of `years` fiscal years starting at `firstYear`/`startMonth`. Sequences run across the
 * whole calendar, which the kernel requires; `fiscalYear` is the year the fiscal year starts in. */
export function buildPeriods(
  calendar: ReturnType<typeof fiscalCalendarId>,
  firstYear: number,
  startMonth: number,
  years: number,
  monthly: boolean,
  firstSequence = 1,
): FiscalPeriod[] {
  const periods: FiscalPeriod[] = [];
  let sequence = firstSequence;
  for (let offset = 0; offset < years; offset++) {
    const fiscalYear = firstYear + offset;
    const length = monthly ? 1 : 3;
    for (let index = 0; index < (monthly ? 12 : 4); index++) {
      const firstMonthIndex = startMonth - 1 + index * length;
      const lastMonthIndex = firstMonthIndex + length - 1;
      const startYear = fiscalYear + Math.floor(firstMonthIndex / 12);
      const startMonthNumber = (firstMonthIndex % 12) + 1;
      const endYear = fiscalYear + Math.floor(lastMonthIndex / 12);
      const endMonthNumber = (lastMonthIndex % 12) + 1;
      periods.push({
        id: fiscalPeriodId(`period-${String(sequence).padStart(3, "0")}`),
        calendarId: calendar,
        fiscalYear: BigInt(fiscalYear),
        sequence: BigInt(sequence),
        label: monthly ? `${startYear}-${pad(startMonthNumber)}` : `FY${fiscalYear} Q${index + 1}`,
        kind: "regular",
        startsOn: localDate(`${startYear}-${pad(startMonthNumber)}-01`),
        endsOn: localDate(
          `${endYear}-${pad(endMonthNumber)}-${pad(lastDay(endYear, endMonthNumber))}`,
        ),
      });
      sequence++;
    }
  }
  return periods;
}

export class KernelBook {
  state: BookState;
  private protocol: BookProtocolState;
  private counter = 0;
  private readonly actor = actorId("fixture");
  private readonly id = bookId("fixture-book");
  private readonly currency = commodityId("USD");
  private readonly monthly: boolean;
  private readonly startMonth: number;
  private readonly calendar = fiscalCalendarId("fixture-calendar");
  private readonly firstYear: number;
  private yearsConfigured: number;

  constructor(options: KernelBookOptions) {
    this.monthly = (options.periodModel ?? "monthly") === "monthly";
    this.startMonth = options.startMonth ?? 1;
    this.firstYear = options.firstYear;
    this.yearsConfigured = options.years;
    const owner = identifier<"BookOwner">("fixture-owner");
    const periods = buildPeriods(
      this.calendar,
      options.firstYear,
      this.startMonth,
      options.years,
      this.monthly,
    );
    const opened = periods[0]?.startsOn ?? localDate(`${options.firstYear}-01-01`);
    const accounts: AccountSnapshot[] = options.accounts.map((spec) => ({
      id: accountId(spec.code.toLowerCase()),
      bookId: this.id,
      code: spec.code,
      name: spec.name ?? `Account ${spec.code}`,
      role: spec.role,
      normalSide: spec.role === "asset" || spec.role === "expense" ? "debit" : "credit",
      postingAllowed: true,
      openedOn: opened,
      ...(spec.parent ? { parentId: accountId(spec.parent.toLowerCase()) } : {}),
      allowedCommodityIds: [],
    }));
    const rounding = accounts.find((account) => account.role === "asset");
    if (!rounding) throw new Error("A fixture book needs an asset account");
    const policy: BookingPolicy = {
      id: policyId("fixture-booking"),
      bookId: this.id,
      version,
      validFrom: instant(`${opened}T00:00:00Z`),
      lotSelection: "specificIdentification",
      scope: "legalEntity",
      scopeKey: owner,
      requiredDimensionIds: [],
      implementationVersion: version,
      capability: {
        id: policyCapabilityId("fixture-specific"),
        method: "specificIdentification",
        scope: "legalEntity",
        status: "supported",
        implementationVersion: version,
        verificationEvidenceIds: [evidenceId("fixture-profile")],
      },
    };
    const quantization: QuantizationPolicy = {
      id: quantizationPolicyId("fixture-quantization"),
      bookId: this.id,
      version,
      functionalCommodityId: this.currency,
      validFrom: opened,
      targetScale: 2n,
      roundingMode: "halfEven",
      roundingAccountId: rounding.id,
    };
    const initial = createBookState(
      {
        bookId: this.id,
        code: "FIXTURE",
        ownerId: owner,
        ownerKind: "legalEntity",
        kind: "operational",
        functionalCommodityId: this.currency,
        primaryBasis: options.basis ?? "accrual",
        fiscalCalendarId: this.calendar,
        accountingTimeZone: "UTC",
      },
      periods,
      {
        bookId: this.id,
        functionalCommodityId: this.currency,
        accounts,
        dimensions: [],
        dimensionMembers: [],
        requiredDimensionIds: [],
      },
      [policy],
      [quantization],
      [],
      instant(NOW),
      undefined,
      (options.chainHead ?? true) ? CHAIN_HEAD_STATE_COMMITMENT_PROFILE : undefined,
    );
    this.state = initial;
    this.protocol = createBookProtocolState();
    this.execute(
      sealCommand({
        id: commandId("fixture-activate"),
        type: "activateBook",
        protocolVersion: version,
        bookId: this.id,
        expectedBookRevision: 0n,
        actorId: this.actor,
        issuedAt: instant(NOW),
        completedAt: instant(NOW),
        committedAt: instant(NOW),
        mode: "newZeroBalance",
        boundaryId: openingBoundaryId("fixture-opening"),
        firstAccountingDate: opened,
      }),
    );
  }

  private execute(command: BookCommand): void {
    const result = executeBookCommand(this.state, this.protocol, command);
    if (result.result.disposition !== "committed")
      throw new Error(
        `Fixture command ${command.type} was rejected: ${JSON.stringify(
          result.result,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        ).slice(0, 400)}`,
      );
    this.state = result.state;
    this.protocol = result.protocol;
  }

  /** Run a command the way a replay does, whatever the kernel says: the state and the protocol become
   * what the transition returns, and a rejection is retained. True when the command committed. */
  attempt(command: BookCommand): boolean {
    const result = executeBookCommand(this.state, this.protocol, command);
    this.state = result.state;
    this.protocol = result.protocol;
    return result.result.disposition === "committed";
  }

  /** A copy of the book that goes on from where this one is, so two different commands can follow the
   * same state. The state and the protocol are immutable, so they are shared. */
  fork(): KernelBook {
    const copy = Object.create(KernelBook.prototype) as KernelBook;
    return Object.assign(copy, this);
  }

  /** Close a period, the way the calendar lane does. True when the kernel closed it. */
  close(periodId: string): boolean {
    return this.attempt(
      closePeriodCommand(
        this.state,
        { actionId: `fx-close-${++this.counter}`, actor: this.actor, now: instant(NOW) },
        periodId,
        "fixture close",
      ),
    );
  }

  /** Close a period and post a closing entry with the close, as a book kept by other software does.
   * Rastrata's reports refuse to read such a book. True when the kernel closed it. */
  closeWithEntry(
    periodId: string,
    date: string,
    lines: readonly (readonly [string, bigint])[],
  ): boolean {
    const posting = this.postingCommand(date, lines, "closing entry").command;
    if (posting.type !== "postJournal") throw new Error("Expected a posting");
    const close = closePeriodCommand(
      this.state,
      { actionId: `fx-close-${++this.counter}`, actor: this.actor, now: instant(NOW) },
      periodId,
      "fixture close with an entry",
    );
    if (close.type !== "closePeriod") throw new Error("Expected a close");
    const { inputHash: _sealed, ...unsealed } = close;
    return this.attempt(
      sealCommand({
        ...unsealed,
        closing: { ...posting.resolved, journal: { ...posting.resolved.journal, kind: "closing" } },
      }),
    );
  }

  /** Reopen a closed period (and every later one). True when the kernel reopened it. */
  reopen(periodId: string): boolean {
    return this.attempt(
      reopenPeriodCommand(
        this.state,
        { actionId: `fx-reopen-${++this.counter}`, actor: this.actor, now: instant(NOW) },
        periodId,
        "fixture reopen",
      ),
    );
  }

  /** Replace a posted journal with a corrected one dated `date`, which supersedes it: from that date
   * on a report leaves the original out. Returns the new journal's id, or null when the kernel
   * refused (the period is closed, say). */
  supersede(
    originalId: string,
    date: string,
    lines: readonly (readonly [string, bigint])[],
    narration = "fixture correction",
  ): string | null {
    const original = this.state.journals.find((item) => item.journal.id === originalId);
    if (!original) throw new Error("Original journal not found");
    const index = ++this.counter;
    const financialId = `fx-${String(index).padStart(6, "0")}`;
    const now = instant(NOW);
    const postings = lines.map(([code, cents], ordinal) => ({
      id: postingId(`${financialId}-${ordinal}`),
      ordinal: BigInt(ordinal),
      accountId: accountId(this.account(code)),
      units: { canonicalNumber: ExactRational.of(cents, 100n), commodityId: this.currency },
      bookValue: { amount: ExactDecimal.of(cents, 2n), functionalCommodityId: this.currency },
      dimensionMemberIds: [],
    }));
    const journal: JournalTransaction = {
      id: journalId(financialId),
      kind: "ordinary",
      bookId: this.id,
      functionalCommodityId: this.currency,
      economicAt: instant(`${date}T12:00:00Z`),
      accountingDate: localDate(date),
      recordedAt: now,
      narration,
      postings,
    };
    const quantization = this.state.quantizationPolicies[0];
    const policy = this.state.policies[0];
    if (!quantization || !policy) throw new Error("No policy");
    const derivation = {
      id: derivationId(`${financialId}-lineage`),
      policyId: policy.id,
      policyVersion: policy.version,
      algorithmVersion: version,
      inputHash: hashCanonical({ originalJournalId: originalId, supersession: true }),
      actorId: this.actor,
      state: "approved" as const,
      recordedAt: now,
      evidence: [
        {
          id: evidenceId(`${financialId}-evidence`),
          sourceSystem: "fixture-review",
          sourceRecordId: originalId,
          observedAt: now,
          contentHash: original.canonicalHash,
        },
      ],
    };
    const resolved = resolveJournal(
      journal,
      this.state.policies,
      this.state.identity.ownerId,
      quantization,
      postings.map((posting) => posting.bookValue.amount.toRational()),
      [derivation],
    );
    if (Array.isArray(resolved))
      throw new Error(`Fixture supersession invalid: ${JSON.stringify(resolved)}`);
    const committed = this.attempt(
      sealCommand({
        id: commandId(`fx-command-${index}`),
        type: "correctJournal",
        protocolVersion: version,
        bookId: this.id,
        expectedBookRevision: this.state.bookRevision,
        actorId: this.actor,
        issuedAt: now,
        completedAt: now,
        committedAt: now,
        correctionKind: "supersession",
        originalJournalId: original.journal.id,
        resolved: resolved as ResolvedTransaction,
      }),
    );
    return committed ? financialId : null;
  }

  /** The id of the account with this code. */
  account(code: string): string {
    return code.toLowerCase();
  }

  /** Post a balanced journal. Each line is an account code and a signed amount in cents (debit
   * positive). Returns the journal's id. */
  post(date: string, lines: readonly (readonly [string, bigint])[], narration = "entry"): string {
    const { command, financialId } = this.postingCommand(date, lines, narration);
    this.execute(command);
    return financialId;
  }

  /** Post a balanced journal if the kernel allows it (not into a closed period, say). Returns the
   * journal's id, or null when it was refused and the book is as it was. */
  tryPost(
    date: string,
    lines: readonly (readonly [string, bigint])[],
    narration = "entry",
  ): string | null {
    const { command, financialId } = this.postingCommand(date, lines, narration);
    return this.attempt(command) ? financialId : null;
  }

  /** Post a balanced journal that carries the evidence of a source record, as the journals the opening
   * tools and the importers post do (`sourceSystem` "rastrata-source-v1", a record id such as
   * "opening-2025-01-01-abc"). */
  postFromSource(
    date: string,
    lines: readonly (readonly [string, bigint])[],
    sourceRecordId: string,
    narration = "entry from a source",
  ): string | null {
    const { command, financialId } = this.postingCommand(date, lines, narration, sourceRecordId);
    return this.attempt(command) ? financialId : null;
  }

  private postingCommand(
    date: string,
    lines: readonly (readonly [string, bigint])[],
    narration: string,
    sourceRecordId?: string,
  ): { command: BookCommand; financialId: string } {
    const total = lines.reduce((sum, [, cents]) => sum + cents, 0n);
    if (total !== 0n) throw new Error("A fixture journal must balance");
    const index = ++this.counter;
    const financialId = `fx-${String(index).padStart(6, "0")}`;
    const postings = lines.map(([code, cents], ordinal) => ({
      id: postingId(`${financialId}-${ordinal}`),
      ordinal: BigInt(ordinal),
      accountId: accountId(this.account(code)),
      units: { canonicalNumber: ExactRational.of(cents, 100n), commodityId: this.currency },
      bookValue: { amount: ExactDecimal.of(cents, 2n), functionalCommodityId: this.currency },
      dimensionMemberIds: [],
    }));
    const journal: JournalTransaction = {
      id: journalId(financialId),
      kind: "ordinary",
      bookId: this.id,
      functionalCommodityId: this.currency,
      economicAt: instant(`${date}T12:00:00Z`),
      accountingDate: localDate(date),
      recordedAt: instant(NOW),
      narration,
      postings,
    };
    const quantization = this.state.quantizationPolicies[0];
    const policy = this.state.policies[0];
    if (!quantization || !policy) throw new Error("No policy");
    const now = instant(NOW);
    const derivations =
      sourceRecordId === undefined
        ? []
        : [
            {
              id: derivationId(`${financialId}-lineage`),
              policyId: policy.id,
              policyVersion: policy.version,
              algorithmVersion: version,
              inputHash: hashCanonical({ sourceRecordId }),
              actorId: this.actor,
              state: "approved" as const,
              recordedAt: now,
              evidence: [
                {
                  id: evidenceId(`${financialId}-evidence`),
                  sourceSystem: "rastrata-source-v1",
                  sourceRecordId,
                  observedAt: now,
                  contentHash: hashCanonical({ sourceRecordId }),
                },
              ],
            },
          ];
    const resolved = resolveJournal(
      journal,
      this.state.policies,
      this.state.identity.ownerId,
      quantization,
      postings.map((posting) => posting.bookValue.amount.toRational()),
      derivations,
    );
    if (Array.isArray(resolved))
      throw new Error(`Fixture journal invalid: ${JSON.stringify(resolved)}`);
    const command = sealCommand({
      id: commandId(`fx-command-${index}`),
      type: "postJournal",
      protocolVersion: version,
      bookId: this.id,
      expectedBookRevision: this.state.bookRevision,
      actorId: this.actor,
      issuedAt: instant(NOW),
      completedAt: instant(NOW),
      committedAt: instant(NOW),
      resolved: resolved as ResolvedTransaction,
    });
    return { command, financialId };
  }

  /** A linked reversal of a posted journal, as the application's reversal builds it. */
  reverse(originalId: string, date: string, reason = "fixture reversal"): string {
    const { command, financialId } = this.reversalCommand(originalId, date, reason);
    this.execute(command);
    return financialId;
  }

  /** Reverse a posted journal if the kernel allows it. Returns the reversal's id, or null when it was
   * refused and the book is as it was. */
  tryReverse(originalId: string, date: string, reason = "fixture reversal"): string | null {
    const { command, financialId } = this.reversalCommand(originalId, date, reason);
    return this.attempt(command) ? financialId : null;
  }

  private reversalCommand(
    originalId: string,
    date: string,
    reason: string,
  ): { command: BookCommand; financialId: string } {
    const original = this.state.journals.find((item) => item.journal.id === originalId);
    if (!original) throw new Error("Original journal not found");
    const index = ++this.counter;
    const financialId = `fx-${String(index).padStart(6, "0")}`;
    const now = instant(NOW);
    const journal: JournalTransaction = {
      id: journalId(financialId),
      kind: "reversing",
      bookId: this.id,
      functionalCommodityId: this.currency,
      economicAt: instant(`${date}T12:00:00Z`),
      accountingDate: localDate(date),
      recordedAt: now,
      narration: `Reversal of No. ${original.postingSequence}: ${reason}`,
      postings: original.journal.postings.map((posting, ordinal) => ({
        ...posting,
        id: postingId(`${financialId}-${ordinal}`),
        units: {
          ...posting.units,
          canonicalNumber: posting.units.canonicalNumber.negate(),
        },
        bookValue: { ...posting.bookValue, amount: posting.bookValue.amount.negate() },
      })),
    };
    const quantization = this.state.quantizationPolicies[0];
    const policy = this.state.policies[0];
    if (!quantization || !policy) throw new Error("No policy");
    const derivation = {
      id: derivationId(`${financialId}-lineage`),
      policyId: policy.id,
      policyVersion: policy.version,
      algorithmVersion: version,
      inputHash: hashCanonical({ originalJournalId: originalId, reason }),
      actorId: this.actor,
      state: "approved" as const,
      recordedAt: now,
      evidence: [
        {
          id: evidenceId(`${financialId}-evidence`),
          sourceSystem: "fixture-review",
          sourceRecordId: originalId,
          observedAt: now,
          contentHash: original.canonicalHash,
        },
      ],
    };
    const resolved = resolveJournal(
      journal,
      this.state.policies,
      this.state.identity.ownerId,
      quantization,
      journal.postings.map((posting) => posting.bookValue.amount.toRational()),
      [derivation],
    );
    if (Array.isArray(resolved))
      throw new Error(`Fixture reversal invalid: ${JSON.stringify(resolved)}`);
    const command = sealCommand({
      id: commandId(`fx-command-${index}`),
      type: "correctJournal",
      protocolVersion: version,
      bookId: this.id,
      expectedBookRevision: this.state.bookRevision,
      actorId: this.actor,
      issuedAt: now,
      completedAt: now,
      committedAt: now,
      correctionKind: "reversal",
      originalJournalId: original.journal.id,
      resolved: resolved as ResolvedTransaction,
    });
    return { command, financialId };
  }

  /** Add an account through a configuration change effective on `effectiveOn`, which the kernel
   * requires to be after the latest journal. */
  addAccount(spec: AccountSpec, effectiveOn: string): void {
    const index = ++this.counter;
    const account: AccountSnapshot = {
      id: accountId(spec.code.toLowerCase()),
      bookId: this.id,
      code: spec.code,
      name: spec.name ?? `Account ${spec.code}`,
      role: spec.role,
      normalSide: spec.role === "asset" || spec.role === "expense" ? "debit" : "credit",
      postingAllowed: true,
      openedOn: localDate(effectiveOn),
      ...(spec.parent ? { parentId: accountId(spec.parent.toLowerCase()) } : {}),
      allowedCommodityIds: [],
    };
    this.configure(index, effectiveOn, this.state.periods, [
      ...this.state.admissionSnapshot.accounts,
      account,
    ]);
  }

  /** Extend the calendar by `years` fiscal years, effective on the first day of the first new period
   * (after every journal), the way a calendar extension appends periods and changes none. */
  extendYears(years: number): void {
    const index = ++this.counter;
    const extra = buildPeriods(
      this.calendar,
      this.firstYear + this.yearsConfigured,
      this.startMonth,
      years,
      this.monthly,
      this.state.periods.length + 1,
    );
    const first = extra[0];
    if (!first) throw new Error("Nothing to extend");
    this.yearsConfigured += years;
    this.configure(
      index,
      first.startsOn,
      [...this.state.periods, ...extra],
      this.state.admissionSnapshot.accounts,
    );
  }

  private configure(
    index: number,
    effectiveOn: string,
    periods: readonly FiscalPeriod[],
    accounts: readonly AccountSnapshot[],
  ): void {
    this.execute(
      sealCommand({
        id: commandId(`fx-command-${index}`),
        type: "replaceConfiguration",
        protocolVersion: version,
        bookId: this.id,
        expectedBookRevision: this.state.bookRevision,
        expectedConfigurationRevision: this.state.configurationRevision,
        actorId: this.actor,
        issuedAt: instant(NOW),
        completedAt: instant(NOW),
        committedAt: instant(NOW),
        effectiveOn: localDate(effectiveOn),
        periods,
        admissionSnapshot: { ...this.state.admissionSnapshot, accounts },
        policies: this.state.policies,
        quantizationPolicies: this.state.quantizationPolicies,
        accountingPolicies: this.state.accountingPolicySnapshot.policies,
      }),
    );
  }
}

/** A small deterministic generator (a 32-bit linear congruential sequence), so a property test over
 * many generated books fails the same way every run and a failing seed can be replayed. */
export function sequence(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
