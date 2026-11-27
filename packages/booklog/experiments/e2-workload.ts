/** A random workload for the real application, sent through the same HTTP boundary a client uses: the
 * flows a person and an agent make in a month of bookkeeping (postings, reversals, drafts, accounts,
 * rules, statement imports and the Inbox, tokens, settings), with the retries a client makes when the
 * answer is "may or may not have been saved", and with plenty of requests the application refuses.
 * What it keeps is a model of what the book acknowledged, to check against a process that has only
 * the log. */
import { operationRequest, changesBook } from "../test/support/app.ts";
import type { Rng } from "../src/rng.ts";

export interface Sendable {
  fetch(request: Request): Promise<Response>;
}

export const BOOK = {
  name: "Workload Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "1020", name: "Savings", role: "asset" },
    { code: "2100", name: "Credit card", role: "liability" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "4000", name: "Revenue", role: "income" },
    { code: "4100", name: "Other income", role: "income" },
    { code: "6100", name: "Software", role: "expense" },
    { code: "6200", name: "Hosting", role: "expense" },
    { code: "6300", name: "Meals", role: "expense" },
    { code: "6400", name: "Travel", role: "expense" },
  ],
};

type Role = "asset" | "liability" | "equity" | "income" | "expense";

interface Reply {
  readonly status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely
  readonly body: any;
}

export interface Counters {
  /** Requests sent (not counting the retries of one). */
  requests: number;
  /** Requests that could change the book. */
  writes: number;
  /** Writes the application answered ok (or a replay of one). */
  acknowledged: number;
  /** Requests the application refused, by its error code. */
  refused: Record<string, number>;
  /** Times a request was sent again because its answer said the outcome was unknown or the book busy. */
  retries: number;
  /** Replays of an acknowledged write under its identity that came back identical. */
  replays: number;
  flows: Record<string, number>;
}

/** What the book acknowledged, to be found by a process that has only the log. */
export interface Model {
  accounts: { code: string; role: Role }[];
  journals: Set<string>;
  rules: Map<string, number>;
  deletedRules: Set<string>;
  tokens: { id: string; secret: string; revoked: boolean }[];
  drafts: Map<string, number>;
  closedMonths: Set<number>;
}

export function newModel(): Model {
  return {
    accounts: BOOK.accounts.map((account) => ({ code: account.code, role: account.role as Role })),
    journals: new Set(),
    rules: new Map(),
    deletedRules: new Set(),
    tokens: [],
    drafts: new Map(),
    closedMonths: new Set(),
  };
}

export function newCounters(): Counters {
  return {
    requests: 0,
    writes: 0,
    acknowledged: 0,
    refused: {},
    retries: 0,
    replays: 0,
    flows: {},
  };
}

const RETRYABLE = new Set([
  "commit_uncertain",
  "commit_conflict",
  "book_busy",
  "lease_lost",
  "tail_unavailable",
  "service_limit",
  "read_not_logged",
]);

export interface WorkloadOptions {
  /** Pause before sending a request again, in milliseconds. */
  readonly retryDelayMs?: number;
  readonly maxRetries?: number;
  /** The book was already set up (a book made by an earlier release, or by an earlier run of the
   * workload): go straight to the flows, and make new accounts above the ones it may have. */
  readonly resume?: boolean;
}

const FLOWS: readonly (readonly [string, number])[] = [
  ["post", 30],
  ["postSplit", 5],
  ["postRefused", 3],
  ["reverse", 3],
  ["draftEdit", 4],
  ["account", 1.5],
  ["tags", 1],
  ["rule", 6],
  ["import", 2],
  ["inbox", 8],
  ["token", 1],
  ["agent", 3],
  ["bookUpdate", 1],
  ["period", 0.5],
  ["replay", 3],
  ["invalid", 2],
  ["reads", 26],
];

/** One book's workload: call `step()` as many times as there is time for. */
export class Workload {
  readonly counters = newCounters();
  readonly model = newModel();
  readonly #book: Sendable;
  readonly #rng: Rng;
  readonly #options: WorkloadOptions;
  #accountCode = 7000;
  #lastWrite: { name: string; input: unknown; operationId: string; reply: Reply } | null = null;
  #uploadCount = 0;
  #started = false;

  constructor(book: Sendable, rng: Rng, options: WorkloadOptions = {}) {
    this.#book = book;
    this.#rng = rng;
    this.#options = options;
    if (options.resume) {
      this.#started = true;
      this.#accountCode = 7500;
    }
  }

  // ---- sending ------------------------------------------------------------------------------------

  /** Send one operation. A write gets an identity (or the one given), kept across retries; an answer
   * that says the outcome is unknown, or that the book is busy, is sent again under that identity. */
  async send(
    name: string,
    input: unknown = {},
    options: { operationId?: string; token?: string; replay?: boolean } = {},
  ): Promise<Reply> {
    const writes = changesBook(operationRequest(name));
    const operationId = options.operationId ?? (writes ? crypto.randomUUID() : undefined);
    if (!options.replay) {
      this.counters.requests += 1;
      if (writes) this.counters.writes += 1;
    }
    const headers: Record<string, string> = options.token
      ? { authorization: `Bearer ${options.token}` }
      : {};
    const maxRetries = this.#options.maxRetries ?? 12;
    let reply: Reply = { status: 0, body: null };
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.#book.fetch(operationRequest(name, input, operationId, headers));
      reply = { status: response.status, body: await response.json() };
      const code = reply.body?.error?.code as string | undefined;
      if (code && RETRYABLE.has(code) && attempt < maxRetries) {
        this.counters.retries += 1;
        const delay = this.#options.retryDelayMs ?? 5;
        if (delay > 0) await Bun.sleep(delay);
        continue;
      }
      break;
    }
    if (reply.body?.ok === true) {
      if (writes && !options.replay) {
        this.counters.acknowledged += 1;
        // A token's secret is shown once: its replay is the same answer without it, by design.
        if (operationId && name !== "tokens.create")
          this.#lastWrite = { name, input, operationId, reply };
      }
    } else {
      const code = String(reply.body?.error?.code ?? `http_${reply.status}`);
      this.counters.refused[code] = (this.counters.refused[code] ?? 0) + 1;
    }
    return reply;
  }

  async upload(bytes: string, name: string): Promise<Reply> {
    this.counters.requests += 1;
    this.counters.writes += 1;
    const response = await this.#book.fetch(
      new Request("http://127.0.0.1:4010/v1/uploads", {
        method: "POST",
        headers: { "content-type": "text/csv", "x-upload-name": encodeURIComponent(name) },
        body: bytes,
      }),
    );
    const reply = { status: response.status, body: await response.json() };
    if (reply.body?.ok === true) this.counters.acknowledged += 1;
    else {
      const code = String(reply.body?.error?.code ?? `http_${reply.status}`);
      this.counters.refused[code] = (this.counters.refused[code] ?? 0) + 1;
    }
    return reply;
  }

  // ---- the model of the book --------------------------------------------------------------------

  #pickAccount(...roles: Role[]): string {
    const choices = this.model.accounts.filter((account) => roles.includes(account.role));
    return (this.#rng.pick(choices) ?? this.model.accounts[0]).code;
  }

  /** A date in 2026 that is not in a month the workload closed. */
  #date(): string {
    for (let tries = 0; tries < 20; tries += 1) {
      const month = this.#rng.between(1, 12);
      if (this.model.closedMonths.has(month)) continue;
      return `2026-${String(month).padStart(2, "0")}-${String(this.#rng.between(1, 28)).padStart(2, "0")}`;
    }
    return "2026-12-15";
  }

  #money(max = 90000): string {
    const cents = this.#rng.between(1, max);
    return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  }

  /** The lines of a balanced entry: money out of or into a bank or card account against a category. */
  #lines(split: boolean): { accountId: string; debit: string; credit: string }[] {
    const out = this.#rng.chance(0.7);
    const bank = this.#pickAccount("asset", "liability");
    const category = out ? this.#pickAccount("expense") : this.#pickAccount("income", "equity");
    const total = this.#rng.between(100, 90000);
    const text = (cents: number) =>
      `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    if (!split) {
      return out
        ? [
            { accountId: category, debit: text(total), credit: "" },
            { accountId: bank, debit: "", credit: text(total) },
          ]
        : [
            { accountId: bank, debit: text(total), credit: "" },
            { accountId: category, debit: "", credit: text(total) },
          ];
    }
    const first = this.#rng.between(1, total - 1);
    const other = this.#pickAccount(out ? "expense" : "income");
    return out
      ? [
          { accountId: category, debit: text(first), credit: "" },
          { accountId: other, debit: text(total - first), credit: "" },
          { accountId: bank, debit: "", credit: text(total) },
        ]
      : [
          { accountId: bank, debit: text(total), credit: "" },
          { accountId: category, debit: "", credit: text(first) },
          { accountId: other, debit: "", credit: text(total - first) },
        ];
  }

  async #prepareAndCommit(
    prepare: string,
    input: unknown,
  ): Promise<{ planned: Reply; committed: Reply | null }> {
    const planned = await this.send(prepare, input);
    if (planned.body?.ok !== true || planned.body.data?.valid === false)
      return { planned, committed: null };
    const committed = await this.send("operations.commit", {
      planId: planned.body.data.planId,
      planHash: planned.body.data.planHash,
    });
    return { planned, committed };
  }

  // ---- flows --------------------------------------------------------------------------------------

  async step(): Promise<string> {
    if (!this.#started) {
      this.#started = true;
      const done = await this.send("book.setup", BOOK);
      if (done.body?.ok !== true)
        throw new Error(`The workload book could not be set up: ${JSON.stringify(done.body)}`);
      this.counters.flows.setup = 1;
      return "setup";
    }
    const total = FLOWS.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.#rng.next() * total;
    let flow = FLOWS[0]?.[0] ?? "reads";
    for (const [name, weight] of FLOWS) {
      roll -= weight;
      if (roll <= 0) {
        flow = name;
        break;
      }
    }
    await this.#run(flow);
    this.counters.flows[flow] = (this.counters.flows[flow] ?? 0) + 1;
    return flow;
  }

  async #run(flow: string): Promise<void> {
    switch (flow) {
      case "post":
      case "postSplit":
        return this.#post(flow === "postSplit", false);
      case "postRefused":
        return this.#post(false, true);
      case "reverse":
        return this.#reverse();
      case "draftEdit":
        return this.#draftEdit();
      case "account":
        return this.#account();
      case "tags":
        return this.#tags();
      case "rule":
        return this.#rule();
      case "import":
        return this.#import();
      case "inbox":
        return this.#inbox();
      case "token":
        return this.#token();
      case "agent":
        return this.#agent();
      case "bookUpdate":
        return this.#bookUpdate();
      case "period":
        return this.#period();
      case "replay":
        return this.#replay();
      case "invalid":
        return this.#invalid();
      default:
        return this.#reads();
    }
  }

  async #post(split: boolean, unbalanced: boolean): Promise<void> {
    const lines = this.#lines(split);
    if (unbalanced && lines[0])
      lines[0] = {
        ...lines[0],
        debit: lines[0].debit ? this.#money() : "",
        credit: lines[0].credit ? this.#money() : "",
      };
    const draft = await this.send("drafts.create", {
      data: {
        date: this.#date(),
        reference: `w-${this.counters.requests}`,
        narration: this.#rng.pick([
          "Software",
          "Hosting",
          "Client payment",
          "Lunch",
          "Flights",
          "Transfer",
        ]),
        lines,
      },
    });
    if (draft.body?.ok !== true) return;
    const { committed, planned } = await this.#prepareAndCommit("journal.prepare", {
      draftId: draft.body.data.id,
      expectedVersion: draft.body.data.version,
    });
    if (committed?.body?.ok === true && committed.body.data?.disposition === "committed") {
      const id = planned.body.data?.effects?.journals?.[0]?.id as string | undefined;
      if (id) this.model.journals.add(id);
    }
  }

  async #reverse(): Promise<void> {
    const ids = [...this.model.journals];
    if (ids.length === 0) return;
    const journalId = this.#rng.pick(ids);
    const { committed } = await this.#prepareAndCommit("journal.prepareReverse", {
      journalId,
      accountingDate: this.#date(),
      reason: "Entered twice",
    });
    if (committed?.body?.ok === true && committed.body.data?.disposition === "committed")
      this.model.journals.delete(journalId);
  }

  async #draftEdit(): Promise<void> {
    const data = {
      date: this.#date(),
      reference: `d-${this.counters.requests}`,
      narration: "Draft",
      lines: this.#lines(false),
    };
    const created = await this.send("drafts.create", { data });
    if (created.body?.ok !== true) return;
    const id = created.body.data.id as string;
    const saved = await this.send("drafts.save", {
      draftId: id,
      expectedVersion: created.body.data.version,
      data: { ...data, reference: `${data.reference}-edited`, lines: this.#lines(false) },
    });
    if (saved.body?.ok !== true) return;
    if (this.#rng.chance(0.5))
      await this.send("drafts.discard", { draftId: id, expectedVersion: saved.body.data.version });
    else this.model.drafts.set(id, saved.body.data.version as number);
  }

  async #account(): Promise<void> {
    const role = this.#rng.pick<Role>(["expense", "expense", "income", "asset", "liability"]);
    const code = String(this.#accountCode++);
    const { committed } = await this.#prepareAndCommit("accounts.prepareCreate", {
      code,
      name: `Account ${code}`,
      role,
      effectiveOn: "2026-01-01",
    });
    if (committed?.body?.ok === true && committed.body.data?.disposition === "committed")
      this.model.accounts.push({ code, role });
  }

  async #tags(): Promise<void> {
    await this.send("accounts.setTags", {
      accountId: this.#pickAccount("expense"),
      effectiveOn: "2026-06-01",
      tags: {
        taxLine: this.#rng.pick(["scheduleC.line22", "scheduleC.line8", "scheduleC.line18"]),
      },
    });
  }

  #rule = async (): Promise<void> => {
    const rule = (name: string) => ({
      name,
      conditions: [
        {
          field: "description",
          operator: "contains",
          value: this.#rng.pick(["github", "aws", "stripe", "uber", "cafe", "figma"]),
        },
      ],
      action: { kind: "categorize", accountId: this.#pickAccount("expense") },
    });
    const madeBy = this.#rng.chance(0.3) ? { kind: "agent", name: "workload" } : { kind: "person" };
    const known = [...this.model.rules.entries()];
    const roll = this.#rng.next();
    if (known.length === 0 || roll < 0.45) {
      const created = await this.send("rules.create", {
        rule: rule(`Rule ${this.counters.requests}`),
        madeBy,
      });
      if (created.body?.ok === true)
        this.model.rules.set(created.body.data.id as string, created.body.data.revision as number);
    } else if (roll < 0.75) {
      const [id, revision] = this.#rng.pick(known);
      const updated = await this.send("rules.update", {
        ruleId: id,
        expectedRevision: revision,
        rule: rule(`Rule ${this.counters.requests} v${revision + 1}`),
        madeBy,
      });
      if (updated.body?.ok === true) this.model.rules.set(id, updated.body.data.revision as number);
    } else if (roll < 0.85) {
      const [id, revision] = this.#rng.pick(known);
      const removed = await this.send("rules.delete", {
        ruleId: id,
        expectedRevision: revision,
        madeBy,
        reason: "Not needed",
      });
      if (removed.body?.ok === true) {
        this.model.rules.delete(id);
        this.model.deletedRules.add(id);
      }
    } else {
      const listed = await this.send("rules.list");
      if (listed.body?.ok !== true) return;
      const ids = (listed.body.data.rules as { id: string }[]).map((item) => item.id);
      if (ids.length < 2) return;
      const shuffled = this.#rng.shuffle(ids);
      await this.send("rules.reorder", {
        expectedRulesRevision: listed.body.data.rulesRevision,
        orderedRuleIds: shuffled,
        madeBy,
      });
    }
  };

  async #import(): Promise<void> {
    this.#uploadCount += 1;
    const lines = this.#rng.between(3, 25);
    const merchants = [
      "GITHUB INC",
      "AWS EMEA",
      "STRIPE PAYOUT",
      "UBER TRIP",
      "BLUE BOTTLE COFFEE",
      "FIGMA INC",
      "ACH CREDIT CLIENT",
    ];
    let balance = 1_000_000 + this.#rng.between(0, 500_000);
    const rows: string[] = [];
    // Newest first, with a running balance, as a bank writes it.
    const entries = Array.from({ length: lines }, () => {
      const out = this.#rng.chance(0.75);
      const cents = this.#rng.between(100, 200_00) * (out ? -1 : 1);
      return {
        cents,
        memo: `${this.#rng.pick(merchants)} ${this.#rng.between(1000, 9999)}`,
        day: this.#rng.between(1, 28),
        month: this.#rng.between(1, 11),
      };
    }).sort((a, b) => a.month - b.month || a.day - b.day);
    const dated = entries.map((entry) => {
      balance += entry.cents;
      return { ...entry, balance };
    });
    const money = (cents: number) =>
      `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
    for (const entry of [...dated].reverse())
      rows.push(
        `${entry.cents < 0 ? "DEBIT" : "CREDIT"},${String(entry.month).padStart(2, "0")}/${String(entry.day).padStart(2, "0")}/2026,${entry.memo},${money(entry.cents)},${entry.cents < 0 ? "ACH_DEBIT" : "ACH_CREDIT"},${money(entry.balance)},,`,
      );
    const csv = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n${rows.join("\n")}\n`;
    const uploaded = await this.upload(csv, `statement-${this.#uploadCount}.csv`);
    if (uploaded.body?.ok !== true) return;
    const sha256 = uploaded.body.data.sha256 as string;
    await this.send("import.preview", { sha256, ledgerAccountId: "1010" });
    await this.send("import.commit", { sha256, ledgerAccountId: "1010" });
  }

  async #inbox(): Promise<void> {
    const listed = await this.send("inbox.list", {
      filter: { status: ["new", "proposed", "drafted"] },
      page: 1,
      pageSize: 12,
      sort: "date_asc",
    });
    if (listed.body?.ok !== true) return;
    const items = (listed.body.data.items as { id: string; status: string }[]) ?? [];
    if (items.length === 0) return;
    const pick = this.#rng.shuffle(items).slice(0, this.#rng.between(1, 4));
    const fresh = pick.filter((item) => item.status === "new" || item.status === "proposed");
    const drafted = pick.filter((item) => item.status === "drafted");
    const roll = this.#rng.next();
    if (fresh.length > 0 && roll < 0.55) {
      await this.send("inbox.categorize", {
        itemIds: fresh.map((item) => item.id),
        accountId: this.#pickAccount("expense", "income"),
      });
    } else if (fresh.length > 0 && roll < 0.7) {
      await this.send("inbox.exclude", {
        itemIds: fresh.map((item) => item.id),
        reason: "personal",
      });
    } else if (drafted.length > 0) {
      await this.send("inbox.post", { itemIds: drafted.map((item) => item.id) });
    } else {
      await this.send("inbox.summary");
    }
    if (this.#rng.chance(0.15)) {
      const excluded = await this.send("inbox.list", {
        filter: { status: ["excluded"] },
        page: 1,
        pageSize: 5,
      });
      const ids = ((excluded.body?.data?.items as { id: string }[]) ?? []).map((item) => item.id);
      if (ids.length > 0) await this.send("inbox.restore", { itemIds: ids, reason: "after all" });
    }
  }

  async #token(): Promise<void> {
    const live = this.model.tokens.filter((token) => !token.revoked);
    if (live.length > 0 && this.#rng.chance(0.4)) {
      const token = this.#rng.pick(live);
      const revoked = await this.send("tokens.revoke", { tokenId: token.id });
      if (revoked.body?.ok === true) token.revoked = true;
      return;
    }
    const created = await this.send("tokens.create", {
      label: `Agent ${this.counters.requests}`,
      permissions: this.#rng.pick([["read"], ["read", "draft"]]),
    });
    // A create whose answer was lost and which was asked again is answered from the record, and the
    // secret is shown once: there is none to keep.
    const secret = created.body?.data?.secret as string | null | undefined;
    if (created.body?.ok === true && secret)
      this.model.tokens.push({ id: secret.slice(4, 20), secret, revoked: false });
  }

  /** An agent with a token reads, and drafts. (Its use is recorded in the book, so even a read writes.) */
  async #agent(): Promise<void> {
    const live = this.model.tokens.filter((token) => !token.revoked);
    if (live.length === 0) return;
    const token = this.#rng.pick(live).secret;
    await this.send("book.get", {}, { token });
    await this.send("journal.list", { page: 1, status: "Posted" }, { token });
    if (this.#rng.chance(0.4))
      await this.send(
        "drafts.create",
        {
          data: {
            date: this.#date(),
            reference: "agent",
            narration: "Proposed by an agent",
            lines: this.#lines(false),
          },
        },
        { token },
      );
  }

  async #bookUpdate(): Promise<void> {
    await this.send("book.update", {
      dateFormat: this.#rng.pick(["short", "medium", "long"]),
      showAccountNumbers: this.#rng.chance(0.5),
      acceptMode: this.#rng.pick(["post", "draft"]),
    });
  }

  async #period(): Promise<void> {
    const month = this.#rng.between(1, 12);
    const closed = this.model.closedMonths.has(month);
    const { committed } = await this.#prepareAndCommit("periods.prepare", {
      periodId: `period-${String(month).padStart(2, "0")}`,
      operation: closed ? "reopen" : "close",
      reason: "Reviewed",
    });
    if (committed?.body?.ok === true && committed.body.data?.disposition === "committed") {
      if (closed) this.model.closedMonths.delete(month);
      else this.model.closedMonths.add(month);
    }
  }

  /** The same write sent again under its identity: the book answers from what it recorded, and
   * records nothing new. */
  async #replay(): Promise<void> {
    const last = this.#lastWrite;
    if (!last) return;
    const again = await this.send(last.name, last.input, {
      operationId: last.operationId,
      replay: true,
    });
    this.counters.requests += 1;
    this.counters.writes += 1;
    if (JSON.stringify(again.body) === JSON.stringify(last.reply.body)) this.counters.replays += 1;
    else
      throw new Error(
        `A replay of ${last.name} under ${last.operationId} answered differently:\n${JSON.stringify(last.reply.body).slice(0, 500)}\n${JSON.stringify(again.body).slice(0, 500)}`,
      );
  }

  async #invalid(): Promise<void> {
    const roll = this.#rng.between(0, 3);
    if (roll === 0) await this.send("drafts.create", { data: { nonsense: true } });
    else if (roll === 1)
      await this.send("rules.create", { rule: { name: "" }, madeBy: { kind: "person" } });
    else if (roll === 2)
      await this.send("journal.prepare", { draftId: "missing", expectedVersion: 1 });
    else
      await this.send("accounts.prepareCreate", {
        code: "1010",
        name: "Duplicate",
        role: "asset",
        effectiveOn: "2026-01-01",
      });
  }

  async #reads(): Promise<void> {
    const roll = this.#rng.between(0, 11);
    switch (roll) {
      case 0:
        await this.send("book.get");
        break;
      case 1:
        await this.send("accounts.list");
        break;
      case 2:
        await this.send("journal.list", { page: this.#rng.between(1, 3), status: "Posted" });
        break;
      case 3: {
        const ids = [...this.model.journals];
        if (ids.length > 0) await this.send("journal.get", { journalId: this.#rng.pick(ids) });
        break;
      }
      case 4:
        await this.send("reports.get", {
          asOf: `2026-${String(this.#rng.between(1, 12)).padStart(2, "0")}-28`,
        });
        break;
      case 5:
        await this.send("reports.cashFlow", { asOf: "2026-12-31" });
        break;
      case 6:
        await this.send("inbox.summary");
        break;
      case 7:
        await this.send("rules.list");
        break;
      case 8:
        await this.send("drafts.list");
        break;
      case 9:
        await this.send("periods.list");
        break;
      case 10:
        await this.send("activity.get", {});
        break;
      default:
        await this.send("tokens.list");
    }
  }
}
