import { useNav } from "@/app/navStore";
import { BackIcon, CloseIcon, ForwardIcon, MaxIcon, MinIcon } from "./icons";

/** Draggable strip across the top of the content: page history and window controls. */
export function TitleBar() {
  const host = window.host;
  const canBack = useNav((s) => s.back.length > 0);
  const canForward = useNav((s) => s.forward.length > 0);
  const goBack = useNav((s) => s.goBack);
  const goForward = useNav((s) => s.goForward);
  return (
    <div className="titlebar">
      <div className="nav-arrows">
        <button aria-label="Back" data-tip="Back" disabled={!canBack} onClick={goBack}>
          <BackIcon size={18} />
        </button>
        <button aria-label="Forward" data-tip="Forward" disabled={!canForward} onClick={goForward}>
          <ForwardIcon size={18} />
        </button>
      </div>
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
