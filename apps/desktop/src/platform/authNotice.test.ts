import { afterEach, describe, expect, it, vi } from "vitest";
import { authNoticeFor, showAuthNotice } from "./authNotice";

describe("authNoticeFor", () => {
  it("maps the server's sign-in errors to friendly messages", () => {
    expect(authNoticeFor("access_denied").text).toBe(
      "Your account isn't allowed to use this server. Ask the server owner to add you to the right group.",
    );
    for (const code of ["token_exchange_failed", "invalid_id_token", "missing_id_token", "server_error", "something_new", null]) {
      expect(authNoticeFor(code).text).toBe(
        "Sign-in failed: the server couldn't confirm your sign-in. Try again or tell the server owner.",
      );
    }
    expect(authNoticeFor("oidc_unavailable").text).toBe("The sign-in service isn't reachable right now. Try again in a moment.");
    expect(authNoticeFor("temporarily_unavailable").problem).toBe("unreachable");
    expect(authNoticeFor("account_disabled").problem).toBe("disabled");
    expect(authNoticeFor("expired").problem).toBe("expired");
  });
});

describe("showAuthNotice", () => {
  afterEach(() => document.body.replaceChildren());

  it("shows one accessible dialog with Try again and Close", () => {
    const retry = vi.fn();
    showAuthNotice(authNoticeFor("access_denied"), retry);
    showAuthNotice(authNoticeFor("access_denied"), retry); // replaces, never stacks
    const dialogs = document.querySelectorAll("[role=alertdialog]");
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].textContent).toContain("Ask the server owner");
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Close", "Try again"]);
    (document.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(retry).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("offers only Close when there is nothing to retry", () => {
    showAuthNotice(authNoticeFor("failed"));
    const buttons = document.querySelectorAll("button");
    expect([...buttons].map((b) => b.textContent)).toEqual(["Close"]);
    buttons[0].click();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });
});
