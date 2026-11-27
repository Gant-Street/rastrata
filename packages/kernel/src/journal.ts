import {
  compareCanonicalText,
  hashCanonical,
  identifier,
  type CanonicalValue,
  type ContentHash,
  type Identifier,
} from "./canonical.ts";
import { ExactDecimal, ExactRational } from "./numeric.ts";

export type BookId = Identifier<"Book">;
export type AccountId = Identifier<"Account">;
export type CommodityId = Identifier<"Commodity">;
export type DimensionId = Identifier<"AccountingDimension">;
export type DimensionMemberId = Identifier<"DimensionMember">;
export type JournalId = Identifier<"JournalTransaction">;
export type PostingId = Identifier<"Posting">;

export const bookId = (value: string): BookId => identifier<"Book">(value);
export const accountId = (value: string): AccountId => identifier<"Account">(value);
export const commodityId = (value: string): CommodityId => identifier<"Commodity">(value);
export const dimensionId = (value: string): DimensionId =>
  identifier<"AccountingDimension">(value);
export const dimensionMemberId = (value: string): DimensionMemberId =>
  identifier<"DimensionMember">(value);
export const journalId = (value: string): JournalId => identifier<"JournalTransaction">(value);
export const postingId = (value: string): PostingId => identifier<"Posting">(value);

declare const localDateBrand: unique symbol;
declare const instantBrand: unique symbol;

export type LocalDate = string & { readonly [localDateBrand]: "LocalDate" };
export type Instant = string & { readonly [instantBrand]: "Instant" };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function localDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new RangeError(`Invalid local date: ${value}`);
  }

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  if (maximumDay === undefined || day < 1 || day > maximumDay) {
    throw new RangeError(`Invalid local date: ${value}`);
  }

  return value as LocalDate;
}

export function instant(value: string): Instant {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (match === null) {
    throw new RangeError(`Invalid supplied instant: ${value}`);
  }

  const date = match[1];
  const hourText = match[2];
  const minuteText = match[3];
  const secondText = match[4];
  const offset = match[5];
  const offsetHourText = match[6];
  const offsetMinuteText = match[7];
  localDate(date!);
  const hour = Number(hourText!);
  const minute = Number(minuteText!);
  const second = Number(secondText!);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`Invalid supplied instant: ${value}`);
  }

  if (offset !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new RangeError(`Invalid supplied instant: ${value}`);
    }
  }

  return value as Instant;
}

function parseInstantOrder(value: string): readonly [number, string] | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return undefined;
  const rawYear = Number(match[1]);
  const rawMonth = Number(match[2]);
  const day = Number(match[3]);
  const y = rawMonth <= 2 ? rawYear - 1 : rawYear;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (rawMonth + (rawMonth > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  const offsetMinutes =
    match[8] === "Z" ? 0 : (match[9] === "+" ? 1 : -1) * (Number(match[10]) * 60 + Number(match[11]));
  const seconds =
    days * 86400 +
    Number(match[4]) * 3600 +
    Number(match[5]) * 60 +
    Number(match[6]) -
    offsetMinutes * 60;
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  return [seconds, fraction];
}

/** Exact chronological comparison of two ISO-8601 instants across offsets and arbitrary fractional seconds. */
export function compareInstants(left: Instant, right: Instant): number {
  const a = parseInstantOrder(left);
  const b = parseInstantOrder(right);
  if (a === undefined || b === undefined) return compareCanonicalText(left, right);
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return compareCanonicalText(a[1], b[1]);
}

export interface Quantity {
  readonly canonicalNumber: ExactRational;
  readonly commodityId: CommodityId;
  readonly sourceNumber?: ExactDecimal;
}

export interface BookValue {
  readonly amount: ExactDecimal;
  readonly functionalCommodityId: CommodityId;
}

export interface TransactionPrice {
  readonly unitRate: ExactRational;
  readonly baseCommodityId: CommodityId;
  readonly quoteCommodityId: CommodityId;
}

export interface CostBasis {
  readonly totalBasis: ExactRational;
  readonly basisCommodityId: CommodityId;
  readonly sourceTotalBasis?: ExactDecimal;
}

export interface AccountSnapshot {
  readonly id: AccountId;
  readonly bookId: BookId;
  readonly code: string;
  readonly name: string;
  readonly role: "asset" | "liability" | "equity" | "income" | "expense" | "gain" | "unrealizedGain";
  readonly normalSide: "debit" | "credit";
  readonly postingAllowed: boolean;
  readonly openedOn: LocalDate;
  readonly closedOn?: LocalDate;
  readonly parentId?: AccountId;
  readonly allowedCommodityIds: readonly CommodityId[];
}

export interface AccountingDimensionSnapshot {
  readonly id: DimensionId;
  readonly bookId: BookId;
  readonly code: string;
  readonly name: string;
  readonly openedOn: LocalDate;
  readonly closedOn?: LocalDate;
}

export interface DimensionMemberSnapshot {
  readonly id: DimensionMemberId;
  readonly dimensionId: DimensionId;
  readonly code: string;
  readonly name: string;
  readonly openedOn: LocalDate;
  readonly closedOn?: LocalDate;
  readonly parentId?: DimensionMemberId;
}

export interface Posting {
  readonly id: PostingId;
  readonly ordinal: bigint;
  readonly accountId: AccountId;
  readonly units: Quantity;
  readonly bookValue: BookValue;
  readonly transactionPrice?: TransactionPrice;
  readonly costBasis?: CostBasis;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
}

export type JournalKind = "opening" | "ordinary" | "adjustment" | "reversing" | "closing";

export interface JournalTransaction {
  readonly id: JournalId;
  readonly kind: JournalKind;
  readonly bookId: BookId;
  readonly functionalCommodityId: CommodityId;
  readonly economicAt: Instant;
  readonly accountingDate: LocalDate;
  readonly settledAt?: Instant;
  readonly recordedAt: Instant;
  readonly narration: string;
  readonly postings: readonly Posting[];
}

export interface JournalAdmissionSnapshot {
  readonly bookId: BookId;
  readonly functionalCommodityId: CommodityId;
  readonly accounts: readonly AccountSnapshot[];
  readonly dimensions: readonly AccountingDimensionSnapshot[];
  readonly dimensionMembers: readonly DimensionMemberSnapshot[];
  readonly requiredDimensionIds: readonly DimensionId[];
  readonly requiredDimensionIdsByPosting?: Readonly<Record<string, readonly DimensionId[]>>;
}

/** A monetary-independent accounting coordinate. No journal or posting identity,
 * ordinal, amount or fabricated unit of money is needed to validate this scope. */
export interface AccountingCoordinate {
  readonly bookId: BookId;
  readonly functionalCommodityId: CommodityId;
  readonly accountingDate: LocalDate;
  readonly accountId: AccountId;
  readonly unitsCommodityId: CommodityId;
  readonly dimensionMemberIds: readonly DimensionMemberId[];
}

export type SemanticDiagnosticCode =
  | "atomic_commit_failed"
  | "command_identity_conflict"
  | "dependent_close_not_current"
  | "fabricated_opening_journal"
  | "fiscal_period_admission"
  | "immutable_book_identity"
  | "invalid_correction_topology"
  | "canonical_identity_conflict"
  | "invalid_chart_or_account"
  | "invalid_dimension_selection"
  | "invalid_exact_number"
  | "invalid_journal_structure"
  | "book_isolation_violation"
  | "lot_overallocation"
  | "policy_ambiguity"
  | "projection_rebuild_mismatch"
  | "stale_book_revision"
  | "ordered_history_violation"
  | "temporal_semantics_violation"
  | "transfer_policy_missing"
  | "unresolved_accounting_input"
  | "monetary_type_mismatch"
  | "journal_imbalance"
  | "inventory_cost_policy_incoherent"
  | "provisional_inventory_violation"
  | "inventory_value_adjustment_violation"
  | "settlement_allocation_violation"
  | "accounting_basis_policy_incomplete"
  | "currency_remeasurement_violation"
  | "allocation_schedule_violation"
  | "allocation_schedule_revision_violation"
  | "tax_policy_ambiguity"
  | "consolidation_input_violation"
  | "external_accounting_authority";

export interface SemanticDiagnostic {
  readonly code: SemanticDiagnosticCode;
  readonly path: string;
  readonly message: string;
  readonly requirementIds: readonly string[];
}

export type JournalAdmissionResult =
  | {
      readonly disposition: "admitted";
      readonly canonicalHash: ContentHash;
    }
  | {
      readonly disposition: "rejected";
      readonly diagnostics: readonly SemanticDiagnostic[];
    };

export function diagnostic(
  code: SemanticDiagnosticCode,
  path: string,
  message: string,
  requirementIds: readonly string[],
): SemanticDiagnostic {
  return Object.freeze({ code, path, message, requirementIds: Object.freeze([...requirementIds]) });
}

function activeOn(
  openedOn: LocalDate,
  closedOn: LocalDate | undefined,
  accountingDate: LocalDate,
): boolean {
  return openedOn <= accountingDate && (closedOn === undefined || accountingDate <= closedOn);
}

function indexById<T extends { readonly id: string }>(
  values: readonly T[],
  path: string,
  diagnostics: SemanticDiagnostic[],
): Map<string, T> {
  const index = new Map<string, T>();
  for (const value of values) {
    if (index.has(value.id)) {
      diagnostics.push(
        diagnostic(
          "canonical_identity_conflict",
          `${path}[id=${value.id}]`,
          `Identifier ${value.id} is assigned more than once in its declared scope`,
          ["ACC-038"],
        ),
      );
      continue;
    }
    index.set(value.id, value);
  }
  return index;
}

function detectParentCycle<T extends { readonly id: string; readonly parentId?: string }>(
  values: readonly T[],
  index: ReadonlyMap<string, T>,
  path: string,
  diagnostics: SemanticDiagnostic[],
  code: "invalid_chart_or_account" | "invalid_dimension_selection",
  requirementId: "ACC-014" | "ACC-037",
): void {
  for (const value of values) {
    const visited = new Set<string>();
    let cursor: T | undefined = value;
    while (cursor?.parentId !== undefined) {
      if (visited.has(cursor.id)) {
        diagnostics.push(
          diagnostic(
            code,
            `${path}[id=${value.id}].parentId`,
            `Hierarchy containing ${value.id} is cyclic`,
            [requirementId],
          ),
        );
        break;
      }
      visited.add(cursor.id);
      cursor = index.get(cursor.parentId);
    }
  }
}

function validateSnapshot(
  snapshot: JournalAdmissionSnapshot,
  diagnostics: SemanticDiagnostic[],
): {
  readonly accounts: ReadonlyMap<string, AccountSnapshot>;
  readonly dimensions: ReadonlyMap<string, AccountingDimensionSnapshot>;
  readonly members: ReadonlyMap<string, DimensionMemberSnapshot>;
} {
  const accounts = indexById(snapshot.accounts, "snapshot.accounts", diagnostics);
  const dimensions = indexById(snapshot.dimensions, "snapshot.dimensions", diagnostics);
  const members = indexById(snapshot.dimensionMembers, "snapshot.dimensionMembers", diagnostics);

  const accountCodes = new Set<string>();
  for (const account of snapshot.accounts) {
    if (account.bookId !== snapshot.bookId) {
      diagnostics.push(
        diagnostic(
          "book_isolation_violation",
          `snapshot.accounts[id=${account.id}].bookId`,
          `Account ${account.id} belongs to another book`,
          ["ACC-026"],
        ),
      );
    }
    if (accountCodes.has(account.code)) {
      diagnostics.push(
        diagnostic(
          "invalid_chart_or_account",
          `snapshot.accounts[id=${account.id}].code`,
          `Account code ${account.code} is duplicated in the chart snapshot`,
          ["ACC-014"],
        ),
      );
    }
    accountCodes.add(account.code);
    if (account.closedOn !== undefined && account.closedOn < account.openedOn) {
      diagnostics.push(
        diagnostic(
          "invalid_chart_or_account",
          `snapshot.accounts[id=${account.id}].closedOn`,
          `Account ${account.id} closes before it opens`,
          ["ACC-013", "ACC-014"],
        ),
      );
    }
    if (account.parentId !== undefined && !accounts.has(account.parentId)) {
      diagnostics.push(
        diagnostic(
          "invalid_chart_or_account",
          `snapshot.accounts[id=${account.id}].parentId`,
          `Account parent ${account.parentId} does not resolve in the chart snapshot`,
          ["ACC-014", "ACC-038"],
        ),
      );
    }
  }
  detectParentCycle(
    snapshot.accounts,
    accounts,
    "snapshot.accounts",
    diagnostics,
    "invalid_chart_or_account",
    "ACC-014",
  );

  const dimensionCodes = new Set<string>();
  for (const dimension of snapshot.dimensions) {
    if (dimension.bookId !== snapshot.bookId) {
      diagnostics.push(
        diagnostic(
          "book_isolation_violation",
          `snapshot.dimensions[id=${dimension.id}].bookId`,
          `Dimension ${dimension.id} belongs to another book`,
          ["ACC-026", "ACC-037"],
        ),
      );
    }
    if (dimensionCodes.has(dimension.code)) {
      diagnostics.push(
        diagnostic(
          "invalid_dimension_selection",
          `snapshot.dimensions[id=${dimension.id}].code`,
          `Dimension code ${dimension.code} is duplicated in the chart snapshot`,
          ["ACC-037"],
        ),
      );
    }
    dimensionCodes.add(dimension.code);
    if (dimension.closedOn !== undefined && dimension.closedOn < dimension.openedOn) {
      diagnostics.push(
        diagnostic(
          "invalid_dimension_selection",
          `snapshot.dimensions[id=${dimension.id}].closedOn`,
          `Dimension ${dimension.id} closes before it opens`,
          ["ACC-013", "ACC-037"],
        ),
      );
    }
  }

  const memberCodes = new Set<string>();
  for (const member of snapshot.dimensionMembers) {
    if (!dimensions.has(member.dimensionId)) {
      diagnostics.push(
        diagnostic(
          "invalid_dimension_selection",
          `snapshot.dimensionMembers[id=${member.id}].dimensionId`,
          `Dimension ${member.dimensionId} does not resolve`,
          ["ACC-037", "ACC-038"],
        ),
      );
    }
    const scopedCode = `${member.dimensionId}\u0000${member.code}`;
    if (memberCodes.has(scopedCode)) {
      diagnostics.push(
        diagnostic(
          "invalid_dimension_selection",
          `snapshot.dimensionMembers[id=${member.id}].code`,
          `Member code ${member.code} is duplicated within dimension ${member.dimensionId}`,
          ["ACC-037"],
        ),
      );
    }
    memberCodes.add(scopedCode);
    if (member.closedOn !== undefined && member.closedOn < member.openedOn) {
      diagnostics.push(
        diagnostic(
          "invalid_dimension_selection",
          `snapshot.dimensionMembers[id=${member.id}].closedOn`,
          `Dimension member ${member.id} closes before it opens`,
          ["ACC-013", "ACC-037"],
        ),
      );
    }

    if (member.parentId !== undefined) {
      const parent = members.get(member.parentId);
      if (parent === undefined || parent.dimensionId !== member.dimensionId) {
        diagnostics.push(
          diagnostic(
            "invalid_dimension_selection",
            `snapshot.dimensionMembers[id=${member.id}].parentId`,
            `Member parent ${member.parentId} does not resolve in the same dimension`,
            ["ACC-037", "ACC-038"],
          ),
        );
      }
    }
  }
  detectParentCycle(
    snapshot.dimensionMembers,
    members,
    "snapshot.dimensionMembers",
    diagnostics,
    "invalid_dimension_selection",
    "ACC-037",
  );

  for (const requiredDimensionId of snapshot.requiredDimensionIds) {
    if (!dimensions.has(requiredDimensionId)) {
      diagnostics.push(
        diagnostic(
          "invalid_dimension_selection",
          "snapshot.requiredDimensionIds",
          `Required dimension ${requiredDimensionId} does not resolve`,
          ["ACC-011", "ACC-037", "ACC-038"],
        ),
      );
    }
  }

  return { accounts, dimensions, members };
}

function rationalValue(value: ExactRational): CanonicalValue {
  return {
    type: "ExactRational",
    numerator: value.numerator,
    denominator: value.denominator,
  };
}

function decimalValue(value: ExactDecimal): CanonicalValue {
  return {
    type: "ExactDecimal",
    coefficient: value.coefficient,
    scale: value.scale,
  };
}

function comparePostings(left: Posting, right: Posting): number {
  const ordinalOrder = Number(left.ordinal - right.ordinal);
  return ordinalOrder || compareCanonicalText(left.id, right.id);
}

export function canonicalPostingValue(posting: Posting): CanonicalValue {
  return {
      type: "Posting",
      id: posting.id,
      ordinal: posting.ordinal,
      accountId: posting.accountId,
      units: {
        type: "Quantity",
        canonicalNumber: rationalValue(posting.units.canonicalNumber),
        commodityId: posting.units.commodityId,
        sourceNumber:
          posting.units.sourceNumber === undefined
            ? null
            : decimalValue(posting.units.sourceNumber),
      },
      bookValue: {
        type: "BookValue",
        amount: decimalValue(posting.bookValue.amount),
        functionalCommodityId: posting.bookValue.functionalCommodityId,
      },
      transactionPrice:
        posting.transactionPrice === undefined
          ? null
          : {
              type: "TransactionPrice",
              unitRate: rationalValue(posting.transactionPrice.unitRate),
              baseCommodityId: posting.transactionPrice.baseCommodityId,
              quoteCommodityId: posting.transactionPrice.quoteCommodityId,
            },
      costBasis:
        posting.costBasis === undefined
          ? null
          : {
              type: "CostBasis",
              totalBasis: rationalValue(posting.costBasis.totalBasis),
              basisCommodityId: posting.costBasis.basisCommodityId,
              sourceTotalBasis:
                posting.costBasis.sourceTotalBasis === undefined
                  ? null
                  : decimalValue(posting.costBasis.sourceTotalBasis),
            },
      dimensionMemberIds: [...posting.dimensionMemberIds].sort(),
  };
}

export function canonicalJournalValue(journal: JournalTransaction): CanonicalValue {
  const postings = [...journal.postings].sort(comparePostings).map(canonicalPostingValue);

  return {
    type: "JournalTransaction",
    id: journal.id,
    kind: journal.kind,
    bookId: journal.bookId,
    functionalCommodityId: journal.functionalCommodityId,
    economicAt: journal.economicAt,
    accountingDate: journal.accountingDate,
    settledAt: journal.settledAt ?? null,
    recordedAt: journal.recordedAt,
    narration: journal.narration,
    postings,
  };
}

function validateCoordinateWithIndexes(
  snapshot: JournalAdmissionSnapshot,
  indexes: ReturnType<typeof validateSnapshot>,
  coordinate: AccountingCoordinate,
  requiredDimensionIds: readonly DimensionId[],
  path: string,
  kind: "posting" | "movement",
  diagnostics: SemanticDiagnostic[],
): void {
  const account = indexes.accounts.get(coordinate.accountId);
  if (account === undefined) {
    diagnostics.push(diagnostic("invalid_chart_or_account", `${path}.accountId`,
      `Account ${coordinate.accountId} does not resolve in the supplied chart`, ["ACC-014", "ACC-038"]));
  } else {
    if (!account.postingAllowed || !activeOn(account.openedOn, account.closedOn, coordinate.accountingDate)) {
      diagnostics.push(diagnostic("invalid_chart_or_account", `${path}.accountId`,
        `Account ${account.id} is not active and posting-enabled on ${coordinate.accountingDate}`, ["ACC-014"]));
    }
    if (account.allowedCommodityIds.length > 0 && !account.allowedCommodityIds.includes(coordinate.unitsCommodityId)) {
      diagnostics.push(diagnostic("invalid_chart_or_account", `${path}.${kind === "posting" ? "units.commodityId" : "unitsCommodityId"}`,
        `Commodity ${coordinate.unitsCommodityId} is not admitted by account ${account.id}`, ["ACC-014"]));
    }
  }

  const selectedDimensions = new Set<string>();
  for (const memberId of coordinate.dimensionMemberIds) {
    const member = indexes.members.get(memberId);
    if (member === undefined) {
      diagnostics.push(diagnostic("invalid_dimension_selection", `${path}.dimensionMemberIds`,
        `Dimension member ${memberId} does not resolve`, ["ACC-037", "ACC-038"]));
      continue;
    }
    const dimension = indexes.dimensions.get(member.dimensionId);
    if (dimension === undefined || dimension.bookId !== snapshot.bookId ||
      !activeOn(dimension.openedOn, dimension.closedOn, coordinate.accountingDate) ||
      !activeOn(member.openedOn, member.closedOn, coordinate.accountingDate)) {
      diagnostics.push(diagnostic("invalid_dimension_selection", `${path}.dimensionMemberIds`,
        `Dimension member ${memberId} is not active in the ${kind === "posting" ? "journal" : "specified"} book on the accounting date`, ["ACC-026", "ACC-037"]));
      continue;
    }
    if (selectedDimensions.has(member.dimensionId)) {
      diagnostics.push(diagnostic("invalid_dimension_selection", `${path}.dimensionMemberIds`,
        `${kind === "posting" ? "Posting" : "Movement"} selects more than one member of dimension ${member.dimensionId}`, ["ACC-037"]));
    }
    selectedDimensions.add(member.dimensionId);
  }
  for (const requiredDimensionId of requiredDimensionIds) {
    if (!selectedDimensions.has(requiredDimensionId)) {
      diagnostics.push(diagnostic("invalid_dimension_selection", `${path}.dimensionMemberIds`,
        `${kind === "posting" ? "Posting" : "Movement"} omits required dimension ${requiredDimensionId}`, ["ACC-011", "ACC-037"]));
    }
  }
}

/** Chart, account, commodity and analytic-dimension checks without a posting.
 * requiredDimensionIds MUST come from the applicable resolved booking policy;
 * this helper does not select or authenticate policy/snapshot inputs. Posting-ID
 * overrides cannot be applied to a movement that has no posting ID. This is not
 * opening/period, quantity, ownership, identity, command or commit admission. */
export function validateAccountingCoordinate(
  snapshot: JournalAdmissionSnapshot,
  coordinate: AccountingCoordinate,
  requiredDimensionIds: readonly DimensionId[],
): readonly SemanticDiagnostic[] {
  const diagnostics: SemanticDiagnostic[] = [];
  const indexes = validateSnapshot(snapshot, diagnostics);
  if (coordinate.bookId !== snapshot.bookId) {
    diagnostics.push(diagnostic("book_isolation_violation", "coordinate.bookId",
      "Movement and supplied snapshot belong to different books", ["ACC-026"]));
  }
  if (coordinate.functionalCommodityId !== snapshot.functionalCommodityId) {
    diagnostics.push(diagnostic("monetary_type_mismatch", "coordinate.functionalCommodityId",
      "Movement and book snapshot use different functional commodities", ["ACC-002", "ACC-026"]));
  }
  if (new Set(requiredDimensionIds).size !== requiredDimensionIds.length ||
    requiredDimensionIds.some((id) => !indexes.dimensions.has(id))) {
    diagnostics.push(diagnostic("invalid_dimension_selection", "coordinate.requiredDimensionIds",
      "Resolved dimension requirements must be distinct and belong to the supplied chart", ["ACC-011", "ACC-037", "ACC-038"]));
  }
  validateCoordinateWithIndexes(snapshot, indexes, coordinate, requiredDimensionIds, "coordinate", "movement", diagnostics);
  return Object.freeze(diagnostics);
}

export function admitJournal(
  snapshot: JournalAdmissionSnapshot,
  journal: JournalTransaction,
): JournalAdmissionResult {
  const diagnostics: SemanticDiagnostic[] = [];
  const indexes = validateSnapshot(snapshot, diagnostics);

  if (journal.bookId !== snapshot.bookId) {
    diagnostics.push(
      diagnostic(
        "book_isolation_violation",
        "journal.bookId",
        "Journal and supplied snapshot belong to different books",
        ["ACC-026"],
      ),
    );
  }
  if (journal.functionalCommodityId !== snapshot.functionalCommodityId) {
    diagnostics.push(
      diagnostic(
        "monetary_type_mismatch",
        "journal.functionalCommodityId",
        "Journal and book snapshot use different functional commodities",
        ["ACC-002", "ACC-026"],
      ),
    );
  }
  if (journal.postings.length < 2) {
    diagnostics.push(
      diagnostic(
        "invalid_journal_structure",
        "journal.postings",
        "A canonical journal must contain at least two real postings",
        ["ACC-018"],
      ),
    );
  }

  const postingIds = new Set<string>();
  const ordinals = new Set<bigint>();
  let balance = ExactRational.zero();

  for (const [index, posting] of journal.postings.entries()) {
    const path = `journal.postings[${index}]`;
    const amountIsDecimal = posting.bookValue.amount instanceof ExactDecimal;
    const quantityIsRational = posting.units.canonicalNumber instanceof ExactRational;
    const sourceIsDecimal =
      posting.units.sourceNumber === undefined || posting.units.sourceNumber instanceof ExactDecimal;
    const priceIsRational =
      posting.transactionPrice === undefined || posting.transactionPrice.unitRate instanceof ExactRational;
    const basisIsRational =
      posting.costBasis === undefined || posting.costBasis.totalBasis instanceof ExactRational;
    const sourceBasisIsDecimal =
      posting.costBasis?.sourceTotalBasis === undefined ||
      posting.costBasis.sourceTotalBasis instanceof ExactDecimal;
    if (
      !amountIsDecimal ||
      !quantityIsRational ||
      !sourceIsDecimal ||
      !priceIsRational ||
      !basisIsRational ||
      !sourceBasisIsDecimal
    ) {
      diagnostics.push(
        diagnostic(
          amountIsDecimal ? "invalid_exact_number" : "monetary_type_mismatch",
          path,
          "Canonical monetary fields must use their exact, non-substitutable runtime types",
          ["ACC-001", "ACC-002", "ACC-022"],
        ),
      );
    }
    if (postingIds.has(posting.id)) {
      diagnostics.push(
        diagnostic(
          "invalid_journal_structure",
          `${path}.id`,
          `Posting identifier ${posting.id} is duplicated`,
          ["ACC-018", "ACC-038"],
        ),
      );
    }
    postingIds.add(posting.id);

    if (posting.ordinal < 0n || ordinals.has(posting.ordinal)) {
      diagnostics.push(
        diagnostic(
          "invalid_journal_structure",
          `${path}.ordinal`,
          `Posting ordinal ${posting.ordinal} is negative or duplicated`,
          ["ACC-018", "ACC-019"],
        ),
      );
    }
    ordinals.add(posting.ordinal);

    if (amountIsDecimal && posting.bookValue.amount.isZero()) {
      diagnostics.push(
        diagnostic(
          "invalid_journal_structure",
          `${path}.bookValue.amount`,
          "A canonical posting must have a nonzero book value",
          ["ACC-003", "ACC-018"],
        ),
      );
    }
    if (amountIsDecimal) balance = balance.add(posting.bookValue.amount.toRational());

    if (posting.bookValue.functionalCommodityId !== snapshot.functionalCommodityId) {
      diagnostics.push(
        diagnostic(
          "monetary_type_mismatch",
          `${path}.bookValue.functionalCommodityId`,
          "Posting book value is not denominated in the book functional commodity",
          ["ACC-002", "ACC-003", "ACC-026"],
        ),
      );
    }

    if (
      quantityIsRational &&
      sourceIsDecimal &&
      posting.units.sourceNumber !== undefined &&
      !posting.units.sourceNumber.toRational().equals(posting.units.canonicalNumber)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid_exact_number",
          `${path}.units`,
          "Source decimal and canonical quantity describe different exact values",
          ["ACC-001", "ACC-002"],
        ),
      );
    }

    if (
      basisIsRational &&
      sourceBasisIsDecimal &&
      posting.costBasis?.sourceTotalBasis !== undefined &&
      !posting.costBasis.sourceTotalBasis.toRational().equals(posting.costBasis.totalBasis)
    ) {
      diagnostics.push(
        diagnostic(
          "invalid_exact_number",
          `${path}.costBasis`,
          "Source decimal and authoritative total basis describe different exact values",
          ["ACC-001", "ACC-023"],
        ),
      );
    }

    if (
      posting.transactionPrice !== undefined &&
      priceIsRational &&
      (posting.transactionPrice.unitRate.isZero() ||
        posting.transactionPrice.unitRate.isNegative() ||
        posting.transactionPrice.baseCommodityId !== posting.units.commodityId ||
        posting.transactionPrice.quoteCommodityId !== snapshot.functionalCommodityId)
    ) {
      diagnostics.push(
        diagnostic(
          "monetary_type_mismatch",
          `${path}.transactionPrice`,
          "Transaction price must be a positive units-to-functional-commodity rate",
          ["ACC-002", "ACC-012", "ACC-026"],
        ),
      );
    }
    if (
      posting.costBasis !== undefined &&
      posting.costBasis.basisCommodityId !== snapshot.functionalCommodityId
    ) {
      diagnostics.push(
        diagnostic(
          "monetary_type_mismatch",
          `${path}.costBasis.basisCommodityId`,
          "Canonical cost basis must identify the book functional commodity",
          ["ACC-002", "ACC-023", "ACC-026"],
        ),
      );
    }

    const requiredDimensions =
      snapshot.requiredDimensionIdsByPosting !== undefined &&
      Object.hasOwn(snapshot.requiredDimensionIdsByPosting, posting.id)
        ? (snapshot.requiredDimensionIdsByPosting[posting.id] ?? snapshot.requiredDimensionIds)
        : snapshot.requiredDimensionIds;
    validateCoordinateWithIndexes(snapshot, indexes, {
      bookId: journal.bookId, functionalCommodityId: journal.functionalCommodityId,
      accountingDate: journal.accountingDate, accountId: posting.accountId,
      unitsCommodityId: posting.units.commodityId, dimensionMemberIds: posting.dimensionMemberIds,
    }, requiredDimensions, path, "posting", diagnostics);
  }

  if (!balance.isZero()) {
    diagnostics.push(
      diagnostic(
        "journal_imbalance",
        "journal.postings",
        `Functional book values do not balance exactly; residual is ${balance}`,
        ["ACC-003"],
      ),
    );
  }

  if (diagnostics.length > 0) {
    return Object.freeze({
      disposition: "rejected",
      diagnostics: Object.freeze(diagnostics),
    });
  }

  return Object.freeze({
    disposition: "admitted",
    canonicalHash: hashCanonical(canonicalJournalValue(journal)),
  });
}
