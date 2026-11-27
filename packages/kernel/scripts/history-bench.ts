/**
 * How the kernel's full-state path behaves as a book grows: the cost of one command against books of
 * increasing size, next to the cost of hashing the whole state once.
 *
 *   N=2000 WINDOW=500 bun packages/kernel/scripts/history-bench.ts
 *
 * Each window posts WINDOW two-line journals through `executeBookCommand` (the path a replay takes) and
 * prints the mean cost of one command and the cost of hashing the whole state once (the mean of a sample
 * before and after the window). A command makes three such hashes: admission twice, because a commit
 * evaluates its intent again, and the next state's own. Everything else a command does is meant to stay
 * flat from the first window to the last: the journal and posting identity checks, the activation
 * lookup, the retained-command lookup and the lists a command appends to are indexed or shared, not
 * scanned or copied. So on a book whose hash re-encodes every journal (one created without the state
 * commitment profile) the first column is about three times the second and both rise, and the part that
 * is not the hash is what is left over: a fraction of a millisecond, too small to read off the
 * difference. On a book whose hash does not depend on the history, the first column is flat.
 *
 * The run also reports how many lists were copied into frozen arrays on demand
 * (`bookHistoryMaterializations`). Nothing here reads `state.journals`, so any that appears is the
 * state hash reading them or a regression on the per-command path.
 */
import {
  type BookCommand,
  type BookProtocolState,
  type BookState,
  bookHistoryMaterializations,
  commandId,
  executeBookCommand,
  hashBookState,
  instant,
  sealCommand,
  semanticVersion,
} from "../src/index.ts";
import { IDS, freshState, journal, resolved } from "../test/fixtures.ts";
import { activationCommand } from "../test/protocol-fixtures.ts";

const total = Number(process.env.N ?? "2000");
const window = Number(process.env.WINDOW ?? String(Math.max(1, Math.floor(total / 4))));

function post(index: number, revision: bigint): BookCommand {
  const at = new Date(Date.UTC(2026, 0, 2) + index * 1000).toISOString();
  return sealCommand({
    id: commandId(`bench-${index}`),
    type: "postJournal",
    protocolVersion: semanticVersion("1.0.0"),
    bookId: IDS.book,
    expectedBookRevision: revision,
    issuedAt: instant(at),
    completedAt: instant(new Date(Date.parse(at) + 1).toISOString()),
    committedAt: instant(new Date(Date.parse(at) + 2).toISOString()),
    actorId: IDS.actor,
    resolved: resolved(journal(`bench-journal-${index}`, "2026-01-15")),
  });
}

function hashMilliseconds(state: BookState): number {
  const started = performance.now();
  hashBookState(state);
  return performance.now() - started;
}

const start = freshState();
const activated = executeBookCommand(
  start.state,
  start.protocol,
  activationCommand("bench-activate"),
);
let state: BookState = activated.state;
let protocol: BookProtocolState = activated.protocol;

console.log(`# ${total} journals through executeBookCommand, windows of ${window}`);
console.log("journals  ms per command  ms to hash the state");
const copiesBefore = bookHistoryMaterializations();
let done = 0;
while (done < total) {
  const count = Math.min(window, total - done);
  const commands: BookCommand[] = [];
  for (let step = 1; step <= count; step += 1)
    commands.push(post(done + step, state.bookRevision + BigInt(step - 1)));
  const hashBefore = hashMilliseconds(state);
  const started = performance.now();
  for (const command of commands) {
    const next = executeBookCommand(state, protocol, command);
    if (next.result.disposition !== "committed")
      throw new Error(`Command ${command.id} was ${next.result.disposition}`);
    state = next.state;
    protocol = next.protocol;
  }
  const perCommand = (performance.now() - started) / count;
  done += count;
  const hashMs = (hashBefore + hashMilliseconds(state)) / 2;
  console.log(
    `${String(done).padStart(8)}  ${perCommand.toFixed(3).padStart(14)}  ${hashMs.toFixed(3).padStart(20)}`,
  );
}
console.log(
  `lists copied into frozen arrays on demand: ${bookHistoryMaterializations() - copiesBefore}`,
);
