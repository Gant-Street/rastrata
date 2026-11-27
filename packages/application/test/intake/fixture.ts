import { statementsFixture, type StatementsFixture } from "../statements/harness.ts";
import {
  type Corpus,
  type CorpusFile,
  generateCorpus,
  type Month,
  MONTHS,
  type SourceTruth,
} from "../support/intake-corpus.ts";

/** A book set up with the corpus's accounts, behind the same HTTP boundary a client uses, and the
 * corpus's files uploaded on demand. */

// biome-ignore lint/suspicious/noExplicitAny: the tests read JSON of many shapes
export type Json = any;

export interface CorpusFixture {
  readonly f: StatementsFixture;
  readonly corpus: Corpus;
  /** The SHA-256 of an uploaded file, by its path in the corpus. */
  readonly ids: Map<string, string>;
  upload(file: CorpusFile): Promise<string>;
  uploadBytes(path: string, bytes: Uint8Array): Promise<string>;
  fileFor(source: SourceTruth, month: Month): CorpusFile;
  source(layout: string): SourceTruth;
  close(): void;
}

export async function corpusFixture(
  options: { corpus?: Corpus; real?: boolean; setup?: boolean } = {},
): Promise<CorpusFixture> {
  const f = await statementsFixture({ setup: false, ...(options.real ? { real: true } : {}) });
  const corpus = options.corpus ?? generateCorpus();
  if (options.setup !== false) {
    const response = await f.call("book.setup", corpus.book, crypto.randomUUID());
    if (!response.body.ok) throw new Error(`setup failed: ${JSON.stringify(response.body)}`);
  }
  const ids = new Map<string, string>();
  const uploadBytes = async (path: string, bytes: Uint8Array) => {
    const name = path.split("/").pop() as string;
    const sha = await f.store(bytes, encodeURIComponent(name), "application/octet-stream");
    ids.set(path, sha);
    return sha;
  };
  return {
    f,
    corpus,
    ids,
    uploadBytes,
    upload: (file) => uploadBytes(file.path, file.bytes),
    fileFor: (source, month) =>
      corpus.files.find(
        (file) => file.source === source.code && file.month === month,
      ) as CorpusFile,
    source: (layout) => corpus.sources.find((item) => item.layout === layout) as SourceTruth,
    close: () => f.close(),
  };
}

export const [M1, M2, M3] = MONTHS as unknown as [Month, Month, Month];

export const money = (cents: bigint): string => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};
