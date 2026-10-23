/** True when the text has a control character (including NUL) or, optionally, a backslash. */
export function hasControlChars(text: string, alsoBackslash = false): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 127 || (alsoBackslash && c === 92)) return true;
  }
  return false;
}

export function stripControlChars(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 32 && text.charCodeAt(i) !== 127) out += text[i];
  return out;
}
