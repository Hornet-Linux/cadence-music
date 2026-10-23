import { generateKeyPairSync, sign } from "node:crypto";

/** Minimal DER encoding, just enough for a self-signed certificate used by the fake Chromecast in tests. */
function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  let len: Buffer;
  if (body.length < 128) len = Buffer.from([body.length]);
  else if (body.length < 256) len = Buffer.from([0x81, body.length]);
  else len = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

const ECDSA_SHA256 = Buffer.from("06082a8648ce3d040302", "hex");
const CN_OID = Buffer.from("0603550403", "hex");

function name(cn: string): Buffer {
  return der(0x30, der(0x31, der(0x30, CN_OID, der(0x0c, Buffer.from(cn)))));
}

const pem = (label: string, data: Buffer) =>
  `-----BEGIN ${label}-----\n${(data.toString("base64").match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;

/** A throwaway key and self-signed certificate, generated fresh for each test run. Nothing is stored. */
export function selfSignedCertificate(commonName = "cadence-test-cast"): { key: string; cert: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    der(0x30, ECDSA_SHA256),
    name(commonName),
    der(0x30, der(0x17, Buffer.from("240101000000Z")), der(0x17, Buffer.from("491231235959Z"))),
    name(commonName),
    spki,
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const cert = der(0x30, tbs, der(0x30, ECDSA_SHA256), der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), cert: pem("CERTIFICATE", cert) };
}
