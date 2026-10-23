import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, written out in full so Cadence needs no AWS SDK. It follows the public
 * specification (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-create-signed-request.html)
 * and is checked against the examples AWS publishes in sigv4.test.ts.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 percent-encoding as SigV4 wants it: only A-Z a-z 0-9 - _ . ~ stay, hex in upper case. */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (ch === "/" && !encodeSlash)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Each path segment of an already-encoded path, decoded and encoded again the SigV4 way. S3 does not double-encode. */
export function canonicalPath(pathname: string): string {
  return (
    pathname
      .split("/")
      .map((seg) => {
        try {
          return uriEncode(decodeURIComponent(seg));
        } catch {
          return uriEncode(seg);
        }
      })
      .join("/") || "/"
  );
}

export function canonicalQuery(params: Iterable<[string, string]>): string {
  return [...params]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function signingKey(secretAccessKey: string, date8: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date8), region), service), "aws4_request");
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign (any case). "host" is added from the URL when missing. */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  credentials: S3Credentials;
  date: Date;
}

function canonicalHeaders(headers: Record<string, string>): { block: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { block: entries.map(([k, v]) => `${k}:${v}\n`).join(""), signed: entries.map(([k]) => k).join(";") };
}

function computeSignature(
  canonical: string,
  input: Pick<SignInput, "region" | "service" | "credentials" | "date">,
): { signature: string; scope: string } {
  const stamp = amzDate(input.date);
  const date8 = stamp.slice(0, 8);
  const scope = `${date8}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, date8, input.region, input.service)).update(toSign, "utf8").digest("hex");
  return { signature, scope };
}

export function buildCanonicalRequest(input: Omit<SignInput, "credentials" | "region" | "service" | "date">): { canonical: string; signedHeaders: string } {
  const headers = { ...input.headers };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "host")) headers.host = input.url.host;
  const { block, signed } = canonicalHeaders(headers);
  const canonical = [input.method.toUpperCase(), canonicalPath(input.url.pathname), canonicalQuery(input.url.searchParams), block, signed, input.payloadHash].join("\n");
  return { canonical, signedHeaders: signed };
}

/** The Authorization header (and the date it was made for) for a request sent with header authentication. */
export function authorizationHeader(input: SignInput): { authorization: string; amzDate: string; signature: string; signedHeaders: string } {
  const { canonical, signedHeaders } = buildCanonicalRequest(input);
  const { signature, scope } = computeSignature(canonical, input);
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate: amzDate(input.date),
    signature,
    signedHeaders,
  };
}

/** A URL that authorises one GET for `expiresSec` seconds (query-string authentication). */
export function presignUrl(input: Omit<SignInput, "headers" | "payloadHash"> & { expiresSec: number; headers?: Record<string, string> }): URL {
  const url = new URL(input.url.href);
  const stamp = amzDate(input.date);
  const scope = `${stamp.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  const headers = { ...(input.headers ?? {}) };
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "host")) headers.host = url.host;
  const { signed } = canonicalHeaders(headers);
  const params: [string, string][] = [
    ...url.searchParams,
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresSec)],
    ["X-Amz-SignedHeaders", signed],
  ];
  if (input.credentials.sessionToken) params.push(["X-Amz-Security-Token", input.credentials.sessionToken]);
  // The query is written out by hand (spaces as %20, never +), exactly as it is signed.
  url.search = canonicalQuery(params);
  const { canonical } = buildCanonicalRequest({ method: input.method, url, headers, payloadHash: UNSIGNED_PAYLOAD });
  const { signature } = computeSignature(canonical, input);
  url.search = canonicalQuery([...params, ["X-Amz-Signature", signature]]);
  return url;
}

/** What the signature of a presigned URL should be (used by the test double to check requests). */
export function expectedPresignedSignature(url: URL, method: string, secretAccessKey: string): string | null {
  const q = url.searchParams;
  const credential = q.get("X-Amz-Credential");
  const stamp = q.get("X-Amz-Date");
  if (!credential || !stamp) return null;
  const [accessKeyId, date8, region, service] = credential.split("/");
  if (!accessKeyId || !date8 || !region || !service || date8 !== stamp.slice(0, 8)) return null;
  const copy = new URL(url.href);
  copy.searchParams.delete("X-Amz-Signature");
  const signedHeaderNames = (q.get("X-Amz-SignedHeaders") ?? "host").split(";");
  const headers: Record<string, string> = {};
  for (const name of signedHeaderNames) headers[name] = name === "host" ? url.host : "";
  const { canonical } = buildCanonicalRequest({ method, url: copy, headers, payloadHash: UNSIGNED_PAYLOAD });
  const toSign = ["AWS4-HMAC-SHA256", stamp, `${date8}/${region}/${service}/aws4_request`, sha256Hex(canonical)].join("\n");
  return createHmac("sha256", signingKey(secretAccessKey, date8, region, service)).update(toSign, "utf8").digest("hex");
}
