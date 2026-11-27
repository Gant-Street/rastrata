import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CUTOVER,
  closingOf,
  type Corpus,
  type CorpusFile,
  generateCorpus,
  hostileFiles,
  type Month,
  MONTHS,
  openingOf,
  type SourceTruth,
  writeCorpus,
} from "@rastrata/application/testing/intake-corpus";

/** A scripted customer's agent: no model, only the public command line.
 *
 * It starts the real service on an empty book, writes a synthetic move-in folder, and then does what
 * a careful agent does with the intake surface: scan the folder, set the book up, plan, write a
 * recipe for every layout that needs one, prove it against the balances each statement prints, plan
 * again, start the books from the trial balance, import every statement month, post the lines, and
 * reconcile every month to its statement at 0.00. Along the way it seeds the faults the gates exist
 * for and checks that each is caught. It prints a table of what passed.
 *
 * The recipes come from the corpus's answer key, because the script is the agent; the gates do not
 * trust them: a recipe is accepted only because the arithmetic of a real statement says so. */

// biome-ignore lint/suspicious/noExplicitAny: the harness reads JSON of many shapes
type Json = any;

export interface Row {
  readonly section: string;
  readonly check: string;
  readonly pass: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface HarnessOptions {
  readonly seed?: number;
  readonly keep?: boolean;
  readonly log?: (line: string) => void;
}

export interface HarnessResult {
  readonly rows: readonly Row[];
  readonly directory: string;
  readonly corpus: Corpus;
}

const root = resolve(import.meta.dir, "../../../..");
const terminal = resolve(root, "apps/terminal");

function goBinary(): string {
  if (process.env.GO_BIN) return process.env.GO_BIN;
  const local = join(homedir(), ".local/go/bin/go");
  return existsSync(local) ? local : "go";
}

const cents = (value: bigint): string => {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

class Failure extends Error {}
function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failure(message);
}

const monthEnd = (month: string): string => {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, "0")}`;
};

/** Every string in a JSON value, to check that none carries a control or direction character. */
function* strings(value: Json): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) yield* strings(item);
}
// A lone tab is the tab delimiter, a closed-set value, not text from a file.
const unsafe = (text: string): boolean =>
  text !== "\t" &&
  [...text].some((symbol) => {
    const point = symbol.codePointAt(0) as number;
    return (
      point < 0x20 ||
      (point >= 0x7f && point <= 0x9f) ||
      (point >= 0x200b && point <= 0x200f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069)
    );
  });

export async function runHarness(options: HarnessOptions = {}): Promise<HarnessResult> {
  const log = options.log ?? (() => {});
  const directory = mkdtempSync(join(tmpdir(), "rastrata-intake-harness-"));
  const binary = join(directory, "rastrata");
  const folder = join(directory, "move-in");
  const work = join(directory, "work");
  mkdirSync(work, { recursive: true });
  const corpus = generateCorpus(options.seed === undefined ? {} : { seed: options.seed });
  const rows: Row[] = [];

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop();
  const endpoint = `http://127.0.0.1:${port}`;
  let server: ReturnType<typeof Bun.spawn> | undefined;

  async function cli(
    args: readonly string[],
    extra: { stdin?: string; env?: Record<string, string> } = {},
  ): Promise<{ out: string; err: string; exit: number; json: Json }> {
    const run = Bun.spawn(
      [binary, ...args, "--endpoint", endpoint, "--request-dir", join(directory, "requests")],
      {
        stdin: extra.stdin === undefined ? "ignore" : new TextEncoder().encode(extra.stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(extra.env ?? {}) },
      },
    );
    const [out, err, exit] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    let json: Json = null;
    try {
      json = out.trim() ? JSON.parse(out) : null;
    } catch {
      json = null;
    }
    return { out, err, exit, json };
  }

  async function check(section: string, name: string, body: () => Promise<unknown>) {
    const started = performance.now();
    try {
      const result = await body();
      const detail = typeof result === "string" ? result : "";
      rows.push({ section, check: name, pass: true, detail, ms: performance.now() - started });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      rows.push({
        section,
        check: name,
        pass: false,
        detail: detail.slice(0, 600),
        ms: performance.now() - started,
      });
    }
    const last = rows[rows.length - 1] as Row;
    log(
      `${last.pass ? "pass" : "FAIL"}  ${section}  ${name}${last.pass ? "" : `  ${last.detail}`}`,
    );
  }

  try {
    // ---- Start the real service ------------------------------------------------------------
    const build = Bun.spawn([goBinary(), "build", "-o", binary, "./cmd/rastrata"], {
      cwd: terminal,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await build.exited) !== 0)
      throw new Failure(`go build failed: ${await new Response(build.stderr).text()}`);
    server = Bun.spawn([process.execPath, "apps/api/src/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        RASTRATA_LOCAL_DEV: "1",
        RASTRATA_API_PORT: String(port),
        RASTRATA_LOCAL_DB: join(directory, "book.sqlite"),
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    let up = false;
    for (let attempt = 0; attempt < 200 && !up; attempt++) {
      try {
        up = (await fetch(`${endpoint}/health`)).ok;
      } catch {}
      if (!up) await Bun.sleep(50);
    }
    if (!up) throw new Failure("the service did not start");

    // ---- The customer's folder -------------------------------------------------------------
    const everything: CorpusFile[] = [...corpus.files, ...hostileFiles()];
    writeCorpus(folder, { ...corpus, files: everything });
    const outside = join(directory, "outside-the-folder.csv");
    writeFileSync(outside, "Date,Amount\n2026-05-01,1.00\n");
    let linked = true;
    try {
      symlinkSync(outside, join(folder, "leak.csv"));
    } catch {
      linked = false;
    }
    const byCode = new Map(corpus.sources.map((source) => [source.code, source]));
    const pathOf = (source: SourceTruth, month: Month): string =>
      (
        corpus.files.find(
          (file) => file.source === source.code && file.month === month,
        ) as CorpusFile
      ).path;
    const file = (path: string): string => join(folder, path);
    const sourceFiles = corpus.files.filter((item) => item.source !== undefined);

    // ---- 1. The book -----------------------------------------------------------------------
    await check("book", "the book is set up with the customer's accounts", async () => {
      const result = await cli(["book", "setup", "--input", "-"], {
        stdin: JSON.stringify(corpus.book),
      });
      must(result.exit === 0, `exit ${result.exit}: ${result.out.slice(0, 300)}`);
    });
    const accounts = await cli(["accounts", "list"]);
    const chart = new Map<string, Json>(
      (accounts.json?.data?.accounts ?? []).map((item: Json) => [item.code, item]),
    );
    const sales = chart.get("4000")?.id as string;
    const expenses = chart.get("5000")?.id as string;
    await check("book", "the cutover is recorded and given to the statement sources", async () => {
      const ids = corpus.sources.map((source) => chart.get(source.code)?.id).join(",");
      const result = await cli(["cutover", "set", "--date", CUTOVER, "--accounts", ids]);
      must(result.exit === 0, `exit ${result.exit}: ${result.out.slice(0, 300)}`);
    });

    // ---- 2. Scan ---------------------------------------------------------------------------
    let scanned: Json = null;
    const idOf = new Map<string, string>();
    const factsOf = new Map<string, Json>();
    await check(
      "scan",
      `the folder is read: ${everything.length} files typed by their content`,
      async () => {
        const result = await cli(["intake", "scan", folder]);
        must(result.exit === 0, `exit ${result.exit}: ${result.err.slice(0, 300)}`);
        scanned = result.json.data;
        for (const item of scanned.files as Json[]) {
          factsOf.set(item.sha256, item);
          for (const path of item.paths as string[]) idOf.set(path, item.sha256);
        }
        const wrong: string[] = [];
        for (const item of everything) {
          const found = factsOf.get(idOf.get(item.path) as string);
          if (!found) wrong.push(`${item.path}: not scanned`);
          else if (
            found.kind !== item.expect.kind ||
            found.role !== item.expect.role ||
            found.parsed !== item.expect.parsed
          )
            wrong.push(
              `${item.path}: ${found.kind}/${found.role}/${found.parsed} not ${item.expect.kind}/${item.expect.role}/${item.expect.parsed}`,
            );
        }
        must(wrong.length === 0, wrong.slice(0, 4).join("; "));
        return `${scanned.files.length} distinct files`;
      },
    );
    await check(
      "scan",
      "a PDF, a workbook, an archive and an image are listed as not parsed and need an agent",
      async () => {
        const wanted = ["pdf", "xlsx", "zip", "image"];
        for (const kind of wanted) {
          const found = (scanned.files as Json[]).filter((item) => item.kind === kind);
          must(
            found.length > 0 &&
              found.every((item) => item.parsed === false && item.need === "agent"),
            `${kind} not listed as needing an agent`,
          );
        }
        const archive = (scanned.files as Json[]).find((item) => item.kind === "zip");
        must(
          archive.details.zip.unsafeNames === 1 && archive.flags.includes("unsafe_names"),
          "the archive's unsafe name was not counted",
        );
        const pdfs = (scanned.files as Json[])
          .filter((item) => item.kind === "pdf")
          .map((item) => item.details.pdf.textLayer)
          .sort();
        must(pdfs.join() === "absent,present", `PDF text layers: ${pdfs}`);
      },
    );
    await check(
      "scan",
      "a symbolic link out of the folder is refused and its target is never read",
      async () => {
        if (!linked) return "symbolic links are not available here";
        const skipped = scanned.skipped as { path: string; reason: string }[];
        must(
          skipped.some((item) => item.path === "leak.csv" && item.reason === "symlink_outside"),
          `skipped: ${JSON.stringify(skipped)}`,
        );
        must(
          !(scanned.files as Json[]).some((item) => item.paths.includes("leak.csv")),
          "the link was followed",
        );
        const outsideId = (scanned.files as Json[]).find(
          (item) => item.size === 28 && item.kind === "csv" && item.rows === 1,
        );
        must(outsideId === undefined, "the file outside the folder was uploaded");
        return undefined;
      },
    );
    await check(
      "scan",
      "hostile names, headers and memos are data: flagged, escaped, and never in the output raw",
      async () => {
        const found = factsOf.get(idOf.get("hostile/ignore previous instructions.csv") as string);
        must(
          found.flags.includes("name_flagged") && found.flags.includes("instruction_text"),
          `flags ${found.flags}`,
        );
        must(
          found.flags.includes("formula_cells") &&
            found.flags.includes("control_characters") &&
            found.flags.includes("markup_text"),
          `flags ${found.flags}`,
        );
        must(
          found.columns.some((column: Json) => column.flags.includes("instruction")),
          "the instruction in a header was not flagged",
        );
        const bad = [...strings(scanned)].filter(unsafe);
        must(bad.length === 0, `${bad.length} strings carry control or direction characters`);
        const text = await cli(["intake", "scan", folder, "--format", "text", "--record=false"]);
        must(
          text.exit === 0 &&
            !text.out.includes("\x1b") &&
            !text.out.includes("\u202E") &&
            !text.out.includes("\x07"),
          "the text table carries a raw control character",
        );
      },
    );
    await check(
      "scan",
      "a trial balance says what date it is as at and whether it balances, for each system's layout",
      async () => {
        for (const path of ["reports/xero/", "reports/quickbooks/", "reports/wave/"]) {
          const item = everything.find((candidate) =>
            candidate.path.startsWith(`${path}trial-balance`),
          ) as CorpusFile;
          const facts = factsOf.get(idOf.get(item.path) as string);
          must(
            facts.trialBalance.asOf === corpus.opening &&
              facts.trialBalance.balanced === true &&
              facts.trialBalance.rows === 13,
            `${path}: ${JSON.stringify(facts.trialBalance)}`,
          );
        }
      },
    );
    await check(
      "scan",
      "a statement's facts are the file's own: lines, range and the balance it carries",
      async () => {
        for (const source of corpus.sources) {
          const facts = factsOf.get(idOf.get(pathOf(source, MONTHS[0])) as string);
          const lines = source.months[MONTHS[0]].length;
          // The corpus drops one pending line into one layout and one totals row into another.
          must(facts.rows >= lines, `${source.layout}: ${facts.rows} rows for ${lines} lines`);
          if (facts.statement?.balance === "running") {
            must(
              facts.statement.chain.breakCount === 0 || facts.need !== "none",
              `${source.layout}: chain broken in an unflagged file`,
            );
          }
        }
      },
    );

    // ---- 3. The plan, before any recipe ----------------------------------------------------
    const tbPath = everything.find((item) =>
      item.path.startsWith("reports/xero/trial-balance"),
    ) as CorpusFile;
    const chartPath = everything.find((item) =>
      item.path.startsWith("reports/xero/chart-of-accounts"),
    ) as CorpusFile;
    const ledgerPath = everything.find((item) =>
      item.path.startsWith("reports/quickbooks/general-ledger"),
    ) as CorpusFile;
    const payoutPath = everything.find((item) =>
      item.path.startsWith("sales/stripe-payouts"),
    ) as CorpusFile;
    const idFor = (path: string): string => idOf.get(path) as string;
    const balancesFor = (omitKnown: boolean): Json[] => {
      const out: Json[] = [];
      for (const source of corpus.sources)
        for (const month of MONTHS) {
          const id = idFor(pathOf(source, month));
          const facts = factsOf.get(id);
          if (omitKnown && facts?.statement?.balance !== "none") continue;
          out.push({
            file: id,
            opening: cents(openingOf(source, month)),
            ending: cents(closingOf(source, month)),
          });
        }
      return out;
    };
    const pick = (prefix: string): string => {
      const found = everything.find((item) => item.path.startsWith(prefix));
      if (!found) throw new Failure(`the corpus has no file under ${prefix}`);
      return idFor(found.path);
    };
    const ignored = [
      ...everything
        .filter((item) => item.path.startsWith("hostile/") || item.path.startsWith("misc/"))
        .map((item) => idFor(item.path)),
      pick("reports/quickbooks/trial-balance"),
      pick("reports/wave/trial-balance"),
      pick("reports/quickbooks/account-list"),
      pick("reports/wave/chart-of-accounts"),
      pick("reports/xero/account-transactions"),
      pick("sales/invoices"),
    ];
    const needHuman = sourceFiles
      .filter((item) => factsOf.get(idFor(item.path))?.need === "human")
      .map((item) => idFor(item.path));
    const planInput = (change: (input: Json) => void = () => {}): Json => {
      const input: Json = {
        cutoverDate: corpus.cutover,
        through: corpus.through,
        sources: corpus.sources.map((source) => ({
          account: source.code,
          files: MONTHS.map((month) => idFor(pathOf(source, month))),
        })),
        files: [...factsOf.keys()],
        trialBalance: idFor(tbPath.path),
        chart: idFor(chartPath.path),
        generalLedger: idFor(ledgerPath.path),
        payoutReports: [idFor(payoutPath.path)],
        balances: balancesFor(true),
        skipInvalidRows: needHuman,
        ignore: ignored,
      };
      change(input);
      return input;
    };
    const plan = async (
      input: Json,
      flags: string[] = [],
      record = false,
    ): Promise<{ exit: number; data: Json }> => {
      const result = await cli(
        ["intake", "plan", "--input", "-", ...(record ? [] : ["--record=false"]), ...flags],
        { stdin: JSON.stringify(input) },
      );
      return { exit: result.exit, data: result.json?.data };
    };
    const needRecipe = sourceFiles.filter(
      (item) => factsOf.get(idFor(item.path))?.need === "recipe",
    );
    await check(
      "plan",
      "before any recipe the plan is not ready and names each file that needs one",
      async () => {
        const { exit, data } = await plan(planInput(), ["--check=true"], true);
        must(exit === 3 && data.ready === false, `exit ${exit}, ready ${data?.ready}`);
        const asked = new Set(
          data.items
            .filter(
              (item: Json) =>
                item.code === "statement_readable" &&
                item.status === "uncertain" &&
                item.next?.command?.includes("intake recipe test"),
            )
            .map((item: Json) => item.file),
        );
        must(
          asked.size === needRecipe.length,
          `${asked.size} files asked for a recipe, ${needRecipe.length} need one`,
        );
        must(data.counts.present > 20, `present ${data.counts.present}`);
        return `${needRecipe.length} files need a recipe`;
      },
    );

    // ---- 4. Recipes ------------------------------------------------------------------------
    const recipeFile = new Map<string, string>();
    for (const source of corpus.sources) {
      if (!source.recipe) continue;
      const path = join(work, `${source.layout}.recipe.json`);
      writeFileSync(path, JSON.stringify(source.recipe));
      recipeFile.set(source.code, path);
    }
    const proofFlags = (source: SourceTruth, month: Month): string[] => [
      "--opening-balance",
      cents(openingOf(source, month)),
      "--ending-balance",
      cents(closingOf(source, month)),
      // A statement whose dates every read both ways is settled by the period it prints. The scan says
      // which files are so, whatever layout they have: a month in which every day happens to be
      // twelve or less is ambiguous too.
      ...(source.ambiguousDates ||
      factsOf.get(idFor(pathOf(source, month)))?.dateOrder === "ambiguous"
        ? ["--period-from", `${month}-01`, "--period-to", monthEnd(month)]
        : []),
      ...(source.layout === "tamarack-checking" ? ["--skip-invalid-rows=true"] : []),
    ];
    for (const source of corpus.sources) {
      await check(
        "recipe",
        `${source.layout}: ${source.recipe ? "the recipe is proven on three statements and saved" : "no recipe needed, three statements proven"}`,
        async () => {
          const proven: string[] = [];
          for (const month of MONTHS) {
            const path = file(pathOf(source, month));
            const args = source.recipe
              ? [
                  "intake",
                  "recipe",
                  "test",
                  recipeFile.get(source.code) as string,
                  path,
                  "--account",
                  source.code,
                ]
              : ["intake", "verify", path, "--account", source.code];
            const result = await cli([...args, ...proofFlags(source, month)]);
            const data = result.json?.data;
            must(
              result.exit === 0 && data?.valid && data?.verified,
              `${month}: exit ${result.exit}; ${data?.verification?.detail ?? result.out.slice(0, 200)}`,
            );
            proven.push(data.verification.method);
          }
          if (source.recipe) {
            const saved = await cli([
              "intake",
              "recipe",
              "save",
              recipeFile.get(source.code) as string,
              file(pathOf(source, MONTHS[0])),
              "--account",
              source.code,
              ...proofFlags(source, MONTHS[0]),
            ]);
            must(
              saved.exit === 0 && saved.json?.data?.revision >= 1,
              `save: exit ${saved.exit}: ${saved.out.slice(0, 300)}`,
            );
          }
          return [...new Set(proven)].join(", ");
        },
      );
    }

    // ---- 5. The plan, with the recipes saved -----------------------------------------------
    await check(
      "plan",
      "with the recipes saved, every file reads, every balance is proven, and the plan is ready",
      async () => {
        const { exit, data } = await plan(planInput(), ["--check=true"], true);
        const gaps =
          data?.items?.filter((item: Json) => item.status !== "present" && item.required) ?? [];
        must(
          exit === 0 && data.ready === true,
          `exit ${exit}; ${gaps
            .slice(0, 3)
            .map((item: Json) => `${item.code} ${item.account ?? ""} ${item.detail}`)
            .join(" | ")}`,
        );
        const agreeing = data.items.filter(
          (item: Json) => item.code === "trial_balance_statements" && item.status === "present",
        ).length;
        must(agreeing === 12, `${agreeing} accounts agree with the trial balance`);
        return `${data.counts.present} present, ${data.counts.missing} missing, ${data.counts.uncertain} uncertain`;
      },
    );

    // ---- 6. Faults: each gate catches the fault it is for ----------------------------------
    const juniper = byCode.get("2010") as SourceTruth;
    const tamarackCard = byCode.get("2030") as SourceTruth;
    const quill = byCode.get("1030") as SourceTruth;
    const harbor = byCode.get("1010") as SourceTruth;
    const variant = (source: SourceTruth, name: string, change: (recipe: Json) => void): string => {
      const recipe = JSON.parse(JSON.stringify(source.recipe));
      change(recipe);
      const path = join(work, `${source.layout}.${name}.recipe.json`);
      writeFileSync(path, JSON.stringify(recipe));
      return path;
    };
    const gateOf = (data: Json, name: string): Json =>
      data.gates.find((gate: Json) => gate.gate === name);
    const fault = async (name: string, body: () => Promise<unknown>) => check("gates", name, body);

    await fault(
      "wrong sign convention: a card read without the issuer's flip fails on the signs and the ending balance",
      async () => {
        const recipe = variant(juniper, "unflipped", (r) => {
          r.mapping.amount.invert = false;
        });
        const result = await cli([
          "intake",
          "recipe",
          "test",
          recipe,
          file(pathOf(juniper, MONTHS[0])),
          ...proofFlags(juniper, MONTHS[0]),
          "--record=false",
        ]);
        must(result.exit === 3 && result.json.data.valid === false, `exit ${result.exit}`);
        must(
          gateOf(result.json.data, "sign_convention").status === "fail" &&
            gateOf(result.json.data, "ending_balance").status === "fail",
          "the sign and the ending balance should both fail",
        );
        must(
          gateOf(result.json.data, "sign_convention").detail.includes("reversed"),
          "the gate should say the signs look reversed",
        );
      },
    );
    await fault(
      "D/M against M/D: an ambiguous column is refused until it is stated, and the wrong order is caught by the period",
      async () => {
        const auto = variant(tamarackCard, "auto", (r) => {
          r.mapping.dateOrder = "auto";
        });
        const first = await cli([
          "intake",
          "recipe",
          "test",
          auto,
          file(pathOf(tamarackCard, MONTHS[0])),
          ...proofFlags(tamarackCard, MONTHS[0]),
          "--record=false",
        ]);
        must(
          first.exit === 3 && gateOf(first.json.data, "date_order").status === "fail",
          "an unstated order should fail",
        );
        const wrong = variant(tamarackCard, "mdy", (r) => {
          r.mapping.dateOrder = "mdy";
        });
        const second = await cli([
          "intake",
          "recipe",
          "test",
          wrong,
          file(pathOf(tamarackCard, MONTHS[0])),
          ...proofFlags(tamarackCard, MONTHS[0]),
          "--record=false",
        ]);
        must(
          second.exit === 3 && gateOf(second.json.data, "date_period").status === "fail",
          "the wrong order should fall outside the period",
        );
        must(
          gateOf(second.json.data, "ending_balance").status === "pass",
          "the sums cannot tell the order, so the ending balance still passes",
        );
        // The right order with no period is only a claim: not proven.
        const claim = await cli([
          "intake",
          "recipe",
          "test",
          recipeFile.get("2030") as string,
          file(pathOf(tamarackCard, MONTHS[0])),
          "--opening-balance",
          cents(openingOf(tamarackCard, MONTHS[0])),
          "--ending-balance",
          cents(closingOf(tamarackCard, MONTHS[0])),
          "--record=false",
        ]);
        must(
          claim.exit === 0 && claim.json.data.verified === false,
          "a date order that only the data's silence supports must not count as proven",
        );
      },
    );
    await fault("a missing month: the plan names the account and the month", async () => {
      const { data } = await plan(
        planInput((input) => {
          input.sources[0].files.splice(1, 1);
        }),
        ["--gaps-only=true"],
      );
      const found = data.items.find(
        (item: Json) => item.code === "statement_coverage" && item.status === "missing",
      );
      must(
        found && found.account === "1010" && found.month === MONTHS[1] && found.gate === "coverage",
        JSON.stringify(found),
      );
      must(data.ready === false, "the plan should not be ready");
    });
    await fault(
      "a missing line: the running balance breaks, or the sums miss the statement by the line",
      async () => {
        const text = (await Bun.file(file(pathOf(harbor, MONTHS[0]))).text()).split("\n");
        text.splice(3, 1);
        const cut = join(work, "harbor-cut.csv");
        writeFileSync(cut, text.join("\n"));
        const result = await cli([
          "intake",
          "recipe",
          "test",
          recipeFile.get("1010") as string,
          cut,
          ...proofFlags(harbor, MONTHS[0]),
          "--record=false",
        ]);
        must(
          result.exit === 3 && gateOf(result.json.data, "balance_chain").status === "fail",
          `exit ${result.exit}`,
        );
        const card = (await Bun.file(file(pathOf(juniper, MONTHS[0]))).text()).split("\n");
        card.splice(2, 1);
        const cutCard = join(work, "juniper-cut.csv");
        writeFileSync(cutCard, card.join("\n"));
        const second = await cli([
          "intake",
          "recipe",
          "test",
          recipeFile.get("2010") as string,
          cutCard,
          ...proofFlags(juniper, MONTHS[0]),
          "--record=false",
        ]);
        must(
          second.exit === 3 &&
            gateOf(second.json.data, "ending_balance").status === "fail" &&
            second.json.data.verification.difference !== undefined,
          "the sums should miss by the missing line",
        );
      },
    );
    await fault(
      "a duplicate file: the plan notices a file listed twice, and importing it again adds nothing (see imports)",
      async () => {
        const { data } = await plan(
          planInput((input) => {
            input.sources[0].files.push(input.sources[0].files[0]);
          }),
          ["--gaps-only=true"],
        );
        must(
          data.items.some(
            (item: Json) => item.code === "duplicate_file" && item.gate === "duplicate_file",
          ),
          "a file listed twice was not noticed",
        );
      },
    );
    await fault(
      "a trial balance that does not tie, and one not as at the day before the cutover, are not relied on",
      async () => {
        const bad = join(directory, "tb-bad");
        mkdirSync(bad, { recursive: true });
        const clean = await Bun.file(file(tbPath.path)).text();
        writeFileSync(join(bad, "untied.csv"), clean.replace("12000.00", "12000.01"));
        writeFileSync(join(bad, "late.csv"), clean.replace(/As at [^\n]*/, "As at 31 May 2026"));
        const scan = await cli(["intake", "scan", bad, "--record=false"]);
        must(scan.exit === 0, `scan exit ${scan.exit}`);
        const byName = (name: string) =>
          (scan.json.data.files as Json[]).find((item) => item.paths.includes(name)) as Json;
        must(
          byName("untied.csv").trialBalance.balanced === false,
          "the untied trial balance was said to balance",
        );
        const untied = await plan(
          planInput((input) => {
            input.trialBalance = byName("untied.csv").sha256;
            input.files.push(input.trialBalance);
          }),
          ["--gaps-only=true"],
        );
        must(
          untied.data.items.some(
            (item: Json) => item.code === "trial_balance_ties" && item.status === "uncertain",
          ),
          "the plan did not doubt the trial balance",
        );
        const late = await plan(
          planInput((input) => {
            input.trialBalance = byName("late.csv").sha256;
            input.files.push(input.trialBalance);
          }),
          ["--gaps-only=true"],
        );
        must(
          late.data.items.some(
            (item: Json) => item.code === "trial_balance_date" && item.status === "uncertain",
          ),
          "the plan accepted a trial balance as at another date",
        );
      },
    );
    await fault(
      "a byte-order mark is read past and reported, and an encoding the recipe gets wrong is refused",
      async () => {
        const facts = factsOf.get(idFor(pathOf(quill, MONTHS[0])));
        must(facts.flags.includes("bom") && facts.encoding === "utf-8", `flags ${facts.flags}`);
        const wrong = variant(quill, "latin", (r) => {
          r.encoding = "windows-1252";
        });
        const result = await cli([
          "intake",
          "recipe",
          "test",
          wrong,
          file(pathOf(quill, MONTHS[0])),
          ...proofFlags(quill, MONTHS[0]),
          "--record=false",
        ]);
        must(
          result.exit === 3 && gateOf(result.json.data, "encoding").status === "fail",
          `exit ${result.exit}`,
        );
      },
    );
    await fault(
      "a pending line: a recipe that would import it fails; the one that leaves it out passes",
      async () => {
        const none = variant(quill, "nofilter", (r) => {
          delete r.mapping.include;
        });
        const result = await cli([
          "intake",
          "recipe",
          "test",
          none,
          file(pathOf(quill, MONTHS[0])),
          ...proofFlags(quill, MONTHS[0]),
          "--record=false",
        ]);
        must(
          result.exit === 3 && gateOf(result.json.data, "pending_rows").status === "fail",
          `exit ${result.exit}`,
        );
        const facts = factsOf.get(idFor(pathOf(quill, MONTHS[0])));
        must(facts.flags.includes("pending_rows"), "the scan did not flag the pending line");
      },
    );
    await fault(
      "a memo over several lines: kept in quotes it is one row; split outside quotes it is caught",
      async () => {
        const facts = factsOf.get(idFor(pathOf(quill, MONTHS[0])));
        must(
          facts.flags.includes("multiline_cells"),
          "the scan did not notice the multi-line memos",
        );
        const text = (await Bun.file(file(pathOf(quill, MONTHS[0]))).text()).replace(/^\uFEFF/, "");
        const broken = text.replace(/"([^"\r\n]*)\r?\n([^"\r\n]*)"/g, "$1\r\n$2");
        must(broken !== text, "the fixture has no multi-line memo");
        const path = join(work, "quill-broken.csv");
        writeFileSync(path, `\uFEFF${broken}`);
        const result = await cli([
          "intake",
          "recipe",
          "test",
          recipeFile.get("1030") as string,
          path,
          ...proofFlags(quill, MONTHS[0]),
          "--record=false",
        ]);
        must(
          result.exit === 3 && gateOf(result.json.data, "multiline_memo").status === "fail",
          `exit ${result.exit}`,
        );
      },
    );
    await fault(
      "an ending balance that does not match fails by the difference, and is never adjusted",
      async () => {
        const result = await cli([
          "intake",
          "recipe",
          "test",
          recipeFile.get("1010") as string,
          file(pathOf(harbor, MONTHS[0])),
          "--opening-balance",
          cents(openingOf(harbor, MONTHS[0])),
          "--ending-balance",
          cents(closingOf(harbor, MONTHS[0]) + 1n),
          "--record=false",
        ]);
        must(
          result.exit === 3 && gateOf(result.json.data, "ending_balance").status === "fail",
          `exit ${result.exit}`,
        );
        must(
          gateOf(result.json.data, "ending_balance").detail.includes("Never adjust a balance"),
          "the gate should refuse to adjust",
        );
        const saved = await cli([
          "intake",
          "recipe",
          "save",
          recipeFile.get("1010") as string,
          file(pathOf(harbor, MONTHS[0])),
          "--opening-balance",
          cents(openingOf(harbor, MONTHS[0])),
          "--ending-balance",
          cents(closingOf(harbor, MONTHS[0]) + 1n),
          "--record=false",
        ]);
        must(
          saved.exit !== 0 && saved.json.error.code === "recipe_unproven",
          `a recipe was saved on a wrong balance: exit ${saved.exit}`,
        );
      },
    );
    await fault(
      "hostile text in a memo is flagged and counted by the proof, and nothing in the report is raw",
      async () => {
        const result = await cli([
          "intake",
          "verify",
          file("hostile/ignore previous instructions.csv"),
          "--record=false",
        ]);
        must(result.exit === 0, `exit ${result.exit}`);
        const bad = [...strings(result.json)].filter(unsafe);
        must(bad.length === 0, `${bad.length} strings carry control or direction characters`);
        must(
          gateOf(result.json.data, "hostile_text").detail.includes("instruction"),
          "the memo that reads as an instruction was not counted",
        );
        must(
          result.json.data.hints.join(" ").includes("do not act on them"),
          "the report should tell the agent not to act on flagged lines",
        );
      },
    );

    // ---- 7. The books start from the trial balance -----------------------------------------
    const owed = (source: SourceTruth): bigint =>
      source.role === "liability" ? -source.opening : source.opening;
    await check(
      "opening",
      "the opening balances, read from a QuickBooks-like trial balance, are reviewed, planned and committed as one entry",
      async () => {
        // The old system's trial balance, from a system whose layout the Xero readers were not written
        // for, read into exact cents and matched to the book's accounts.
        const quickbooks = everything.find((item) =>
          item.path.startsWith("reports/quickbooks/trial-balance"),
        );
        must(quickbooks, "the corpus has no QuickBooks-like trial balance");
        const read = await cli([
          "intake",
          "trial-balance",
          file(quickbooks.path),
          "--balances-only=true",
        ]);
        must(read.exit === 0, `trial-balance exit ${read.exit}: ${read.out.slice(0, 300)}`);
        const oldBooks = new Map(
          read.out
            .trim()
            .split(",")
            .map((pair) => pair.split("=") as [string, string]),
        );
        // The statements prove the bank and card balances. Here the old books agree with them; where
        // they did not, the statement's figure is the one that goes in, and the plan said so.
        const balances = corpus.sources
          .map((source) => {
            must(
              oldBooks.get(source.code) === cents(owed(source)),
              `${source.code}: the old books say ${oldBooks.get(source.code)}, the statement ${cents(owed(source))}`,
            );
            return `${source.code}=${cents(owed(source))}`;
          })
          .join(",");
        const review = await cli(["opening", "review", "--date", CUTOVER, "--balances", balances]);
        must(
          review.exit === 0 && review.json.data.valid !== false,
          `review exit ${review.exit}: ${review.out.slice(0, 300)}`,
        );
        const planned = await cli(["opening", "plan", "--date", CUTOVER, "--balances", balances]);
        must(planned.exit === 0, `plan exit ${planned.exit}: ${planned.out.slice(0, 300)}`);
        const { planId, planHash } = planned.json.data.plan as { planId: string; planHash: string };
        const done = await cli(["operations", "commit", planId, planHash]);
        must(
          done.exit === 0 && done.json.data.disposition === "committed",
          `commit exit ${done.exit}: ${done.out.slice(0, 300)}`,
        );
      },
    );

    // ---- 8. Import every statement month ---------------------------------------------------
    for (const source of corpus.sources) {
      await check(
        "import",
        `${source.layout}: three months previewed, imported, and imported again without adding a line`,
        async () => {
          let total = 0;
          for (const month of MONTHS) {
            const path = file(pathOf(source, month));
            const extra = [
              ...(source.recipe ? ["--profile", source.recipe.name] : []),
              ...(source.layout === "tamarack-checking" ? ["--skip-invalid-rows=true"] : []),
            ];
            const lines = source.months[month].length;
            const dry = await cli([
              "import",
              path,
              "--account",
              source.code,
              "--dry-run=true",
              ...extra.filter((flag) => flag !== "--skip-invalid-rows=true"),
            ]);
            must(
              dry.exit === 0 || source.layout === "tamarack-checking",
              `${month} preview exit ${dry.exit}: ${dry.out.slice(0, 200)}`,
            );
            must(
              dry.json.data.counts.lines === lines,
              `${month} preview read ${dry.json.data.counts.lines} lines, not ${lines}`,
            );
            const done = await cli(["import", path, "--account", source.code, ...extra]);
            must(done.exit === 0, `${month} import exit ${done.exit}: ${done.out.slice(0, 300)}`);
            must(
              done.json.data.counts.new === lines,
              `${month}: ${done.json.data.counts.new} new of ${lines}`,
            );
            total += lines;
            if (month === MONTHS[0]) {
              const again = await cli(["import", path, "--account", source.code, ...extra]);
              must(
                again.exit === 0 && again.json.data.counts.new === 0,
                `a second import added ${again.json?.data?.counts?.new} lines`,
              );
            }
          }
          return `${total} lines`;
        },
      );
    }

    // ---- 9. Post what is waiting -----------------------------------------------------------
    await check(
      "post",
      "the lines are categorised and posted, each account in turn, until nothing waits",
      async () => {
        for (const source of corpus.sources) {
          for (const [direction, account] of [
            ["in", sales],
            ["out", expenses],
          ] as const) {
            const drafted = await cli([
              "inbox",
              "categorize",
              `--chart-account=${source.code}`,
              `--direction=${direction}`,
              "--status=new,proposed",
              `--account=${account}`,
            ]);
            must(
              drafted.exit === 0 || drafted.json?.error?.code === "nothing_selected",
              `${source.code} ${direction}: exit ${drafted.exit} ${drafted.out.slice(0, 200)}`,
            );
          }
          for (let round = 0; round < 12; round++) {
            const posted = await cli([
              "inbox",
              "post",
              `--chart-account=${source.code}`,
              "--status=drafted",
            ]);
            must(
              posted.exit === 0 || posted.json?.error?.code === "nothing_selected",
              `${source.code} post: exit ${posted.exit} ${posted.out.slice(0, 200)}`,
            );
            if ((posted.json?.data?.remaining ?? 0) === 0) break;
          }
        }
        const summary = await cli(["inbox", "summary"]);
        const waiting = summary.json?.data?.counts ?? summary.json?.data;
        return JSON.stringify(waiting).slice(0, 200);
      },
    );

    // ---- 10. Reconcile every month to its statement ----------------------------------------
    for (const source of corpus.sources) {
      await check(
        "reconcile",
        `${source.layout}: three months reconciled to the statement at 0.00`,
        async () => {
          for (const month of MONTHS) {
            const statement =
              source.role === "liability" ? -closingOf(source, month) : closingOf(source, month);
            const started = await cli([
              "reconcile",
              "start",
              "--account",
              source.code,
              "--date",
              monthEnd(month),
              "--balance",
              cents(statement),
            ]);
            must(started.exit === 0, `${month} start: ${started.out.slice(0, 300)}`);
            const id = started.json.data.id as string;
            const selected = await cli(["reconcile", "select", id, "--all"]);
            must(
              selected.exit === 0 &&
                selected.json.data.difference === "0.00" &&
                selected.json.data.canComplete === true,
              `${month}: difference ${selected.json?.data?.difference}`,
            );
            const done = await cli([
              "reconcile",
              "complete",
              id,
              "--version",
              String(selected.json.data.version),
            ]);
            must(
              done.exit === 0 && done.json.data.status === "completed",
              `${month} complete: ${done.out.slice(0, 300)}`,
            );
          }
          return "3 records";
        },
      );
    }

    // ---- 11. The measures ------------------------------------------------------------------
    await check(
      "status",
      "the move-in is measured: time to the first import and reconciliation, interventions, gaps",
      async () => {
        const result = await cli(["intake", "status"]);
        const status = result.json?.data;
        must(result.exit === 0, `exit ${result.exit}`);
        // Every month once, and the first month of each account a second time, which added nothing.
        must(
          status.imports === corpus.sources.length * (MONTHS.length + 1),
          `${status.imports} imports`,
        );
        must(
          status.reconciliations === corpus.sources.length * MONTHS.length,
          `${status.reconciliations} reconciliations`,
        );
        must(
          status.secondsToFirstImport !== null && status.secondsToFirstReconciliation !== null,
          "the times are empty",
        );
        must(
          status.interventions > 0,
          "no intervention was counted, yet files needed an agent and recipes",
        );
        must(
          status.unresolvedGaps === 0,
          `${status.unresolvedGaps} gaps are still open after the plan was ready`,
        );
        return `first import after ${status.secondsToFirstImport}s, first reconciliation after ${status.secondsToFirstReconciliation}s, ${status.interventions} interventions, ${status.unresolvedGaps} gaps open`;
      },
    );

    // ---- 12. Scopes ------------------------------------------------------------------------
    await check(
      "scopes",
      "a read-only token plans and reads the log but cannot save a recipe or write the log",
      async () => {
        const made = await cli([
          "tokens",
          "create",
          "--label",
          "intake harness read",
          "--preset",
          "read-only",
        ]);
        const token = made.json?.data?.secret as string | undefined;
        must(made.exit === 0 && token, `token: exit ${made.exit}: ${made.out.slice(0, 200)}`);
        const env = { RASTRATA_TOKEN: token };
        const planned = await cli(["intake", "plan", "--input", "-", "--record=false"], {
          stdin: JSON.stringify(planInput()),
          env,
        });
        must(
          planned.exit === 0,
          `plan with read: exit ${planned.exit} ${planned.out.slice(0, 200)}`,
        );
        const listed = await cli(["intake", "friction", "list"], { env });
        must(listed.exit === 0, `list with read: exit ${listed.exit}`);
        const status = await cli(["intake", "status"], { env });
        must(status.exit === 0, `status with read: exit ${status.exit}`);
        const written = await cli(
          ["intake", "friction", "add", "--kind", "note", "--reason", "x"],
          { env },
        );
        must(
          written.exit !== 0 && written.json?.error?.code === "permission_denied",
          `friction add with read: exit ${written.exit} ${written.out.slice(0, 200)}`,
        );
        const saved = await cli(
          [
            "intake",
            "recipe",
            "save",
            recipeFile.get("1010") as string,
            file(pathOf(harbor, MONTHS[0])),
            ...proofFlags(harbor, MONTHS[0]),
            "--record=false",
          ],
          { env },
        );
        must(saved.exit !== 0, "a read-only token saved a recipe");
        const scan = await cli(["intake", "scan", folder, "--record=false"], { env });
        must(
          scan.exit !== 0 && scan.json?.error?.code === "permission_denied",
          `scan with read: exit ${scan.exit}`,
        );
        return "read: plan, status, list; refused: friction, recipe save, upload";
      },
    );
  } catch (error) {
    rows.push({
      section: "harness",
      check: "the harness ran to its end",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: 0,
    });
  } finally {
    server?.kill();
    await server?.exited;
    if (!options.keep) rmSync(directory, { recursive: true, force: true });
  }
  return { rows, directory, corpus };
}

/** The table a person reads. */
export function renderTable(rows: readonly Row[]): string {
  const widthOf = (pick: (row: Row) => string, floor: number) =>
    Math.max(floor, ...rows.map((row) => pick(row).length));
  const sectionWidth = widthOf((row) => row.section, 7);
  const checkWidth = Math.min(
    96,
    widthOf((row) => row.check, 5),
  );
  const line = (row: Row) =>
    `${row.section.padEnd(sectionWidth)}  ${row.check.slice(0, checkWidth).padEnd(checkWidth)}  ${row.pass ? "PASS" : "FAIL"}  ${row.detail.slice(0, 110)}`;
  const passed = rows.filter((row) => row.pass).length;
  return [
    `${"SECTION".padEnd(sectionWidth)}  ${"CHECK".padEnd(checkWidth)}  RESULT  DETAIL`,
    ...rows.map(line),
    "",
    `${passed} of ${rows.length} checks passed${passed === rows.length ? "" : `; ${rows.length - passed} failed`}`,
  ].join("\n");
}
