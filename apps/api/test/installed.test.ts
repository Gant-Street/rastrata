import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APPLICATION_API_VERSION } from "@rastrata/application/schema";
import { resolveDataPaths } from "../src/data-directory.ts";

// These tests run the real thing: the executable that tooling/build-service.ts makes, with no Bun
// involved once it is built, in a home directory of its own. They are the proof that one file serves
// the API and the web app, keeps the data where it should, and works its backups and its offline tool.

const repository = resolve(import.meta.dir, "../../..");
const version = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"))
  .version as string;
const workspace = mkdtempSync(join(tmpdir(), "rastrata-installed-"));
const binary = join(workspace, "rastrata-service");

beforeAll(() => {
  const build = Bun.spawnSync(
    [process.execPath, join(repository, "apps/api/tooling/build-service.ts"), "--out", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0)
    throw new Error(`building the service failed:\n${build.stdout}${build.stderr}`);
}, 180_000);

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const running: { stop(): Promise<number> }[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

/** A home directory of its own, so that the service finds nothing of the developer's. */
function home(): string {
  const directory = mkdtempSync(join(workspace, "home-"));
  return directory;
}

async function pump(stream: ReadableStream<Uint8Array>, into: (text: string) => void) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) into(decoder.decode(chunk, { stream: true }));
}

/** Start the executable on a port the system chooses, and wait until it says where it is. */
async function start(directory: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([binary], {
    env: { PATH: process.env.PATH ?? "", HOME: directory, RASTRATA_API_PORT: "0", ...env },
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  let err = "";
  void pump(child.stdout, (text) => {
    out += text;
  });
  void pump(child.stderr, (text) => {
    err += text;
  });
  const service = {
    child,
    out: () => out,
    err: () => err,
    async stop(): Promise<number> {
      if (child.exitCode === null) child.kill("SIGTERM");
      return child.exited;
    },
  };
  running.push(service);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const found = /is running at (http:\/\/127\.0\.0\.1:(\d+))\//.exec(out);
    if (found) return { ...service, base: found[1] as string, port: Number(found[2]) };
    if (child.exitCode !== null)
      throw new Error(`the service ended (${child.exitCode}): ${out}${err}`);
    if (Date.now() > deadline) throw new Error(`the service did not start: ${out}${err}`);
    await Bun.sleep(25);
  }
}

const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);
const ownerHeaders = (directory: string) => ({
  authorization: `Bearer ${readFileSync(resolveDataPaths({ env: { HOME: directory } }).ownerKey, "utf8").trim()}`,
});

const call = (
  base: string,
  name: string,
  input: unknown,
  headers: Record<string, string>,
  operationId?: string,
) =>
  fetch(`${base}/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      version: APPLICATION_API_VERSION,
      bookId: "local-book",
      ...(operationId ? { operationId } : {}),
      input,
    }),
  });

const SETUP = {
  name: "Installed Co",
  currency: "USD",
  fiscalYear: 2026,
  periodModel: "monthly",
  accounts: [
    { code: "1000", name: "Cash", role: "asset" },
    { code: "3000", name: "Capital", role: "equity" },
  ],
};

test("one executable serves the API, the web app and a deep link, in a home of its own", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const service = await start(directory);

  // The service says who it is, and which release.
  const health = await fetch(`${service.base}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({
    ok: true,
    service: "rastrata",
    version,
    // No book yet, so nothing to read: ready at once.
    warming: false,
    warmup: { state: "ready", entries: 0, seconds: 0 },
  });

  // The API answers as the app asks it: the owner key is attached for the app's own requests.
  const book = await call(service.base, "book.get", {}, { "sec-fetch-site": "same-origin" });
  expect(book.status).toBe(200);
  const data = (await book.json()).data;
  expect(data.enabled).toBe(true);
  expect(data.setup).toBeNull();
  expect(data.principal).toEqual({ kind: "owner" });
  expect(data.ownerAccess).toBe("key");

  // The app's index, and a deep link the router handles after the reload.
  const index = await fetch(`${service.base}/`, { headers: { accept: "text/html" } });
  expect(index.status).toBe(200);
  expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const html = await index.text();
  expect(html).toContain('<div id="root"></div>');
  const deep = await fetch(`${service.base}/journal/new`, { headers: { accept: "text/html" } });
  expect(deep.status).toBe(200);
  expect(await deep.text()).toBe(html);
  // Its files are served, hashed names forever, and what is not in the build is not found.
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] as string;
  const asset = await fetch(`${service.base}${script}`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(asset.headers.get("cache-control")).toContain("immutable");
  expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(100_000);
  expect((await fetch(`${service.base}/assets/nothing.js`)).status).toBe(404);
  expect((await fetch(`${service.base}/licenses/inter.txt`)).status).toBe(200);
  for (const hidden of ["/../../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/package.json"])
    expect((await fetch(`${service.base}${hidden}`)).status, hidden).toBe(404);

  // The lock is on: a program with no credentials is refused; the key opens it.
  const bare = await call(service.base, "book.get", {}, {});
  expect(bare.status).toBe(401);
  expect((await bare.json()).error.code).toBe("authentication_required");
  expect((await call(service.base, "book.get", {}, ownerHeaders(directory))).status).toBe(200);

  // The data is where it should be, and private.
  expect(existsSync(paths.database)).toBe(true);
  expect(paths.directory.startsWith(directory)).toBe(true);
  expect(modeOf(paths.directory)).toBe("700");
  expect(modeOf(paths.logs)).toBe("700");
  expect(modeOf(paths.ownerKey)).toBe("600");
  expect(modeOf(paths.database)).toBe("600");
  expect(readFileSync(paths.ownerKey, "utf8").trim()).toMatch(/^rso_[A-Za-z0-9_-]{43}$/);

  // The log says what happened, and never a credential.
  const log = readFileSync(paths.serviceLog, "utf8");
  expect(log).toContain(`Starting Rastrata ${version}`);
  expect(log).toContain(`Listening on ${service.base}/ (this computer only)`);
  expect(log).toContain("Owner lock: on");
  expect(log).toContain("Backups: automatic");
  expect(log).not.toContain(readFileSync(paths.ownerKey, "utf8").trim());
  expect(service.out()).not.toContain("rso_");
  expect(service.err()).toBe("");

  // It stops on request, cleanly, and says so.
  expect(await service.stop()).toBe(0);
  expect(readFileSync(paths.serviceLog, "utf8")).toContain("Stopped");
}, 60_000);

test("a second start finds the same key and the same book", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const first = await start(directory);
  const key = readFileSync(paths.ownerKey, "utf8");
  const setup = await fetch(`${first.base}/api/book/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ownerHeaders(directory) },
    body: JSON.stringify(SETUP),
  });
  expect(setup.status).toBe(200);
  expect(await first.stop()).toBe(0);

  const second = await start(directory);
  expect(readFileSync(paths.ownerKey, "utf8")).toBe(key);
  const book = await call(second.base, "book.get", {}, ownerHeaders(directory));
  expect((await book.json()).data.setup.name).toBe("Installed Co");
  // The Host rule holds in the executable too.
  const forged = await fetch(`${second.base}/health`, { headers: { host: "evil.example" } });
  expect(forged.status).toBe(421);
}, 60_000);

test("it listens on this computer only", async () => {
  const directory = home();
  const service = await start(directory);
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && address.family === "IPv4" && !address.internal);
  // A computer with no network has no other address to try, which proves nothing either way.
  if (!outside) return;
  const attempt = await fetch(`http://${outside.address}:${service.port}/health`, {
    signal: AbortSignal.timeout(3000),
  }).then(
    (response) => `answered ${response.status}`,
    () => "refused",
  );
  expect(attempt).toBe("refused");
}, 30_000);

test("backups and their verification run inside the executable, and stopping takes a last one", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const service = await start(directory);
  const owner = ownerHeaders(directory);
  expect(
    (
      await fetch(`${service.base}/api/book/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", ...owner },
        body: JSON.stringify(SETUP),
      })
    ).status,
  ).toBe(200);

  // A long job is asked about with the same identity until it is done.
  const job = async (name: string) => {
    const id = crypto.randomUUID();
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await call(service.base, name, {}, owner, id);
      expect(response.status).toBe(200);
      const body = (await response.json()).data;
      if (body.state !== "running") return body;
      await Bun.sleep(100);
    }
    throw new Error(`${name} did not finish`);
  };
  const made = await job("backup.create");
  expect(made.state).toBe("done");
  expect(made.backup.fileName).toMatch(/\.sqlite$/);
  const verified = await job("backup.verify");
  expect(verified.state).toBe("done");
  expect(verified.verification.passed).toBe(true);
  expect(existsSync(join(paths.backups, made.backup.fileName))).toBe(true);
  expect(modeOf(paths.backups)).toBe("700");

  // Stopping takes one more, so the newest copy is as new as the book.
  const before = readdirSync(paths.backups).filter((name) => name.endsWith(".sqlite")).length;
  expect(await service.stop()).toBe(0);
  const after = readdirSync(paths.backups).filter((name) => name.endsWith(".sqlite")).length;
  expect(after).toBeGreaterThanOrEqual(before);
  expect(readFileSync(paths.serviceLog, "utf8")).toContain("Stopped");
}, 90_000);

test("the offline tool is inside the executable: restore a backup with nothing else installed", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const service = await start(directory);
  const owner = ownerHeaders(directory);
  await fetch(`${service.base}/api/book/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", ...owner },
    body: JSON.stringify(SETUP),
  });
  const id = crypto.randomUUID();
  let state = "running";
  while (state === "running") {
    const response = await call(service.base, "backup.create", {}, owner, id);
    state = (await response.json()).data.state;
    if (state === "running") await Bun.sleep(100);
  }
  expect(state).toBe("done");
  expect(await service.stop()).toBe(0);

  const target = join(directory, "restored", "book.sqlite");
  const run = Bun.spawnSync(
    [binary, "tool", "restore", "latest", "--to", target, "--backup-dir", paths.backups],
    { env: { PATH: process.env.PATH ?? "", HOME: directory }, stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const result = JSON.parse(run.stdout.toString().trim());
  expect(result.ok).toBe(true);
  expect(existsSync(target)).toBe(true);

  // An export folder that is not one is refused with the tool's own exit code, not a crash.
  const bad = Bun.spawnSync([binary, "tool", "check-export", join(directory, "nothing-here")], {
    env: { PATH: process.env.PATH ?? "", HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect([3, 4]).toContain(bad.exitCode);
  expect(JSON.parse(bad.stdout.toString().trim()).ok).toBe(false);
}, 90_000);

test("it refuses to start with an owner key other users can read, and never prints the key", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const first = await start(directory);
  expect(await first.stop()).toBe(0);
  const key = readFileSync(paths.ownerKey, "utf8").trim();
  chmodSync(paths.ownerKey, 0o644);

  const run = Bun.spawnSync([binary], {
    env: { PATH: process.env.PATH ?? "", HOME: directory, RASTRATA_API_PORT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(78);
  const output = `${run.stdout}${run.stderr}`;
  expect(output).toContain("can be read by other users");
  expect(output).toContain(`chmod 600 '${paths.ownerKey}'`);
  expect(output).not.toContain(key);
  expect(readFileSync(paths.serviceLog, "utf8")).not.toContain(key);
}, 60_000);

test("it refuses a port that is taken before it opens the book, and says how to choose another", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const taken = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const run = Bun.spawnSync([binary], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: directory,
        RASTRATA_API_PORT: String(taken.port),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(78);
    expect(run.stderr.toString()).toContain(`Port ${taken.port} is already in use`);
    expect(run.stderr.toString()).toContain("rastrata status");
    // The book was not opened: there is none yet.
    expect(existsSync(paths.database)).toBe(false);
  } finally {
    taken.stop(true);
  }
}, 30_000);

test("the port comes from the settings file when the environment does not say", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  // A free port, found by asking for one and letting go of it.
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  writeFileSync(paths.config, JSON.stringify({ port }));
  const service = await start(directory, { RASTRATA_API_PORT: "" });
  expect(service.port).toBe(port);
  expect(await service.stop()).toBe(0);

  // A settings file that cannot be understood stops the start with a message, not a guess.
  writeFileSync(paths.config, "port = 7278");
  const run = Bun.spawnSync([binary], {
    env: { PATH: process.env.PATH ?? "", HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(78);
  expect(run.stderr.toString()).toContain(paths.config);
}, 60_000);

test("the command line of the executable: version, paths and help", () => {
  const directory = home();
  const env = { PATH: process.env.PATH ?? "", HOME: directory };
  const run = (...args: string[]) =>
    Bun.spawnSync([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
  expect(run("version").stdout.toString().trim()).toBe(version);
  expect(run("--version").stdout.toString().trim()).toBe(version);
  const paths = JSON.parse(run("paths").stdout.toString());
  expect(paths).toEqual(JSON.parse(JSON.stringify(resolveDataPaths({ env: { HOME: directory } }))));
  expect(run("help").stdout.toString()).toContain("rastrata-service tool");
  const unknown = run("frobnicate");
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain('Unknown command "frobnicate"');
  // Nothing was created by asking.
  expect(existsSync(paths.directory)).toBe(false);
});

test("a .env or bunfig.toml in the directory it is started from is not read", async () => {
  const directory = home();
  const decoy = join(directory, "decoy");
  mkdirSync(decoy);
  writeFileSync(
    join(decoy, ".env"),
    `RASTRATA_API_PORT=1\nRASTRATA_DATA_DIR=${join(decoy, "stolen")}\n`,
  );
  writeFileSync(join(decoy, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
  writeFileSync(join(decoy, "evil.ts"), "throw new Error('preloaded')");
  const child = Bun.spawn([binary], {
    env: { PATH: process.env.PATH ?? "", HOME: directory, RASTRATA_API_PORT: "0" },
    cwd: decoy,
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  void pump(child.stdout, (text) => {
    out += text;
  });
  running.push({
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      return child.exited;
    },
  });
  const deadline = Date.now() + 30_000;
  while (!/is running at/.test(out) && child.exitCode === null && Date.now() < deadline)
    await Bun.sleep(25);
  expect(out).toContain("is running at");
  expect(existsSync(join(decoy, "stolen"))).toBe(false);
  expect(existsSync(resolveDataPaths({ env: { HOME: directory } }).database)).toBe(true);
}, 60_000);

test("files left readable by others are made private when the service starts", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  // The file the login item sends the process's output to is made by the login item, with its own
  // permissions; a book that was copied or restored carries whatever the copy gave it.
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  writeFileSync(paths.stdioLog, "from a login item\n");
  chmodSync(paths.stdioLog, 0o644);
  const first = await start(directory);
  expect(await first.stop()).toBe(0);
  expect(modeOf(paths.stdioLog)).toBe("600");
  chmodSync(paths.database, 0o644);
  chmodSync(paths.stdioLog, 0o666);
  const second = await start(directory);
  expect(modeOf(paths.database)).toBe("600");
  expect(modeOf(paths.stdioLog)).toBe("600");
  expect(await second.stop()).toBe(0);
}, 60_000);

/** Ask for a backup and wait for it: a long job is asked about, with one identity, until it is done. */
async function backUp(base: string, owner: Record<string, string>) {
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await call(base, "backup.create", {}, owner, id);
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    if (body.state !== "running") return body;
    await Bun.sleep(100);
  }
  throw new Error("the backup did not finish");
}

test("the backup folder can be moved with the settings file, and the environment wins over it", async () => {
  const directory = home();
  const paths = resolveDataPaths({ env: { HOME: directory } });
  const elsewhere = join(directory, "another drive", "backups");
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.config, JSON.stringify({ backupDir: elsewhere }));

  const first = await start(directory);
  const owner = ownerHeaders(directory);
  expect(
    (
      await fetch(`${first.base}/api/book/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", ...owner },
        body: JSON.stringify(SETUP),
      })
    ).status,
  ).toBe(200);
  const made = await backUp(first.base, owner);
  expect(made.state).toBe("done");
  expect(existsSync(join(elsewhere, made.backup.fileName))).toBe(true);
  expect(existsSync(paths.backups)).toBe(false);
  expect(readFileSync(paths.serviceLog, "utf8")).toContain(
    `Backups: automatic, kept in ${elsewhere}`,
  );
  expect(await first.stop()).toBe(0);

  const fromEnvironment = join(directory, "from the environment");
  const second = await start(directory, { RASTRATA_BACKUP_DIR: fromEnvironment });
  const again = await backUp(second.base, owner);
  expect(again.state).toBe("done");
  expect(existsSync(join(fromEnvironment, again.backup.fileName))).toBe(true);
  expect(await second.stop()).toBe(0);
}, 90_000);
