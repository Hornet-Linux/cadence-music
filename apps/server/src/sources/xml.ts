/**
 * A small, forgiving XML reader for the replies of WebDAV (multistatus) and S3 (ListBucketResult).
 * It only builds a tree of elements; it never fetches anything and never expands entities
 * defined in the document (a DOCTYPE with ENTITY declarations is refused outright), so hostile
 * replies cannot make it read files or blow up memory. Namespace prefixes are dropped and
 * names are lower-cased, because servers differ on both ("d:href", "D:href", "href").
 */

export interface XmlNode {
  /** Local name, lower-case. */
  name: string;
  text: string;
  children: XmlNode[];
}

const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export class XmlError extends Error {}

export function parseXml(input: string): XmlNode {
  if (/<!ENTITY/i.test(input)) throw new XmlError("entity declarations are not allowed");
  const root: XmlNode = { name: "#root", text: "", children: [] };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(input))) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3] !== undefined) {
      const closing = m[2] === "/";
      const name = m[3].slice(m[3].lastIndexOf(":") + 1).toLowerCase();
      if (closing) {
        // Tolerate stray closers; pop to the matching open element if there is one.
        for (let i = stack.length - 1; i > 0; i--) {
          if (stack[i]!.name === name) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      if (++nodes > MAX_NODES) throw new XmlError("document too large");
      const node: XmlNode = { name, text: "", children: [] };
      top.children.push(node);
      if (m[5] !== "/") {
        if (stack.length >= MAX_DEPTH) throw new XmlError("document too deep");
        stack.push(node);
      }
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  const first = root.children[0];
  if (!first) throw new XmlError("empty document");
  return first;
}

/** First direct child with this (lower-case) name. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Trimmed text of the first direct child with this name. */
export function childText(node: XmlNode, name: string): string | undefined {
  const c = child(node, name);
  return c ? c.text.trim() : undefined;
}

/** Every descendant with this name, depth first. */
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}
