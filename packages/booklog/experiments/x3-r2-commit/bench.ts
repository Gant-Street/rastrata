// X3 benchmark: R2 as the commit point, through a Worker with an R2 binding. TAIL_URL, TAIL_TOKEN, LABEL, RUN_ID.
const url = (process.env.TAIL_URL ?? "").replace(/\/+$/, "");
const token = process.env.TAIL_TOKEN ?? "";
const label = process.env.LABEL ?? "run";
const run = process.env.RUN_ID ?? `r${Date.now().toString(36)}`;
if (!url || !token) throw new Error("TAIL_URL and TAIL_TOKEN are required");

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

async function call(
  path: string,
  key: string,
  extra = "",
): Promise<{ ms: number; json: Record<string, unknown>; r2: number | null }> {
  const started = performance.now();
  const response = await fetch(`${url}${path}?key=${encodeURIComponent(key)}${extra}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as Record<string, unknown>;
  const ms = performance.now() - started;
  const timing = /r2;dur=(\d+)/.exec(response.headers.get("server-timing") ?? "");
  return { ms, json: body, r2: timing ? Number(timing[1]) : null };
}

const out: Record<string, unknown> = { label, run };
// Worker alone
const pings: number[] = [];
for (let i = 0; i < 201; i += 1) {
  const started = performance.now();
  await (await fetch(`${url}/ping`)).text();
  if (i > 0) pings.push(performance.now() - started);
}
out.workerOnly = stats(pings);

async function series(
  name: string,
  count: number,
  path: string,
  keyOf: (i: number) => string,
  extra = "",
) {
  const client: number[] = [];
  const inside: number[] = [];
  let odd = 0;
  for (let i = 0; i < count; i += 1) {
    const r = await call(path, keyOf(i), extra);
    client.push(r.ms);
    if (r.r2 !== null) inside.push(r.r2);
    if (path === "/put" && r.json.created !== true) odd += 1;
  }
  out[name] = { client: stats(client), insideWorker: stats(inside), unexpected: odd };
}

await series("put_2KiB_create_only", 200, "/put", (i) => `x3/${run}/a/${i}`, "&size=2048");
await series("put_64KiB_create_only", 100, "/put", (i) => `x3/${run}/b/${i}`, "&size=65536");
await series("head_existing", 200, "/head", (i) => `x3/${run}/a/${i % 200}`);
await series("get_2KiB", 200, "/get", (i) => `x3/${run}/a/${i % 200}`);
await series("head_missing", 100, "/head", (i) => `x3/${run}/missing/${i}`);

// A second create-only on a key that exists must be refused, every time.
let refused = 0;
for (let i = 0; i < 50; i += 1) {
  const r = await call("/put", `x3/${run}/a/${i}`, "&size=2048");
  if (r.json.created === false) refused += 1;
}
out.second_create_refused_of_50 = refused;

// Twenty writers at once, each its own key, to see whether the latency holds under parallel commits.
const conc: number[] = [];
const started = performance.now();
await Promise.all(
  Array.from({ length: 20 }, async (_, w) => {
    for (let i = 0; i < 25; i += 1)
      conc.push((await call("/put", `x3/${run}/c/${w}-${i}`, "&size=2048")).ms);
  }),
);
out.put_2KiB_20_writers = {
  client: stats(conc),
  perSecond: round(conc.length / ((performance.now() - started) / 1000)),
};

// Racing for one key: exactly one winner per round.
let rounds = 0;
let bad = 0;
for (let i = 0; i < 40; i += 1) {
  const key = `x3/${run}/race/${i}`;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => call("/put", key, "&size=512")),
  );
  rounds += 1;
  if (results.filter((r) => r.json.created === true).length !== 1) bad += 1;
}
out.race_5_writers_one_key = { rounds, roundsWithNotExactlyOneWinner: bad };

console.log(`RESULT ${JSON.stringify(out)}`);
