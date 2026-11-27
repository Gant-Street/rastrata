import {
  type FakeAccount,
  type FakeConnection,
  type FakeProblem,
  FIXTURE_CLAIM_CODE,
  FIXTURE_PASSWORD,
  FIXTURE_USER,
  FakeBridge,
  day,
} from "./fake-bridge.ts";

/** The stand-in SimpleFIN Bridge of the tests, listening on this machine, for the browser flow and the
 * command line's integration test: the Rastrata service is started with RASTRATA_SIMPLEFIN_STANDIN
 * pointing here, which is the one address on this machine its bank feed may speak to over http. It
 * only ever answers on the loopback address and holds nothing but the fictional September below: a
 * business with a checking account, a savings account and an account in euros. Nothing here is a real
 * credential, bank, account or business.
 *
 *   RASTRATA_FAKE_SIMPLEFIN_PORT   the port to listen on
 *
 * It answers the protocol exactly as the unit tests' fake does (fake-bridge.ts). A few control
 * routes, all under /__fake/, let a test say what the Bridge does next:
 *
 *   GET  /__fake/token          the setup token a person would copy from the Bridge
 *   GET  /__fake/access         the secrets a claim hands out, so a test can prove they appear nowhere
 *   POST /__fake/reset          back to the start: unclaimed, the fictional September, nothing queued
 *   POST /__fake/accounts       add an account that the Bridge starts listing (a FakeAccount as JSON)
 *   POST /__fake/problems       what the Bridge reports as wrong: { problems?, warnings?, messages? }
 *   POST /__fake/respond-once   answer the next request with { status, body, headers? }
 *   GET  /__fake/log            what the Bridge was asked (never an Authorization value) */

const port = Number(process.env.RASTRATA_FAKE_SIMPLEFIN_PORT ?? "");
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("Set RASTRATA_FAKE_SIMPLEFIN_PORT");
const origin = `http://127.0.0.1:${port}`;

const BANK_A: FakeConnection = {
  id: "CON-bank-a",
  name: "Example Bank (business)",
  orgId: "bank-a.invalid",
  orgName: "Example Bank",
};
const BANK_B: FakeConnection = {
  id: "CON-bank-b",
  name: "Example Euro Bank",
  orgId: "bank-b.invalid",
  orgName: "Example Euro Bank",
};

/** Fixed dates, so the same figures come out whenever the test runs. The service's own clock is the
 * real one, which is always after this month. */
function fictionalSeptember(): FakeAccount[] {
  const balanceDate = Math.floor(Date.now() / 1000);
  return [
    {
      id: "ACT-checking-0001",
      name: "Business Checking",
      currency: "USD",
      // 1,000.00 before the month began, and the eleven posted lines below.
      balance: "6878.18",
      balanceDate,
      connId: BANK_A.id,
      transactions: [
        {
          id: "T-3001",
          posted: day("2026-09-01"),
          amount: "2500.00",
          description: "ACME INVOICE 77 PAYMENT",
        },
        {
          id: "T-3002",
          posted: day("2026-09-02"),
          amount: "-12.50",
          description: "COFFEE SHOP 0042",
          payee: "Coffee Shop",
        },
        {
          id: "T-3003",
          posted: day("2026-09-03"),
          amount: "-45.15",
          description: "SOFTWARE SUBSCRIPTION",
        },
        { id: "T-3004", posted: day("2026-09-08"), amount: "-19.00", description: "CLOUD HOSTING" },
        {
          id: "T-3005",
          posted: day("2026-09-10"),
          amount: "1840.22",
          description: "PAYMENT PROCESSOR TRANSFER",
        },
        {
          id: "T-3006",
          posted: day("2026-09-12"),
          amount: "-250.00",
          description: "OFFICE SUPPLIES",
        },
        {
          id: "T-3007",
          posted: day("2026-09-15"),
          amount: "3200.00",
          description: "GLOBEX INVOICE 78 PAYMENT",
        },
        {
          id: "T-3008",
          posted: day("2026-09-17"),
          amount: "-64.20",
          description: "CARD HOLD HOTEL",
          pending: true,
        },
        {
          id: "T-3009",
          posted: day("2026-09-22"),
          amount: "-89.99",
          description: "DOMAIN RENEWAL",
        },
        { id: "T-3010", posted: day("2026-09-25"), amount: "-1200.00", description: "RENT SEPT" },
        { id: "T-3011", posted: day("2026-09-28"), amount: "-37.40", description: "TEAM LUNCH" },
        { id: "T-3012", posted: day("2026-09-30"), amount: "-8.00", description: "BANK FEE" },
      ],
    },
    {
      id: "ACT-savings-0002",
      name: "Business Savings",
      currency: "USD",
      balance: "10001.20",
      balanceDate,
      connId: BANK_A.id,
      transactions: [
        { id: "S-4001", posted: day("2026-09-30"), amount: "1.20", description: "INTEREST" },
      ],
    },
    {
      id: "ACT-euro-0003",
      name: "Euro Account",
      currency: "EUR",
      balance: "250.00",
      balanceDate,
      connId: BANK_B.id,
      transactions: [
        {
          id: "E-5001",
          posted: day("2026-09-14"),
          amount: "-30.00",
          description: "SOFTWARE LICENCE EUR",
        },
      ],
    },
  ];
}

function freshBridge(): FakeBridge {
  const bridge = new FakeBridge(Math.floor(Date.now() / 1000), origin);
  bridge.accounts = fictionalSeptember();
  bridge.connections = [BANK_A, BANK_B];
  return bridge;
}

let bridge = freshBridge();

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function control(request: Request, path: string): Promise<Response> {
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      const body = await request.json();
      return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  if (path === "token" && request.method === "GET")
    return json(200, {
      setupToken: bridge.setupToken(FIXTURE_CLAIM_CODE),
      claimUrl: `${origin}/simplefin/claim/${FIXTURE_CLAIM_CODE}`,
      origin,
    });
  if (path === "access" && request.method === "GET")
    return json(200, {
      accessUrl: bridge.accessUrl(),
      user: FIXTURE_USER,
      password: FIXTURE_PASSWORD,
    });
  if (path === "reset" && request.method === "POST") {
    bridge = freshBridge();
    return json(200, { ok: true });
  }
  if (path === "accounts" && request.method === "POST") {
    const account = (await read()) as unknown as FakeAccount;
    if (typeof account.id !== "string" || typeof account.name !== "string")
      return json(400, { error: "An account needs an id and a name." });
    bridge.accounts = [...bridge.accounts.filter((a) => a.id !== account.id), account];
    return json(200, { accounts: bridge.accounts.map((a) => a.id) });
  }
  if (path === "problems" && request.method === "POST") {
    const body = await read();
    bridge.problems = (Array.isArray(body.problems) ? body.problems : []) as FakeProblem[];
    bridge.warnings = (Array.isArray(body.warnings) ? body.warnings : []) as string[];
    bridge.messages = (Array.isArray(body.messages) ? body.messages : []) as string[];
    return json(200, { ok: true });
  }
  if (path === "respond-once" && request.method === "POST") {
    const body = await read();
    bridge.respondOnce(
      typeof body.status === "number" ? body.status : 500,
      body.body ?? "",
      (body.headers ?? {}) as Record<string, string>,
    );
    return json(200, { ok: true });
  }
  if (path === "log" && request.method === "GET") return json(200, { requests: bridge.log });
  return json(404, { error: "No such control route." });
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__fake/"))
      return control(request, url.pathname.slice("/__fake/".length));
    // The Bridge's idea of now is the real time, as the service's is.
    bridge.now = Math.floor(Date.now() / 1000);
    return bridge.fetch(request.url, { method: request.method, headers: request.headers });
  },
});
console.info(`fake SimpleFIN Bridge on ${origin}`);
