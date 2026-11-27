// Benchmark: what it costs to open a book that this process has never held, the cold activation a pod
// pays when a tenant's first request lands on it. A builder process makes a book of N journals through
// the bulk path and exits; then a FRESH process opens a copy of the file and reads it, and the driver
// reports the time and the peak resident memory of that process as the operating system measured it
// (`/usr/bin/time -l` on macOS, `/usr/bin/time -v` on Linux, which is why the Docker image installs it).
//
//   N=2000 bun bench/cold-load.ts                       one book, read with and without the snapshot attempt
//   N=5000 ACCOUNTS=100 REVISIONS=10 bun bench/cold-load.ts
//   bun bench/cold-load.ts sweep                         10, 500, 2,000, 5,000 and 20,000 journals,
//                                                        with a four-account chart and with a realistic
//                                                        one (100 accounts, 10 configuration revisions)
//   bun bench/cold-load.ts build <path>                  (the builder process; N, ACCOUNTS, REVISIONS)
//   bun bench/cold-load.ts read <path>                   (the fresh process; SNAPSHOTS=no, REPORT=yes)
//
// Every book is read two ways, because they cost very different amounts of memory:
//   with     the service as it ships. A cold read of a book between about 1,600 and 10,000 journals
//            makes ONE attempt to save an aggregate snapshot, which builds the whole encoding before the
//            kernel refuses it for being over its 16 MiB cap: 470 to 670 MB of transient memory.
//   without  `snapshots: false` on the local service (the hosted design keeps no aggregate snapshot: the
//            book's SQLite file in the object store is its snapshot). The read alone.
// The pre-registered threshold (a 5,000-journal book ready in 5 s and 1 GiB) is judged on "without".
//
// Environment: N (default 2000), ACCOUNTS (default 4), REVISIONS (default 0), SPREAD=yes (journals over
// the whole chart instead of cash against sales), SNAPSHOT=yes (the builder reads the book once before it
// closes, so a read snapshot is saved when the book fits under the kernel's 16 MiB cap: the "snapshot
// plus tail" path; only the "with" read restores it), MODES (with,without), REPORT=yes (the fresh process
// also compiles the first report, which builds the sorted view), REPEAT (fresh reads per book and mode,
// default 3), SWEEP (the journal counts of the sweep, comma separated), DIR (where the books go; default
// the system temp directory: in a container, keep it off a bind mount), KEEP=yes (leave the books),
// JSON=<file> (append one JSON line per measured read), REPLAY=trusted (the fresh process opens the book with
// `replay: "trusted"`: the stored revisions are applied, not executed again; see ReplayMode in src/service.ts), BEHIND=yes (the
// fresh process opens the book with `verifyBehind`, as a pod does: the first read applies the stored revisions and every outcome
// is executed again behind it, `checkMs` being the time the check takes after the first answer).
//
// What it measures is `LocalBookService.open` and the first `readAggregate`: the application reading
// the native ledger's outcomes and re-executing every one through the kernel (see bench/scale.ts for
// the same cost per journal). It is the cost of a hosted pod's materialize step once the book's file is
// on its disk; the download of that file is not in it. Each read starts from a fresh copy of the built
// file, because a read that fits a snapshot saves one when it closes and would change the next read.
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { arch, cpus, freemem, loadavg, platform, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { LocalBookService } from "../src/local.ts";
import { buildBook } from "./support/book.ts";

const mode = process.argv[2] ?? "run";
const yes = (name: string, fallback = "no") => (process.env[name] ?? fallback) === "yes";
const number = (name: string, fallback: number) => Number(process.env[name] ?? String(fallback));
const mb = (bytes: number) => bytes / 1048576;
const fixed = (value: number, places = 1) => value.toFixed(places);

/** What a fresh process on this machine is limited to by its container: memory and CPU, if capped. */
function containerLimits(): string {
  const first = (files: readonly string[]): string | null => {
    for (const file of files)
      try {
        return readFileSync(file, "utf8").trim();
      } catch {
        // Not this cgroup version.
      }
    return null;
  };
  const memory = first([
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]);
  const quota = first(["/sys/fs/cgroup/cpu.max"]);
  const memoryText =
    memory && /^[0-9]+$/.test(memory) && Number(memory) < 2 ** 50
      ? `${fixed(mb(Number(memory)), 0)} MiB`
      : "none";
  const [limit, period] = (quota ?? "max").split(" ");
  const cpuText =
    limit && limit !== "max" && period ? `${fixed(Number(limit) / Number(period), 2)} CPU` : "none";
  return `memory limit ${memoryText}, cpu limit ${cpuText}`;
}

if (mode === "build") {
  // The builder process: make the book, say how big it is, exit.
  const path = process.argv[3];
  if (!path) throw new Error("usage: cold-load.ts build <path>");
  const built = await buildBook({
    path,
    journals: number("N", 2000),
    accounts: number("ACCOUNTS", 4),
    revisions: number("REVISIONS", 0),
    spread: yes("SPREAD"),
    snapshot: yes("SNAPSHOT"),
  });
  const bytes =
    statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0);
  console.log(
    JSON.stringify({ kind: "build", ...built, bytes, rssMb: mb(process.memoryUsage.rss()) }),
  );
  process.exit(0);
}

if (mode === "read") {
  // The fresh process. `bootMs` is the time from the start of the process to here: the runtime and
  // the modules imported above.
  const path = process.argv[3];
  if (!path) throw new Error("usage: cold-load.ts read <path>");
  const bootMs = performance.now();
  let started = performance.now();
  // `snapshots: false` is the off switch for the aggregate snapshot (LocalOpenOptions, from the hoststore
  // lane): the hosted design keeps the book's SQLite file as its snapshot instead.
  const service = await LocalBookService.open(path, {
    safety: false,
    snapshots: process.env.SNAPSHOTS !== "no",
    replay: process.env.REPLAY === "trusted" ? "trusted" : "full",
    ...(yes("BEHIND") ? { verifyBehind: true } : {}),
  });
  const openMs = performance.now() - started;
  started = performance.now();
  const { aggregate } = await service.readAggregate();
  const readMs = performance.now() - started;
  const rssAfterRead = mb(process.memoryUsage.rss());
  let checkMs: number | null = null;
  if (yes("BEHIND")) {
    started = performance.now();
    await service.verification();
    checkMs = performance.now() - started;
  }
  let reportMs: number | null = null;
  if (yes("REPORT")) {
    started = performance.now();
    // biome-ignore lint/suspicious/noExplicitAny: bench reaches the report entry point
    await (service as any).reports(`${aggregate.state.periods.at(-1)?.endsOn ?? "2026-12-31"}`);
    reportMs = performance.now() - started;
  }
  const usage = process.resourceUsage();
  console.log(
    JSON.stringify({
      kind: "read",
      journals: aggregate.state.journals.length,
      bootMs,
      openMs,
      readMs,
      checkMs,
      reportMs,
      rssAfterReadMb: rssAfterRead,
      rssAfterMb: mb(process.memoryUsage.rss()),
      maxRssMb: usage.maxRSS / 1024,
      readStats: service.readStats,
    }),
  );
  service.close();
  process.exit(0);
}

// ---- the driver -------------------------------------------------------------------------------------------

interface Case {
  readonly journals: number;
  readonly accounts: number;
  readonly revisions: number;
  readonly snapshot: boolean;
}

type Snapshots = "with" | "without";

interface Measured {
  readonly wallSeconds: number | null;
  readonly peakRssMb: number | null;
  readonly userSeconds: number | null;
  readonly systemSeconds: number | null;
  readonly exit: number;
  readonly killed: boolean;
  readonly read: Record<string, unknown> | null;
}

const time = platform() === "darwin" ? ["/usr/bin/time", "-l"] : ["/usr/bin/time", "-v"];

/** Run a command under time(1) and parse what it reports; the command's own stdout is JSON. */
async function measured(args: readonly string[], env: Record<string, string>): Promise<Measured> {
  const child = Bun.spawn([...time, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let wall: number | null = null;
  let peak: number | null = null;
  let user: number | null = null;
  let system: number | null = null;
  if (platform() === "darwin") {
    // "        1.62 real         1.45 user         0.12 sys" and " 340459520  maximum resident set size"
    const times = /([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys/.exec(err);
    if (times) [wall, user, system] = [Number(times[1]), Number(times[2]), Number(times[3])];
    const resident = /([0-9]+)\s+maximum resident set size/.exec(err);
    if (resident) peak = mb(Number(resident[1]));
  } else {
    const elapsed =
      /Elapsed \(wall clock\) time \(h:mm:ss or m:ss\): (?:([0-9]+):)?([0-9]+):([0-9.]+)/.exec(err);
    if (elapsed)
      wall = Number(elapsed[1] ?? 0) * 3600 + Number(elapsed[2]) * 60 + Number(elapsed[3]);
    const userMatch = /User time \(seconds\): ([0-9.]+)/.exec(err);
    const systemMatch = /System time \(seconds\): ([0-9.]+)/.exec(err);
    if (userMatch) user = Number(userMatch[1]);
    if (systemMatch) system = Number(systemMatch[1]);
    const resident = /Maximum resident set size \(kbytes\): ([0-9]+)/.exec(err);
    if (resident) peak = Number(resident[1]) / 1024;
  }
  const line = out
    .trim()
    .split("\n")
    .reverse()
    .find((text) => text.startsWith("{"));
  const killed = /terminated by signal|Killed/.test(err) || exit === 137 || exit === 9;
  if (exit !== 0 && !killed) console.error(err.split("\n").slice(0, 12).join("\n"));
  return {
    wallSeconds: wall,
    peakRssMb: peak,
    userSeconds: user,
    systemSeconds: system,
    exit,
    killed,
    read: line ? (JSON.parse(line) as Record<string, unknown>) : null,
  };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const script = process.argv[1] ?? "bench/cold-load.ts";
const bun = process.execPath;
const root = process.env.DIR ?? tmpdir();
mkdirSync(root, { recursive: true });
const repeat = number("REPEAT", 3);
const jsonFile = process.env.JSON;
const modes = (process.env.MODES ?? "with,without").split(",") as Snapshots[];

const cases: Case[] =
  mode === "sweep"
    ? [
        ...(process.env.SWEEP ?? "10,500,2000,5000,20000")
          .split(",")
          .map(Number)
          .flatMap((journals) => [
            { journals, accounts: 4, revisions: 0, snapshot: false },
            ...(journals > 10 ? [{ journals, accounts: 100, revisions: 10, snapshot: false }] : []),
          ]),
        // The snapshot path: a book small enough to be encoded under the kernel's cap restores
        // instead of replaying.
        ...(yes("NO_SNAPSHOT_CASES")
          ? []
          : [{ journals: 500, accounts: 100, revisions: 10, snapshot: true }]),
      ]
    : [
        {
          journals: number("N", 2000),
          accounts: number("ACCOUNTS", 4),
          revisions: number("REVISIONS", 0),
          snapshot: yes("SNAPSHOT"),
        },
      ];

console.log(
  `# cold load: ${platform()} ${arch()}, ${cpus().length} cpus (${cpus()[0]?.model ?? "unknown"}), ` +
    `${fixed(mb(totalmem()), 0)} MiB memory (${fixed(mb(freemem()), 0)} MiB free), ${containerLimits()}, ` +
    `Bun ${Bun.version}, load average ${loadavg()
      .map((value) => value.toFixed(2))
      .join(" ")}`,
);
console.log(
  `| journals | chart | snapshot attempt | start | build s | file MB | open s | read s (min / median) | ms per journal | peak resident MB (max) | wall s | user + sys s |${yes("REPORT") ? " first report s (median) |" : ""}`,
);
console.log(
  `| ---: | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |${yes("REPORT") ? " ---: |" : ""}`,
);

for (const item of cases) {
  const directory = mkdtempSync(join(root, "rastrata-cold-"));
  const path = join(directory, "book.sqlite");
  const copy = join(directory, "read.sqlite");
  const env = {
    N: String(item.journals),
    ACCOUNTS: String(item.accounts),
    REVISIONS: String(item.revisions),
    SNAPSHOT: item.snapshot ? "yes" : "no",
  };
  const built = await measured([bun, script, "build", path], env);
  const info = built.read as { bytes?: number; milliseconds?: number } | null;
  const chart = `${item.accounts} acct, ${item.revisions} rev`;
  for (const snapshots of modes) {
    const reads: Measured[] = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true });
      copyFileSync(path, copy);
      reads.push(
        await measured([bun, script, "read", copy], {
          ...env,
          SNAPSHOTS: snapshots === "with" ? "yes" : "no",
        }),
      );
    }
    const good = reads.filter((run) => run.read && run.exit === 0);
    const stats = (
      good[0]?.read as
        | { readStats?: { snapshot: number; verified: number; trusted?: number } }
        | undefined
    )?.readStats;
    // "replay" re-executes every outcome from genesis; "snapshot" restores a saved state and
    // replays only the outcomes after it (the number in brackets is how many were re-executed).
    const start = stats
      ? stats.snapshot > 0
        ? `snapshot (+${stats.verified})`
        : (stats.trusted ?? 0) > 0
          ? `trusted (${stats.trusted}${stats.verified > 0 ? ` + ${stats.verified} executed` : ""})`
          : `replay (${stats.verified})`
      : "-";
    const prefix = `| ${item.journals} | ${chart} | ${snapshots === "with" ? "yes (as shipped)" : "no (off)"} | ${start} | ${fixed((info?.milliseconds ?? 0) / 1000)} | ${fixed(mb(info?.bytes ?? 0))} |`;
    if (good.length === 0) {
      const first = reads[0];
      console.log(
        `${prefix} - | ${first?.killed ? "killed (out of memory?)" : "failed"} | - | ${fixed(first?.peakRssMb ?? 0, 0)} | - | - |`,
      );
    } else {
      const readSeconds = good.map((run) => (run.read?.readMs as number) / 1000);
      const openSeconds = good.map((run) => (run.read?.openMs as number) / 1000);
      const peak = Math.max(...good.map((run) => run.peakRssMb ?? 0));
      const wall = median(good.map((run) => run.wallSeconds ?? Number.NaN));
      const cpu = median(good.map((run) => (run.userSeconds ?? 0) + (run.systemSeconds ?? 0)));
      const reportSeconds = good.flatMap((run) =>
        typeof run.read?.reportMs === "number" ? [run.read.reportMs / 1000] : [],
      );
      console.log(
        `${prefix} ${fixed(median(openSeconds), 2)} | ${fixed(Math.min(...readSeconds), 2)} / ${fixed(median(readSeconds), 2)} | ${fixed((median(readSeconds) * 1000) / item.journals, 2)} | ${fixed(peak, 0)} | ${fixed(wall, 2)} | ${fixed(cpu, 2)} |${yes("REPORT") ? ` ${fixed(median(reportSeconds), 2)} |` : ""}`,
      );
    }
    if (jsonFile)
      for (const run of reads)
        appendFileSync(
          jsonFile,
          `${JSON.stringify({ platform: platform(), arch: arch(), snapshots, case: item, build: info, ...run })}\n`,
        );
  }
  if (!yes("KEEP")) rmSync(directory, { recursive: true, force: true });
}
