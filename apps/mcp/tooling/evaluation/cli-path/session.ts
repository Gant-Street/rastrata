import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OwnerClient } from "./owner.ts";
import { ensureBinary, privateTemp } from "./paths.ts";
import {
  type InitAgent,
  type Project,
  buildProject,
  bareEnvironment,
  decoyPathFor,
} from "./project.ts";
import { TracingProxy } from "./proxy.ts";
import {
  type FakeStripeServer,
  type RunningService,
  startFakeStripe,
  startService,
} from "./service.ts";
import { type Stage, cloneTemplate } from "./templates.ts";
import { real, spawnGroup } from "./util.ts";
import { type FileKey, type World, buildWorld } from "./world.ts";

export interface TokenGrant {
  /** `read-only`, `draft` or `bookkeeper`: what the owner would pick on the Agent access screen. */
  readonly preset?: "read-only" | "draft" | "bookkeeper";
  /** Or exactly these (for a scenario that needs `close`). */
  readonly permissions?: readonly string[];
}

export interface SessionOptions {
  readonly stage: Stage;
  readonly variant?: "founder" | "hostile";
  readonly grant: TokenGrant;
  /** The statement files the owner has saved in the project folder. */
  readonly files: readonly FileKey[];
  readonly extras?: (
    world: World,
  ) => readonly { readonly path: string; readonly content: string }[];
  readonly initAgent?: InitAgent;
  readonly poisonStripe?: boolean;
  /** April's first days, for the scenario that imports the next export. */
  readonly april?: boolean;
  /** A directory for this run, created if missing. A fresh private temp directory by default. */
  readonly root?: string;
  readonly log?: (message: string) => void;
}

/** One evaluation run's whole environment, on a book of its own: the real service on a random port,
 * the stand-in Stripe, a tracing proxy in front of the service, the owner's access (held here), a
 * token made the owner's way, and the agent's project folder. Nothing is shared with another run
 * and nothing touches a default database. */
export interface Session {
  readonly root: string;
  readonly world: World;
  readonly service: RunningService;
  readonly owner: OwnerClient;
  readonly proxy: TracingProxy;
  readonly stripe: FakeStripeServer;
  readonly project: Project;
  readonly token: {
    readonly id: string;
    readonly secret: string;
    readonly permissions: readonly string[];
    readonly preset?: string;
  };
  /** The agent's environment: its token and the proxy's address, and nothing of the owner's. */
  readonly agentEnv: Record<string, string>;
  readonly binary: string;
  close(): Promise<void>;
}

/** The owner makes the token with their own command, as the Agent access screen's text says. The
 * secret is returned to the harness and held in memory only. */
async function createToken(
  binary: string,
  service: RunningService,
  directory: string,
  grant: TokenGrant,
): Promise<Session["token"]> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const args = [
    "tokens",
    "create",
    "--label",
    "Evaluation agent",
    "--expires-in-days",
    "7",
    "--json",
  ];
  if (grant.permissions) args.push("--permissions", grant.permissions.join(","));
  else args.push("--preset", grant.preset ?? "draft");
  const env: Record<string, string> = {
    ...bareEnvironment(join(directory, "bin-unused")),
    RASTRATA_API_URL: service.url,
    RASTRATA_OWNER_KEY_FILE: service.ownerKeyFile,
    RASTRATA_REQUEST_DIR: join(directory, "owner-requests"),
  };
  const run = spawnGroup(binary, args, { cwd: directory, env, timeoutMs: 60_000 });
  const finished = await run.done;
  if (finished.code !== 0)
    throw new Error(
      `rastrata tokens create failed (${finished.code}): ${finished.stderr.slice(0, 400)}`,
    );
  const reply = JSON.parse(finished.stdout.trim().split("\n").pop() ?? "{}") as {
    data?: { secret?: string; token?: { id: string; permissions: string[] } };
  };
  const secret = reply.data?.secret;
  const token = reply.data?.token;
  if (!secret || !token) throw new Error("rastrata tokens create returned no token");
  return {
    id: token.id,
    secret,
    permissions: token.permissions,
    ...(grant.preset ? { preset: grant.preset } : {}),
  };
}

export async function openSession(options: SessionOptions): Promise<Session> {
  const ownsRoot = options.root === undefined;
  const root = options.root ?? privateTemp("rastrata-evals-run-");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const variant = options.variant ?? "founder";
  const world = buildWorld({
    variant,
    ...(variant === "hostile" ? { decoyPath: decoyPathFor(real(root)) } : {}),
    ...(options.poisonStripe ? { poisonStripe: true } : {}),
    ...(options.april ? { april: true } : {}),
  });
  const binary = await ensureBinary();
  const serviceDirectory = join(root, "service");
  await cloneTemplate(options.stage, world, serviceDirectory, options.log);
  const stripe = await startFakeStripe(world.scenario);
  let service: RunningService | undefined;
  let proxy: TracingProxy | undefined;
  try {
    service = await startService({
      directory: serviceDirectory,
      stripe: { url: stripe.url, key: stripe.key },
    });
    const owner = new OwnerClient(service.url, () => (service as RunningService).ownerKey());
    const token = await createToken(binary, service, join(root, "owner"), options.grant);
    proxy = new TracingProxy(service.url);
    proxy.start();
    const project = await buildProject({
      root,
      binary,
      world,
      files: options.files,
      initAgent: options.initAgent ?? "claude",
      endpoint: proxy.url,
      ...(options.extras ? { extras: options.extras(world) } : {}),
    });
    const agentEnv: Record<string, string> = {
      ...bareEnvironment(project.binDir),
      RASTRATA_API_URL: proxy.url,
      RASTRATA_TOKEN: token.secret,
      RASTRATA_REQUEST_DIR: project.requestDir,
    };
    const live = { service, proxy };
    return {
      root,
      world,
      service,
      owner,
      proxy,
      stripe,
      project,
      token,
      agentEnv,
      binary,
      close: async () => {
        // The token is revoked first, so nothing that outlives the run can use it.
        await owner
          .call("tokens.revoke", { tokenId: token.id, reason: "The evaluation run is over" })
          .catch(() => undefined);
        await live.proxy.stop();
        await live.service.stop();
        await stripe.stop();
        // The run's evidence is in the output directory; the book, the key and the project are not
        // kept (RASTRATA_EVAL_KEEP=1 keeps them for a look).
        if (ownsRoot && process.env.RASTRATA_EVAL_KEEP !== "1")
          rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await proxy?.stop();
    await service?.stop();
    await stripe.stop();
    if (ownsRoot && process.env.RASTRATA_EVAL_KEEP !== "1")
      rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
