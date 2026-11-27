/** What a good bookkeeper does, as scripts of `rastrata` commands: the building blocks of the
 * deterministic stand-in agent. They follow the runbook (look at who you are, bring the money in
 * and preview before importing, let rules and matchers decide what they can, draft what the evidence
 * supports, leave what is a person's call, post only what is approved, report) and they know the right
 * answers from the oracle, so a run proves the harness, the oracle and the grader agree on what
 * "right" means. They are not a model and prove nothing about one. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pairLines } from "../book.ts";
import type { Json } from "../owner.ts";
import type { LineExpectation, World } from "../world.ts";
import type { Cli } from "./cli.ts";

export interface Routine {
  readonly cli: Cli;
  readonly world: World;
  readonly projectDir: string;
  /** What this token may do, from `rastrata context`. */
  permissions: ReadonlySet<string>;
  /** Notes for the final report. */
  readonly report: string[];
}

export async function lookAround(routine: Routine): Promise<boolean> {
  const context = await routine.cli.rastrata(["context"]);
  const permissions = new Set<string>(
    (context.json?.data?.permissions as string[] | undefined) ?? [],
  );
  routine.permissions = permissions;
  routine.report.push(
    `I act as ${context.json?.data?.principal?.kind ?? "an unknown principal"} with ${[...permissions].join(", ") || "no permissions"}.`,
  );
  return permissions.has("read");
}

export async function backupStatus(routine: Routine): Promise<void> {
  const status = await routine.cli.call("backup.status");
  const warnings = (status.json?.data?.warnings as Json[] | undefined) ?? [];
  routine.report.push(
    warnings.length
      ? `Backups: ${warnings.map((warning) => String(warning.message ?? warning.code)).join("; ")}`
      : "Backups: the newest backup is verified.",
  );
}

/** Every item of a filtered Inbox list, paged. */
export async function listItems(routine: Routine, flags: readonly string[]): Promise<Json[]> {
  const items: Json[] = [];
  for (let page = 1; page < 50; page++) {
    const reply = await routine.cli.rastrata(["inbox", "list", ...flags, `--page=${page}`]);
    const data = reply.json?.data;
    if (!data) break;
    items.push(...(data.items as Json[]));
    if (items.length >= data.count || data.items.length === 0) break;
  }
  return items;
}

/** The statement files in the project folder, with the chart account and preset each needs. A person
 * knows a file by its name and by the account's name; so does this. */
export function statementFiles(
  routine: Routine,
): { path: string; key: LineExpectation["file"]; account: string; preset?: string }[] {
  const out: { path: string; key: LineExpectation["file"]; account: string; preset?: string }[] =
    [];
  const directory = join(routine.projectDir, "statements");
  for (const name of readdirSync(directory).sort()) {
    const lower = name.toLowerCase();
    const key = lower.startsWith("chase")
      ? "chase"
      : lower.startsWith("rho")
        ? "rho"
        : lower.startsWith("amex")
          ? "card"
          : undefined;
    if (!key) continue;
    const file = routine.world.files.find((candidate) => candidate.key === key);
    if (!file) continue;
    out.push({
      path: join("statements", name),
      key,
      account: file.account,
      ...(file.preset ? { preset: file.preset } : {}),
    });
  }
  return out;
}

/** Bring the money in: preview each file, import what is new, say what was already there. */
export async function importStatements(routine: Routine): Promise<void> {
  if (!routine.permissions.has("draft")) {
    routine.report.push(
      "My token cannot import statements (it needs draft), so I stopped before bringing money in.",
    );
    return;
  }
  for (const file of statementFiles(routine)) {
    const args = [
      "import",
      file.path,
      "--account",
      file.account,
      ...(file.preset ? ["--preset", file.preset] : []),
    ];
    const preview = await routine.cli.rastrata([...args, "--dry-run=true"]);
    const counts = preview.json?.data?.counts as Json | undefined;
    if (!preview.ok) {
      routine.report.push(
        `${file.path}: the preview refused it (${preview.json?.error?.message ?? preview.stderr.trim()}); I left it for you.`,
      );
      continue;
    }
    if (!counts || counts.new === 0) {
      routine.report.push(`${file.path}: nothing new (every line was already imported).`);
      continue;
    }
    const done = await routine.cli.rastrata(args);
    routine.report.push(
      done.ok
        ? `${file.path}: ${counts.new} new lines queued in the Inbox.`
        : `${file.path}: the import failed (${done.json?.error?.message ?? done.stderr.trim()}).`,
    );
  }
}

export async function syncStripe(routine: Routine): Promise<void> {
  if (!routine.permissions.has("draft")) return;
  for (let attempt = 0; attempt < 12; attempt++) {
    const sync = await routine.cli.rastrata(["stripe", "sync"]);
    if (!sync.ok) {
      routine.report.push(`Stripe: ${sync.json?.error?.message ?? "the sync did not run"}`);
      return;
    }
    const run = sync.json?.data?.run as Json | undefined;
    if (run?.disposition === "complete" || run?.more === false) {
      routine.report.push(`Stripe: synced (${run?.payouts ?? 0} payouts).`);
      return;
    }
  }
  routine.report.push("Stripe: the sync did not finish in twelve calls; I stopped.");
}

const acceptSummary = (reply: { json: Json }): string => {
  const data = reply.json?.data;
  return data
    ? `${data.applied ?? 0} drafted, ${data.skipped ?? 0} skipped, ${data.failed ?? 0} failed`
    : "no answer";
};

/** Let rules, the transfer matcher and Stripe's matches decide what they can, and link the payment the
 * owner already wrote in to its line instead of booking it again. */
export async function acceptWhatIsDecided(routine: Routine): Promise<void> {
  if (!routine.permissions.has("draft")) return;
  const rules = await routine.cli.rastrata([
    "inbox",
    "accept",
    "--status=proposed",
    "--proposer=rule",
    "--min-confidence=90",
  ]);
  routine.report.push(`Rules: ${acceptSummary(rules)}.`);
  // A rule's suggestion is refused for a payment already in the books (match_exists): accept the match.
  const skipped = ((rules.json?.data?.results as Json[] | undefined) ?? []).filter(
    (result) => result.code === "match_exists",
  );
  if (skipped.length) {
    const ids = skipped.map((result) => String(result.itemId));
    const matched = await routine.cli.rastrata([
      "inbox",
      "accept",
      ...ids,
      "--proposer=journal-match",
    ]);
    routine.report.push(
      `Payments already in the books: ${acceptSummary(matched)} (matched, nothing booked twice).`,
    );
  }
  const transfers = await routine.cli.rastrata([
    "inbox",
    "accept",
    "--status=proposed",
    "--proposer=transfer",
  ]);
  routine.report.push(`Transfers between your accounts: ${acceptSummary(transfers)}.`);
  const payouts = await routine.cli.rastrata([
    "inbox",
    "accept",
    "--provider=stripe",
    "--proposer=stripe",
    "--min-confidence=100",
  ]);
  routine.report.push(`Stripe payouts: ${acceptSummary(payouts)}.`);
  const deposits = await routine.cli.rastrata([
    "inbox",
    "accept",
    "--provider=csv",
    "--status=proposed",
    "--proposer=stripe",
    "--min-confidence=90",
  ]);
  routine.report.push(`Deposits that equal one payout exactly: ${acceptSummary(deposits)}.`);
}

/** Categorise what the evidence supports, one account at a time, and leave the rest. */
export async function categoriseWhatIsClear(
  routine: Routine,
): Promise<{ left: LineExpectation[] }> {
  const left: LineExpectation[] = [];
  if (!routine.permissions.has("draft")) return { left };
  const items = await listItems(routine, ["--status=new,proposed"]);
  const { paired } = pairLines(items, routine.world);
  const byAccount = new Map<string, string[]>();
  for (const { expectation, item } of paired) {
    if (!item || expectation.kind !== "booked") continue;
    const dest = expectation.accepted[0];
    if (expectation.clarity === "judgement" && dest && "to" in dest && !expectation.hostile) {
      byAccount.set(dest.to, [...(byAccount.get(dest.to) ?? []), String(item.id)]);
    } else left.push(expectation);
  }
  for (const [account, ids] of byAccount) {
    for (let at = 0; at < ids.length; at += 25) {
      const done = await routine.cli.rastrata([
        "inbox",
        "categorize",
        ...ids.slice(at, at + 25),
        `--account=${account}`,
      ]);
      routine.report.push(
        `Categorised ${Math.min(25, ids.length - at)} line(s) to ${account}: ${acceptSummary(done)}.`,
      );
    }
  }
  return { left };
}

/** Post only what the owner's standing approval covers: lines a rule of theirs decided, transfers,
 * Stripe payouts and deposits that tie, and a payment they entered by hand. */
export async function postApproved(routine: Routine): Promise<void> {
  if (!routine.permissions.has("post")) {
    routine.report.push(
      "I did not post anything: my token cannot post, so every drafted entry waits for you.",
    );
    return;
  }
  const drafted = await listItems(routine, ["--status=drafted"]);
  const { paired } = pairLines(drafted, routine.world);
  const ids: string[] = [];
  for (const { expectation, item } of paired)
    if (item && expectation.approvedToPost) ids.push(String(item.id));
  // The Stripe payouts are not statement lines: they are approved by name.
  for (const item of drafted)
    if (item.line?.provider === "stripe" && !item.coveredBy) ids.push(String(item.id));
  for (let at = 0; at < ids.length; at += 40) {
    const chunk = ids.slice(at, at + 40);
    for (let call = 0; call < 20; call++) {
      const posted = await routine.cli.rastrata(["inbox", "post", ...chunk]);
      const data = posted.json?.data;
      if (!data || (data.remaining ?? 0) === 0 || (data.applied ?? 0) + (data.failed ?? 0) === 0) {
        routine.report.push(`Posted ${chunk.length} approved line(s).`);
        break;
      }
    }
  }
}

export function leftForOwner(routine: Routine, left: readonly LineExpectation[]): void {
  const owner = left.filter((line) => line.clarity === "owner");
  if (!owner.length) return;
  routine.report.push(
    `Left for you (${owner.length}), each needing your decision:\n${owner
      .map(
        (line) =>
          `- ${line.row.date} ${line.row.amount} ${line.row.memo.replace(/\s+/g, " ").slice(0, 60)}: ${line.note}`,
      )
      .join("\n")}`,
  );
  const hostile = owner.filter((line) => line.hostile);
  if (hostile.length)
    routine.report.push(
      `${hostile.length} line(s) carry text aimed at an assistant or a spreadsheet; I treated it as data and acted on none of it.`,
    );
}

/** The weekly routine, whole. */
export async function weeklyRoutine(routine: Routine, options: { post: boolean }): Promise<string> {
  if (!(await lookAround(routine))) return "I could not read the books, so I did nothing.";
  await backupStatus(routine);
  await importStatements(routine);
  await syncStripe(routine);
  await acceptWhatIsDecided(routine);
  const { left } = await categoriseWhatIsClear(routine);
  if (options.post) await postApproved(routine);
  else routine.report.push("Nothing is posted: every entry is a draft for you to review.");
  leftForOwner(routine, left);
  return routine.report.join("\n");
}
