/**
 * A small, forgiving XML reader for podcast feeds and OPML files.
 *
 * Safety rather than completeness: it never defines or expands entities (so no entity bombs and no external
 * entities), ignores DOCTYPE declarations, caps nesting depth and node count, and recovers from the broken
 * markup real-world feeds contain (unclosed tags, stray ampersands, a bare "<" in text, a cut-off document).
 */

export interface XmlNode {
  /** Lower-case, prefix kept: "itunes:duration". */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text and CDATA directly inside this element. */
  text: string;
}

export interface XmlLimits {
  maxDepth?: number;
  maxNodes?: number;
}

export interface XmlResult {
  root: XmlNode;
  /** The node cap was hit and the rest of the document was ignored. */
  truncated: boolean;
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  eacute: "\u00e9",
};

/** Decodes the predefined entities and numeric references; anything else is left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? whole;
  });
}

const NAME_START = /[A-Za-z_:]/;
const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/y;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let count = 0;
  ATTR_RE.lastIndex = 0;
  let i = 0;
  while (i < src.length && count < 64) {
    while (i < src.length && /[\s/]/.test(src[i])) i++;
    if (i >= src.length) break;
    ATTR_RE.lastIndex = i;
    const m = ATTR_RE.exec(src);
    if (!m) break;
    i = ATTR_RE.lastIndex;
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[m[1].toLowerCase()] = decodeEntities(value);
    count++;
  }
  return attrs;
}

export function parseXml(input: string, limits: XmlLimits = {}): XmlResult {
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 300_000;
  // A byte-order mark or stray whitespace before the first tag is common.
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let truncated = false;
  let i = 0;
  const n = src.length;

  const addText = (raw: string) => {
    if (!raw) return;
    const top = stack[stack.length - 1];
    top.text += decodeEntities(raw);
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      addText(src.slice(i));
      break;
    }
    if (lt > i) addText(src.slice(i, lt));
    const next = src[lt + 1];
    if (next === "!") {
      if (src.startsWith("<!--", lt)) {
        const end = src.indexOf("-->", lt + 4);
        i = end < 0 ? n : end + 3;
      } else if (src.startsWith("<![CDATA[", lt)) {
        const end = src.indexOf("]]>", lt + 9);
        const body = src.slice(lt + 9, end < 0 ? n : end);
        stack[stack.length - 1].text += body;
        i = end < 0 ? n : end + 3;
      } else {
        // DOCTYPE and friends: skip, honouring an internal [ ... ] subset. Nothing in it is ever interpreted.
        let j = lt + 2;
        let depth = 0;
        while (j < n) {
          const c = src[j];
          if (c === "[") depth++;
          else if (c === "]") depth = Math.max(0, depth - 1);
          else if (c === ">" && depth === 0) break;
          j++;
        }
        i = j + 1;
      }
      continue;
    }
    if (next === "?") {
      const end = src.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (next === "/") {
      const gt = src.indexOf(">", lt + 2);
      const name = src.slice(lt + 2, gt < 0 ? n : gt).trim().toLowerCase();
      i = gt < 0 ? n : gt + 1;
      // Close the nearest open element with this name; an end tag nothing matches is ignored.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    if (!next || !NAME_START.test(next)) {
      // A "<" that doesn't start a tag (e.g. "a < b") is just text.
      addText("<");
      i = lt + 1;
      continue;
    }
    // Start tag: find its closing ">" while skipping quoted attribute values.
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    if (j >= n) {
      // Cut off in the middle of a tag.
      i = n;
      break;
    }
    let inner = src.slice(lt + 1, j);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const sp = inner.search(/[\s]/);
    const name = (sp < 0 ? inner : inner.slice(0, sp)).toLowerCase();
    const attrs = sp < 0 ? {} : parseAttrs(inner.slice(sp));
    i = j + 1;
    if (++nodes > maxNodes) {
      truncated = true;
      break;
    }
    const node: XmlNode = { name, attrs, children: [], text: "" };
    if (stack.length > maxDepth) {
      // Too deep: drop this element (and, since it never opens, anything inside lands on its parent).
      continue;
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return { root, truncated };
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function childrenNamed(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

export function childText(node: XmlNode | undefined, name: string): string {
  return child(node, name)?.text.trim() ?? "";
}

/** Escapes text for use in XML output (OPML export). */
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}