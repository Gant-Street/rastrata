// X1 benchmark: the Durable Object tail (worker.js) measured through the real DurableObjectLogTier client.
//
//   TAIL_URL=https://<worker> TAIL_TOKEN=<token> LABEL=oke PHASES=ping,head,append bun bench.ts
//
// Phases: ping head append concurrent leases contend many readback cold wake (the default set), and
// seed remote writer takeover (explicit). Every phase prints one JSON line `RESULT {...}`; nothing
// here prints the token.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { DurableObjectLogTier } from "../../src/tier-durable.ts";
import { GENESIS_HASH, type AppendInput } from "../../src/tier.ts";

const url = (process.env.TAIL_URL ?? "").replace(/\/+$/, "");
const token = process.env.TAIL_TOKEN ?? "";
const label = process.env.LABEL ?? "run";
const run = process.env.RUN_ID ?? `r${Date.now().toString(36)}`;
if (!url || !token) throw new Error("TAIL_URL and TAIL_TOKEN are required");

const phases = (
  process.env.PHASES ?? "ping,head,append,concurrent,leases,contend,many,readback,cold,wake"
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// ---- plumbing -------------------------------------------------------------------------------------

interface Meta {
  tailMs: number | null;
  read: number;
  written: number;
  colo: string;
  status: number;
}
let last: Meta = { tailMs: null, read: 0, written: 0, colo: "", status: 0 };
const metas = new Map<string, Meta[]>();

function metaFrom(response: Response): Meta {
  const timing = /tail;dur=(\d+)/.exec(response.headers.get("server-timing") ?? "");
  const rows = /r=(\d+);w=(\d+)/.exec(response.headers.get("x-rows") ?? "");
  return {
    tailMs: timing ? Number(timing[1]) : null,
    read: rows ? Number(rows[1]) : 0,
    written: rows ? Number(rows[2]) : 0,
    colo: response.headers.get("x-worker-colo") ?? "",
    status: response.status,
  };
}

const makeFetch =
  (query = "") =>
  async (target: string, init: RequestInit): Promise<Response> => {
    const response = await fetch(query ? `${target}?${query}` : target, init);
    last = metaFrom(response);
    return response;
  };

const plain = new DurableObjectLogTier({
  baseUrl: url,
  token,
  fetch: makeFetch(),
  timeoutMs: 20_000,
});
const hinted = new DurableObjectLogTier({
  baseUrl: url,
  token,
  fetch: makeFetch("hint=enam"),
  timeoutMs: 20_000,
});

async function raw(
  book: string,
  op: string,
  body: unknown,
  query = "",
): Promise<{ json: { ok?: boolean; colo?: string | null }; meta: Meta; ms: number }> {
  const started = performance.now();
  const response = await fetch(
    `${url}/v1/books/${encodeURIComponent(book)}/${op}${query ? `?${query}` : ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
  );
  const json = await response.json();
  return { json, meta: metaFrom(response), ms: performance.now() - started };
}

/** Time one call; records the server's own reading of it next to the client's. */
async function timed<T>(bucket: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  const ms = performance.now() - started;
  const list = metas.get(bucket) ?? [];
  list.push({ ...last });
  metas.set(bucket, list);
  return { value, ms };
}

const round = (x: number) => Math.round(x * 10) / 10;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { n: 0 };
  const at = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))] as number;
  return {
    n,
    min: round(sorted[0] as number),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted[n - 1] as number),
    mean: round(values.reduce((a, b) => a + b, 0) / n),
  };
}
function serverSide(bucket: string) {
  const list = metas.get(bucket) ?? [];
  const tail = list.map((m) => m.tailMs).filter((x): x is number => x !== null);
  const writes = list.map((m) => m.written);
  const reads = list.map((m) => m.read);
  const colos: Record<string, number> = {};
  for (const m of list) colos[m.colo || "?"] = (colos[m.colo || "?"] ?? 0) + 1;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    tail: stats(tail),
    rowsReadPerCall: list.length ? round(sum(reads) / list.length) : 0,
    rowsWrittenPerCall: list.length ? round(sum(writes) / list.length) : 0,
    workerColos: colos,
  };
}

const hashOf = (seq: number, prev: string) =>
  createHash("sha256").update(`${seq}:${prev}`).digest("hex");
const bodies = new Map<number, Uint8Array>();
function body(size: number): Uint8Array {
  let b = bodies.get(size);
  if (!b) {
    b = new Uint8Array(randomBytes(size));
    bodies.set(size, b);
  }
  return b;
}
function entry(seq: number, prev: string, fence: number, size: number): AppendInput {
  return { seq, prevHash: prev, hash: hashOf(seq, prev), fence, body: body(size) };
}

function emit(phase: string, data: unknown): void {
  console.log(`RESULT ${JSON.stringify({ label, run, phase, ...(data as object) })}`);
}

async function lease(tier: DurableObjectLogTier, book: string, holder: string, ttlMs = 60_000) {
  const got = await tier.acquire(book, holder, ttlMs);
  if (!got.ok) throw new Error(`no lease on ${book}: held by ${got.heldBy}`);
  return got.lease;
}

// ---- phases ---------------------------------------------------------------------------------------

async function ping() {
  const times: number[] = [];
  let first = 0;
  let colo = "";
  for (let i = 0; i < 301; i += 1) {
    const started = performance.now();
    const response = await fetch(`${url}/ping`);
    const j = (await response.json()) as { colo: string };
    const ms = performance.now() - started;
    colo = j.colo;
    if (i === 0) first = ms;
    else times.push(ms);
  }
  emit("ping", { firstRequestMs: round(first), workerColo: colo, warm: stats(times) });
}

async function head() {
  const book = `${run}-head`;
  const created = await timed("head-first", () => plain.head(book));
  const times: number[] = [];
  for (let i = 0; i < 300; i += 1) times.push((await timed("head", () => plain.head(book))).ms);
  emit("head", { firstCallMs: round(created.ms), warm: stats(times), server: serverSide("head") });
}

async function append() {
  const out: Record<string, unknown> = {};
  for (const [size, count] of [
    [1_000, 200],
    [10_000, 200],
    [100_000, 100],
  ] as const) {
    const book = `${run}-a${size}`;
    const l = await lease(plain, book, "bench");
    let prev = GENESIS_HASH;
    const times: number[] = [];
    for (let seq = 1; seq <= count; seq += 1) {
      const input = entry(seq, prev, l.fence, size);
      const { value, ms } = await timed(`append-${size}`, () => plain.append(book, input));
      if (!value.ok) throw new Error(`append ${seq} refused: ${value.reason}`);
      prev = input.hash;
      times.push(ms);
    }
    const h = await plain.head(book);
    if (h.seq !== count || h.hash !== prev)
      throw new Error("head does not match what was acknowledged");
    out[`${size}B`] = { client: stats(times), server: serverSide(`append-${size}`) };
  }
  emit("append", out);
}

async function concurrent() {
  const out: Record<string, unknown> = {};
  for (const [books, count, size] of [
    [20, 100, 1_000],
    [20, 50, 10_000],
    [100, 20, 1_000],
  ] as const) {
    const times: number[] = [];
    const started = performance.now();
    let refused = 0;
    await Promise.all(
      Array.from({ length: books }, async (_, i) => {
        const book = `${run}-c${books}x${size}-${i}`;
        const l = await lease(plain, book, "bench");
        let prev = GENESIS_HASH;
        for (let seq = 1; seq <= count; seq += 1) {
          const input = entry(seq, prev, l.fence, size);
          const { value, ms } = await timed(`conc-${books}-${size}`, () =>
            plain.append(book, input),
          );
          if (!value.ok) refused += 1;
          prev = input.hash;
          times.push(ms);
        }
      }),
    );
    const wall = performance.now() - started;
    out[`${books}books_${size}B`] = {
      appends: times.length,
      refused,
      wallSeconds: round(wall / 1000),
      appendsPerSecond: round(times.length / (wall / 1000)),
      client: stats(times),
      server: serverSide(`conc-${books}-${size}`),
    };
  }
  emit("concurrent", out);
}

async function leases() {
  const book = `${run}-lease`;
  const acq: number[] = [];
  const ren: number[] = [];
  const rel: number[] = [];
  for (let i = 0; i < 100; i += 1) {
    const a = await timed("acquire", () => plain.acquire(book, "bench", 30_000));
    acq.push(a.ms);
    if (!a.value.ok) throw new Error("acquire refused");
    const fence = a.value.lease.fence;
    ren.push(
      (await timed("renew", () => plain.renew(book, { holder: "bench", fence }, 30_000))).ms,
    );
    rel.push((await timed("release", () => plain.release(book, { holder: "bench", fence }))).ms);
  }
  emit("leases", {
    acquire: { client: stats(acq), server: serverSide("acquire") },
    renew: { client: stats(ren), server: serverSide("renew") },
    release: { client: stats(rel), server: serverSide("release") },
  });
}

async function contend() {
  // Two pods race for one book, a hundred times: exactly one wins every round.
  let rounds = 0;
  let bothWon = 0;
  let noneWon = 0;
  for (let i = 0; i < 100; i += 1) {
    const book = `${run}-race-${i}`;
    const [a, b] = await Promise.all([
      plain.acquire(book, "pod-a", 5_000),
      plain.acquire(book, "pod-b", 5_000),
    ]);
    rounds += 1;
    if (a.ok && b.ok) bothWon += 1;
    if (!a.ok && !b.ok) noneWon += 1;
  }
  // A paused holder (a zombie) wakes after another has taken over: its append must be refused.
  const book = `${run}-zombie`;
  const a = await lease(plain, book, "pod-a", 1_000);
  const first = entry(1, GENESIS_HASH, a.fence, 1_000);
  const wrote = await plain.append(book, first);
  await Bun.sleep(1_300);
  const b = await lease(plain, book, "pod-b", 5_000);
  const stale = await plain.append(book, entry(2, first.hash, a.fence, 1_000));
  const fresh = await plain.append(book, entry(2, first.hash, b.fence, 1_000));
  emit("contend", {
    rounds,
    bothWon,
    noneWon,
    zombie: {
      firstAck: wrote.ok,
      takeoverSawEntry: b.head.seq === 1 && b.head.hash === first.hash,
      staleRefused: !stale.ok && stale.reason === "fence",
      freshAccepted: fresh.ok,
    },
  });
}

async function many() {
  const book = `${run}-many`;
  const l = await lease(plain, book, "bench");
  let seq = 0;
  let prev = GENESIS_HASH;
  const out: Record<string, unknown> = {};
  for (const [k, requests] of [
    [1, 60],
    [3, 60],
    [10, 40],
  ] as const) {
    const times: number[] = [];
    for (let r = 0; r < requests; r += 1) {
      const entries = [];
      for (let i = 0; i < k; i += 1) {
        seq += 1;
        const e = entry(seq, prev, l.fence, 1_000);
        prev = e.hash;
        entries.push({
          seq: e.seq,
          prevHash: e.prevHash,
          hash: e.hash,
          body: Buffer.from(e.body).toString("base64"),
        });
      }
      const res = await raw(book, "append_many", { fence: l.fence, entries });
      if (!res.json.ok) throw new Error(`append_many refused: ${JSON.stringify(res.json)}`);
      times.push(res.ms);
      const list = metas.get(`many-${k}`) ?? [];
      list.push(res.meta);
      metas.set(`many-${k}`, list);
    }
    out[`${k}_per_request`] = { client: stats(times), server: serverSide(`many-${k}`) };
  }
  const h = await plain.head(book);
  if (h.seq !== seq || h.hash !== prev) throw new Error("head does not match after group commits");
  emit("many", out);
}

async function readback() {
  const book = `${run}-readback`;
  const l = await lease(plain, book, "bench");
  let prev = GENESIS_HASH;
  const sawOwnWrite: boolean[] = [];
  const reads: number[] = [];
  for (let seq = 1; seq <= 100; seq += 1) {
    const input = entry(seq, prev, l.fence, 1_000);
    await plain.append(book, input);
    prev = input.hash;
    const r = await timed("read1", () => plain.readFrom(book, seq, 1));
    reads.push(r.ms);
    sawOwnWrite.push(r.value.entries[0]?.hash === input.hash);
  }
  const sizes: Record<string, unknown> = {};
  for (const limit of [1, 10, 100]) {
    const times: number[] = [];
    for (let i = 0; i < 40; i += 1)
      times.push((await timed(`readn-${limit}`, () => plain.readFrom(book, 1, limit))).ms);
    sizes[`${limit}_entries_1KB`] = stats(times);
  }
  emit("readback", {
    readYourWrite: sawOwnWrite.every(Boolean),
    singleRead: { client: stats(reads), server: serverSide("read1") },
    bulkRead: sizes,
  });
}

async function cold() {
  const warmAcq: number[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, tier, query] of [
    ["created_from_here", plain, ""],
    ["created_with_hint_enam", hinted, "hint=enam"],
  ] as const) {
    const firsts: number[] = [];
    const seconds: number[] = [];
    const colos: Record<string, number> = {};
    for (let i = 0; i < 30; i += 1) {
      const book = `${run}-cold-${name}-${i}`;
      firsts.push((await timed(`cold-${name}`, () => tier.acquire(book, "bench", 30_000))).ms);
      seconds.push((await timed(`cold2-${name}`, () => tier.head(book))).ms);
      if (i < 10) {
        const where = await raw(book, "where", {}, query);
        colos[where.json.colo ?? "?"] = (colos[where.json.colo ?? "?"] ?? 0) + 1;
      }
    }
    out[name] = {
      firstCall: stats(firsts),
      secondCall: stats(seconds),
      objectColos: colos,
      server: serverSide(`cold-${name}`),
    };
  }
  emit("cold", { ...out, warmAcquireForReference: warmAcq });
}

async function wake() {
  // Objects idle past the 10 s hibernation threshold, then touched again: what the next request costs.
  const books = Array.from({ length: 20 }, (_, i) => `${run}-wake-${i}`);
  await Promise.all(books.map((b) => plain.acquire(b, "bench", 5_000)));
  await Bun.sleep(25_000);
  const after25: number[] = [];
  for (const b of books.slice(0, 10)) after25.push((await timed("wake25", () => plain.head(b))).ms);
  await Bun.sleep(125_000);
  const after150: number[] = [];
  for (const b of books.slice(10)) after150.push((await timed("wake150", () => plain.head(b))).ms);
  const rows = serverSide("wake25");
  emit("wake", { after25s: stats(after25), after150s: stats(after150), rowsOnWake: rows });
}

async function seed() {
  // Create objects from this machine (a far-away first request), for `remote` to use from the cluster.
  const colos: Record<string, number> = {};
  for (let i = 0; i < 20; i += 1) {
    const book = `${run}-seed-${i}`;
    await plain.head(book);
    const where = await raw(book, "where", {});
    colos[where.json.colo ?? "?"] = (colos[where.json.colo ?? "?"] ?? 0) + 1;
  }
  emit("seed", { objects: 20, objectColos: colos });
}

async function remote() {
  const seedRun = process.env.SEED_RUN ?? "";
  if (!seedRun) throw new Error("SEED_RUN is required");
  const first: number[] = [];
  const appendTimes: number[] = [];
  const headTimes: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const book = `${seedRun}-seed-${i}`;
    const got = await timed("remote-acquire", () => plain.acquire(book, "bench", 60_000));
    first.push(got.ms);
    if (!got.value.ok) throw new Error("acquire refused");
    let prev = GENESIS_HASH;
    for (let seq = 1; seq <= 20; seq += 1) {
      const input = entry(seq, prev, got.value.lease.fence, 1_000);
      appendTimes.push((await timed("remote-append", () => plain.append(book, input))).ms);
      prev = input.hash;
    }
    headTimes.push((await timed("remote-head", () => plain.head(book))).ms);
  }
  emit("remote", { acquire: stats(first), append: stats(appendTimes), head: stats(headTimes) });
}

async function writer() {
  // Appends forever under a lease it keeps renewing, writing every acknowledged sequence to a file with a
  // synchronous write (so a kill cannot lose the line); with KILL_AFTER_MS it kills itself with SIGKILL, at
  // whatever instant that falls, which is nearly always inside a request.
  const book = process.env.BOOK ?? `${run}-kill`;
  const ackFile = process.env.ACK_FILE ?? "/tmp/acks.txt";
  const fd = openSync(ackFile, "a");
  const l = await lease(plain, book, "writer", 6_000);
  console.log(`LEASE fence=${l.fence}`);
  let prev = l.head.hash;
  let seq = l.head.seq;
  setInterval(() => {
    plain.renew(book, { holder: "writer", fence: l.fence }, 6_000).catch(() => {});
  }, 2_000);
  const killAfter = Number(process.env.KILL_AFTER_MS ?? "0");
  if (killAfter > 0) setTimeout(() => process.kill(process.pid, "SIGKILL"), killAfter);
  for (;;) {
    seq += 1;
    const input = entry(seq, prev, l.fence, 1_000);
    const result = await plain.append(book, input);
    if (!result.ok) {
      console.log(`REFUSED seq=${seq} reason=${result.reason}`);
      closeSync(fd);
      process.exit(3);
    }
    prev = input.hash;
    writeSync(fd, `${seq}\n`);
  }
}

async function killtest() {
  // A writer process is killed (SIGKILL) at a random instant, a new holder takes over once the lease lapses,
  // and nothing the writer was told is lost, the chain is intact, and the log goes on.
  const rounds = Number(process.env.ROUNDS ?? "10");
  const outcomes: unknown[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const book = `${run}-kill-${i}`;
    const ackFile = `/tmp/acks-${run}-${i}.txt`;
    const killAfter = 1_500 + Math.floor(Math.random() * 4_000);
    const child = Bun.spawn([process.execPath, process.argv[1] as string], {
      env: {
        ...process.env,
        PHASES: "writer",
        BOOK: book,
        ACK_FILE: ackFile,
        KILL_AFTER_MS: String(killAfter),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    let acked = 0;
    try {
      const lines = readFileSync(ackFile, "utf8").trim().split("\n");
      acked = Number(lines[lines.length - 1] ?? "0");
    } catch {
      acked = 0;
    }
    const started = performance.now();
    let tries = 0;
    let taken: Awaited<ReturnType<typeof lease>> | null = null;
    while (!taken) {
      tries += 1;
      const got = await plain.acquire(book, "taker", 30_000);
      if (got.ok) taken = got.lease;
      else await Bun.sleep(200);
    }
    const waitedMs = performance.now() - started;
    const page = await plain.readFrom(book, 1);
    let prev = GENESIS_HASH;
    let intact = true;
    for (const e of page.entries) {
      if (e.prevHash !== prev || e.hash !== hashOf(e.seq, e.prevHash)) intact = false;
      prev = e.hash;
    }
    const resumed = await plain.append(
      book,
      entry(taken.head.seq + 1, taken.head.hash, taken.fence, 1_000),
    );
    outcomes.push({
      round: i,
      killedAfterMs: killAfter,
      exitCode: child.exitCode,
      signal: child.signalCode,
      acknowledged: acked,
      headSeq: taken.head.seq,
      lostAcknowledged: Math.max(0, acked - taken.head.seq),
      unacknowledgedCommitted: taken.head.seq - acked,
      chainIntact: intact && page.entries.length === taken.head.seq,
      takeoverWaitedMs: round(waitedMs),
      tries,
      resumed: resumed.ok,
    });
  }
  const list = outcomes as {
    lostAcknowledged: number;
    unacknowledgedCommitted: number;
    chainIntact: boolean;
    resumed: boolean;
  }[];
  emit("killtest", {
    rounds,
    lostAcknowledged: list.reduce((a, o) => a + o.lostAcknowledged, 0),
    roundsWithAnUnacknowledgedCommit: list.filter((o) => o.unacknowledgedCommitted > 0).length,
    allChainsIntact: list.every((o) => o.chainIntact),
    allResumed: list.every((o) => o.resumed),
    outcomes,
  });
}

async function takeover() {
  const book = process.env.BOOK ?? "";
  const ackedMax = Number(process.env.ACKED_MAX ?? "0");
  if (!book) throw new Error("BOOK is required");
  const started = performance.now();
  let tries = 0;
  let lease2: Awaited<ReturnType<typeof lease>> | null = null;
  while (!lease2) {
    tries += 1;
    const got = await plain.acquire(book, "taker", 30_000);
    if (got.ok) lease2 = got.lease;
    else await Bun.sleep(250);
  }
  const waitedMs = performance.now() - started;
  const page = await plain.readFrom(book, 1);
  let prev = GENESIS_HASH;
  let intact = true;
  for (const e of page.entries) {
    if (e.prevHash !== prev || e.hash !== hashOf(e.seq, e.prevHash)) intact = false;
    prev = e.hash;
  }
  const headSeq = lease2.head.seq;
  const next = entry(headSeq + 1, lease2.head.hash, lease2.fence, 1_000);
  const resumed = await plain.append(book, next);
  emit("takeover", {
    waitedMs: round(waitedMs),
    acquireTries: tries,
    headSeq,
    ackedMax,
    acknowledgedAllPresent: headSeq >= ackedMax,
    unacknowledgedExtra: headSeq - ackedMax,
    chainIntact: intact && page.entries.length === headSeq,
    resumedAfterTakeover: resumed.ok,
  });
}

async function hop() {
  // Where the time goes between the pod and the object: a Worker alone, an empty call to the object over RPC,
  // the same over fetch, and a read.
  const book = `${run}-hop`;
  await raw(book, "echo", {});
  const out: Record<string, unknown> = {};
  const ping: number[] = [];
  for (let i = 0; i < 300; i += 1) {
    const started = performance.now();
    await (await fetch(`${url}/ping`)).text();
    ping.push(performance.now() - started);
  }
  out.workerOnly = stats(ping);
  for (const op of ["echo", "echof", "head"]) {
    const times: number[] = [];
    const tails: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const r = await raw(book, op, {});
      times.push(r.ms);
      if (r.meta.tailMs !== null) tails.push(r.meta.tailMs);
    }
    out[op] = { client: stats(times), workerToObject: stats(tails) };
  }
  emit("hop", out);
}

const table: Record<string, () => Promise<void>> = {
  hop,
  ping,
  head,
  append,
  concurrent,
  leases,
  contend,
  many,
  readback,
  cold,
  wake,
  seed,
  remote,
  writer,
  killtest,
  takeover,
};
for (const phase of phases) {
  const fn = table[phase];
  if (!fn) throw new Error(`unknown phase ${phase}`);
  const started = performance.now();
  try {
    await fn();
  } catch (error) {
    emit(phase, { error: error instanceof Error ? error.message : String(error) });
  }
  console.log(`DONE ${phase} in ${round((performance.now() - started) / 1000)} s`);
}
