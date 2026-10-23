import { useEffect, useRef, type ReactNode } from "react";
import { useServer } from "@/plugins/builtins/server/serverStore";
import { usePluginHost } from "@/plugins/host";
import { LogoMark } from "@/ui/icons";
import { isWebPlayer } from "@/ui/platform";
import { useOnboarding, wizardMode } from "./onboardingStore";

interface Step {
  id: string;
  title: string;
  description?: string;
  body: ReactNode;
}

/**
 * First-run setup. The welcome and finish pages are built in; everything in
 * between is contributed by plugins (server, Spotify, Apple Music…), so a new
 * plugin can add its own step. Every step can be skipped.
 *
 * On the web player (and the phone apps) the page comes from the person's own
 * server: the wizard doesn't talk about files on this computer or running the
 * deploy script, skips the server step once they are signed in, and doesn't
 * appear at all for anyone already signed in.
 */
export function SetupWizard() {
  const { open, step, manual, next, back, finish } = useOnboarding();
  const pluginSteps = usePluginHost((s) => s.contributions.setupSteps);
  const serverStatus = useServer((s) => s.status);
  const user = useServer((s) => s.user);
  const hasToken = useServer((s) => !!s.token);
  const hasError = useServer((s) => !!s.error);
  const dialogRef = useRef<HTMLDivElement>(null);
  const web = isWebPlayer();

  const mode = wizardMode({ web, manual, serverStatus, signedIn: !!user, hasToken, hasError });
  useEffect(() => {
    if (open && mode === "skip") finish();
  }, [open, mode, finish]);

  const visible = open && mode === "show";
  useEffect(() => {
    if (visible) dialogRef.current?.querySelector<HTMLElement>(".wizard-footer button.primary")?.focus();
  }, [visible, step]);

  if (!visible) return null;

  const serverStep = (id: string) => web && id === "server";
  const steps: Step[] = [
    {
      id: "welcome",
      title: "Welcome to Cadence",
      description: web
        ? "Let's get you listening."
        : "Let's get your music in. Every step is optional and you can change it later in Settings.",
      body: (
        <div className="wizard-welcome">
          <div className="wizard-logo" aria-hidden>
            <LogoMark size={56} />
          </div>
          {web ? (
            <p>
              This player streams music from <strong>your own server</strong>, and can add <strong>Spotify</strong>,{" "}
              <strong>Apple Music</strong> and <strong>Jellyfin</strong> too, all in one library and one queue.
            </p>
          ) : (
            <>
              <p>
                This app plays music from <strong>your own server</strong>, <strong>Spotify</strong>,{" "}
                <strong>Apple Music</strong>, <strong>Jellyfin</strong> and <strong>files on this computer</strong>, all in
                one library and one queue.
              </p>
              <p className="muted">
                Self-hosting? Run <code>deploy/setup.sh</code> on your server first; it prints a one-time setup code
                you'll use in the next step.
              </p>
            </>
          )}
        </div>
      ),
    },
    ...pluginSteps
      // Already signed in to the server that served this page: nothing to set up.
      .filter((s) => !(serverStep(s.id) && user))
      .map((s) => ({
        id: s.id,
        title: serverStep(s.id) ? "Sign in" : s.title,
        description: serverStep(s.id) ? "Sign in to your server to see your music." : s.description,
        body: s.render(),
      })),
    {
      id: "done",
      title: "You're all set",
      description: "Enjoy your music.",
      body: (
        <div className="wizard-welcome">
          <p>
            Your library is under <strong>Library</strong>.{" "}
            {web ? (
              <>
                Each connected service has its own page under <strong>More</strong>.
              </>
            ) : (
              <>
                Each source has its own page under <strong>More</strong>; add files from this computer under{" "}
                <strong>Local Files</strong>.
              </>
            )}
          </p>
          <p className="muted">
            You can run this setup again any time from <strong>Settings → About</strong>.
          </p>
        </div>
      ),
    },
  ];

  const index = Math.min(step, steps.length - 1);
  const current = steps[index];
  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  return (
    <div className="wizard-backdrop" role="dialog" aria-modal="true" aria-labelledby="wizard-title" ref={dialogRef}>
      <div className="wizard">
        <div className="wizard-progress" role="img" aria-label={`Step ${index + 1} of ${steps.length}`}>
          {steps.map((s, i) => (
            <span key={s.id} className={`dot${i === index ? " current" : i < index ? " done" : ""}`} />
          ))}
        </div>
        <header className="wizard-header">
          <h1 id="wizard-title">{current.title}</h1>
          {current.description && <p className="muted">{current.description}</p>}
        </header>
        <div className="wizard-body">{current.body}</div>
        <footer className="wizard-footer">
          <div>
            {!isLast && (
              <button className="btn ghost" onClick={finish}>
                Skip setup
              </button>
            )}
          </div>
          <div className="row">
            {!isFirst && (
              <button className="btn ghost" onClick={back}>
                Back
              </button>
            )}
            {isLast ? (
              <button className="btn primary" onClick={finish}>
                Start listening
              </button>
            ) : (
              <button className="btn primary" onClick={next}>
                {isFirst ? "Get started" : "Next"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
