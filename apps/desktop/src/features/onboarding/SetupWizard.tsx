import type { ReactNode } from "react";
import { usePluginHost } from "@/plugins/host";
import { useOnboarding } from "./onboardingStore";

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
 */
export function SetupWizard() {
  const { open, step, next, back, finish } = useOnboarding();
  const pluginSteps = usePluginHost((s) => s.contributions.setupSteps);
  if (!open) return null;

  const steps: Step[] = [
    {
      id: "welcome",
      title: "Welcome to Unnamed Music App",
      description: "Let's get your music in. Every step is optional and you can change it later in Settings.",
      body: (
        <div className="wizard-welcome">
          <p>
            This app plays music from <strong>your own server</strong>, <strong>Spotify</strong>,{" "}
            <strong>Apple Music</strong> and <strong>files on this computer</strong> — all in one
            library and one queue.
          </p>
          <p className="muted">
            Self-hosting? Run <code>deploy/setup.sh</code> on your server first; it prints a one-time
            setup code you'll use in the next step.
          </p>
        </div>
      ),
    },
    ...pluginSteps.map((s) => ({ id: s.id, title: s.title, description: s.description, body: s.render() })),
    {
      id: "done",
      title: "You're all set",
      description: "Enjoy your music.",
      body: (
        <div className="wizard-welcome">
          <p>
            Your library is under <strong>Library</strong>, and each source has its own page in the
            sidebar. Add files from this computer under <strong>Local Files</strong>.
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
    <div className="wizard-backdrop" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div className="wizard">
        <div className="wizard-progress" aria-label={`Step ${index + 1} of ${steps.length}`}>
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
