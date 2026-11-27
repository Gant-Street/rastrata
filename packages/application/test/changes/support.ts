/** The book the changes lane is tested on: the acceptance month's own book (the same template, cutover,
 * opening balances, bank file and rows), cut down to the first two weeks of March so that a test can
 * make a change of every kind in a few seconds. Everything is reached through `ApplicationHttp`, as a
 * client reaches it, and every principal is a real one: the owner, an agent token, a member and the
 * control plane. */
import type { WorkspaceRole } from "../../src/agent/member.ts";
import type { ApplicationAccess } from "../../src/agent/principal.ts";
import { WRITE_OPERATIONS } from "../../src/client-contracts.gen.ts";
import { ApplicationHttp } from "../../src/http.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import { allItems, pairRows } from "../acceptance/drive.ts";
import type { Row } from "../acceptance/month.ts";
import { BANK_AND_CARD, CHASE, OPENING, RENAMED, cents, chaseCsv } from "../acceptance/month.ts";
import { type Json, type Reply, type World, openWorld } from "../acceptance/world.ts";

export type { Json, Reply, World };

const WRITES: ReadonlySet<string> = new Set(WRITE_OPERATIONS);
const short = (value: unknown): string => JSON.stringify(value).slice(0, 700);

/** A way of calling the book: as the owner, as an agent's token, or as a member or the control plane. */
export interface Caller {
  readonly name: string;
  call(operation: string, input?: unknown, operationId?: string): Promise<Reply>;
  /** A call that must succeed; returns its `data`. */
  ok(operation: string, input?: unknown, operationId?: string): Promise<Json>;
}

function callerOf(
  name: string,
  send: (operation: string, input: unknown, operationId: string | undefined) => Promise<Reply>,
): Caller {
  const call: Caller["call"] = (operation, input = {}, operationId) =>
    send(
      operation,
      input,
      operationId ?? (WRITES.has(operation) ? crypto.randomUUID() : undefined),
    );
  return {
    name,
    call,
    async ok(operation, input, operationId) {
      const reply = await call(operation, input, operationId);
      if (reply.status !== 200 || reply.body.ok !== true)
        throw new Error(
          `${name}: ${operation} answered ${reply.status}: ${short(reply.body.error ?? reply.body)}`,
        );
      return reply.body.data;
    },
  };
}

/** A caller that reaches the book through `ApplicationHttp` with access the runtime already decided
 * on, as a host does for a person or the control plane it has vouched for. */
function httpCaller(name: string, http: ApplicationHttp, access: ApplicationAccess): Caller {
  return callerOf(name, async (operation, input, operationId) => {
    const response = await http.fetch(
      new Request(`http://127.0.0.1:4010/v1/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
      access,
    );
    return { status: response.status, body: await response.json(), headers: response.headers };
  });
}

const httpFor = (world: World): ApplicationHttp =>
  new ApplicationHttp(
    world.service,
    { bookId: world.service.bookId, permissions: BUSINESS_PERMISSIONS },
    { clock: () => new Date(world.clock.ms) },
  );

/** The control plane acting for itself: it can change who is in the book and nothing else. */
export function serviceCaller(world: World, name = "control"): Caller {
  const http = httpFor(world);
  return httpCaller(`service ${name}`, http, http.serviceAccess(name));
}

/** A member of the book: the control plane puts them in (through its own caller), and a host then
 * vouches for them, so the book treats them as their role allows and records them as themselves. */
export async function memberCaller(
  world: World,
  userId: string,
  role: WorkspaceRole,
  email = `${userId}@example.com`,
): Promise<Caller> {
  await serviceCaller(world).ok("members.add", { userId, email, role });
  const http = httpFor(world);
  const access = http.memberAccess(userId);
  if (access === null) throw new Error(`${userId} is not in the book`);
  return httpCaller(`member ${role}`, http, access);
}

/** The owner. */
export function ownerCaller(world: World): Caller {
  return callerOf("owner", (operation, input, operationId) =>
    world.call(operation, input, operationId ? { operationId } : {}),
  );
}

/** An agent token with these permissions; its name is what a list shows as the maker. */
export async function agentCaller(
  world: World,
  label: string,
  permissions: readonly string[],
): Promise<Caller & { readonly tokenId: string; readonly secret: string }> {
  const issued = await world.ok("tokens.create", { label, permissions });
  const secret = issued.secret as string;
  return {
    ...callerOf(`agent ${label}`, (operation, input, operationId) =>
      world.call(operation, input, {
        credential: secret,
        ...(operationId ? { operationId } : {}),
      }),
    ),
    tokenId: issued.token.id as string,
    secret,
  };
}

/** The rows of the acceptance month that this book imports: the first two weeks of March, the lines
 * that go to one account. */
export const MARCH_ROWS: readonly Row[] = CHASE.filter(
  (row) => row.date >= "2026-03-01" && row.date <= "2026-03-13" && "to" in row.dest,
);

export interface MonthBook {
  readonly world: World;
  readonly owner: Caller;
  /** The Inbox item each March row became. */
  readonly items: ReadonlyMap<Row, Json>;
  readonly rows: readonly Row[];
  /** Move the injected clock on by this many minutes, so that two changes do not share an instant. */
  advance(minutes?: number): void;
  close(): Promise<void> | void;
}

/** The acceptance month's book, as the owner leaves it after the first two weeks of March: a book from
 * the Schedule C online-business template, the cutover and the opening balances, the Chase file
 * imported, every line categorised and posted. */
export async function monthBook(): Promise<MonthBook> {
  const world = await openWorld();
  const owner = ownerCaller(world);
  const template = await world.ok("templates.get", {
    templateId: "sole-proprietor",
    basis: "cash",
    taxYear: 2026,
    addOns: ["online-business"],
  });
  await world.ok("book.setup", {
    name: "Willow Lane Studio",
    currency: "USD",
    fiscalYear: 2026,
    periodModel: "monthly",
    basis: "cash",
    accounts: [
      ...BANK_AND_CARD,
      ...template.accounts.map((a: Json) => ({
        code: a.code,
        name: RENAMED[a.code] ?? a.name,
        role: a.role,
        ...(a.parentCode ? { parentCode: a.parentCode } : {}),
        tags: a.tags,
      })),
    ],
  });
  await world.ok("cutover.set", {
    cutoverDate: "2026-03-01",
    accountIds: ["1000", "1010", "2000"],
  });
  const balances = Object.entries(OPENING).map(([accountId, balance]) => ({ accountId, balance }));
  const planned = await world.ok("opening.plan", { cutoverDate: "2026-03-01", balances });
  const opened = await world.ok("operations.commit", {
    planId: planned.plan.planId,
    planHash: planned.plan.planHash,
  });
  if (opened.disposition !== "committed") throw new Error("the opening entry did not post");

  const upload = await world.upload(
    chaseCsv(MARCH_ROWS, cents(OPENING["1000"] as string)),
    "chase-march.csv",
  );
  if (upload.status !== 200) throw new Error(`upload: ${short(upload.body)}`);
  await world.ok("import.commit", { sha256: upload.body.data.sha256, ledgerAccountId: "1000" });
  const imported = await allItems(world, {});
  const { paired } = pairRows(imported, "1000", MARCH_ROWS);
  const byAccount = new Map<string, string[]>();
  for (const [row, item] of paired) {
    const code = (row.dest as { to: string }).to;
    byAccount.set(code, [...(byAccount.get(code) ?? []), item.id as string]);
  }
  for (const [accountId, itemIds] of byAccount)
    await world.ok("inbox.categorize", { itemIds, accountId });
  const posted = await world.ok("inbox.post", { filter: { status: ["drafted"] } });
  if (posted.failed !== 0) throw new Error(`posting: ${short(posted)}`);

  return {
    world,
    owner,
    items: paired,
    rows: MARCH_ROWS,
    advance(minutes = 1) {
      world.clock.ms += minutes * 60_000;
    },
    close: () => world.close(),
  };
}

/** The kinds of change the ledger holds. A list narrowed to them is the book's own history: one change for
 * each revision. The other kinds come from rules, tags, reconciliations and who has access. */
export const LEDGER_KINDS = [
  "book.opened",
  "entry.posted",
  "entry.reversed",
  "period.closed",
  "period.reopened",
  "calendar.extended",
  "account.added",
  "account.changed",
  "account.closed",
  "book.changed",
] as const;

/** Every change of one list, all pages, read at the revision and instant of the first. */
export async function allChanges(
  reader: Caller,
  input: Record<string, unknown> = {},
): Promise<{ readonly changes: Json[]; readonly first: Json }> {
  const changes: Json[] = [];
  let first: Json | undefined;
  for (let page = 1; page < 500; page += 1) {
    const data: Json = await reader.ok("changes.list", {
      ...input,
      page,
      pageSize: 200,
      ...(first ? { revision: first.revision, asOf: first.asOf } : {}),
    });
    first ??= data;
    changes.push(...data.changes);
    if (changes.length >= data.count || data.changes.length === 0) break;
  }
  return { changes, first: first as Json };
}
