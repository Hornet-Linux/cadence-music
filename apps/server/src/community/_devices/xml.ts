/**
 * A tiny XML reader for UPnP device descriptions and SOAP replies. It handles elements, text, CDATA,
 * comments, entities and namespaces (prefixes are dropped). It is not a general XML parser: no DTDs, no
 * validation. Input comes from devices on the local network, so size is capped by the callers.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  text: string;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const localName = (n: string) => n.slice(n.indexOf(":") + 1);

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, text: "", children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      stack[stack.length - 1]!.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      const stop = end === -1 ? src.length : end;
      stack[stack.length - 1]!.text += src.slice(lt + 9, stop);
      i = end === -1 ? src.length : end + 3;
    } else if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      const end = src.indexOf(">", lt + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt + 2);
      if (stack.length > 1) stack.pop();
      i = end === -1 ? src.length : end + 1;
    } else {
      // Find the end of the tag, skipping '>' inside quoted attribute values.
      let j = lt + 1;
      let quote = "";
      while (j < src.length) {
        const c = src[j]!;
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        j++;
      }
      let body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
      const node: XmlNode = { name: localName(m?.[1] ?? ""), attrs: {}, text: "", children: [] };
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      const attrSrc = m?.[2] ?? "";
      for (let a = attrRe.exec(attrSrc); a; a = attrRe.exec(attrSrc)) {
        const key = a[1]!;
        if (key.startsWith("xmlns")) continue;
        node.attrs[localName(key)] = decodeEntities(a[3] ?? a[4] ?? "");
      }
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

/** First descendant (depth-first) with this local name. */
export function findNode(node: XmlNode, name: string): XmlNode | null {
  for (const child of node.children) {
    if (child.name === name) return child;
    const deeper = findNode(child, name);
    if (deeper) return deeper;
  }
  return null;
}

export function findAllNodes(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAllNodes(child, name, out);
  }
  return out;
}

export function childText(node: XmlNode, name: string): string | undefined {
  const child = node.children.find((c) => c.name === name);
  return child ? child.text.trim() : undefined;
}
