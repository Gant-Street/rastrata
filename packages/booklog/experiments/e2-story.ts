/** What serving a book from the log costs, measured on the application's own acceptance story: the
 * same seventeen tests, run on a book in a file and on a book in the log in several ways, interleaved
 * so that load on the machine falls on all of them alike. Reports wall time and CPU time (the CPU time
 * of the child process, which does not grow when the machine is busy), and where the extra goes.
 *
 *   bun experiments/e2-story.ts [--rounds 5] [--json out.json]
 *
 * Configurations:
 *   native        the story as the application runs it: a file, synchronous=FULL
 *   dormant       a book in the log with the change capture switched off: the wrapper alone (a held
 *                 transaction per write, the request and response copied, the lease), no entries
 *   as-landed     capture on; reads that write are logged before they are answered; slices make their
 *                 tables on first use
 *   prepared      as-landed with every slice's tables made when the book is opened
 *   final         prepared, and a read's effects are logged within two seconds or with the next write */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { machine, parseArgs, printTable, quantile } from "./lib.ts";

const root = resolve(import.meta.dir, "../../..");
const backend = resolve(import.meta.dir, "../test/support/acceptance-backend.ts");
const story = "packages/application/test/acceptance/first-month.test.ts";

interface Config {
  readonly name: string;
  readonly env: Record<string, string>;
}

const CONFIGS: readonly Config[] = [
  { name: "native", env: {} },
  {
    name: "dormant",
    env: {
      ACCEPTANCE_BACKEND: backend,
      ACCEPTANCE_CAPTURE: "off",
      ACCEPTANCE_READS: "log-first",
      ACCEPTANCE_PREPARE: "off",
    },
  },
  {
    name: "as-landed",
    env: { ACCEPTANCE_BACKEND: backend, ACCEPTANCE_READS: "log-first", ACCEPTANCE_PREPARE: "off" },
  },
  {
    name: "prepared",
    env: { ACCEPTANCE_BACKEND: backend, ACCEPTANCE_READS: "log-first", ACCEPTANCE_PREPARE: "on" },
  },
  {
    name: "final",
    env: { ACCEPTANCE_BACKEND: backend, ACCEPTANCE_READS: "defer", ACCEPTANCE_PREPARE: "on" },
  },
];

interface Run {
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly passed: boolean;
  readonly account: Account[];
}
interface Account {
  world: number;
  entries: { cause: string; bytes: number }[];
  restarts: { kind: string; closeMs: number; openMs: number }[];
  openMs: number;
  verifyMs: number;
  runtime: {
    work: number;
    peek: number;
    encode: number;
    append: number;
    commit: number;
    emptyWrites: number;
  };
  requests: Record<string, { reads: number; writes: number; ms: number }>;
}

async function run(config: Config, directory: string): Promise<Run> {
  const file = join(directory, `${config.name}-${Math.random().toString(36).slice(2)}.jsonl`);
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "test", "--timeout", "120000", story], {
    cwd: root,
    env: {
      ...process.env,
      ...config.env,
      ...(config.env.ACCEPTANCE_BACKEND ? { ACCEPTANCE_ACCOUNT_FILE: file } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const wallMs = performance.now() - started;
  const usage = child.resourceUsage();
  const cpuMs = usage
    ? (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000
    : Number.NaN;
  let account: Account[] = [];
  try {
    account = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Account);
  } catch {
    // native runs leave no accounting
  }
  return {
    wallMs,
    cpuMs,
    passed: /\b17 pass\b/.test(`${out}\n${err}`) && /\b0 fail\b/.test(`${out}\n${err}`),
    account,
  };
}

const median = (values: number[]): number =>
  quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );

async function main(): Promise<void> {
  const args = parseArgs();
  const rounds = args.number("rounds", 5);
  const directory = mkdtempSync(join(tmpdir(), "e2-story-"));
  const results = new Map<string, Run[]>();
  try {
    for (let round = 0; round < rounds; round += 1)
      for (const config of CONFIGS) {
        const result = await run(config, directory);
        if (!result.passed) throw new Error(`The story did not pass under ${config.name}`);
        const list = results.get(config.name) ?? [];
        list.push(result);
        results.set(config.name, list);
        console.error(
          `round ${round + 1} ${config.name}: ${result.wallMs.toFixed(0)} ms wall, ${result.cpuMs.toFixed(0)} ms cpu`,
        );
      }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const native = median((results.get("native") ?? []).map((item) => item.cpuMs));
  const nativeWall = median((results.get("native") ?? []).map((item) => item.wallMs));
  console.log(
    `\nThe acceptance story (17 tests, 2,891 assertions), ${rounds} rounds interleaved; machine: ${JSON.stringify(machine())}`,
  );
  printTable(
    [
      "configuration",
      "wall ms (median)",
      "cpu ms (median)",
      "cpu over native",
      "entries (all worlds)",
      "entries from reads",
    ],
    CONFIGS.map((config) => {
      const list = results.get(config.name) ?? [];
      const cpu = median(list.map((item) => item.cpuMs));
      const sample = list[0]?.account ?? [];
      const entries = sample.reduce((sum, world) => sum + world.entries.length, 0);
      const fromReads = sample.reduce(
        (sum, world) => sum + world.entries.filter((entry) => entry.cause === "read").length,
        0,
      );
      return [
        config.name,
        Math.round(median(list.map((item) => item.wallMs))),
        Math.round(cpu),
        config.name === "native"
          ? ""
          : `+${Math.round(cpu - native)} ms (${(((cpu - native) / native) * 100).toFixed(0)}%)`,
        config.name === "native" ? "" : entries,
        config.name === "native" ? "" : fromReads,
      ];
    }),
  );

  console.log(
    "\nWhere the log's time goes, per run of the story (median over rounds of the sum over the story's worlds)",
  );
  const rows: (string | number)[][] = [];
  for (const config of CONFIGS.slice(1)) {
    const list = results.get(config.name) ?? [];
    const sum = (pick: (world: Account) => number) =>
      median(list.map((item) => item.account.reduce((total, world) => total + pick(world), 0)));
    const restartMs = sum((world) =>
      world.restarts.reduce((total, restart) => total + restart.closeMs + restart.openMs, 0),
    );
    const coldMs = sum((world) =>
      world.restarts
        .filter((restart) => restart.kind === "cold")
        .reduce((total, restart) => total + restart.openMs, 0),
    );
    rows.push([
      config.name,
      Math.round(sum((world) => world.runtime.work)),
      Math.round(sum((world) => world.runtime.peek)),
      Math.round(sum((world) => world.runtime.encode)),
      Math.round(sum((world) => world.runtime.append)),
      Math.round(sum((world) => world.runtime.commit)),
      Math.round(sum((world) => world.openMs)),
      Math.round(restartMs),
      Math.round(coldMs),
      Math.round(sum((world) => world.verifyMs)),
    ]);
  }
  printTable(
    [
      "configuration",
      "write work ms",
      "peek ms",
      "encode ms",
      "tail append ms",
      "local commit ms",
      "opening ms",
      "restarts ms",
      "of which cold",
      "closing check ms (test only)",
    ],
    rows,
  );
  console.log(
    `\nnative wall median ${Math.round(nativeWall)} ms, cpu median ${Math.round(native)} ms`,
  );
  const json = args.string("json", "");
  if (json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      json,
      `${JSON.stringify({ rounds, machine: machine(), results: Object.fromEntries([...results].map(([name, list]) => [name, list.map(({ account, ...rest }) => ({ ...rest, worlds: account.length }))])) }, null, 2)}\n`,
    );
  }
}

await main();
