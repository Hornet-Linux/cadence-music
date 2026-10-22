import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizationHeader, buildCanonicalRequest, canonicalPath, canonicalQuery, EMPTY_SHA256, expectedPresignedSignature, presignUrl, sha256Hex, signingKey, uriEncode, UNSIGNED_PAYLOAD } from "./sigv4.js";

// The examples AWS publishes, so a mistake in the signer shows up here and not as "access denied" in production.

const S3_CREDS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const S3_DATE = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
const BASE = { region: "us-east-1", service: "s3", credentials: S3_CREDS, date: S3_DATE };

test("AWS test suite: get-vanilla", () => {
  const out = authorizationHeader({
    method: "GET",
    url: new URL("https://example.amazonaws.com/"),
    headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    payloadHash: EMPTY_SHA256,
    region: "us-east-1",
    service: "service",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  });
  assert.equal(out.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(
    out.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("AWS S3 docs: GET Object with a Range header", () => {
  const out = authorizationHeader({
    ...BASE,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": "20130524T000000Z" },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(out.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.equal(out.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("AWS S3 docs: PUT Object (a $ in the key, extra signed headers)", () => {
  const payload = "Welcome to Amazon S3.";
  assert.equal(sha256Hex(payload), "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const out = authorizationHeader({
    ...BASE,
    method: "PUT",
    url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": sha256Hex(payload),
      "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash: sha256Hex(payload),
  });
  assert.equal(out.signedHeaders, "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class");
  assert.equal(out.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
});

test("AWS S3 docs: GET Bucket Lifecycle (a query parameter without a value)", () => {
  const out = authorizationHeader({
    ...BASE,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"),
    headers: { host: "examplebucket.s3.amazonaws.com", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": "20130524T000000Z" },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(out.signature, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
});

test("AWS S3 docs: GET Bucket (List Objects) with sorted query parameters", () => {
  const out = authorizationHeader({
    ...BASE,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2"),
    headers: { host: "examplebucket.s3.amazonaws.com", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": "20130524T000000Z" },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(out.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

test("AWS S3 docs: presigned GET URL", () => {
  const url = presignUrl({
    ...BASE,
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    expiresSec: 86400,
  });
  assert.equal(url.searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.equal(url.searchParams.get("X-Amz-Credential"), "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "86400");
  // And the checker used by the test double agrees.
  assert.equal(expectedPresignedSignature(url, "GET", S3_CREDS.secretAccessKey), url.searchParams.get("X-Amz-Signature"));
  assert.notEqual(expectedPresignedSignature(url, "GET", "another-secret"), url.searchParams.get("X-Amz-Signature"));
});

test("AWS docs: the derived signing key", () => {
  // From "Examples of how to derive a signing key" in the SigV4 documentation (iam service, 20150830).
  const key = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
  assert.equal(key.toString("hex"), "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
});

test("encodes the way SigV4 requires", () => {
  assert.equal(uriEncode("a b/c~d-e_f.g"), "a%20b%2Fc~d-e_f.g");
  assert.equal(uriEncode("a b/c", false), "a%20b/c");
  assert.equal(uriEncode("é+&=!'()*$"), "%C3%A9%2B%26%3D%21%27%28%29%2A%24");
  assert.equal(canonicalPath("/Music/Caf%C3%A9%20Del%20Mar/it's (live).mp3"), "/Music/Caf%C3%A9%20Del%20Mar/it%27s%20%28live%29.mp3");
  assert.equal(canonicalPath("/"), "/");
  assert.equal(canonicalQuery(new URLSearchParams("b=2&a=1&a=0&c=x y")), "a=0&a=1&b=2&c=x%20y");
  assert.equal(canonicalQuery(new URLSearchParams("lifecycle")), "lifecycle=");
});

test("signing is stable for the same input and changes with every part of it", () => {
  const base = { ...BASE, method: "GET", url: new URL("https://b.s3.amazonaws.com/k"), headers: { "x-amz-date": "20130524T000000Z" }, payloadHash: EMPTY_SHA256 };
  const a = authorizationHeader(base).signature;
  assert.equal(authorizationHeader(base).signature, a);
  assert.notEqual(authorizationHeader({ ...base, method: "HEAD" }).signature, a);
  assert.notEqual(authorizationHeader({ ...base, url: new URL("https://b.s3.amazonaws.com/k2") }).signature, a);
  assert.notEqual(authorizationHeader({ ...base, region: "eu-west-1" }).signature, a);
  assert.notEqual(authorizationHeader({ ...base, credentials: { ...S3_CREDS, secretAccessKey: "x" } }).signature, a);
  assert.notEqual(authorizationHeader({ ...base, payloadHash: UNSIGNED_PAYLOAD }).signature, a);
  assert.match(buildCanonicalRequest(base).canonical, /^GET\n\/k\n\nhost:b\.s3\.amazonaws\.com\nx-amz-date:20130524T000000Z\n\nhost;x-amz-date\n/);
});
