#!/usr/bin/env bun
/** A manual check that the login item the installer writes works with the real launchd on this Mac:
 * it starts at load, is restarted after a crash, is not restarted after a clean stop, and goes away
 * on uninstall. Unlike the package smoke test, which runs against a stand-in for launchctl, this
 * talks to the real thing.
 *
 *   bun apps/api/tooling/check-launchd.ts [PACKAGE.tar.gz]
 *
 * It builds the package when none is given. It uses a home directory and a data directory of its own
 * (under the system's temporary folder) and a throwaway login item name (RASTRATA_SERVICE_LABEL), so
 * the real login item and your real books are never touched; it removes what it made when it ends,
 * whatever happened. It takes about a minute (it waits out launchd's ten second restart throttle). */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage } from "./package.ts";

if (process.platform !== "darwin") throw new Error("This checks launchd, so it runs on a Mac.");

const root = mkdtempSync(join(tmpdir(), "rastrata-launchd-check-"));
const uid = process.getuid?.() as number;
const throwaway = `com.rastrata.service.trial-${crypto.randomUUID().slice(0, 8)}`;
const target = `gui/${uid}/${throwaway}`;
const home = join(root, "home");
const data = join(root, "data");
const bin = join(home, ".local/bin");
const env = { HOME: home, RASTRATA_SERVICE_LABEL: throwaway };

interface Result {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}
const run = (command: string[], extra: Record<string, string> = {}): Result => {
  const done = Bun.spawnSync(command, {
    env: { ...process.env, ...extra } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: done.exitCode ?? -1,
    stdout: Buffer.from(done.stdout ?? ""),
    stderr: Buffer.from(done.stderr ?? ""),
  };
};
const rastrata = (...args: string[]) => run([join(bin, "rastrata"), ...args], env);
const launchd = () => run(["launchctl", "print", target]);
const field = (text: string, name: string) =>
  new RegExp(`^\\s*${name} = (.+)$`, "m").exec(text)?.[1];
const note = (text: string) => console.log(text);
const must = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

mkdirSync(home, { recursive: true });
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = probe.port;
probe.stop(true);
const address = `http://127.0.0.1:${port}`;
const health = async (): Promise<{ version: string } | null> => {
  try {
    const response = await fetch(`${address}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? ((await response.json()) as { version: string }) : null;
  } catch {
    return null;
  }
};
const waitFor = async (what: string, check: () => Promise<boolean> | boolean, seconds: number) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};

let failed = false;
try {
  must(launchd().exitCode !== 0, `${target} is already loaded: refusing to touch it`);
  const archive =
    process.argv[2] ?? (await buildPackage({ outDirectory: join(root, "dist") })).archive;
  mkdirSync(join(root, "package"));
  must(run(["tar", "-xzf", archive, "-C", join(root, "package")]).exitCode === 0, "cannot unpack");
  const top = join(root, "package", readdirSync(join(root, "package"))[0] as string);

  const install = run(
    ["sh", join(top, "install.sh"), "--port", String(port), "--data-dir", data],
    env,
  );
  must(install.exitCode === 0, `install.sh failed: ${install.stderr}`);
  const plist = join(home, "Library/LaunchAgents", `${throwaway}.plist`);
  note(`plutil: ${run(["plutil", "-lint", plist]).stdout.toString().trim()}`);
  const printed = launchd().stdout.toString();
  const first = Number(field(printed, "pid"));
  must(field(printed, "state") === "running" && first > 0, "launchd does not show it running");
  note(`started at load by launchd: pid ${first}; health ${JSON.stringify(await health())}`);
  must((await health()) !== null, "it does not answer");

  process.kill(first, "SIGKILL");
  note("killed it with SIGKILL; launchd restarts a crash after its throttle (10 s)");
  await waitFor(
    "a restart after a crash",
    async () => {
      const pid = Number(field(launchd().stdout.toString(), "pid"));
      return pid > 0 && pid !== first && (await health()) !== null;
    },
    45,
  );
  const second = Number(field(launchd().stdout.toString(), "pid"));
  note(`restarted after the crash: pid ${second}`);

  process.kill(second, "SIGTERM");
  await waitFor("the service to stop", async () => (await health()) === null, 20);
  await Bun.sleep(14_000);
  const idle = launchd();
  note(
    `after a clean stop and 14 s: loaded ${idle.exitCode === 0}, state ${field(idle.stdout.toString(), "state")}`,
  );
  must((await health()) === null, "it was restarted after a clean stop");
  must(
    readFileSync(join(data, "logs/service.log"), "utf8").includes("Stopped"),
    "the log does not say it stopped",
  );

  must(
    rastrata("start").exitCode === 0 && (await health()) !== null,
    "start did not bring it back",
  );
  must(rastrata("stop").exitCode === 0, "stop failed");
  await Bun.sleep(1000);
  must(launchd().exitCode !== 0 && (await health()) === null, "stop left it loaded or running");
  must(rastrata("status").exitCode === 3, "status of a stopped service must exit 3");
  must(rastrata("start").exitCode === 0 && (await health()) !== null, "start after stop failed");
  const doctor = rastrata("doctor", "--format", "text");
  note(doctor.stdout.toString());
  must(doctor.exitCode === 0, "doctor reports a failure");
} catch (error) {
  failed = true;
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  const uninstall = rastrata("uninstall");
  const gone = launchd().exitCode !== 0;
  const left = run(["pgrep", "-f", join(bin, "rastrata-service")])
    .stdout.toString()
    .trim();
  note(
    `uninstall exit ${uninstall.exitCode}; login item gone ${gone}; unit file gone ${!existsSync(join(home, "Library/LaunchAgents", `${throwaway}.plist`))}; processes left ${left || "none"}`,
  );
  if (!gone) run(["launchctl", "bootout", target]);
  for (const pid of left.split("\n").filter(Boolean)) process.kill(Number(pid), "SIGKILL");
  rmSync(root, { recursive: true, force: true });
  console.log(failed ? "RESULT: failed" : "RESULT: the real launchd does what the installer says");
  process.exit(failed ? 1 : 0);
}
