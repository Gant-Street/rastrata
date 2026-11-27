import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationHttp } from "../../src/http.ts";
import { LocalBookService } from "../../src/local.ts";
import { APPLICATION_API_VERSION, BUSINESS_PERMISSIONS } from "../../src/schema.ts";
import type { BusinessPermission } from "../../src/schema.ts";
import { setRulesClock } from "../../src/slices/rules/store.ts";

/** A real local book behind the real HTTP boundary, for the rules operations. Account ids are the
 * lower-cased codes, so "6100" is Software. */

export const book = {
  name: "Rules Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1010", name: "Checking", role: "asset" },
    { code: "1020", name: "Savings", role: "asset" },
    { code: "2100", name: "Credit card", role: "liability" },
    { code: "3100", name: "Owner draw", role: "equity" },
    { code: "4000", name: "Revenue", role: "income" },
    { code: "6100", name: "Software", role: "expense" },
    { code: "6200", name: "Hosting", role: "expense" },
    { code: "6300", name: "Meals", role: "expense" },
    { code: "6900", name: "Old software", role: "expense" },
  ],
};

export const author = { kind: "person" } as const;
export const agent = { kind: "agent", name: "claude-code" } as const;

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are inspected loosely in tests
  body: any;
}

export async function rulesBook(
  options: {
    clean?: (work: () => void) => void;
    /** Leave the real clock and let the lane open its own tables on first use. */
    realClock?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "rastrata-rules-"));
  const path = join(directory, "book.sqlite");
  let service = await LocalBookService.open(path);
  let http = new ApplicationHttp(service, {
    bookId: service.bookId,
    permissions: BUSINESS_PERMISSIONS,
  });
  let tick = 0;
  const clock = () => {
    if (options.realClock) return;
    setRulesClock(service, {
      now: () => `2026-04-01T09:00:${String(tick++ % 60).padStart(2, "0")}.000Z`,
      today: () => "2026-04-10",
    });
  };
  clock();
  options.clean?.(() => {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (
    name: string,
    input: unknown = {},
    operationId?: string,
    permissions?: readonly BusinessPermission[],
    credential?: string,
  ): Promise<Reply> => {
    const target = permissions
      ? new ApplicationHttp(service, { bookId: service.bookId, permissions })
      : http;
    const response = await target.fetch(
      new Request(`http://127.0.0.1:4010/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        body: JSON.stringify({
          version: APPLICATION_API_VERSION,
          bookId: "local-book",
          input,
          ...(operationId ? { operationId } : {}),
        }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  /** A write with a fresh identity; fails the test if the call did not succeed. */
  const write = async (name: string, input: unknown) => {
    const reply = await call(name, input, crypto.randomUUID());
    if (!reply.body.ok) throw new Error(`${name} failed: ${JSON.stringify(reply.body.error)}`);
    return reply.body.data;
  };
  const read = async (name: string, input: unknown = {}) => {
    const reply = await call(name, input);
    if (!reply.body.ok) throw new Error(`${name} failed: ${JSON.stringify(reply.body.error)}`);
    return reply.body.data;
  };
  let sequence = 0;
  /** Post a journal that moves money through `bank` against `category`, from a source event whose
   * description is the bank's memo. `amount` is signed: negative is money out. */
  const post = async (
    date: string,
    memo: string,
    amount: string,
    category: string,
    bank = "1010",
  ) => {
    const absolute = amount.replace("-", "");
    const out = amount.startsWith("-");
    const id = `ingest-test-${++sequence}`;
    const draft = await write("drafts.create", {
      data: {
        date,
        reference: id,
        narration: `Narration ${sequence}`,
        source: { id, description: memo },
        lines: [
          { accountId: out ? category : bank, debit: absolute, credit: "" },
          { accountId: out ? bank : category, debit: "", credit: absolute },
        ],
      },
    });
    const planId = crypto.randomUUID();
    const plan = (await call("journal.prepare", { draftId: draft.id, expectedVersion: 1 }, planId))
      .body.data;
    const receipt = (await call("operations.commit", { planId, planHash: plan.planHash })).body
      .data;
    if (receipt.disposition !== "committed")
      throw new Error(`posting failed: ${JSON.stringify(receipt)}`);
    return plan.effects.journals[0].id as string;
  };
  /** Create a scoped agent token as the owner and return its bearer string and public id. */
  const token = async (permissions: readonly string[], label = "Test agent") => {
    const reply = await call("tokens.create", { label, permissions }, crypto.randomUUID());
    if (!reply.body.ok) throw new Error(`tokens.create failed: ${JSON.stringify(reply.body)}`);
    const secret = reply.body.data.secret as string;
    return { secret, id: secret.slice(4, 20) };
  };
  /** A request made with a token: the caller is that agent, not the owner. */
  const as = (
    credential: string,
    name: string,
    input: unknown = {},
    operationId?: string,
  ): Promise<Reply> => call(name, input, operationId, undefined, credential);
  return {
    call,
    read,
    write,
    post,
    token,
    as,
    get service() {
      return service;
    },
    async setup() {
      const reply = await call("book.setup", book, crypto.randomUUID());
      if (!reply.body.ok) throw new Error(JSON.stringify(reply.body));
    },
    async restart() {
      service.close();
      service = await LocalBookService.open(path);
      http = new ApplicationHttp(service, {
        bookId: service.bookId,
        permissions: BUSINESS_PERMISSIONS,
      });
      clock();
    },
  };
}

/** A rule input for the wire. */
export const githubRule = (overrides: Record<string, unknown> = {}) => ({
  name: "GitHub",
  conditions: [{ field: "description", operator: "contains", value: "github" }],
  action: { kind: "categorize", accountId: "6100" },
  ...overrides,
});
