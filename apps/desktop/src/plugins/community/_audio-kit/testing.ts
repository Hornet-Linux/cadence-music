import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/** Render into jsdom with the live store state (renderToString only sees initial state). */
export function renderLive(node: ReactNode): { html: () => string; container: HTMLElement; unmount: () => void } {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    html: () => container.innerHTML,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
