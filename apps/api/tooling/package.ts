#!/usr/bin/env bun
/** Build the install package: everything one person needs to run Rastrata on one computer.
 *
 *   bun run package [--target darwin-arm64|linux-amd64] [--out DIR] [--version X.Y.Z] [--web DIR]
 *   bun run package --cli-only [--target darwin-arm64|darwin-amd64|linux-arm64|linux-amd64|all] [--out DIR] [--version X.Y.Z]
 *
 * The second form writes rastrata-cli-<version>-<os>-<arch>.tar.gz: the command line on its own, for working on a hosted workspace (see `buildCliPackage`).
 *
 * writes <out>/rastrata-<version>-<os>-<arch>.tar.gz (default out: dist/) and its .sha256, with
 *
 *   bin/rastrata, bin/rastrata-service   the command line tool and the service (the web app inside)
 *   share/rastrata/templates/            the login item templates, which the tool also carries
 *   install.sh                           installs into ~/.local/bin and starts the login service
 *   README.txt, VERSION, PLATFORM
 *   SHA256SUMS                           the SHA-256 of every file above
 *
 * The archive is the same bytes for the same inputs: entries are sorted, owners and times are fixed
 * (the time of the commit), and the compression has no timestamp. Nothing is signed or published;
 * where a package is sent from is the founder's decision. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { buildService, productVersion, root } from "./build-service.ts";

export interface Platform {
  readonly os: "darwin" | "linux";
  readonly arch: "arm64" | "amd64";
}

const GO_MODULE = "github.com/Gant-Street/rastrata/apps/terminal";

export function hostPlatform(): Platform {
  return {
    os: process.platform === "darwin" ? "darwin" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "amd64",
  };
}

/** `darwin-arm64`, `linux-amd64` or `linux-x64`. */
export function parsePlatform(text: string): Platform {
  const match = /^(darwin|linux)-(arm64|amd64|x64)$/.exec(text);
  if (!match)
    throw new Error(`Unknown target "${text}": use darwin-arm64, linux-arm64 or linux-amd64`);
  return { os: match[1] as Platform["os"], arch: match[2] === "arm64" ? "arm64" : "amd64" };
}

export const platformName = (platform: Platform): string => `${platform.os}-${platform.arch}`;
/** The computers the command line on its own is built for with `--target all`. */
export const CLI_PLATFORMS: readonly Platform[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "amd64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "amd64" },
];
const bunTarget = (platform: Platform): string =>
  `bun-${platform.os}-${platform.arch === "arm64" ? "arm64" : "x64"}`;

function goBinary(): string {
  for (const candidate of [process.env.GO_BIN, join(homedir(), ".local/go/bin/go")])
    if (candidate && existsSync(candidate)) return candidate;
  const found = Bun.which("go");
  if (!found) throw new Error("Go is required to build the command line tool: set GO_BIN to it.");
  return found;
}

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : "";
}

/** The command line is one program in two editions: the package with the service stamps it "whole", and the command line on its own stamps it "cli" (it defaults to the hosted service and has no service commands). */
function buildCommandLine(
  outfile: string,
  platform: Platform,
  version: string,
  commit: string,
  edition: "whole" | "cli",
) {
  const flags = [
    "-s",
    "-w",
    `-X ${GO_MODULE}/internal/buildinfo.Version=${version}`,
    `-X ${GO_MODULE}/internal/buildinfo.Channel=installed`,
    `-X ${GO_MODULE}/internal/buildinfo.Edition=${edition}`,
    `-X ${GO_MODULE}/internal/buildinfo.Commit=${commit}`,
  ].join(" ");
  const run = Bun.spawnSync(
    [goBinary(), "build", "-trimpath", "-ldflags", flags, "-o", outfile, "./cmd/rastrata"],
    {
      cwd: join(root, "apps/terminal"),
      env: {
        ...process.env,
        GOOS: platform.os,
        GOARCH: platform.arch,
        CGO_ENABLED: "0",
        GOTOOLCHAIN: "local",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (run.exitCode !== 0)
    throw new Error(`go build failed (${run.exitCode}):\n${run.stdout}${run.stderr}`);
}

// ---- the archive ------------------------------------------------------------------------------

interface Entry {
  readonly path: string;
  readonly mode: number;
  readonly data?: Uint8Array;
}

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

/** One ustar header. Names must fit the 100 bytes of the name field: the package's paths are short
 * on purpose, and a longer one is a mistake worth stopping for. */
function header(entry: Entry, mtime: number): Buffer {
  const block = Buffer.alloc(512);
  const directory = entry.data === undefined;
  const name = directory ? `${entry.path}/` : entry.path;
  if (Buffer.byteLength(name) > 100)
    throw new Error(`The path is too long for a tar header: ${name}`);
  block.write(name, 0, "utf8");
  block.write(octal(entry.mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(entry.data?.byteLength ?? 0, 12), 124, "ascii");
  block.write(octal(mtime, 12), 136, "ascii");
  block.fill(0x20, 148, 156);
  block.write(directory ? "5" : "0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** A tar archive of the entries in the order given. */
export function tar(entries: readonly Entry[], mtime: number): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry, mtime));
    if (entry.data !== undefined && entry.data.byteLength > 0) {
      parts.push(Buffer.from(entry.data));
      parts.push(Buffer.alloc((512 - (entry.data.byteLength % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function listFiles(directory: string, base = directory): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory()
        ? listFiles(join(directory, item.name), base)
        : [relative(base, join(directory, item.name)).split("\\").join("/")],
    )
    .sort();
}

// ---- the package ------------------------------------------------------------------------------

export interface PackageOptions {
  readonly platform?: Platform;
  /** The folder the package is written to. */
  readonly outDirectory: string;
  readonly version?: string;
  /** An existing build of the web app, to save the time of building one. */
  readonly webDirectory?: string;
}

export interface BuiltPackage {
  readonly archive: string;
  readonly checksumFile: string;
  readonly sha256: string;
  readonly version: string;
  readonly platform: Platform;
  readonly name: string;
}

export async function buildPackage(options: PackageOptions): Promise<BuiltPackage> {
  const platform = options.platform ?? hostPlatform();
  const version = options.version ?? productVersion();
  const name = `rastrata-${version}-${platformName(platform)}`;
  const commit = git("rev-parse", "--short", "HEAD");
  const stage = mkdtempSync(join(tmpdir(), "rastrata-package-"));
  try {
    const top = join(stage, name);
    mkdirSync(join(top, "bin"), { recursive: true });
    mkdirSync(join(top, "share/rastrata/templates"), { recursive: true });

    const host = hostPlatform();
    await buildService({
      outfile: join(top, "bin/rastrata-service"),
      version,
      ...(options.webDirectory ? { webDirectory: options.webDirectory } : {}),
      ...(platformName(platform) === platformName(host) ? {} : { target: bunTarget(platform) }),
    });
    buildCommandLine(join(top, "bin/rastrata"), platform, version, commit, "whole");

    const templates = join(root, "apps/terminal/internal/service/templates");
    for (const file of readdirSync(templates))
      copyFileSync(join(templates, file), join(top, "share/rastrata/templates", file));
    copyFileSync(join(import.meta.dir, "package/install.sh"), join(top, "install.sh"));
    copyFileSync(join(import.meta.dir, "package/README.txt"), join(top, "README.txt"));
    writeFileSync(join(top, "VERSION"), `${version}\n`);
    writeFileSync(join(top, "PLATFORM"), `${platformName(platform)}\n`);
    for (const executable of ["bin/rastrata", "bin/rastrata-service", "install.sh"])
      chmodSync(join(top, executable), 0o755);

    // A package that cannot run is not worth shipping: where this machine can run it, it must say its
    // release, both programs.
    if (platformName(platform) === platformName(host))
      for (const program of ["bin/rastrata-service", "bin/rastrata"]) {
        const run = Bun.spawnSync([join(top, program), "version"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        if (run.exitCode !== 0 || !run.stdout.toString().includes(version))
          throw new Error(
            `${program} does not run or does not say ${version}: ${run.stdout}${run.stderr}`,
          );
      }

    const files = listFiles(top);
    const sums = files.map((file) => `${sha256(readFileSync(join(top, file)))}  ${file}`);
    writeFileSync(join(top, "SHA256SUMS"), `${sums.join("\n")}\n`);

    return writeArchive(
      top,
      name,
      ["", "bin", "share", "share/rastrata", "share/rastrata/templates"],
      options.outDirectory,
      version,
      platform,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** The archive of what is in `top`: the folders named (`""` is the package's own), then every file, in order, with owners and times fixed (the time of the commit) and the
 * compression without a timestamp, so that the same inputs are the same bytes. Written with its checksum file. */
function writeArchive(
  top: string,
  name: string,
  folders: readonly string[],
  outDirectory: string,
  version: string,
  platform: Platform,
): BuiltPackage {
  const mtime = Number(git("log", "-1", "--format=%ct")) || 0;
  const entries: Entry[] = [
    ...folders.map((folder) => ({ path: folder === "" ? name : `${name}/${folder}`, mode: 0o755 })),
    ...listFiles(top).map((file) => ({
      path: `${name}/${file}`,
      mode: statSync(join(top, file)).mode & 0o111 ? 0o755 : 0o644,
      data: readFileSync(join(top, file)),
    })),
  ];
  const archive = gzipSync(tar(entries, mtime), { level: 9 });
  mkdirSync(outDirectory, { recursive: true });
  const archivePath = join(outDirectory, `${name}.tar.gz`);
  writeFileSync(archivePath, archive);
  const digest = sha256(archive);
  const checksumFile = `${archivePath}.sha256`;
  writeFileSync(checksumFile, `${digest}  ${name}.tar.gz\n`);
  return { archive: archivePath, checksumFile, sha256: digest, version, platform, name };
}

/** The command line on its own, for a person or an agent who works on a hosted workspace: `rastrata`, an installer that puts it in `~/.local/bin` and nothing else, a README, the
 * checksums. No service, no login item, no web app: it is built in seconds and is a few megabytes. Made the same way as the package (the same bytes for the same inputs, nothing signed
 * or published; where it is sent from is the founder's decision). */
export async function buildCliPackage(options: PackageOptions): Promise<BuiltPackage> {
  const platform = options.platform ?? hostPlatform();
  const version = options.version ?? productVersion();
  const name = `rastrata-cli-${version}-${platformName(platform)}`;
  const commit = git("rev-parse", "--short", "HEAD");
  const stage = mkdtempSync(join(tmpdir(), "rastrata-cli-package-"));
  try {
    const top = join(stage, name);
    mkdirSync(join(top, "bin"), { recursive: true });
    buildCommandLine(join(top, "bin/rastrata"), platform, version, commit, "cli");
    copyFileSync(join(import.meta.dir, "package/install-cli.sh"), join(top, "install.sh"));
    copyFileSync(join(import.meta.dir, "package/README-cli.txt"), join(top, "README.txt"));
    writeFileSync(join(top, "VERSION"), `${version}\n`);
    writeFileSync(join(top, "PLATFORM"), `${platformName(platform)}\n`);
    for (const executable of ["bin/rastrata", "install.sh"])
      chmodSync(join(top, executable), 0o755);
    if (platformName(platform) === platformName(hostPlatform())) {
      const run = Bun.spawnSync([join(top, "bin/rastrata"), "version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (run.exitCode !== 0 || !run.stdout.toString().includes(version))
        throw new Error(
          `bin/rastrata does not run or does not say ${version}: ${run.stdout}${run.stderr}`,
        );
    }
    const sums = listFiles(top).map((file) => `${sha256(readFileSync(join(top, file)))}  ${file}`);
    writeFileSync(join(top, "SHA256SUMS"), `${sums.join("\n")}\n`);
    return writeArchive(top, name, ["", "bin"], options.outDirectory, version, platform);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const unknown = args.filter(
    (arg, index) =>
      arg.startsWith("--") &&
      !["--target", "--out", "--version", "--web", "--cli-only"].includes(arg) &&
      !(index > 0 && ["--target", "--out", "--version", "--web"].includes(args[index - 1] ?? "")),
  );
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown[0]}`);
  const target = value("--target");
  const version = value("--version");
  const web = value("--web");
  const cliOnly = args.includes("--cli-only");
  // `--target all` is for the command line on its own, which a Go cross-compile makes for every computer an agent runs on in seconds.
  if (target === "all" && !cliOnly)
    throw new Error(
      "--target all is for --cli-only: the package with the service is built on its own computer",
    );
  const platforms: readonly (Platform | undefined)[] =
    target === "all" ? CLI_PLATFORMS : [target ? parsePlatform(target) : undefined];
  for (const platform of platforms) {
    const options = {
      outDirectory: resolve(value("--out") ?? join(root, "dist")),
      ...(platform ? { platform } : {}),
      ...(version ? { version } : {}),
    };
    const built = cliOnly
      ? await buildCliPackage(options)
      : await buildPackage({ ...options, ...(web ? { webDirectory: resolve(web) } : {}) });
    console.info(
      `${built.archive}\n  ${(statSync(built.archive).size / 1048576).toFixed(1)} MB, sha256 ${built.sha256}`,
    );
  }
}
