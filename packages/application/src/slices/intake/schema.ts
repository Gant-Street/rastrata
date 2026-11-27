import {
  array,
  date,
  hash,
  id,
  nullable,
  object,
  operation,
  page,
  ref,
  signedMoney,
  text,
  type Schema,
} from "../../schema-kit.ts";
import {
  CONFIDENCES,
  DATE_ORDERS,
  DELIMITERS,
  ENCODINGS,
  FILE_FLAGS,
  FILE_KINDS,
  FRICTION_CLASSES,
  FRICTION_KINDS,
  GATE_STATUSES,
  GATES,
  LINE_ENDINGS,
  NEEDS,
  OWNERS,
  PLAN_CODES,
  PLAN_STATUSES,
  ROLES,
  ROLE_REASONS,
  UNPARSED_REASONS,
} from "../../intake/sets.ts";
import type { SliceSchema } from "../types.ts";

/** The wire shapes of the intake lane. A file's bytes are never in a request: files are uploaded
 * once (POST /v1/uploads) and named by their SHA-256. Everything an output says about a customer's
 * file is a count, a date, an amount, a code from a closed set, or text in the two fields named
 * for it (a file name and a column header), bounded and with control and direction characters
 * written out. Money is a decimal string with two places. */

const count: Schema = { type: "integer", minimum: 0 };
const oneOf = (values: readonly string[]): Schema => ({ type: "string", enum: values });
const amount = signedMoney;
const currency = text(3);

const definitions: Record<string, Schema> = {
  IntakeScanInput: object({ files: { ...array(hash, 100), minItems: 1 } }),

  IntakeColumn: object({
    index: { type: "integer", minimum: 1 },
    header: text(80),
    /** Cautions about the header text: instruction, formula, markup, control, direction. */
    flags: array(text(20), 6),
  }),
  IntakeRange: object({ from: date, to: date }),
  IntakeBalance: object({ asOf: date, amount }),
  IntakeChain: object({
    order: oneOf(["oldest-first", "newest-first"]),
    flipped: { type: "boolean" },
    compared: count,
    breakCount: count,
  }),
  IntakeStatement: object(
    {
      /** How the parser would read the file with no help. */
      reading: oneOf(["preset", "detected", "profile", "ofx", "none"]),
      /** The name of the saved recipe that reads it. */
      recipe: text(80),
      presetId: text(64),
      presetVerified: { type: "boolean" },
      lines: count,
      moneyIn: amount,
      moneyOut: amount,
      net: amount,
      currency,
      balance: oneOf(["running", "reported", "none"]),
      /** The balance before the oldest line, from a running balance. */
      opening: amount,
      /** The balance after the newest line: running, or reported by the file. */
      closing: ref("IntakeBalance"),
      chain: ref("IntakeChain"),
    },
    ["reading", "lines", "moneyIn", "moneyOut", "net", "currency", "balance"],
  ),
  IntakeOfxAccount: object(
    {
      key: text(200),
      label: text(80),
      type: oneOf(["bank", "card"]),
      currency,
      lines: count,
      from: nullable(date),
      to: nullable(date),
      closing: ref("IntakeBalance"),
    },
    ["key", "label", "type", "currency", "lines", "from", "to"],
  ),
  IntakeTrialBalance: object({
    asOf: nullable(date),
    layout: nullable(text(40)),
    rows: count,
    balanced: { type: "boolean" },
    debit: amount,
    credit: amount,
    problems: count,
  }),
  IntakeSummary: object(
    {
      accounts: count,
      distinct: count,
      debit: amount,
      credit: amount,
      gross: amount,
      fee: amount,
      net: amount,
      total: amount,
      types: array(text(40), 12),
    },
    [],
  ),
  IntakePdf: object({
    pages: count,
    textLayer: oneOf(["present", "absent", "unknown"]),
    encrypted: { type: "boolean" },
  }),
  IntakeZip: object({
    entries: count,
    names: array(text(80), 20),
    unsafeNames: count,
    workbook: { type: "boolean" },
  }),
  IntakeJson: object({
    shape: oneOf(["object", "array"]),
    records: count,
    keys: array(text(40), 20),
  }),
  IntakeDetails: object(
    { pdf: ref("IntakePdf"), zip: ref("IntakeZip"), json: ref("IntakeJson") },
    [],
  ),
  IntakeProblems: object({ errors: count, warnings: count, messages: array(text(300), 5) }),

  IntakeFile: object(
    {
      sha256: hash,
      /** The file's name as a label, with control and direction characters written out. */
      name: text(200),
      size: count,
      /** What it is, from its bytes and never from its extension. */
      kind: oneOf(FILE_KINDS),
      /** False for a file the program does not read: it needs an agent. */
      parsed: { type: "boolean" },
      /** Who has to act before it can be used. */
      need: oneOf(NEEDS),
      why: oneOf(UNPARSED_REASONS),
      role: oneOf(ROLES),
      confidence: oneOf(CONFIDENCES),
      reasons: array(oneOf(ROLE_REASONS), 8),
      encoding: oneOf(ENCODINGS),
      delimiter: oneOf(DELIMITERS),
      lineEnding: oneOf(LINE_ENDINGS),
      headerRow: { type: "integer", minimum: 1 },
      columns: array(ref("IntakeColumn"), 40),
      rows: count,
      range: ref("IntakeRange"),
      dateOrder: oneOf(DATE_ORDERS),
      currency,
      statement: ref("IntakeStatement"),
      accounts: array(ref("IntakeOfxAccount"), 20),
      trialBalance: ref("IntakeTrialBalance"),
      summary: ref("IntakeSummary"),
      details: ref("IntakeDetails"),
      flags: array(oneOf(FILE_FLAGS), 20),
      problems: ref("IntakeProblems"),
    },
    [
      "sha256",
      "size",
      "kind",
      "parsed",
      "need",
      "role",
      "confidence",
      "reasons",
      "flags",
      "problems",
    ],
  ),
  IntakeScanTotals: object({
    files: count,
    bytes: count,
    parsed: count,
    needRecipe: count,
    needAgent: count,
    needHuman: count,
  }),
  IntakePlanSource: object(
    {
      /** The chart account these files belong to: its id, code or exact name. */
      account: text(80),
      kind: oneOf(["bank", "card"]),
      files: array(hash, 60),
    },
    ["account", "files"],
  ),
  IntakePlanBalance: object(
    {
      file: hash,
      /** What the statement prints as its opening and ending balance, read from the statement. */
      opening: amount,
      ending: amount,
    },
    ["file"],
  ),
  IntakePlanInput: object(
    {
      cutoverDate: date,
      /** The last day the statements should reach. */
      through: date,
      sources: array(ref("IntakePlanSource"), 30),
      /** Every file the scan found, so a file nobody assigned is noticed. */
      files: array(hash, 200),
      trialBalance: hash,
      chart: hash,
      generalLedger: hash,
      payoutReports: array(hash, 12),
      balances: array(ref("IntakePlanBalance"), 200),
      /** Files left out of the move on purpose: they are not reported as unassigned. */
      ignore: array(hash, 200),
      /** Files whose unreadable rows the owner agreed to leave out. */
      skipInvalidRows: array(hash, 200),
      /** There are no earlier books: no trial balance is expected. */
      fresh: { type: "boolean" },
      /** List only what is missing or uncertain. */
      gapsOnly: { type: "boolean" },
    },
    ["sources"],
  ),
  IntakePlanNext: object({ command: text(240), file: hash, note: text(300) }, ["note"]),
  IntakePlanItem: object(
    {
      code: oneOf(PLAN_CODES),
      status: oneOf(PLAN_STATUSES),
      /** The move cannot start until a required item is present. */
      required: { type: "boolean" },
      /** Who has to act: the customer's agent with what it has, or the customer. */
      owner: oneOf(OWNERS),
      account: text(128),
      file: hash,
      month: text(7),
      gate: oneOf(GATES),
      detail: text(400),
      next: ref("IntakePlanNext"),
    },
    ["code", "status", "required", "owner", "detail"],
  ),
  IntakePlanMonth: object({ month: text(7), state: oneOf(["covered", "missing"]), files: count }),
  IntakePlanSourceView: object(
    {
      account: text(80),
      accountId: text(128),
      kind: oneOf(["bank", "card"]),
      files: count,
      months: array(ref("IntakePlanMonth"), 120),
    },
    ["account", "kind", "files", "months"],
  ),
  IntakePlanCounts: object({ present: count, missing: count, uncertain: count }),
  IntakePlan: object({
    cutoverDate: nullable(date),
    through: nullable(date),
    sources: array(ref("IntakePlanSourceView"), 30),
    items: array(ref("IntakePlanItem"), 400),
    counts: ref("IntakePlanCounts"),
    /** Nothing required is missing or uncertain. */
    ready: { type: "boolean" },
    /** More items than are listed. */
    truncated: { type: "boolean" },
  }),

  // The friction log: every point where the move-in needed a person or an agent's retry.
  IntakeFrictionEvent: object(
    {
      kind: oneOf(FRICTION_KINDS),
      /** What it was about: a file's SHA-256, an account code, or a word such as "cutover". */
      source: text(120),
      /** Why, in the writer's words. Cleaned and bounded before it is kept. */
      reason: text(300),
      /** A gap keeps one open event for a key: recording it again changes nothing until it is resolved. */
      key: text(120),
    },
    ["kind", "reason"],
  ),
  IntakeFrictionInput: object(
    {
      events: array(ref("IntakeFrictionEvent"), 50),
      /** Keys whose open events are now resolved. */
      resolve: array(text(120), 50),
      /** What resolved them. */
      note: text(300),
    },
    [],
  ),
  IntakeFrictionResult: object({
    recorded: count,
    deduplicated: count,
    resolved: count,
    ids: array(count, 50),
    /** Gap events still open after this call. */
    openGaps: count,
  }),
  IntakeFrictionListInput: object(
    {
      status: oneOf(["open", "resolved", "all"]),
      kind: oneOf(FRICTION_KINDS),
      page,
      pageSize: { type: "integer", minimum: 1, maximum: 100 },
    },
    [],
  ),
  IntakeFrictionRecord: object(
    {
      id: count,
      kind: oneOf(FRICTION_KINDS),
      class: oneOf(FRICTION_CLASSES),
      key: text(120),
      source: text(120),
      reason: text(300),
      /** "owner" or "agent:<token id>". */
      actor: text(80),
      at: text(40),
      resolvedAt: text(40),
      resolution: text(300),
    },
    ["id", "kind", "class", "source", "reason", "actor", "at"],
  ),
  IntakeFrictionList: object({
    count,
    page,
    pageSize: { type: "integer", minimum: 1 },
    events: array(ref("IntakeFrictionRecord"), 100),
  }),
  IntakeKindCount: object({ kind: oneOf(FRICTION_KINDS), count }),
  IntakeEventCounts: object({
    total: count,
    info: count,
    agent: count,
    retry: count,
    human: count,
    gap: count,
  }),
  IntakeGapLog: object({ open: count }),
  IntakeStatus: object({
    /** The first event of the log: when the move-in began. */
    startedAt: nullable(text(40)),
    /** The first completed statement import. */
    firstImportAt: nullable(text(40)),
    /** The first completed reconciliation. */
    firstReconciliationAt: nullable(text(40)),
    secondsToFirstImport: nullable(count),
    secondsToFirstReconciliation: nullable(count),
    /** Events where the tooling could not go on by itself: an agent had to step in, retry, or ask. */
    interventions: count,
    /** Gap events still open: something missing that is still missing. */
    unresolvedGaps: count,
    events: ref("IntakeEventCounts"),
    byKind: array(ref("IntakeKindCount"), 20),
    imports: count,
    reconciliations: count,
    /** The gap log of the move (the shadow lane's), apart from this log. */
    gapLog: ref("IntakeGapLog"),
  }),

  // Recipes: the statement mapping the import already uses, with a name, a version and a proof.
  IntakeRecipe: object(
    {
      /** The recipe format; always 1. */
      version: { type: "integer", enum: [1] },
      name: { ...text(80), minLength: 1, pattern: "\\S" },
      note: text(300),
      accountKind: oneOf(["bank", "card"]),
      /** The encoding the file must decode as; a file that decodes otherwise fails the gate. */
      encoding: oneOf(ENCODINGS),
      /** How the columns of the file become lines: the same mapping an import profile holds. */
      mapping: ref("ImportMapping"),
    },
    ["version", "name", "accountKind", "mapping"],
  ),
  IntakeRecipeTestInput: object(
    {
      sha256: hash,
      /** Left out, the file is read as an import would read it with no help (an OFX file, a bank
       * the presets know). */
      recipe: ref("IntakeRecipe"),
      /** The balances the statement prints at its start and end: never read from the books. */
      openingBalance: amount,
      endingBalance: amount,
      /** The period the statement prints. A date order that every date satisfies is settled by it. */
      periodFrom: date,
      periodTo: date,
      /** The owner agreed that rows which cannot be read (a totals row) are not transactions. */
      skipInvalidRows: { type: "boolean" },
      /** The chart account the file is for, so signs can be judged against a bank or a card. */
      ledgerAccountId: id,
    },
    ["sha256"],
  ),
  IntakeVerification: object(
    {
      method: oneOf(["running_balance", "ending_balance", "none"]),
      status: oneOf(["pass", "fail", "unverified"]),
      opening: amount,
      closing: amount,
      expected: amount,
      difference: amount,
      detail: text(400),
    },
    ["method", "status", "detail"],
  ),
  IntakeGateResult: object(
    {
      gate: oneOf(GATES),
      status: oneOf(GATE_STATUSES),
      detail: text(400),
      /** The file rows it is about, as a spreadsheet numbers them. */
      rows: array({ type: "integer", minimum: 1 }, 8),
    },
    ["gate", "status", "detail"],
  ),
  IntakeRejectedRow: object({ row: { type: "integer", minimum: 1 }, reason: text(300) }, [
    "reason",
  ]),
  IntakeErrorKind: object({ kind: text(40), count }),
  IntakeReading: object(
    {
      format: oneOf(["csv", "ofx", "unknown"]),
      source: oneOf(["recipe", "profile", "preset", "detected", "ofx", "none"]),
      encoding: oneOf(ENCODINGS),
      delimiter: oneOf(DELIMITERS),
      headerRow: count,
      dateOrder: oneOf(["mdy", "dmy", "ymd"]),
    },
    ["format", "source"],
  ),
  IntakeRows: object({
    total: count,
    lines: count,
    rejected: count,
    filtered: count,
    noAmount: count,
    zero: count,
  }),
  IntakeTotals: object({ moneyIn: amount, moneyOut: amount, net: amount }),
  IntakeFileRef: object({ sha256: hash, size: count, name: text(200) }, ["sha256", "size"]),
  IntakeRecipeRef: object({ name: text(80), version: { type: "integer", minimum: 1 } }),
  IntakeRecipeReport: object(
    {
      /** No gate failed and the file reads: it could be imported as it stands. Exit code 3 when false. */
      valid: { type: "boolean" },
      /** A proof exists and it passed: the running balance follows, or the lines come to the ending balance. */
      verified: { type: "boolean" },
      file: ref("IntakeFileRef"),
      recipe: ref("IntakeRecipeRef"),
      reading: ref("IntakeReading"),
      rows: ref("IntakeRows"),
      range: nullable(ref("IntakeRange")),
      totals: ref("IntakeTotals"),
      rejected: array(ref("IntakeRejectedRow"), 50),
      errorKinds: array(ref("IntakeErrorKind"), 12),
      verification: ref("IntakeVerification"),
      gates: array(ref("IntakeGateResult"), 20),
      hints: array(text(300), 8),
    },
    [
      "valid",
      "verified",
      "file",
      "reading",
      "rows",
      "range",
      "totals",
      "rejected",
      "errorKinds",
      "verification",
      "gates",
      "hints",
    ],
  ),
  IntakeRecipeProof: object(
    {
      sha256: hash,
      openingBalance: amount,
      endingBalance: amount,
      periodFrom: date,
      periodTo: date,
      skipInvalidRows: { type: "boolean" },
    },
    ["sha256"],
  ),
  IntakeRecipeSaveInput: object(
    {
      recipe: ref("IntakeRecipe"),
      /** The files the recipe is proven against, each with the balances its statement prints. */
      proofs: { ...array(ref("IntakeRecipeProof"), 6), minItems: 1 },
      /** Make the recipe the default for this chart account's files. */
      ledgerAccountId: id,
    },
    ["recipe", "proofs"],
  ),
  IntakeProven: object({
    sha256: hash,
    method: oneOf(["running_balance", "ending_balance"]),
    lines: count,
    from: date,
    to: date,
  }),
  IntakeSavedRecipe: object(
    {
      name: text(80),
      /** One more each time the same name is saved again. */
      revision: { type: "integer", minimum: 1 },
      accountKind: oneOf(["bank", "card"]),
      /** The import profile the recipe is saved as: `import --profile` runs it. */
      profileId: id,
      ledgerAccountId: nullable(id),
      proven: array(ref("IntakeProven"), 6),
      savedAt: text(40),
      savedBy: text(80),
      recipe: ref("IntakeRecipe"),
    },
    [
      "name",
      "revision",
      "accountKind",
      "profileId",
      "ledgerAccountId",
      "proven",
      "savedAt",
      "savedBy",
      "recipe",
    ],
  ),
  IntakeRecipeList: object({ recipes: array(ref("IntakeSavedRecipe"), 100) }),

  // A trial balance read into exact cents, with the book's account each row names when it names one.
  IntakeTrialBalanceInput: object({ sha256: hash }),
  IntakeTrialBalanceMatch: object({
    accountId: id,
    how: oneOf(["code", "name"]),
    role: oneOf(["asset", "liability", "equity", "income", "expense", "gain", "unrealizedGain"]),
  }),
  IntakeTrialBalanceRow: object(
    {
      row: { type: "integer", minimum: 1 },
      section: text(80),
      code: text(40),
      name: text(150),
      debit: amount,
      credit: amount,
      /** Debits less credits: positive is a debit. */
      balance: amount,
      /** The book account the row names by its code or its exact name, when exactly one does. */
      match: ref("IntakeTrialBalanceMatch"),
      /** The balance as `opening.review` takes it: in the matched account's normal orientation
       * (a bank holding 1,200.00 and a card owing 300.00 are both positive). */
      suggested: amount,
    },
    ["row", "name", "debit", "credit", "balance"],
  ),
  IntakeTrialBalanceIssue: object(
    {
      severity: oneOf(["error", "warning", "info"]),
      row: { type: "integer", minimum: 1 },
      message: text(300),
    },
    ["severity", "message"],
  ),
  IntakeTrialBalanceView: object({
    asOf: nullable(date),
    layout: nullable(text(40)),
    balanced: { type: "boolean" },
    debit: amount,
    credit: amount,
    rows: array(ref("IntakeTrialBalanceRow"), 1200),
    issues: array(ref("IntakeTrialBalanceIssue"), 20),
  }),

  IntakeScan: object({
    files: array(ref("IntakeFile"), 100),
    /** Files named in the request that are not in the archive: upload them first. */
    missing: array(hash, 100),
    /** Files left for another call: one call reads at most 96 MiB. */
    deferred: array(hash, 100),
    totals: ref("IntakeScanTotals"),
  }),
};

export const intakeSchema: SliceSchema = {
  name: "intake",
  definitions,
  readsBeforeSetup: ["intake.scan", "intake.plan", "intake.recipeTest", "intake.trialBalance"],
  operations: [
    operation(
      "intake.scan",
      "Inventory the files a customer brought, from their archived bytes: each file's kind by content (CSV, TSV, OFX, QFX, JSON, PDF, workbook, archive), size, encoding, delimiter, row count, date range and a guess of its role (bank or card statement, trial balance, chart of accounts, general ledger, payout report, invoices, other). Nothing is imported and nothing is written. Files are named by the SHA-256 their upload returned.",
      "read",
      "IntakeScanInput",
      false,
      "IntakeScan",
    ),
    operation(
      "intake.trialBalance",
      "Read an uploaded trial balance of any system (Xero, QuickBooks, Wave or another with an account column and debit and credit columns) into exact cents: its as-at date, whether it balances, and each account's debit, credit and balance, with the book's account where a row names one by its code or its exact name and the balance as opening.review takes it. Titles, section headings and total rows are not accounts. Nothing is imported or changed. Bank, card and Stripe balances still come from the statements, not from here.",
      "read",
      "IntakeTrialBalanceInput",
      false,
      "IntakeTrialBalanceView",
    ),
    operation(
      "intake.recipeTest",
      "Read an uploaded statement file with a recipe (or with no recipe, as an import would) without importing anything, and prove it: rows read and rejected with the reason for each, the date range and totals, and the gates. Each gate is a check a fault would fail: the running balance follows from the amounts, the lines come to the ending balance the statement prints, the signs, the date order (and the statement period), the encoding, pending lines, memos over several lines, rows that cannot be read. `valid` is false when a gate fails; `verified` is true only when the arithmetic proves the file complete.",
      "read",
      "IntakeRecipeTestInput",
      false,
      "IntakeRecipeReport",
    ),
    operation(
      "intake.recipeSave",
      "Save a recipe that has been proven. The proofs are run again here, on the uploaded files with the balances the statement prints, and a recipe that does not pass every gate on every proof is refused. It is kept as an import profile, so `import --profile NAME` (or the account's automatic match) reads files with it the same way every time; nothing is imported or posted. Saving the same name again is a new revision.",
      "draft",
      "IntakeRecipeSaveInput",
      true,
      "IntakeSavedRecipe",
    ),
    operation(
      "intake.recipeList",
      "List the saved recipes with the files each was proven against.",
      "read",
      "Empty",
      false,
      "IntakeRecipeList",
    ),
    operation(
      "intake.friction",
      "Record where the move-in needed a person or a retry (a file only an agent can read, a recipe that failed a gate, a question for the owner, a month with no statement), and resolve the gaps that are closed. Events have a kind from a closed set, a source and a reason; a gap event with a key is recorded once until it is resolved. Retained: a lost reply never records twice. The log is kept with the book.",
      "draft",
      "IntakeFrictionInput",
      true,
      "IntakeFrictionResult",
    ),
    operation(
      "intake.frictionList",
      "Page the friction log, oldest first, open or resolved or all, optionally one kind. Walk the pages to export it as JSON.",
      "read",
      "IntakeFrictionListInput",
      false,
      "IntakeFrictionList",
    ),
    operation(
      "intake.status",
      "How the move-in is going, in four measures: the time from the first event to the first completed statement import and to the first completed reconciliation, the number of interventions (points where the tooling needed an agent, a retry or a person), and the gaps still open. Also the events by class and kind and the move's gap log.",
      "read",
      "Empty",
      false,
      "IntakeStatus",
    ),
    operation(
      "intake.plan",
      "Turn what is known about a move-in into a checklist: for each bank or card account the months its statements cover, whether each file reads, whether it carries a balance to prove it, whether the files carry on from one another; the cutover date; the trial balance (present, as at the day before the cutover, balanced, agreeing with the first statements); files nobody assigned. Each item is present, missing or uncertain, says who has to act, and names the next command. It reads the archived files and the book and changes nothing.",
      "read",
      "IntakePlanInput",
      false,
      "IntakePlan",
    ),
  ],
};
