import { resolve } from "node:path";
import { loadOrCreateOwnerKey } from "@rastrata/application/agent/local";
import { startLocalApplicationServer } from "./server.ts";

if (process.env.RASTRATA_LOCAL_DEV !== "1")
  throw new Error(
    "The initial application service requires explicit RASTRATA_LOCAL_DEV=1 local mode",
  );
const port = process.env.RASTRATA_API_PORT ?? "4010";
if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error("Invalid RASTRATA_API_PORT");
// Opt-in lock: with a key file, requests must present the owner key (or an agent token).
const ownerKeyFile = process.env.RASTRATA_OWNER_KEY_FILE;
// Off unless asked for: the book in a log (packages/booklog) instead of a file, for the hosting
// experiments. The local product is the other branch and is not changed by it. See hosted.ts.
const bookStore = process.env.RASTRATA_BOOK_STORE;

if (bookStore) {
  const { kindOf, parseBookStore, startHostedApplicationServer } = await import("./hosted.ts");
  const config = parseBookStore(bookStore);
  const control = process.env.RASTRATA_BOOK_CONTROL === "1";
  const hosted = await startHostedApplicationServer({
    config,
    port: Number(port),
    ...(ownerKeyFile ? { ownerKey: loadOrCreateOwnerKey(ownerKeyFile) } : {}),
    control,
    warm: process.env.RASTRATA_BOOK_WARM === "1",
    standby: process.env.RASTRATA_BOOK_STANDBY === "1",
    promote: process.env.RASTRATA_BOOK_PROMOTE === "manual" ? "manual" : "auto",
    ...(process.env.RASTRATA_BOOK_FOLLOW_MS
      ? { followMs: Number(process.env.RASTRATA_BOOK_FOLLOW_MS) }
      : {}),
    ...(process.env.RASTRATA_BOOK_LEASE_MS
      ? { leaseMs: Number(process.env.RASTRATA_BOOK_LEASE_MS) }
      : {}),
    ...(process.env.RASTRATA_BOOK_IDLE_RELEASE_MS
      ? { idleReleaseMs: Number(process.env.RASTRATA_BOOK_IDLE_RELEASE_MS) }
      : {}),
    // The breaker in front of a Durable Object tail is on; an experiment that injects its own faults turns it off.
    ...(process.env.RASTRATA_BOOK_TAIL_BREAKER === "off" ? { guard: false as const } : {}),
    exit: () => process.exit(0),
  });
  console.info(
    `Rastrata application on a book in a log: ${hosted.server.url} (book ${config.bookId}, tail ${kindOf(config.tail)}, bulk store ${kindOf(config.bulk)}, cache in ${config.cache})`,
  );
  console.info(
    ownerKeyFile
      ? `Owner access: locked. Requests need the owner key in ${ownerKeyFile} or an agent token.`
      : "Owner access: open. Any program on this computer can use Rastrata without a token.",
  );
  if (process.env.RASTRATA_BOOK_STANDBY === "1")
    console.info("Standby: following the book and ready to take it over; serving nothing yet.");
  if (control)
    console.info(
      "Control routes: on (/control/status, /control/tail, /control/evict, /control/fault, /control/drain, /control/release, /control/promote).",
    );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void hosted.stop().then(() => process.exit(0));
    });
} else {
  const application = await startLocalApplicationServer({
    path: process.env.RASTRATA_LOCAL_DB ?? resolve(import.meta.dir, "../../web/.local/book.sqlite"),
    port: Number(port),
    ...(ownerKeyFile ? { ownerKey: loadOrCreateOwnerKey(ownerKeyFile) } : {}),
    // Automatic backups: daily and on shutdown, unless turned off for a throwaway book.
    backups: process.env.RASTRATA_BACKUPS !== "off",
    // The daily bank feed sync is off until the owner turns it on in the book's settings; this only
    // starts the timer that looks at that setting. RASTRATA_BANKFEED=off leaves the timer out.
    bankfeed: process.env.RASTRATA_BANKFEED !== "off",
  });
  console.info(`Rastrata local application: ${application.server.url}`);
  console.info(
    application.scheduler && application.service.host.safety
      ? `Backups: automatic, kept in ${application.service.host.safety.directories.backups} (change them on the Backups screen; copy that folder off this disk too).`
      : "Backups: automatic backups are off (RASTRATA_BACKUPS=off).",
  );
  console.info(
    ownerKeyFile
      ? `Owner access: locked. Requests need the owner key in ${ownerKeyFile} or an agent token.`
      : "Owner access: open. Any program on this computer can use Rastrata without a token; an agent token only limits an agent that uses it. Set RASTRATA_OWNER_KEY_FILE to require the owner key.",
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void application.stop().then(() => process.exit(0));
    });
}
