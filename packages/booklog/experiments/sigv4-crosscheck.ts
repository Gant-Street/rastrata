/** Cross-check of src/sigv4.ts against curl's own `--aws-sigv4` (an independent implementation):
 * curl signs a request to a local capture server, then the same inputs go through our signer and the
 * two signatures must be equal. Used to produce the regression vectors in test/sigv4.test.ts.
 * Only fake credentials are used. Run: bun experiments/sigv4-crosscheck.ts */
import { sha256Hex, signRequest } from "../src/sigv4.ts";

const ACCESS = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

interface Case {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
const cases: readonly Case[] = [
  { name: "get", method: "GET", path: "/bucket/books/b1/log/000000000001" },
  {
    name: "put-conditional",
    method: "PUT",
    path: "/bucket/books/b1/log/000000000002",
    headers: { "if-none-match": "*", "content-type": "application/octet-stream" },
    body: "hello entry",
  },
  {
    name: "put-meta",
    method: "PUT",
    path: "/bucket/runs/hoststore/r1/test%24file.text",
    headers: { "x-amz-meta-hash": "abc123", "x-amz-meta-prev": "000" },
    body: "x",
  },
  {
    name: "list",
    method: "GET",
    path: "/bucket",
    query:
      "list-type=2&max-keys=2&prefix=books%2Fb1%2Flog%2F&start-after=books%2Fb1%2Flog%2F000000000001",
  },
  { name: "head", method: "HEAD", path: "/bucket/a%20b/c" },
];

const captured: { method: string; headers: Record<string, string>; url: string }[] = [];
const server = Bun.serve({
  port: 18999,
  hostname: "127.0.0.1",
  async fetch(request) {
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers.entries()) headers[name] = value;
    captured.push({ method: request.method, headers, url: request.url });
    await request.arrayBuffer();
    return new Response("ok");
  },
});

let failures = 0;
for (const item of cases) {
  captured.length = 0;
  const url = `http://127.0.0.1:${server.port}${item.path}${item.query ? `?${item.query}` : ""}`;
  const payloadHash = sha256Hex(item.body ?? "");
  const args = [
    "curl",
    "-sS",
    "-X",
    item.method,
    "--aws-sigv4",
    "aws:amz:us-east-1:s3",
    "--user",
    `${ACCESS}:${SECRET}`,
    "-H",
    `x-amz-content-sha256: ${payloadHash}`,
    ...Object.entries(item.headers ?? {}).flatMap(([name, value]) => ["-H", `${name}: ${value}`]),
    ...(item.method === "HEAD" ? ["-I"] : []),
    ...(item.body !== undefined ? ["--data-binary", item.body] : []),
    url,
  ];
  // Asynchronous: the capture server runs in this process and must keep answering.
  const run = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(run.stderr).text();
  await run.exited;
  const seen = captured[0];
  if (!seen) {
    console.log(`${item.name}: curl sent nothing: ${errors}`);
    failures += 1;
    continue;
  }
  const authorization = seen.headers.authorization ?? "";
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(";") ?? [];
  const theirs = /Signature=([0-9a-f]+)/.exec(authorization)?.[1];
  const stamp = seen.headers["x-amz-date"] ?? "";
  const date = new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  const extra: Record<string, string> = {};
  for (const name of signedHeaders)
    if (!["host", "x-amz-date", "x-amz-content-sha256"].includes(name))
      extra[name] = seen.headers[name] ?? "";
  const ours = signRequest({
    method: item.method,
    url: new URL(url),
    headers: extra,
    payloadHash: seen.headers["x-amz-content-sha256"] ?? payloadHash,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    region: "us-east-1",
    date,
  });
  const same = ours.signature === theirs;
  if (!same) failures += 1;
  console.log(
    `${same ? "same  " : "DIFFER"} ${item.name.padEnd(16)} signed=${signedHeaders.join(";")}\n         date=${stamp} theirs=${theirs}\n         ours  =${ours.signature}`,
  );
}
server.stop(true);
console.log(failures === 0 ? "\nall signatures match curl's" : `\n${failures} case(s) differ`);
process.exit(failures === 0 ? 0 : 1);
