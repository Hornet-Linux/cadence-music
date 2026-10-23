// A calm, self-contained notice for single sign-on that didn't work in the web
// player. The sign-in redirect lands before the React app renders (and the
// welcome wizard would otherwise cover any error), so this is plain DOM.

export type AuthProblem = "not_allowed" | "disabled" | "failed" | "unreachable" | "expired";

export interface AuthNotice {
  problem: AuthProblem;
  title: string;
  text: string;
}

const NOTICES: Record<AuthProblem, Omit<AuthNotice, "problem">> = {
  not_allowed: {
    title: "No access to this server",
    text: "Your account isn't allowed to use this server. Ask the server owner to add you to the right group.",
  },
  disabled: {
    title: "Account switched off",
    text: "Your account on this server has been switched off. Ask the server owner to turn it back on.",
  },
  failed: {
    title: "Sign-in failed",
    text: "Sign-in failed: the server couldn't confirm your sign-in. Try again or tell the server owner.",
  },
  unreachable: {
    title: "Sign-in unavailable",
    text: "The sign-in service isn't reachable right now. Try again in a moment.",
  },
  expired: {
    title: "Sign-in expired",
    text: "That sign-in took too long or was already used. Try again.",
  },
};

/** Map an error code from the sign-in redirect (or our own) to what we tell the person. */
export function authNoticeFor(code: string | null | undefined): AuthNotice {
  const c = (code ?? "").trim();
  let problem: AuthProblem;
  if (c === "access_denied") problem = "not_allowed";
  else if (c === "account_disabled") problem = "disabled";
  else if (c === "oidc_unavailable" || c === "temporarily_unavailable" || c === "unreachable") problem = "unreachable";
  else if (c === "expired" || c === "invalid_code" || c === "invalid_state") problem = "expired";
  else problem = "failed";
  return { problem, ...NOTICES[problem] };
}

const NOTICE_ID = "auth-notice";

/** Show the notice over the page. `retry` (when given) is offered as "Try again". */
export function showAuthNotice(notice: AuthNotice, retry?: () => void): HTMLElement {
  document.getElementById(NOTICE_ID)?.remove();
  const backdrop = document.createElement("div");
  backdrop.id = NOTICE_ID;
  backdrop.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;" +
      "padding:16px;background:rgba(0,0,0,0.45);font-family:inherit",
  );
  const box = document.createElement("div");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", `${NOTICE_ID}-title`);
  box.setAttribute("aria-describedby", `${NOTICE_ID}-text`);
  box.setAttribute(
    "style",
    "width:100%;max-width:420px;box-sizing:border-box;padding:22px;border-radius:var(--radius,14px);" +
      "background:var(--bg-elevated,#1c1c1f);color:var(--text,#ececf1);border:1px solid var(--border,rgba(255,255,255,0.1));" +
      "box-shadow:0 12px 40px rgba(0,0,0,0.35)",
  );
  const title = document.createElement("h2");
  title.id = `${NOTICE_ID}-title`;
  title.textContent = notice.title;
  title.setAttribute("style", "margin:0 0 8px;font-size:18px;font-weight:600");
  const text = document.createElement("p");
  text.id = `${NOTICE_ID}-text`;
  text.textContent = notice.text;
  text.setAttribute("style", "margin:0 0 18px;line-height:1.5;color:var(--text-muted,#a9a9b3)");
  const actions = document.createElement("div");
  actions.setAttribute("style", "display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap");

  const button = (label: string, primary: boolean, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute(
      "style",
      "min-height:44px;min-width:44px;padding:0 18px;border-radius:var(--radius-sm,10px);font:inherit;cursor:pointer;" +
        (primary
          ? "background:var(--accent,#8f8fd6);color:var(--accent-fg,#111);border:0"
          : "background:transparent;color:var(--text,#ececf1);border:1px solid var(--border-strong,rgba(255,255,255,0.2))"),
    );
    b.addEventListener("click", onClick);
    return b;
  };
  const close = () => backdrop.remove();
  actions.append(button("Close", !retry, close));
  if (retry) actions.append(button("Try again", true, () => { close(); retry(); }));
  box.append(title, text, actions);
  backdrop.append(box);
  backdrop.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.body.append(backdrop);
  (actions.lastElementChild as HTMLElement | null)?.focus();
  return backdrop;
}
