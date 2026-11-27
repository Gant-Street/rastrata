import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productVersion } from "../tooling/build-service.ts";
import { buildCliPackage, CLI_PLATFORMS, hostPlatform, platformName } from "../tooling/package.ts";

// The command line on its own (`bun run package --cli-only`): what a person or an agent who works on a hosted workspace installs. It is built for real, unpacked with the system's tar into a home
// directory of its own and installed by its own install.sh, which must put the one program in place, say what to do next, and refuse a package that is not the one that was built.

const version = productVersion();
const workspace = mkdtempSync(join(tmpdir(), "rastrata-cli-package-test-"));
const host = hostPlatform();
let built: Awaited<ReturnType<typeof buildCliPackage>>;

beforeAll(async () => {
  built = await buildCliPackage({ outDirectory: join(workspace, "dist") });
}, 300_000);
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const run = (command: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
  const done = Bun.spawnSync(command, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { PATH: process.env.PATH ?? "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

/** The package unpacked in a folder of its own. */
function unpack(label: string): string {
  const folder = join(workspace, `unpacked-${label}`);
  mkdirSync(folder, { recursive: true });
  expect(run(["tar", "-xzf", built.archive, "-C", folder]).code).toBe(0);
  return join(folder, built.name);
}

test("the command line is a package of its own: one program, an installer, a README, the version, the platform and the checksums, and nothing of the service", () => {
  expect(built.name).toBe(`rastrata-cli-${version}-${platformName(host)}`);
  const listed = run(["tar", "-tzf", built.archive]).out.split("\n").filter(Boolean).sort();
  expect(listed).toEqual(
    [
      `${built.name}/`,
      `${built.name}/PLATFORM`,
      `${built.name}/README.txt`,
      `${built.name}/SHA256SUMS`,
      `${built.name}/VERSION`,
      `${built.name}/bin/`,
      `${built.name}/bin/rastrata`,
      `${built.name}/install.sh`,
    ].sort(),
  );
  // The service, its templates and the web app are not in it: this is for a person whose books are on app.rastrata.com.
  expect(listed.join("\n")).not.toContain("rastrata-service");
  expect(listed.join("\n")).not.toContain("templates");
  // A command line is a few megabytes, not the service's tens.
  expect(statSync(built.archive).size).toBeLessThan(15 * 1048576);
  const checksum = readFileSync(built.checksumFile, "utf8").trim();
  expect(checksum).toBe(`${built.sha256}  ${built.name}.tar.gz`);
});

test("the same inputs are the same bytes", async () => {
  const again = await buildCliPackage({ outDirectory: join(workspace, "dist-again") });
  expect(again.sha256).toBe(built.sha256);
}, 300_000);

test("install.sh puts the program in the home directory and nothing else, says what to do next, and the program runs and says its release", () => {
  const top = unpack("install");
  const home = join(workspace, "home-install");
  mkdirSync(home, { recursive: true });
  const installed = run(["sh", join(top, "install.sh")], { env: { HOME: home } });
  expect(installed.code, installed.err).toBe(0);
  const program = join(home, ".local/bin/rastrata");
  expect(existsSync(program)).toBe(true);
  expect(statSync(program).mode & 0o111).not.toBe(0);
  expect(run([program, "version"]).out).toContain(version);
  // What it says is what to do on a hosted workspace.
  expect(installed.out).toContain("RASTRATA_API_URL=https://app.rastrata.com");
  expect(installed.out).toContain("rastrata agent status");
  // Nothing was set up besides the program: no service, no login item, no data directory.
  const made = run(["find", home, "-mindepth", "1", "-not", "-path", `${home}/.local*`]).out.trim();
  expect(made).toBe("");
  // Installing again over it works.
  expect(run(["sh", join(top, "install.sh")], { env: { HOME: home } }).code).toBe(0);
});

test("the program is the command line on its own: it goes to the hosted service, has no local service to look after, and says so in plain words", () => {
  const top = unpack("edition");
  const home = join(workspace, "home-edition");
  mkdirSync(home, { recursive: true });
  expect(run(["sh", join(top, "install.sh")], { env: { HOME: home } }).code).toBe(0);
  const program = join(home, ".local/bin/rastrata");
  const env = { HOME: home };
  // Its help is about a hosted workspace, and lists nothing that looks after a service on this computer.
  const help = run([program, "help"], { env }).out;
  expect(help).toContain("(default https://app.rastrata.com)");
  expect(help).toContain("your books are in your workspace at https://app.rastrata.com/");
  for (const looksAfterAService of [
    "\n  doctor ",
    "\n  start ",
    "\n  install ",
    "\n  restore ",
    "Start the Bun service",
  ])
    expect(help).not.toContain(looksAfterAService);
  expect(help).toContain("\n  agent status ");
  // A command that does look after a service answers in one sentence and sends nobody to a command it does not have.
  for (const command of ["doctor", "start", "status", "open", "uninstall", "update"]) {
    const answered = run([program, command], { env });
    expect(answered.code, command).toBe(2);
    expect(answered.err, command).toContain(
      `rastrata ${command} is not part of the command line on its own`,
    );
    expect(answered.err, command).toContain("https://app.rastrata.com/");
    expect(answered.out, command).toContain('"code":"not_in_this_package"');
  }
  // Nothing was made on the computer by asking.
  expect(run(["find", home, "-mindepth", "1", "-not", "-path", `${home}/.local*`]).out.trim()).toBe(
    "",
  );
});

test("a package that is not the one that was built is refused, and nothing is installed", () => {
  // A program that was changed.
  const changed = unpack("changed");
  writeFileSync(
    join(changed, "bin/rastrata"),
    `${readFileSync(join(changed, "bin/rastrata"), "latin1")}x`,
    "latin1",
  );
  const homeChanged = join(workspace, "home-changed");
  mkdirSync(homeChanged, { recursive: true });
  const refused = run(["sh", join(changed, "install.sh")], { env: { HOME: homeChanged } });
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain("SHA256SUMS");
  expect(existsSync(join(homeChanged, ".local/bin/rastrata"))).toBe(false);

  // A package for another kind of computer.
  const other = unpack("other");
  writeFileSync(join(other, "PLATFORM"), host.os === "darwin" ? "linux-amd64\n" : "darwin-arm64\n");
  const homeOther = join(workspace, "home-other");
  mkdirSync(homeOther, { recursive: true });
  const wrong = run(["sh", join(other, "install.sh")], { env: { HOME: homeOther } });
  expect(wrong.code).not.toBe(0);
  expect(wrong.err).toContain("this package is for");
  expect(existsSync(join(homeOther, ".local/bin/rastrata"))).toBe(false);
});

test("it is built for every computer an agent runs on, from this one: a cross-compile with no C toolchain", async () => {
  expect(CLI_PLATFORMS.map(platformName)).toEqual([
    "darwin-arm64",
    "darwin-amd64",
    "linux-arm64",
    "linux-amd64",
  ]);
  const other = CLI_PLATFORMS.find((platform) => platformName(platform) !== platformName(host));
  expect(other).toBeDefined();
  const foreign = await buildCliPackage({
    outDirectory: join(workspace, "dist-foreign"),
    ...(other ? { platform: other } : {}),
  });
  expect(foreign.name).toBe(`rastrata-cli-${version}-${other ? platformName(other) : ""}`);
  const top = join(workspace, "unpacked-foreign");
  mkdirSync(top, { recursive: true });
  expect(run(["tar", "-xzf", foreign.archive, "-C", top]).code).toBe(0);
  expect(readFileSync(join(top, foreign.name, "PLATFORM"), "utf8").trim()).toBe(
    other ? platformName(other) : "",
  );
}, 300_000);
