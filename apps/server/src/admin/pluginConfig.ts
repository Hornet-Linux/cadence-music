/** Shown instead of a secret value; sending it back means "keep what is saved". */
export const MASK = "********";

const SECRET_KEY = /(key|secret|token|passw|credential)/i;

export const MAX_CONFIG_BYTES = 20_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A copy of a plugin's saved config that is safe to show on screen: secret-looking values are hidden. */
export function maskConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskConfig);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && typeof v === "string" && v ? MASK : maskConfig(v);
  }
  return out;
}

/** Put back the saved value wherever the admin left the mask in place. */
export function unmaskConfig(incoming: unknown, saved: unknown): unknown {
  if (Array.isArray(incoming)) return incoming.map((v, i) => unmaskConfig(v, Array.isArray(saved) ? saved[i] : undefined));
  if (!isObject(incoming)) return incoming;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const was = isObject(saved) ? saved[k] : undefined;
    out[k] = v === MASK && typeof was === "string" ? was : unmaskConfig(v, was);
  }
  return out;
}

/** The config the admin sent, if it is a plain JSON object that is small enough; otherwise null. */
export function validConfig(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  return JSON.stringify(value).length <= MAX_CONFIG_BYTES ? value : null;
}
