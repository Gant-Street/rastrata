import { ApplicationError } from "./errors.ts";
import type { Committer } from "./slices/changes/store.ts";
import type { ApplicationService } from "./service.ts";
import type { BookSetup, JournalDraftData } from "./contracts.ts";
import {
  APPLICATION_API_VERSION,
  BUSINESS_PERMISSIONS,
  type BusinessPermission,
} from "./schema.ts";

/** The routes below admit only the owner (`guardLegacy`), so whatever they commit is the owner's. */
const owner = (operation: string): Committer => ({ by: "owner", operation });

/** Compatibility grouping for the existing browser screens. All accounting and
 * workflow operations are supplied by the shared application service. */
export function createLegacyBookHandler(
  localBook: ApplicationService | null,
  permissions: readonly BusinessPermission[] = BUSINESS_PERMISSIONS,
) {
  async function bookApi(request: Request): Promise<Response> {
    if (!localBook)
      return request.method === "GET"
        ? Response.json({ enabled: false, setup: null })
        : new Response("Not found", { status: 404 });
    if (request.method === "GET")
      return Response.json({ enabled: true, setup: localBook.setupState() });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
      return Response.json({ error: "Expected JSON" }, { status: 415 });
    try {
      const body = await request.text();
      if (body.length > 65536)
        return Response.json({ error: "Request too large" }, { status: 413 });
      const setup = JSON.parse(body) as BookSetup;
      const result = await localBook.setup(setup, owner("legacy.book.setup"));
      return Response.json(result);
    } catch (error) {
      if (error instanceof ApplicationError)
        return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof SyntaxError || error instanceof TypeError)
        return Response.json({ error: error.message }, { status: 400 });
      if (error instanceof Error && error.message === "Book already configured")
        return Response.json({ error: error.message }, { status: 409 });
      console.error("Local book setup failed", error);
      return Response.json({ error: "Book setup unavailable" }, { status: 503 });
    }
  }

  async function journalApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      path === "/api/periods" ||
      /^\/api\/periods\/period-(?:m\d{1,2}-)?(?:\d{4}-)?\d{2}\/(close|reopen)$/.test(path)
    ) {
      if (!localBook?.setupState()) return Response.json({ periods: null });
      try {
        if (path === "/api/periods" && request.method === "GET")
          return Response.json(await localBook.periods());
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
          return Response.json({ error: "Expected JSON" }, { status: 415 });
        const body = await request.text();
        if (body.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        const input = JSON.parse(body) as { actionId: string; reason: string };
        const match =
          /^\/api\/periods\/(period-(?:m\d{1,2}-)?(?:\d{4}-)?\d{2})\/(close|reopen)$/.exec(path);
        if (!match) return new Response("Not found", { status: 404 });
        return Response.json(
          await localBook.changePeriod(
            {
              ...input,
              periodId: match[1] ?? "",
              operation: match[2] as "close" | "reopen",
            },
            false,
            owner("legacy.periods"),
          ),
        );
      } catch (error) {
        if (error instanceof ApplicationError)
          return Response.json({ error: error.message }, { status: error.status });
        if (error instanceof TypeError || error instanceof SyntaxError)
          return Response.json({ error: error.message }, { status: 400 });
        console.error("Local period request failed", error);
        return Response.json({ error: "Periods unavailable" }, { status: 503 });
      }
    }
    if (path === "/api/accounts" || /^\/api\/accounts\/[A-Za-z0-9_-]+$/.test(path)) {
      if (!localBook?.setupState()) return Response.json({ accounts: null });
      try {
        if (request.method === "GET") return Response.json(await localBook.accounts());
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
          return Response.json({ error: "Expected JSON" }, { status: 415 });
        const body = await request.text();
        if (body.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        const input = JSON.parse(body);
        const result =
          path === "/api/accounts"
            ? await localBook.createAccount(input, false, owner("legacy.accounts"))
            : await localBook.changeAccount(
                {
                  ...input,
                  accountId: path.slice("/api/accounts/".length),
                },
                false,
                owner("legacy.accounts"),
              );
        return Response.json(result);
      } catch (error) {
        if (error instanceof ApplicationError)
          return Response.json({ error: error.message }, { status: error.status });
        if (error instanceof TypeError || error instanceof SyntaxError)
          return Response.json({ error: error.message }, { status: 400 });
        console.error("Local account request failed", error);
        return Response.json({ error: "Accounts unavailable" }, { status: 503 });
      }
    }
    if (path === "/api/journal" && request.method === "GET") {
      if (!localBook?.setupState()) return Response.json({ book: null });
      try {
        const revision = url.searchParams.get("revision");
        return Response.json({
          book: await localBook.journalBook({
            page: Number(url.searchParams.get("page") ?? "1"),
            text: url.searchParams.get("text") ?? "",
            from: url.searchParams.get("from") ?? "",
            to: url.searchParams.get("to") ?? "",
            accountId: url.searchParams.get("accountId") ?? "",
            status: url.searchParams.get("status") ?? "",
            ...(revision ? { revision: BigInt(revision) } : {}),
          }),
        });
      } catch (error) {
        if (error instanceof ApplicationError)
          return Response.json({ error: error.message }, { status: error.status });
        if (error instanceof TypeError)
          return Response.json({ error: error.message }, { status: 400 });
        console.error("Local journal read failed", error);
        return Response.json({ error: "Journal unavailable" }, { status: 503 });
      }
    }
    if (!localBook) return new Response("Not found", { status: 404 });
    const reversal = /^\/api\/journal\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/reverse$/.exec(path);
    const match = /^\/api\/drafts\/([0-9a-f-]{36})(\/post)?$/.exec(path);
    try {
      if (reversal && request.method === "POST") {
        if (!(request.headers.get("content-type") ?? "").startsWith("application/json"))
          return Response.json({ error: "Expected JSON" }, { status: 415 });
        const body = await request.text();
        if (body.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        const input = JSON.parse(body) as {
          actionId: string;
          accountingDate: string;
          reason: string;
        };
        return Response.json(
          await localBook.reverseJournal(
            {
              ...input,
              journalId: reversal[1] ?? "",
            },
            false,
            owner("legacy.journal"),
          ),
        );
      }
      if (path === "/api/drafts" && request.method === "GET")
        return Response.json(localBook.draftPage(Number(url.searchParams.get("page") ?? "1")));
      if (match && request.method === "GET" && !match[2]) {
        const draft = localBook.draft(match[1] ?? "");
        return draft ? Response.json(draft) : new Response("Not found", { status: 404 });
      }
      if (match && request.method === "POST" && match[2])
        return Response.json(await localBook.postDraft(match[1] ?? "", owner("legacy.drafts")));
      if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") {
        if (
          request.method !== "DELETE" &&
          !(request.headers.get("content-type") ?? "").startsWith("application/json")
        )
          return Response.json({ error: "Expected JSON" }, { status: 415 });
        const text = request.method === "DELETE" ? "" : await request.text();
        if (text.length > 65536)
          return Response.json({ error: "Request too large" }, { status: 413 });
        const body = text
          ? (JSON.parse(text) as { data: JournalDraftData; version: number })
          : null;
        if (path === "/api/drafts" && request.method === "POST")
          return Response.json(localBook.createDraft(body?.data as JournalDraftData), {
            status: 201,
          });
        if (match && !match[2] && request.method === "PUT")
          return Response.json(
            localBook.saveDraft(
              match[1] ?? "",
              body?.version as number,
              body?.data as JournalDraftData,
            ),
          );
        if (match && !match[2] && request.method === "DELETE") {
          const version = Number(new URL(request.url).searchParams.get("version"));
          localBook.discardDraft(match[1] ?? "", version);
          return new Response(null, { status: 204 });
        }
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof ApplicationError)
        return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof TypeError || error instanceof SyntaxError)
        return Response.json({ error: error.message }, { status: 400 });
      if (error instanceof Error && /^(Draft changed|Book already configured)/.test(error.message))
        return Response.json({ error: error.message }, { status: 409 });
      if (error instanceof Error && /^(Draft not found|Book is not configured)/.test(error.message))
        return Response.json({ error: error.message }, { status: 404 });
      console.error("Local journal request failed", error);
      return Response.json({ error: "Journal unavailable" }, { status: 503 });
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const permission: BusinessPermission =
      request.method === "GET"
        ? "read"
        : path === "/api/book/setup" || path === "/api/book"
          ? "provision"
          : path.includes("/accounts")
            ? "configure"
            : path.includes("/periods")
              ? "close"
              : path.endsWith("/reverse")
                ? "correct"
                : path.endsWith("/post")
                  ? "post"
                  : "draft";
    if (!permissions.includes(permission))
      return Response.json({ error: "Permission denied" }, { status: 403 });
    const response =
      path === "/api/book" || path === "/api/book/setup"
        ? await bookApi(request)
        : await journalApi(request);
    response.headers.set("x-rastrata-api-version", APPLICATION_API_VERSION);
    return response;
  };
}
