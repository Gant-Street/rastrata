import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildPackage,
  hostPlatform,
  parsePlatform,
  platformName,
  tar,
} from "../tooling/package.ts";
import { productVersion } from "../tooling/build-service.ts";

// The package is built for real, unpacked with the system's tar into a home directory of its own, and
// installed by its own install.sh. Only the operating system's service manager is a double
// (launchctl or systemctl, scripts that keep state in a file and really start the program the unit
// names), so nothing here touches the machine's own login items.

const version = productVersion();
const workspace = mkdtempSync(join(tmpdir(), "rastrata-package-test-"));
const outDirectory = join(workspace, "dist");
const host = hostPlatform();
let built: Awaited<ReturnType<typeof buildPackage>>;

beforeAll(async () => {
  built = await buildPackage({ outDirectory });
}, 300_000);

const state = join(workspace, "manager-state");
afterAll(() => {
  // Whatever the double started is stopped before the files under it go.
  try {
    const pid = Number(readFileSync(join(state, "pid"), "utf8").trim());
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    // Nothing was running.
  }
  rmSync(workspace, { recursive: true, force: true });
});

const LAUNCHCTL = `#!/bin/sh
# A stand-in for launchctl: it keeps what launchd would know in $FAKE_CTL_STATE and really starts the
# program the plist names, so the installer can be run against it.
state="\${FAKE_CTL_STATE:?}"
mkdir -p "$state"
echo "launchctl $*" >> "$state/calls"
pidfile="$state/pid"
alive() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }
stop_service() {
  if alive; then
    kill -TERM "$(cat "$pidfile")" 2>/dev/null || true
    n=0
    while alive && [ "$n" -lt 200 ]; do sleep 0.1; n=$((n + 1)); done
    if alive; then kill -KILL "$(cat "$pidfile")" 2>/dev/null || true; fi
  fi
  rm -f "$pidfile"
}
start_service() {
  exe=$(sed -n '/<key>ProgramArguments<\\/key>/,/<\\/array>/s:.*<string>\\(/[^<]*\\)</string>.*:\\1:p' "$(cat "$state/plist")" | head -n 1)
  [ -x "$exe" ] || { echo "cannot execute $exe" >&2; exit 78; }
  nohup "$exe" serve >>"$state/stdio.log" 2>&1 </dev/null &
  echo $! > "$pidfile"
}
case "$1" in
  bootstrap)
    if [ -f "$state/loaded" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi
    echo "$3" > "$state/plist"
    touch "$state/loaded"
    start_service ;;
  bootout)
    if [ ! -f "$state/loaded" ]; then echo "Boot-out failed: 3: No such process" >&2; exit 3; fi
    stop_service
    rm -f "$state/loaded" ;;
  kickstart)
    if [ ! -f "$state/loaded" ]; then echo "Could not find service" >&2; exit 113; fi
    alive || start_service ;;
  print)
    if [ ! -f "$state/loaded" ]; then echo "Could not find service \\"com.rastrata.service\\" in domain" >&2; exit 113; fi
    if alive; then
      printf 'gui/501/com.rastrata.service = {\\n\\ttype = LaunchAgent\\n\\tstate = running\\n\\tpid = %s\\n}\\n' "$(cat "$pidfile")"
    else
      printf 'gui/501/com.rastrata.service = {\\n\\ttype = LaunchAgent\\n\\tstate = not running\\n}\\n'
    fi ;;
  *) echo "unsupported: $*" >&2; exit 64 ;;
esac
`;

const SYSTEMCTL = `#!/bin/sh
# A stand-in for systemctl --user: the same idea as the launchctl one, for the systemd unit.
state="\${FAKE_CTL_STATE:?}"
mkdir -p "$state"
echo "systemctl $*" >> "$state/calls"
[ "$1" = "--user" ] || { echo "this double only serves systemctl --user" >&2; exit 64; }
shift
pidfile="$state/pid"
unit="$HOME/.config/systemd/user/rastrata.service"
alive() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }
stop_service() {
  if alive; then
    kill -TERM "$(cat "$pidfile")" 2>/dev/null || true
    n=0
    while alive && [ "$n" -lt 200 ]; do sleep 0.1; n=$((n + 1)); done
    if alive; then kill -KILL "$(cat "$pidfile")" 2>/dev/null || true; fi
  fi
  rm -f "$pidfile"
}
start_service() {
  exe=$(sed -n 's/^ExecStart="\\([^"]*\\)" serve.*/\\1/p' "$unit" | head -n 1)
  [ -x "$exe" ] || { echo "cannot execute $exe" >&2; exit 203; }
  nohup "$exe" serve >>"$state/stdio.log" 2>&1 </dev/null &
  echo $! > "$pidfile"
}
case "$1" in
  daemon-reload) ;;
  enable) touch "$state/enabled" ;;
  disable) rm -f "$state/enabled" ;;
  start) touch "$state/loaded"; alive || start_service ;;
  restart) touch "$state/loaded"; stop_service; start_service ;;
  stop) stop_service ;;
  show)
    load=not-found; active=inactive; sub=dead; pid=0
    if [ -f "$unit" ]; then load=loaded; fi
    if alive; then active=active; sub=running; pid=$(cat "$pidfile"); fi
    printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nMainPID=%s\\n' "$load" "$active" "$sub" "$pid" ;;
  *) echo "unsupported: $*" >&2; exit 64 ;;
esac
`;

function doubles(): string {
  const directory = join(workspace, "doubles");
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of [
    ["launchctl", LAUNCHCTL],
    ["systemctl", SYSTEMCTL],
  ] as const) {
    writeFileSync(join(directory, name), text);
    chmodSync(join(directory, name), 0o755);
  }
  return directory;
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

test("the package has what it says, in the shape it says, and its checksums hold", async () => {
  expect(built.name).toBe(`rastrata-${version}-${platformName(host)}`);
  expect(built.archive).toBe(join(outDirectory, `${built.name}.tar.gz`));

  // The checksum file beside it is the archive's SHA-256, in the format shasum reads.
  const archive = readFileSync(built.archive);
  expect(readFileSync(built.checksumFile, "utf8")).toBe(
    `${sha256(archive)}  ${built.name}.tar.gz\n`,
  );

  // The system's own tar reads it (bsdtar on a Mac, GNU tar elsewhere) and finds only the package's folder.
  const extracted = join(workspace, "extracted");
  mkdirSync(extracted);
  const untar = Bun.spawnSync(["tar", "-xzf", built.archive, "-C", extracted], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(untar.exitCode, untar.stderr.toString()).toBe(0);
  expect(readdirSync(extracted)).toEqual([built.name]);
  const top = join(extracted, built.name);
  const listing = Bun.spawnSync(["tar", "-tzf", built.archive], { stdout: "pipe" })
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
  expect(
    listing.every((entry) => entry.startsWith(`${built.name}/`) || entry === `${built.name}/`),
  ).toBe(true);
  expect(listing.some((entry) => entry.split("/").some((part) => part.startsWith("._")))).toBe(
    false,
  );

  const files = (directory: string, base = directory): string[] =>
    readdirSync(directory, { withFileTypes: true })
      .flatMap((item) =>
        item.isDirectory()
          ? files(join(directory, item.name), base)
          : [join(directory, item.name).slice(base.length + 1)],
      )
      .sort();
  expect(files(top)).toEqual([
    "PLATFORM",
    "README.txt",
    "SHA256SUMS",
    "VERSION",
    "bin/rastrata",
    "bin/rastrata-service",
    "install.sh",
    "share/rastrata/templates/com.rastrata.service.plist.tmpl",
    "share/rastrata/templates/rastrata.service.tmpl",
  ]);
  for (const executable of ["bin/rastrata", "bin/rastrata-service", "install.sh"])
    expect(modeOf(join(top, executable)), executable).toBe("755");
  for (const data of ["README.txt", "VERSION", "PLATFORM", "SHA256SUMS"])
    expect(modeOf(join(top, data)), data).toBe("644");
  expect(readFileSync(join(top, "VERSION"), "utf8")).toBe(`${version}\n`);
  expect(readFileSync(join(top, "PLATFORM"), "utf8")).toBe(`${platformName(host)}\n`);

  // SHA256SUMS lists every other file, and the system's own tools agree with it.
  const sums = readFileSync(join(top, "SHA256SUMS"), "utf8").trim().split("\n");
  expect(sums.map((line) => line.slice(66))).toEqual(
    files(top).filter((file) => file !== "SHA256SUMS"),
  );
  for (const line of sums) {
    expect(line.slice(0, 64)).toBe(sha256(readFileSync(join(top, line.slice(66)))));
  }
  const check = Bun.spawnSync(
    [
      Bun.which("shasum") ? "shasum" : "sha256sum",
      ...(Bun.which("shasum") ? ["-a", "256"] : []),
      "-c",
      "SHA256SUMS",
    ],
    { cwd: top, stdout: "pipe", stderr: "pipe" },
  );
  expect(check.exitCode, check.stdout.toString() + check.stderr.toString()).toBe(0);

  // The templates in the package are the ones the command line carries.
  for (const name of ["com.rastrata.service.plist.tmpl", "rastrata.service.tmpl"])
    expect(readFileSync(join(top, "share/rastrata/templates", name), "utf8")).toBe(
      readFileSync(
        resolve(import.meta.dir, "../../terminal/internal/service/templates", name),
        "utf8",
      ),
    );
  // The programs say their release.
  for (const program of ["bin/rastrata-service", "bin/rastrata"])
    expect(
      Bun.spawnSync([join(top, program), "version"], { stdout: "pipe" }).stdout.toString(),
    ).toContain(version);
}, 60_000);

test("the archive writer makes the same bytes for the same files, and tar and gzip read them", () => {
  const entries = [
    { path: "top", mode: 0o755 },
    { path: "top/a.txt", mode: 0o644, data: new TextEncoder().encode("hello\n") },
    { path: "top/run", mode: 0o755, data: new Uint8Array(1000).fill(7) },
    { path: "top/empty", mode: 0o644, data: new Uint8Array(0) },
  ];
  const first = tar(entries, 1_700_000_000);
  expect(sha256(first)).toBe(sha256(tar(entries, 1_700_000_000)));
  expect(first.length % 512).toBe(0);
  const directory = mkdtempSync(join(workspace, "tar-"));
  writeFileSync(join(directory, "x.tar"), first);
  const listing = Bun.spawnSync(["tar", "-tvf", join(directory, "x.tar")], {
    stdout: "pipe",
  }).stdout.toString();
  expect(listing).toContain("top/a.txt");
  expect(listing).toMatch(/-rwxr-xr-x.*top\/run/);
  expect(Bun.spawnSync(["tar", "-xf", join(directory, "x.tar"), "-C", directory]).exitCode).toBe(0);
  expect(readFileSync(join(directory, "top/a.txt"), "utf8")).toBe("hello\n");
  expect(readFileSync(join(directory, "top/run")).length).toBe(1000);
  expect(readFileSync(join(directory, "top/empty")).length).toBe(0);
  expect(() =>
    tar([{ path: `top/${"x".repeat(120)}`, mode: 0o644, data: new Uint8Array(1) }], 0),
  ).toThrow("too long");
});

test("a package for another computer is built too: Linux x64 at least builds", async () => {
  // Cross-building Bun's executable fetches the runtime for the other system once; with no network
  // this cannot be checked here, and says so rather than failing the build of the real package.
  const target = parsePlatform("linux-amd64");
  let other: Awaited<ReturnType<typeof buildPackage>>;
  try {
    other = await buildPackage({ outDirectory: join(workspace, "dist-linux"), platform: target });
  } catch (error) {
    const message = String(error);
    if (/download|ENOTFOUND|ECONNREFUSED|network|fetch failed|getaddrinfo/i.test(message)) {
      console.warn("skipped: the Linux runtime could not be downloaded here");
      return;
    }
    throw error;
  }
  expect(other.name).toBe(`rastrata-${version}-linux-amd64`);
  const extracted = join(workspace, "extracted-linux");
  mkdirSync(extracted);
  expect(Bun.spawnSync(["tar", "-xzf", other.archive, "-C", extracted]).exitCode).toBe(0);
  for (const program of ["bin/rastrata", "bin/rastrata-service"]) {
    const bytes = readFileSync(join(extracted, other.name, program));
    expect(Array.from(bytes.subarray(0, 4)), program).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  }
  expect(readFileSync(join(extracted, other.name, "PLATFORM"), "utf8")).toBe("linux-amd64\n");
}, 300_000);

test("install.sh installs, the commands work, the service updates, rolls back, and uninstalls", async () => {
  const home = mkdtempSync(join(workspace, "home-"));
  const port = await freePort();
  const doublesDirectory = doubles();
  const env: Record<string, string> = {
    // ~/.local/bin is not on the PATH, as on a fresh Mac: the installer says how to add it.
    PATH: `${doublesDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    FAKE_CTL_STATE: state,
  };
  const run = (command: string[], extra: Record<string, string> = {}) =>
    Bun.spawnSync(command, {
      env: { ...env, ...extra },
      stdout: "pipe",
      stderr: "pipe",
      cwd: home,
    });
  const rastrata = (...args: string[]) => run([join(home, ".local/bin/rastrata"), ...args]);
  const json = (result: ReturnType<typeof run>) => JSON.parse(result.stdout.toString());

  const extracted = join(workspace, "extracted-install");
  mkdirSync(extracted);
  expect(Bun.spawnSync(["tar", "-xzf", built.archive, "-C", extracted]).exitCode).toBe(0);
  const top = join(extracted, built.name);

  // ---- install ----
  const install = run(["sh", join(top, "install.sh"), "--port", String(port)]);
  expect(install.exitCode, install.stderr.toString() + install.stdout.toString()).toBe(0);
  const address = `http://127.0.0.1:${port}`;
  expect(install.stdout.toString()).toContain(`Open it:    ${address}`);
  expect(install.stdout.toString()).toContain("To use the rastrata command, add");

  const bin = join(home, ".local/bin");
  expect(modeOf(join(bin, "rastrata"))).toBe("755");
  expect(modeOf(join(bin, "rastrata-service"))).toBe("755");
  expect(readdirSync(bin).filter((name) => name.startsWith("."))).toEqual([]);
  const dataDirectory =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Rastrata")
      : join(home, ".local/share/rastrata");
  expect(modeOf(dataDirectory)).toBe("700");
  expect(modeOf(join(dataDirectory, "owner.key"))).toBe("600");
  expect(JSON.parse(readFileSync(join(dataDirectory, "config.json"), "utf8"))).toEqual({ port });
  const unit =
    process.platform === "darwin"
      ? join(home, "Library/LaunchAgents/com.rastrata.service.plist")
      : join(home, ".config/systemd/user/rastrata.service");
  expect(readFileSync(unit, "utf8")).toContain(join(bin, "rastrata-service"));
  expect(existsSync(join(state, "calls"))).toBe(true);

  // ---- the installed command line, with nothing configured, finds the service and the key ----
  const health = await fetch(`${address}/health`);
  expect(await health.json()).toEqual({
    ok: true,
    service: "rastrata",
    version,
    warming: false,
    warmup: { state: "ready", entries: 0, seconds: 0 },
  });
  const status = json(rastrata("status", "--format", "json"));
  expect(status.data.running).toBe(true);
  expect(status.data.answering).toBe(true);
  expect(status.data.address).toBe(address);
  expect(status.data.dataDirectory).toBe(dataDirectory);
  const context = rastrata("context");
  expect(context.exitCode, context.stderr.toString()).toBe(0);
  expect(json(context).data.ownerAccess).toBe("key");
  // A request with no key is refused: the lock is on.
  const bare = await fetch(`${address}/v1/book.get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: "rastrata-application-v1", bookId: "local-book", input: {} }),
  });
  expect(bare.status).toBe(401);
  expect(rastrata("open", "--print", "--format", "json").stdout.toString()).toContain(
    `${address}/`,
  );

  // ---- set up a book and take a backup through the packaged binaries, workers and all ----
  writeFileSync(
    join(home, "setup.json"),
    JSON.stringify({
      name: "Package Co",
      currency: "USD",
      fiscalYear: 2026,
      periodModel: "monthly",
      accounts: [
        { code: "1000", name: "Cash", role: "asset" },
        { code: "3000", name: "Capital", role: "equity" },
      ],
    }),
  );
  const setup = rastrata("book", "setup", "--input", join(home, "setup.json"));
  expect(setup.exitCode, setup.stderr.toString()).toBe(0);
  const backup = rastrata("backup", "create");
  expect(backup.exitCode, backup.stderr.toString()).toBe(0);
  const verify = rastrata("backup", "verify");
  expect(verify.exitCode, verify.stderr.toString()).toBe(0);
  expect(json(verify).data.verification.passed).toBe(true);
  expect(
    readdirSync(join(dataDirectory, "backups/book")).some((name) => name.endsWith(".sqlite")),
  ).toBe(true);

  // One journal, posted as the owner, so that the size doctor reports below is a number the running
  // service gave and not a default on either side.
  {
    const ownerKey = readFileSync(join(dataDirectory, "owner.key"), "utf8").trim();
    const call = async (name: string, input: unknown, operationId?: string) =>
      (
        await fetch(`${address}/v1/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
          body: JSON.stringify({
            version: "rastrata-application-v1",
            bookId: "local-book",
            input,
            ...(operationId ? { operationId } : {}),
          }),
        })
      ).json();
    const draft = await call(
      "drafts.create",
      {
        data: {
          date: "2026-01-15",
          reference: "P1",
          narration: "Capital",
          lines: [
            { accountId: "1000", debit: "10.00", credit: "" },
            { accountId: "3000", debit: "", credit: "10.00" },
          ],
        },
      },
      crypto.randomUUID(),
    );
    const prepared = await call(
      "journal.prepare",
      { draftId: draft.data.id, expectedVersion: 1 },
      crypto.randomUUID(),
    );
    const committed = await call("operations.commit", {
      planId: prepared.data.planId,
      planHash: prepared.data.planHash,
    });
    expect(committed.data.disposition).toBe("committed");
  }

  // ---- doctor: nothing fails on a fresh install; the backups' place is pointed at ----
  const doctor = rastrata("doctor", "--format", "json");
  expect(doctor.exitCode, doctor.stdout.toString()).toBe(0);
  const checks = json(doctor).data.checks as { name: string; status: string; message: string }[];
  expect(checks.filter((check) => check.status === "fail")).toEqual([]);
  expect(checks.find((check) => check.name === "Owner lock")?.status).toBe("ok");
  // The service's own count, read by the command through the owner key.
  expect(checks.find((check) => check.name === "Capacity")).toMatchObject({
    status: "ok",
    message: expect.stringContaining("1 journal so far, a small book"),
  });
  expect(checks.find((check) => check.name === "Backup place")?.message).toContain("same disk");
  expect(doctor.stdout.toString()).not.toContain(
    readFileSync(join(dataDirectory, "owner.key"), "utf8").trim(),
  );

  // ---- logs ----
  const logs = rastrata("logs", "--lines", "20");
  expect(logs.stdout.toString()).toContain(`Listening on ${address}/`);

  // ---- stop and start ----
  expect(rastrata("stop").exitCode).toBe(0);
  expect(rastrata("status").exitCode).toBe(3);
  await expect(fetch(`${address}/health`)).rejects.toBeDefined();
  expect(readFileSync(join(dataDirectory, "logs/service.log"), "utf8")).toContain("Stopped");
  expect(rastrata("start").exitCode).toBe(0);
  expect(json(rastrata("context")).data.setup.name).toBe("Package Co");

  // ---- restore: with no Bun anywhere, the installed command puts the newest backup over the book,
  // and only once the service has let go of it ----
  const running = rastrata("restore", "latest", "--replace");
  expect(running.exitCode).toBe(3);
  expect(running.stdout.toString()).toContain("rastrata stop");
  expect(rastrata("stop").exitCode).toBe(0);
  const restore = rastrata("restore", "latest", "--replace");
  expect(restore.exitCode, restore.stdout.toString() + restore.stderr.toString()).toBe(0);
  expect(json(restore).ok).toBe(true);
  expect(readdirSync(dataDirectory).some((name) => name.startsWith("book.sqlite.replaced-"))).toBe(
    true,
  );
  expect(rastrata("start").exitCode).toBe(0);
  expect(json(rastrata("context")).data.setup.name).toBe("Package Co");

  // ---- installing again over itself is allowed, keeps the key and the book ----
  const key = readFileSync(join(dataDirectory, "owner.key"), "utf8");
  const again = run(["sh", join(top, "install.sh"), "--port", String(port)]);
  expect(again.exitCode, again.stderr.toString()).toBe(0);
  expect(readFileSync(join(dataDirectory, "owner.key"), "utf8")).toBe(key);
  expect(json(rastrata("context")).data.setup.name).toBe("Package Co");

  // ---- update to a newer package: backed up first, programs replaced, the new release answers ----
  const newer = await buildPackage({
    outDirectory: join(workspace, "dist-newer"),
    version: "0.1.1",
  });
  const beforeBackups = readdirSync(join(dataDirectory, "backups/book")).filter((name) =>
    name.endsWith(".sqlite"),
  ).length;
  const update = rastrata("update", "--from", newer.archive, "--format", "json");
  expect(update.exitCode, update.stdout.toString() + update.stderr.toString()).toBe(0);
  expect(json(update).data.To).toBe("0.1.1");
  expect(await (await fetch(`${address}/health`)).json()).toMatchObject({
    ok: true,
    service: "rastrata",
    version: "0.1.1",
  });
  expect(rastrata("version").stdout.toString()).toContain("rastrata 0.1.1");
  expect(readdirSync(bin).sort()).toEqual([
    "rastrata",
    "rastrata-service",
    "rastrata-service.previous",
    "rastrata.previous",
  ]);
  expect(
    readdirSync(join(dataDirectory, "backups/book")).filter((name) => name.endsWith(".sqlite"))
      .length,
  ).toBeGreaterThan(beforeBackups);
  expect(json(rastrata("context")).data.setup.name).toBe("Package Co");

  // ---- a downgrade must be asked for; a damaged package changes nothing ----
  const refused = rastrata("update", "--from", built.archive);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stdout.toString()).toContain("--allow-downgrade");
  expect(await (await fetch(`${address}/health`)).json()).toMatchObject({
    ok: true,
    service: "rastrata",
    version: "0.1.1",
  });
  const damagedPath = join(workspace, `rastrata-0.1.2-${platformName(host)}.tar.gz`);
  const damaged = Buffer.from(readFileSync(newer.archive));
  const middle = Math.floor(damaged.length / 2);
  damaged[middle] = (damaged[middle] ?? 0) ^ 0xff;
  writeFileSync(damagedPath, damaged);
  const broken = rastrata("update", "--from", damagedPath);
  expect(broken.exitCode).not.toBe(0);
  expect(await (await fetch(`${address}/health`)).json()).toMatchObject({
    ok: true,
    service: "rastrata",
    version: "0.1.1",
  });
  const allowed = rastrata("update", "--from", built.archive, "--allow-downgrade");
  expect(allowed.exitCode, allowed.stdout.toString() + allowed.stderr.toString()).toBe(0);
  expect(await (await fetch(`${address}/health`)).json()).toMatchObject({
    ok: true,
    service: "rastrata",
    version,
  });

  // ---- uninstall: the programs and the login item go, the books stay ----
  const uninstall = rastrata("uninstall", "--format", "text");
  expect(uninstall.exitCode, uninstall.stderr.toString()).toBe(0);
  expect(uninstall.stdout.toString()).toContain("Your books and backups are still in");
  expect(existsSync(unit)).toBe(false);
  expect(readdirSync(bin)).toEqual([]);
  await expect(fetch(`${address}/health`)).rejects.toBeDefined();
  expect(statSync(join(dataDirectory, "book.sqlite")).size).toBeGreaterThan(0);
  expect(existsSync(join(dataDirectory, "owner.key"))).toBe(true);
  expect(sha256(readFileSync(built.archive))).toBe(built.sha256);
}, 600_000);
