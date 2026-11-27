/** What the page keeps on the device of what it has read of the book, so that the next time it opens it can draw from it before the service has answered (held.ts; docs/reference/program/
 * performance.md, "Under 100 ms" and "Privacy of a copy on the device"). It is kept locked. Each answer is encrypted (AES-GCM) with a key that is not kept with it: the key comes with the
 * token (the control Worker's `copyKey`), which only a person with a live session has, and is made from the session, the person and the workspace, so that it is the same all through one
 * session and is no use for another. When the session ends there is no way to make the key again, and what is on the device cannot be read; the page also deletes it at sign-out. What a
 * record says in the clear is the workspace it belongs to (which is in the address), the build of the page that made it and when: not what the answer was, nor what was asked, which is inside it.
 * A page reads back only what a page of its own build made: a release may change what an answer holds (the contract lets a reply gain fields), and a page must not be given what its code was not
 * written for; what an older build left is deleted when the copy is opened.
 *
 * Nothing here ever fails the page. A browser without storage (a private window, a blocked profile) has no copy, and one that cannot be read or locked again is deleted. */

const DATABASE = "rastrata-copy";
const STORE = "answers";
/** The most the device keeps of one workspace's answers, so that unlocking them (decrypting them all) stays a small part of a page's start. */
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 300;

export interface Answer {
  /** What it was held under (held.ts). */
  readonly key: string;
  readonly text: string;
  readonly at: number;
}

interface StoredRecord {
  /** A hash of the key, so that what was asked is not in the clear. */
  readonly id: string;
  readonly scope: string;
  /** The build of the page that made it. */
  readonly build: string;
  readonly at: number;
  readonly iv: Uint8Array;
  readonly data: Uint8Array;
}

/** Where the locked records are put: the browser's IndexedDB, or a stand-in in a test. */
export interface Place {
  records(scope: string): Promise<StoredRecord[]>;
  put(records: StoredRecord[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /** Everything of every workspace. */
  wipe(): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const unbase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function idOf(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Copy {
  readonly #place: Place;
  readonly #build: string;
  #key: CryptoKey | null = null;
  #scope = "";
  readonly #queued = new Map<string, Answer>();
  #flush: ReturnType<typeof setTimeout> | undefined;
  #written: Promise<void> = Promise.resolve();

  constructor(place: Place | null = indexedPlace(), build = "dev") {
    this.#place = place ?? nowhere;
    this.#build = build;
  }

  /** Unlock the copy of `scope` with the key that came with the token, and give back what was in it, newest first. A record that cannot be read with this key (it is from another session,
   * or was damaged) is deleted. Never throws: no copy is what it gives back when it cannot. */
  async unlock(rawKey: string, scope: string): Promise<Answer[]> {
    try {
      const key = await crypto.subtle.importKey("raw", unbase64(rawKey), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
      this.#key = key;
      this.#scope = scope;
      const everything = await this.#place.records(scope);
      // What an older build of the page left is not read, and is deleted.
      const bad: string[] = everything
        .filter((record) => record.build !== this.#build)
        .map((record) => record.id);
      const stored = everything.filter((record) => record.build === this.#build);
      const answers = (
        await Promise.all(
          stored.map(async (record): Promise<Answer | null> => {
            try {
              const clear = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: record.iv as Uint8Array<ArrayBuffer> },
                key,
                record.data as Uint8Array<ArrayBuffer>,
              );
              const parsed = JSON.parse(decoder.decode(clear)) as Partial<Answer>;
              if (typeof parsed.key !== "string" || typeof parsed.text !== "string")
                throw new Error();
              return { key: parsed.key, text: parsed.text, at: record.at };
            } catch {
              bad.push(record.id);
              return null;
            }
          }),
        )
      ).filter((answer): answer is Answer => answer !== null);
      if (bad.length > 0) await this.#place.remove(bad).catch(() => {});
      return answers.sort((a, b) => b.at - a.at);
    } catch {
      this.#key = null;
      return [];
    }
  }

  /** Keep an answer. Not before the copy is unlocked: nothing is written that could not be read back. It is written a moment later, with the others that were kept meanwhile. */
  save(answer: Answer): void {
    if (this.#key === null) return;
    this.#queued.set(answer.key, answer);
    this.#flush ??= setTimeout(() => {
      this.#flush = undefined;
      this.#written = this.#write().catch(() => {});
    }, 400);
  }

  async #write(): Promise<void> {
    const key = this.#key;
    const batch = [...this.#queued.values()];
    this.#queued.clear();
    if (key === null || batch.length === 0) return;
    const records = await Promise.all(
      batch.map(async (answer): Promise<StoredRecord> => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          encoder.encode(JSON.stringify({ key: answer.key, text: answer.text })),
        );
        return {
          id: await idOf(answer.key),
          scope: this.#scope,
          build: this.#build,
          at: answer.at,
          iv,
          data: new Uint8Array(data),
        };
      }),
    );
    await this.#place.put(records);
    await this.#trim();
  }

  /** The least recently made go when there are too many or they are too big. */
  async #trim(): Promise<void> {
    const all = (await this.#place.records(this.#scope)).sort((a, b) => b.at - a.at);
    let bytes = 0;
    const drop: string[] = [];
    all.forEach((record, index) => {
      bytes += record.data.length;
      if (index >= MAX_RECORDS || bytes > MAX_BYTES) drop.push(record.id);
    });
    if (drop.length > 0) await this.#place.remove(drop);
  }

  /** What was kept of this workspace is stale: a change was made. Whatever was waiting to be written is dropped too. */
  async erase(): Promise<void> {
    this.#queued.clear();
    await this.#written;
    try {
      const ids = (await this.#place.records(this.#scope)).map((record) => record.id);
      if (ids.length > 0) await this.#place.remove(ids);
    } catch {
      // A copy that cannot be erased is locked, and the key is gone with the session.
    }
  }

  /** The person has signed out or been taken out: everything on the device of every workspace is deleted, and the key is let go. */
  async forget(): Promise<void> {
    this.#key = null;
    this.#queued.clear();
    if (this.#flush !== undefined) clearTimeout(this.#flush);
    this.#flush = undefined;
    try {
      await this.#place.wipe();
    } catch {
      // See `erase`.
    }
  }

  /** Whatever has been kept has been written (for a test, and for a page that is being left). */
  async settled(): Promise<void> {
    if (this.#flush !== undefined) {
      clearTimeout(this.#flush);
      this.#flush = undefined;
      this.#written = this.#write().catch(() => {});
    }
    await this.#written;
  }
}

/** Delete everything of every workspace that is on this device. It needs no key: it is what the sign-in page does when someone signs out or deletes their account, and it holds nothing of
 * the book itself (the application's own is `forgetCopy`, held.ts). Never throws: a device that cannot be wiped has only what is locked, and the key is gone with the session. */
export async function wipeDevice(): Promise<void> {
  try {
    await indexedPlace()?.wipe();
  } catch {
    // See above.
  }
}

/** No storage: nothing is kept and nothing is found. */
const nowhere: Place = {
  records: async () => [],
  put: async () => {},
  remove: async () => {},
  wipe: async () => {},
};

/** The browser's IndexedDB, or `null` where there is none or it cannot be opened. */
export function indexedPlace(): Place | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("scope", "scope");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked"));
    });
    // A database that could not be opened is tried again by the next call.
    opened.catch(() => {
      opened = undefined;
    });
    return opened;
  };
  const done = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const finished = (transaction: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  return {
    async records(scope) {
      const store = (await open()).transaction(STORE, "readonly").objectStore(STORE);
      return (await done(store.index("scope").getAll(scope))) as StoredRecord[];
    },
    async put(records) {
      const transaction = (await open()).transaction(STORE, "readwrite");
      for (const record of records) transaction.objectStore(STORE).put(record);
      await finished(transaction);
    },
    async remove(ids) {
      const transaction = (await open()).transaction(STORE, "readwrite");
      for (const id of ids) transaction.objectStore(STORE).delete(id);
      await finished(transaction);
    },
    async wipe() {
      const transaction = (await open()).transaction(STORE, "readwrite");
      transaction.objectStore(STORE).clear();
      await finished(transaction);
    },
  };
}
