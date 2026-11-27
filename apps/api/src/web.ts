/** The web app, served by the same process that serves the API, so that one executable is the whole
 * product. This file holds the three things that are not obvious about that:
 *
 * 1. What is reachable. The built app is listed once, at start-up, into a table from URL path to
 *    file. A request is answered from the table or not at all: no request path is ever joined onto a
 *    directory, so nothing outside the build can be read, whatever the path says. A browser asking
 *    for a page (`Accept: text/html`) at any other path gets the app's index, so deep links and
 *    reloads work; anything else that is missing is a 404.
 * 2. What a browser with no session is sent. A hosted service that is locked tells `serve` that the
 *    browser is not signed in, and a request for the app's page is then answered with the sign-in page
 *    (`signin.html` of the build) and never with the app: the app's screens are not drawn, and its code
 *    is not sent, to someone who has not got in. Nor are the topics of Help (the build's files under
 *    `/help-content/`), which are for the people who use the app. The files of the build under `/assets/` stay open to
 *    all (their names are hashes, they hold no data and a cache may keep them); the book is behind the
 *    API, which asks for the session on every request.
 * 3. Who the browser is. The app sends no credentials. When the service is locked, the service
 *    attaches the owner key to a request that comes from its own app (the browser says so with
 *    `Sec-Fetch-Site: same-origin`, or, in a browser too old to say it, an `Origin` equal to the
 *    service's own) and carries no credentials of its own. Anything else with no credentials, a
 *    command line tool or an agent that forgot its token, stays refused. The caller has checked the
 *    Host header already (see `startLocalApplicationServer`), which is what keeps another website
 *    from looking same-origin through DNS rebinding.
 *
 * What this does not do: any program on the computer can send those headers, so the lock bounds a
 * well-behaved agent configured with a token, not hostile software or other accounts on a shared
 * computer (see docs/explanation/data-directory-and-owner-lock.md). */
import { createHash } from "node:crypto";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
};

/** Headers every response of the installed service carries: the app cannot be framed, and no other
 * site can read its responses. */
const HARDENING: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
};

export interface WebApp {
  /** How many files the build has. */
  readonly files: number;
  /** Whether the build has a sign-in page. A locked service needs one to send in place of the app: a build that has
   * none sends the app to everyone, as a build made before the page existed did, and the product server refuses it. */
  readonly signIn: boolean;
  /** An answer for a request for the app, or null when the request is not for it. `who` is what a locked service
   * knows of the browser: when it is not signed in, a request for the app's page is answered with the sign-in page
   * (or, for a browser that came from another website, with the hop described at `hop`) and the app is not sent.
   * Without `who` nothing is locked, and the page is the app. */
  serve(request: Request, who?: { readonly signedIn: boolean }): Response | null;
}

/** Add the hardening headers to a response, keeping any the response already sets. A response that
 * has them all (the app's own files) is returned as it is, so its body is not copied. */
export function hardened(response: Response): Response {
  const wanted: Record<string, string> = {
    ...HARDENING,
    "content-security-policy": "frame-ancestors 'none'",
  };
  const missing = Object.entries(wanted).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of missing) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The inline scripts of a page, hashed for the Content Security Policy. The page the build makes
 * has one (it sets the saved theme before the first paint); any inline script the build adds later
 * is allowed by its own hash and nothing else is. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi))
    hashes.push(
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
    );
  return hashes;
}

/** Where the bot check's widget lives. The sign-in page of a service with accounts loads its script and frames it; no other page is allowed to. */
const TURNSTILE = "https://challenges.cloudflare.com";

export function contentSecurityPolicy(
  scriptHashes: readonly string[],
  options: { readonly captcha?: boolean } = {},
): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${scriptHashes.join(" ")}${options.captcha ? ` ${TURNSTILE}` : ""}`.trim(),
    ...(options.captcha ? [`frame-src ${TURNSTILE}`] : []),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // The build inlines some of its fonts as data: URIs.
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

const extensionOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot <= path.lastIndexOf("/") ? "" : path.slice(dot).toLowerCase();
};

const asksForPage = (request: Request): boolean =>
  (request.method === "GET" || request.method === "HEAD") &&
  (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");

/** Read the build in `directory` and serve it. Returns null when there is no build there (no
 * index.html), so a service started from source without a build still answers its API. */
export async function loadWebApp(
  directory: string,
  options: { readonly accounts?: boolean } = {},
): Promise<WebApp | null> {
  const accounts = options.accounts === true;
  const table = new Map<string, ReturnType<typeof Bun.file>>();
  try {
    for await (const path of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true }))
      table.set(`/${path.split("\\").join("/")}`, Bun.file(`${directory}/${path}`));
  } catch {
    return null;
  }
  const index = table.get("/index.html");
  if (!index) return null;
  // The sign-in page is part of the build, but a build made before it existed has none: such a service serves
  // the app to everyone, as it always did, and the API still asks for the session.
  const signIn = table.get("/signin.html");
  // The pages (the app's and the sign-in's) carry a policy of their own, from their own inline script.
  const pages = new Map<string, string>([
    ["/index.html", contentSecurityPolicy(inlineScriptHashes(await index.text()))],
  ]);
  // The sign-in page of a service with accounts shows the bot check, so it may load the widget; the rest of the pages may not.
  if (signIn)
    pages.set(
      "/signin.html",
      contentSecurityPolicy(inlineScriptHashes(await signIn.text()), { captcha: accounts }),
    );

  const respond = (path: string, file: ReturnType<typeof Bun.file>, request: Request): Response => {
    const policy = pages.get(path);
    const headers: Record<string, string> = {
      ...HARDENING,
      "content-type": TYPES[extensionOf(path)] ?? "application/octet-stream",
      "content-length": String(file.size),
      // Files named by their hash never change; the page that names them always may.
      "cache-control": path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : policy
          ? "no-store"
          : "no-cache",
      ...(policy ? { "content-security-policy": policy } : {}),
    };
    return new Response(request.method === "HEAD" ? null : file, { status: 200, headers });
  };

  /** What a browser that followed a link from another website is given when it has no session in view: a page
   * with nothing in it that asks again at once. The session's cookie is `SameSite=Strict`, so a browser does not
   * send it with a request that comes from another website, and a person who is signed in would be told to sign
   * in. The same request made by this page itself (`Sec-Fetch-Site: same-origin`) carries it, and is answered
   * with the app, or, if there is no session after all, with the sign-in page: the hop happens once. */
  const hop = (request: Request): Response =>
    new Response(
      request.method === "HEAD"
        ? null
        : '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0"><title>Rastrata</title>',
      {
        status: 200,
        headers: {
          ...HARDENING,
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": contentSecurityPolicy([]),
        },
      },
    );
  const cameFromAnotherSite = (request: Request): boolean =>
    request.headers.get("sec-fetch-site") === "cross-site" &&
    request.headers.get("sec-fetch-mode") === "navigate";

  return {
    files: table.size,
    signIn: signIn !== undefined,
    serve(request, who) {
      if (request.method !== "GET" && request.method !== "HEAD") return null;
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return null;
      }
      // A link in an invitation, and `/start` (where the application sends someone who has to choose a workspace), open the sign-in page for everyone, signed in or not: that
      // page reads what the link is for, signs the person in if need be, lets them choose or make a workspace, and lets them in.
      if (
        accounts &&
        signIn &&
        who &&
        (path.startsWith("/invite/") || path === "/start") &&
        asksForPage(request)
      )
        return respond("/signin.html", signIn, request);
      const file = path === "/" ? index : table.get(path);
      // Help is part of the app, not of the public site: like the app's page, its topics are not sent to a
      // browser that has not signed in.
      if (file && path.startsWith("/help-content/") && who && !who.signedIn) return null;
      const app = file === index || (file === undefined && asksForPage(request));
      if (app && who && !who.signedIn && signIn)
        return cameFromAnotherSite(request)
          ? hop(request)
          : respond("/signin.html", signIn, request);
      if (file) return respond(path === "/" ? "/index.html" : path, file, request);
      return asksForPage(request) ? respond("/index.html", index, request) : null;
    },
  };
}

/** Whether a request comes from the service's own app running in a browser. The caller has already
 * refused a Host that does not name this machine and port. */
export function fromOwnApp(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

/** The request with the owner key attached, when it comes from the app and has no credentials of
 * its own. A request that brings any Authorization header keeps it untouched: an agent's token is
 * never upgraded, and a wrong credential stays wrong. */
export function actingForOwner(request: Request, ownerKey: string): Request {
  if (request.headers.has("authorization") || !fromOwnApp(request)) return request;
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${ownerKey}`);
  return new Request(request, { headers });
}
