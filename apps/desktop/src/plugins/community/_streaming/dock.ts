/**
 * The visible player panel for services whose official embedded player must stay on screen
 * (YouTube's policies forbid hiding it or playing from a player that is not displayed;
 * SoundCloud's and Deezer's widgets carry their own branding). Plain DOM, so any plugin can
 * use it without a shared UI file.
 *
 * Rules this panel keeps, on purpose:
 *  - the player area is at least 200x200 and nothing is drawn over it (the title bar, close
 *    button, notes and credit sit above and below it, never on top);
 *  - there is only ever one panel (and so one embedded player) at a time;
 *  - closing the panel destroys the player, so nothing keeps playing out of sight.
 */

export const MIN_PLAYER_PX = 200;

export interface DockOptions {
  /** "YouTube", "SoundCloud"... */
  service: string;
  /** Link to the current item on the service. */
  href?: string;
  hrefLabel?: string;
  /** Required credit line. */
  credit: { text: string; href: string };
  /** Height of the player area in px (never below the 200px minimum). */
  height: number;
  /** The person pressed Close. */
  onClose: () => void;
}

export interface DockHandle {
  readonly body: HTMLElement;
  /** A line below the player (errors, "press play in the player"). */
  setNote: (text: string | null) => void;
  /** Close without calling `onClose`. */
  close: () => void;
  readonly isOpen: boolean;
}

let current: { el: HTMLElement; handle: DockHandle } | null = null;

function link(href: string, text: string, className: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = className;
  return a;
}

export function openDock(opts: DockOptions): DockHandle {
  closeDock();
  const el = document.createElement("aside");
  el.className = "stream-dock";
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", `${opts.service} player`);

  const head = document.createElement("header");
  head.className = "stream-dock-head";
  const title = document.createElement("span");
  title.className = "stream-dock-title";
  title.textContent = opts.service;
  head.append(title);
  if (opts.href) head.append(link(opts.href, opts.hrefLabel ?? `Open in ${opts.service}`, "stream-dock-open"));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "stream-dock-close";
  close.textContent = "Close";
  close.setAttribute("aria-label", `Close the ${opts.service} player`);
  head.append(close);

  const body = document.createElement("div");
  body.className = "stream-dock-body";
  body.style.minWidth = `${MIN_PLAYER_PX}px`;
  body.style.height = `${Math.max(MIN_PLAYER_PX, opts.height)}px`;

  const note = document.createElement("p");
  note.className = "stream-dock-note";
  note.hidden = true;
  note.setAttribute("role", "status");

  const foot = document.createElement("footer");
  foot.className = "stream-dock-credit";
  foot.append(link(opts.credit.href, opts.credit.text, "stream-dock-credit-link"));

  el.append(head, body, note, foot);
  document.body.append(el);

  let open = true;
  const handle: DockHandle = {
    body,
    get isOpen() {
      return open;
    },
    setNote(text) {
      note.textContent = text ?? "";
      note.hidden = !text;
    },
    close() {
      if (!open) return;
      open = false;
      el.remove();
      if (current?.handle === handle) current = null;
    },
  };
  close.addEventListener("click", () => {
    handle.close();
    opts.onClose();
  });
  current = { el, handle };
  return handle;
}

/** Close the panel, if one is open, without telling its owner. */
export function closeDock(): void {
  current?.handle.close();
}

export function dockElement(): HTMLElement | null {
  return current?.el ?? null;
}
