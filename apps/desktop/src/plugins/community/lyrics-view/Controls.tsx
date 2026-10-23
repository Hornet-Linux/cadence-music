import { useLyricsTranslators, TRANSLATE_LANGUAGES } from "./api";
import { FONT_MAX, FONT_MIN, FONT_STEP, useLyricsView } from "./lyricsStore";

/** A- / A+ buttons. */
export function FontControls() {
  const scale = useLyricsView((s) => s.fontScale);
  const set = useLyricsView((s) => s.setFontScale);
  return (
    <div className="lv-group" role="group" aria-label="Text size">
      <button type="button" className="lv-btn icon" onClick={() => set(scale - FONT_STEP)} disabled={scale <= FONT_MIN} aria-label="Smaller text">
        <span aria-hidden style={{ fontSize: "0.85rem" }}>A</span>
      </button>
      <button type="button" className="lv-btn icon" onClick={() => set(scale + FONT_STEP)} disabled={scale >= FONT_MAX} aria-label="Larger text">
        <span aria-hidden style={{ fontSize: "1.2rem" }}>A</span>
      </button>
    </div>
  );
}

/** The Translate toggle and language menu. Renders nothing unless a translator plugin is on. */
export function TranslateControls() {
  const available = useLyricsTranslators((s) => s.translators.length > 0);
  const on = useLyricsView((s) => s.translateOn);
  const language = useLyricsView((s) => s.translateLanguage);
  const status = useLyricsView((s) => s.translateStatus);
  const setOn = useLyricsView((s) => s.setTranslateOn);
  const setLanguage = useLyricsView((s) => s.setTranslateLanguage);
  if (!available) return null;
  return (
    <div className="lv-group">
      <button type="button" className={`lv-btn${on ? " on" : ""}`} aria-pressed={on} onClick={() => setOn(!on)}>
        {status === "loading" ? "Translating…" : "Translate"}
      </button>
      {on && (
        <select className="lv-select lang" value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Translate into">
          {TRANSLATE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Says why a translation is missing, in words the listener can act on. */
export function TranslateNote() {
  const on = useLyricsView((s) => s.translateOn);
  const status = useLyricsView((s) => s.translateStatus);
  const error = useLyricsView((s) => s.translateError);
  const retry = useLyricsView((s) => s.setTranslateOn);
  if (!on || status !== "error") return null;
  return (
    <p className="lv-note warn" role="alert">
      {error ?? "Translation failed."}{" "}
      <button type="button" className="lv-link" onClick={() => retry(true)}>
        Try again
      </button>
    </p>
  );
}
