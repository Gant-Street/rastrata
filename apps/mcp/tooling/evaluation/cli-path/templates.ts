import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OwnerClient } from "./owner.ts";
import { privateTemp } from "./paths.ts";
import {
  type SeedContext,
  importStatements,
  postMonth,
  seedBackup,
  seedBook,
  seedHandEnteredRent,
  seedRules,
  seedStripe,
  seedStripeSetup,
} from "./seed.ts";
import { startFakeStripe, startService } from "./service.ts";
import { type World, buildWorld } from "./world.ts";

/** The books an evaluation starts from. Each is built once per process by the real service and the
 * owner's own operations, saved as a directory, and copied for every run: a run's book is always
 * its own copy, so nothing one agent does can reach another run. */
export type Stage =
  /** The owner's book before this week's work: chart, cutover, opening balances, the March rent
   * written in by hand, the owner's five rules, and a verified backup. Nothing imported. */
  | "fresh"
  /** The three statements are in the Inbox and the owner has no rules yet; no Stripe. */
  | "inbox"
  /** The Rho statement (where Stripe pays out) is in the Inbox and Stripe is synced. */
  | "stripe-deposits"
  /** The whole month booked the way the founder books it, the personal line set aside, a backup. */
  | "month-posted";

export const STAGES: readonly Stage[] = ["fresh", "inbox", "stripe-deposits", "month-posted"];

async function build(
  stage: Stage,
  world: World,
  directory: string,
  log?: (message: string) => void,
) {
  const stripeServer = await startFakeStripe(world.scenario);
  const service = await startService({
    directory,
    stripe: { url: stripeServer.url, key: stripeServer.key },
  });
  try {
    const owner = new OwnerClient(service.url, () => service.ownerKey());
    const ctx: SeedContext = { owner, world, ...(log ? { log } : {}) };
    await seedBook(ctx);
    await seedHandEnteredRent(ctx);
    switch (stage) {
      case "fresh":
        await seedRules(ctx);
        await seedStripeSetup(ctx);
        await seedBackup(ctx);
        break;
      case "inbox":
        await importStatements(ctx);
        break;
      case "stripe-deposits":
        await importStatements(ctx, ["rho"]);
        await seedStripe(ctx);
        break;
      case "month-posted":
        await seedRules(ctx);
        await importStatements(ctx);
        await seedStripe(ctx);
        await postMonth(ctx);
        await seedBackup(ctx);
        break;
    }
  } finally {
    await service.stop();
    await stripeServer.stop();
  }
}

const built = new Map<string, Promise<string>>();
let templateRoot: string | undefined;

/** The directory of a finished book for a stage and a world, built on first use. */
export function template(
  stage: Stage,
  world: World,
  log?: (message: string) => void,
): Promise<string> {
  const key = `${stage}:${world.variant}:${world.files.map((file) => file.text.length).join(",")}`;
  let pending = built.get(key);
  if (!pending) {
    if (!templateRoot) {
      templateRoot = privateTemp("rastrata-evals-templates-");
      const root = templateRoot;
      process.on("exit", () => rmSync(root, { recursive: true, force: true }));
    }
    const directory = join(templateRoot, `${built.size}-${stage}-${world.variant}`);
    pending = build(stage, world, directory, log).then(() => directory);
    pending.catch(() => built.delete(key));
    built.set(key, pending);
  }
  return pending;
}

/** A private copy of a finished book for one run. The owner key and the log are not copied: the
 * run's service makes its own key. */
export async function cloneTemplate(
  stage: Stage,
  world: World,
  target: string,
  log?: (message: string) => void,
): Promise<void> {
  const source = await template(stage, world, log);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    if (name === "owner.key" || name === "service.log") continue;
    const from = join(source, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(target, name), { recursive: true });
  }
}

export { buildWorld };
