import { CloseIcon, MaxIcon, MinIcon } from "./icons";

/** Draggable strip across the top of the content, with window controls. */
export function TitleBar() {
  const host = window.host;
  return (
    <div className="titlebar">
      <div className="win-controls">
        <button aria-label="Minimize" onClick={() => host?.window.minimize()}>
          <MinIcon />
        </button>
        <button aria-label="Maximize" onClick={() => host?.window.toggleMaximize()}>
          <MaxIcon />
        </button>
        <button className="close" aria-label="Close" onClick={() => host?.window.close()}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
