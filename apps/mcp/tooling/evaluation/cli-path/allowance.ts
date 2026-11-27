/** The programs a bookkeeper's shell may run: `rastrata`, and filters that read their input and write
 * into the project. One list for every driver and for the audit, so what an agent is allowed and what
 * the audit calls ordinary cannot drift apart.
 *
 * It has no interpreter and no program that starts another (`xargs`, `find`, `sh -c`): what such a
 * program does cannot be read from the command line. JSON is read with `jq`. (Claude Code's agent is
 * also given `python3`, which its operating-system sandbox contains: see `SANDBOXED_PROGRAMS`.) */
export const ALLOWED_PROGRAMS = [
  "rastrata",
  "jq",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "sed",
  "grep",
  "cat",
  "ls",
  "echo",
  "printf",
  "date",
  "diff",
  "column",
  "tee",
  "mkdir",
  "cp",
  "mv",
  "cd",
] as const;

/** What Claude Code's agent may also run: an interpreter, because the operating system's sandbox around
 * every command keeps it where the shell is (it reads the project and the system, writes the project,
 * reaches only this machine), and reading JSON is what a bookkeeper's agent does most. The first
 * baseline runs showed why: with it refused, one agent could not get a compact view of the Inbox and
 * stopped. Codex and opencode have no such sandbox and are not given it. */
export const SANDBOXED_PROGRAMS = ["python3"] as const;

/** Claude Code's list: a bookkeeper's, and the interpreter its sandbox contains. */
export const CLAUDE_PROGRAMS = [...ALLOWED_PROGRAMS, ...SANDBOXED_PROGRAMS] as const;

/** What the sandbox probe adds, on purpose: commands that must fail inside the sandbox (the
 * permission layer would refuse them first otherwise). */
export const PROBE_PROGRAMS = [...CLAUDE_PROGRAMS, "touch", "curl"] as const;

/** Programs that reach the network by themselves. */
export const NETWORK_PROGRAMS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
  "dig",
  "nslookup",
  "ping",
  "rsync",
  "traceroute",
  "nmap",
]);

/** Programs that change the machine or the user's account: never a bookkeeper's. */
export const SYSTEM_PROGRAMS: ReadonlySet<string> = new Set([
  "sudo",
  "su",
  "doas",
  "chmod",
  "chown",
  "chgrp",
  "kill",
  "pkill",
  "killall",
  "launchctl",
  "osascript",
  "open",
  "defaults",
  "security",
  "dscl",
  "diskutil",
  "mount",
  "umount",
  "systemctl",
  "crontab",
  "dd",
]);

/** Programs that can do anything the sandbox leaves them, or run other programs: outside a
 * bookkeeper's allowance, and read by what their command line shows. */
export const CAPABLE_PROGRAMS: ReadonlySet<string> = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "nodejs",
  "bun",
  "bunx",
  "deno",
  "ruby",
  "perl",
  "php",
  "lua",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "brew",
  "gem",
  "cargo",
  "go",
  "git",
  "make",
  "docker",
  "xargs",
  "find",
  "eval",
  "source",
  ".",
]);

/** Shells that run the command line in their next argument. */
export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
