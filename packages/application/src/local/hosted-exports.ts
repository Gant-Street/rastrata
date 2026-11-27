import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ApplicationError } from "../errors.ts";
import type { ExportArchive, ExportHost } from "../safety/host.ts";
import type { StoredExport } from "../safety/types.ts";
import { DirectoryExportSink, listExportFolders } from "./export-sink.ts";
import { zipStream } from "./zip.ts";

/** A place in line for the work of making an export, shared by every book of a pod: an export reads a whole book and writes it out, and a pod that served a hundred
 * people who all pressed the button at once would do nothing else. */
export interface ExportGate {
  /** Resolves with the way to give the place back (once) when it is this export's turn. */
  acquire(): Promise<() => void>;
}

/** A gate that lets `concurrent` exports run at once (one, by default) and the rest wait their turn, in the order they asked. */
export function createExportGate(concurrent = 1): ExportGate {
  let free = concurrent;
  const waiting: (() => void)[] = [];
  const give = (): void => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  const place = (): (() => void) => {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      give();
    };
  };
  return {
    acquire() {
      if (free > 0) {
        free -= 1;
        return Promise.resolve(place());
      }
      return new Promise((resolve) => waiting.push(() => resolve(place())));
    },
  };
}

export interface HostedExportOptions {
  /** The folder this book's exports are made in. */
  readonly directory: string;
  /** How long an export is kept, to be downloaded: an hour by default. */
  readonly keepForMs?: number;
  /** The most exports kept, the newest: three by default. */
  readonly keep?: number;
  /** The clock, in milliseconds, for tests. */
  readonly now?: () => number;
  /** The pod's turn-taking for the work, so that books do not all export at once. */
  readonly gate?: ExportGate;
  /** The least time between two exports of this book: a minute by default. The one that is there is good for an hour; asking for another is rarely what a person means. */
  readonly minGapMs?: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const WORKING = /^\.partial-/;

/** Exports on a hosted pod: the open export a book makes (the same files the installed application writes into its export folder), kept for an hour in a folder of the
 * book's own so that it can be downloaded as one zip, and then removed. The pod keeps the book's backups itself (the platform does), so this is all of the safety lane
 * it offers. The folder is the pod's scratch space: a restart that finds one a crash left removes it with the others. */
export function createHostedExportHost(options: HostedExportOptions): ExportHost {
  const { directory } = options;
  const keepFor = options.keepForMs ?? 3_600_000;
  const keep = options.keep ?? 3;
  const now = options.now ?? Date.now;
  const minGap = options.minGapMs ?? 60_000;
  let lastStart = Number.NEGATIVE_INFINITY;

  /** Remove what has been kept long enough, all but the newest few, and the working folders an export that stopped half way left. */
  async function prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return;
    }
    const folders: { name: string; at: number }[] = [];
    for (const name of names) {
      try {
        const info = await stat(join(directory, name));
        if (info.isDirectory()) folders.push({ name, at: info.mtimeMs });
      } catch {
        // Gone already.
      }
    }
    const finished = folders
      .filter((folder) => !WORKING.test(folder.name))
      .sort((left, right) => right.at - left.at);
    const doomed = [
      ...folders.filter((folder) => WORKING.test(folder.name) && now() - folder.at > keepFor),
      ...finished.filter((folder, index) => index >= keep || now() - folder.at > keepFor),
    ];
    await Promise.all(
      doomed.map((folder) => rm(join(directory, folder.name), { recursive: true, force: true })),
    );
  }

  /** Where an export is to be fetched from, which is all a person needs to know of it: the pod's folder is nobody's business. */
  const placed = (found: StoredExport): StoredExport => ({
    ...found,
    location: `/v1/exports/${found.id}`,
  });

  return {
    directories: { exports: "" },
    async beginExport(id) {
      if (now() - lastStart < minGap)
        throw new ApplicationError(
          "export_too_soon",
          "An export was made a moment ago. Fetch that one, or try again in a minute.",
          429,
          [],
          true,
        );
      lastStart = now();
      const release = options.gate ? await options.gate.acquire() : () => {};
      let sink: DirectoryExportSink;
      try {
        await prune();
        sink = new DirectoryExportSink(directory, id);
      } catch (error) {
        release();
        throw error;
      }
      // What the job reports as where it is, is where it is fetched from. Its place in line is given back when it ends, whichever way.
      return {
        file: (path) => sink.file(path),
        finish: async () => {
          try {
            await sink.finish();
          } finally {
            release();
          }
          return { location: `/v1/exports/${id}` };
        },
        abort: async () => {
          try {
            await sink.abort();
          } finally {
            release();
          }
        },
      };
    },
    async listExports() {
      await prune();
      return (await listExportFolders(directory)).map(placed);
    },
    async archive(id): Promise<ExportArchive | null> {
      if (!ID.test(id)) return null;
      await prune();
      const found = (await listExportFolders(directory)).find((candidate) => candidate.id === id);
      if (!found) return null;
      const files = (await readdir(found.location, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
      return {
        name: `${id}.zip`,
        body: zipStream(
          files.map((file) => ({ name: `${id}/${file}`, path: join(found.location, file) })),
        ),
      };
    },
  };
}
