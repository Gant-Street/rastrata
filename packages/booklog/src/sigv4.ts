import { createHash, createHmac } from "node:crypto";

/** AWS Signature Version 4 for S3-compatible services (R2, OCI Object Storage, MinIO, S3). It is a
 * direct transcription of the published algorithm with no dependency, so the exact headers sent are
 * ours to choose: the commit point needs `If-None-Match: *` signed with the request. The unit
 * tests check it against the signatures AWS publishes for its documented examples. */

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding as SigV4 defines it: letters, digits and "-_.~" stay, everything else
 * (UTF-8 bytes) becomes %XX in upper case. "/" stays only when `keepSlash` (a path). */
export function uriEncode(value: string, keepSlash = false): string {
  let result = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === "/")) result += char;
    else result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

export interface SigningInput {
  readonly method: string;
  /** The absolute URL, already percent-encoded as it will be sent. */
  readonly url: URL;
  /** Headers to send and sign, names in any case. `host`, `x-amz-date` and `x-amz-content-sha256`
   * are added. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  readonly payloadHash: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region: string;
  readonly service?: string;
  /** The signing time, as a Date. */
  readonly date: Date;
}

export interface SignedRequest {
  /** Every header to send, lower-cased, including Authorization. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const compact = (value: string): string => value.trim().replace(/\s+/g, " ");

export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

export function signRequest(input: SigningInput): SignedRequest {
  const service = input.service ?? "s3";
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  headers.host = input.url.host;
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = input.payloadHash;
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${compact(headers[name] as string)}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const query = [...input.url.searchParams.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((left, right) =>
      left[0] === right[0] ? (left[1] < right[1] ? -1 : 1) : left[0] < right[0] ? -1 : 1,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    input.method.toUpperCase(),
    // S3 signs the path exactly as sent: already encoded once, never encoded again.
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
