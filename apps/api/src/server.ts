import {
  LocalBookService,
  startBackupScheduler,
  startBankfeedScheduler,
  type BackupSchedulerOptions,
  type BankfeedScheduler,
  type BankfeedSchedulerOptions,
  type LocalSafetyOptions,
} from "@rastrata/application/local";
import { ApplicationHttp, MAX_UPLOAD_BYTES } from "@rastrata/application/http";
import { createLegacyBookHandler } from "@rastrata/application/legacy-http";
import { BUSINESS_PERMISSIONS } from "@rastrata/application/schema";
import { sizeOf } from "@rastrata/application/telemetry";
import { configureTelemetry, shutdownTelemetry, telemetryEnabled } from "@rastrata/telemetry";
import { BEACON_PATH } from "@rastrata/telemetry/web";
import { bookCapacity } from "./capacity.ts";
import { beaconHandler } from "./rum.ts";
import { asksForDocument, healthTelemetry, observeHttp } from "./telemetry.ts";
import { Warmup, type WarmupOptions } from "./warmup.ts";
import { actingForOwner, hardened, type WebApp } from "./web.ts";

/** The names that mean this computer. The Host header must be one of them with the server's own port. */
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** `ownerKey` locks the owner: requests must then present it (or an agent token). Left out, a
 * request with no credentials is the owner, the loopback development mode. `backups` starts the
 * automatic backups (daily and on shutdown, by the settings in the book); a server started without
 * it, as the tests do, makes no backups by itself and says so on the Backups screen. `bankfeed`
 * starts the timer of the optional daily bank feed sync; it does nothing until the owner turns the
 * daily sync on in the bank feed settings (it is off by default), and a server started without it
 * never syncs by itself.
 *
 * `web` is the installed service: the same process also serves the web app, attaches the owner key
 * to the requests the app itself makes (see web.ts), and sends the hardening headers on every
 * response. `health` is added to the answer of GET /health (the version). `safety` names the
 * backup and export folders instead of reading them from the environment.
 *
 * `warmUp` reads the book once in the background as soon as the server is listening, so that a
 * restart does the long first read while nobody waits for it (see warmup.ts). Until it has finished,
 * GET /health says `warming: true`. Left out, as in the development API and the tests, nothing is
 * read until a request needs it.
 *
 * `telemetry` is read from the environment unless it is `false`: with an OTLP endpoint named
 * (RASTRATA_OTEL_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT) the server sends spans and metrics to it,
 * and without one it does nothing at all, which is every local product. `RASTRATA_RUM` turns on the
 * endpoint where browsers report how pages felt (rum.ts), and only together with telemetry. A server
 * shuts down the telemetry it started, and leaves alone what a caller had already turned on. */
export async function startLocalApplicationServer(options: {
  path: string;
  port: number;
  ownerKey?: string;
  backups?: boolean | BackupSchedulerOptions;
  bankfeed?: boolean | BankfeedSchedulerOptions;
  web?: WebApp | null;
  health?: Record<string, unknown>;
  safety?: LocalSafetyOptions;
  warmUp?: boolean | WarmupOptions;
  telemetry?: false | { readonly env?: Readonly<Record<string, string | undefined>> };
}) {
  const environment = (options.telemetry || undefined)?.env ?? process.env;
  const ownsTelemetry =
    options.telemetry !== false &&
    !telemetryEnabled() &&
    (await configureTelemetry({ serviceName: "rastrata-api", env: environment }));
  const rumOn = telemetryEnabled() && /^(on|1|true)$/i.test(environment.RASTRATA_RUM?.trim() ?? "");
  const rumSample = Math.min(1, Math.max(0, Number(environment.RASTRATA_RUM_SAMPLE ?? "0.1") || 0));
  const warmup = options.warmUp ? new Warmup(options.warmUp === true ? {} : options.warmUp) : null;
  const service = await LocalBookService.open(options.path, {
    ...(options.safety ? { safety: options.safety } : {}),
    ...(warmup ? { observe: warmup.observe } : {}),
  });
  const application = new ApplicationHttp(
    service,
    { bookId: service.bookId, permissions: BUSINESS_PERMISSIONS },
    options.ownerKey ? { ownerKey: options.ownerKey } : {},
  );
  const legacy = createLegacyBookHandler(service);
  const beacon = rumOn ? beaconHandler({ application, size: () => sizeOf(service) }) : null;
  let scheduler: Awaited<ReturnType<typeof startBackupScheduler>> = null;
  let feedScheduler: BankfeedScheduler | null = null;
  try {
    if (options.backups)
      scheduler = await startBackupScheduler(
        service,
        options.backups === true ? {} : options.backups,
      );
    if (options.bankfeed)
      feedScheduler = startBankfeedScheduler(
        service,
        options.bankfeed === true ? {} : options.bankfeed,
      );
    // The Host header must name this machine and this server's port exactly. A page on another
    // site whose name has been pointed at 127.0.0.1 (DNS rebinding) sends its own name, and its
    // requests look same-origin to the browser; refusing it here, before anything else, is what
    // keeps such a page from using a service that acts for its owner.
    let allowedHosts = new Set<string>();
    const route = async (incoming: Request): Promise<Response> => {
      // The Host is checked before the URL is read: a hostile one can make the URL unreadable.
      if (!allowedHosts.has((incoming.headers.get("host") ?? "").toLowerCase()))
        return Response.json(
          { error: "Host not allowed: use the address the service printed", code: "host_denied" },
          { status: 421 },
        );
      let url: URL;
      try {
        url = new URL(incoming.url);
      } catch {
        return Response.json({ error: "Bad request" }, { status: 400 });
      }
      const origin = incoming.headers.get("origin");
      if (!LOOPBACK_NAMES.includes(url.hostname) || (origin && origin !== url.origin))
        return Response.json({ error: "Local application origin denied" }, { status: 403 });
      const request =
        options.web && options.ownerKey ? actingForOwner(incoming, options.ownerKey) : incoming;
      // The browser's report of how pages felt. Not registered unless telemetry and RASTRATA_RUM are
      // on, and then it authenticates before it reads a byte.
      if (beacon && url.pathname === BEACON_PATH) return beacon(request);
      if (url.pathname.startsWith("/v1/")) return application.fetch(request);
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (!(declared <= 131072))
        return Response.json({ error: "Request too large" }, { status: 413 });
      if (url.pathname.startsWith("/api/")) {
        const refusal = await application.guardLegacy(request);
        if (refusal) return refusal;
        // How much the book holds, for `rastrata doctor`: counts and sizes, for the owner only.
        if (url.pathname === "/api/capacity" && request.method === "GET")
          try {
            return Response.json(await bookCapacity(service, options.path), {
              headers: { "cache-control": "no-store" },
            });
          } catch {
            return Response.json(
              { error: "The book could not be read", code: "capacity_unavailable" },
              { status: 503, headers: { "cache-control": "no-store" } },
            );
          }
        return legacy(request);
      }
      if (url.pathname === "/health" && request.method === "GET")
        return Response.json(
          {
            ok: true,
            ...options.health,
            ...healthTelemetry(),
            // Tells the page it may report, and how often (the share of page views that do).
            ...(beacon ? { rum: { sample: rumSample } } : {}),
            ...warmup?.status(),
          },
          { headers: { "cache-control": "no-store" } },
        );
      return (
        options.web?.serve(request) ??
        new Response("Not found", {
          status: 404,
          // Never kept (see hosted.ts): a file that is missing now may be there after the next release.
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        })
      );
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      // Only POST /v1/uploads takes a large raw body (a statement file). The server limit has to
      // admit it, so every other route enforces the 128 KiB limit itself.
      maxRequestBodySize: MAX_UPLOAD_BYTES + 4096,
      // The first read of a book that has no saved snapshot replays every entry (a millisecond an entry
      // for a book made with the chain-head state commitment: 15 seconds at 20,000 journals; about 22
      // seconds at a thousand journals and minutes beyond two thousand for one made without it), and a
      // request that waits for it sends nothing meanwhile. Bun closes such a connection after ten
      // seconds unless told otherwise; 255 is its longest. See "The scale limit" in
      // docs/reference/program/main.md.
      idleTimeout: 255,
      async fetch(request) {
        const response = await observeHttp(request, () => route(request));
        const answered = options.web ? hardened(response) : response;
        // The page learns that it is asked to report how it felt from its own document's headers,
        // so a service that does not ask is never even sent the code that reports.
        if (beacon && asksForDocument(request)) {
          try {
            answered.headers.append("server-timing", `rum;desc="${rumSample}"`);
          } catch {
            // A response whose headers cannot be changed is sent as it is.
          }
        }
        return answered;
      },
    });
    allowedHosts = new Set(LOOPBACK_NAMES.map((name) => `${name}:${server.port}`));
    // Listening first: /health answers while the book is read, which is what lets a person (or the
    // command line) see that the service is up and reading rather than stuck.
    warmup?.start(service, options.path);
    return {
      server,
      service,
      scheduler,
      feedScheduler,
      warmup,
      async stop() {
        feedScheduler?.stop();
        // Requests waiting for the book to be read would hold a graceful stop until the whole read
        // was over, which can be minutes: they are dropped instead, as the service is going anyway.
        const reading = warmup?.reading ?? false;
        warmup?.stopping();
        await server.stop(reading);
        // A last backup, so the newest copy is as new as the book; it never holds shutdown up for
        // long (see BackupScheduler.stop).
        await scheduler?.stop({ shutdownBackup: true });
        service.close();
        // Last, so the final backup's spans and the last metrics are sent.
        if (ownsTelemetry) await shutdownTelemetry();
      },
    };
  } catch (error) {
    feedScheduler?.stop();
    warmup?.stopping();
    await scheduler?.stop({ shutdownBackup: false });
    service.close();
    if (ownsTelemetry) await shutdownTelemetry();
    throw error;
  }
}
