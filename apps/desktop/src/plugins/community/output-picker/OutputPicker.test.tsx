import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNav } from "@/app/navStore";
import { emptyContributions, usePluginHost } from "@/plugins/host";
import { useOutput } from "../_devices/outputState";
import type { OutputTarget } from "../../types";
import plugin from "./index";
import { OutputPicker } from "./OutputPicker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function target(id: string, devices: { id: string; name: string }[], overrides: Partial<OutputTarget> = {}): OutputTarget {
  return { id, label: `Label ${id}`, listDevices: vi.fn(async () => devices), select: vi.fn(async () => undefined), ...overrides };
}

async function render(...targets: OutputTarget[]) {
  usePluginHost.setState({ contributions: { ...emptyContributions(), outputTargets: targets } });
  await act(async () => {
    root.render(<OutputPicker />);
  });
}

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button.po-device")];
const byName = (name: string) => buttons().find((b) => b.textContent?.includes(name))!;
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useOutput.setState({ active: null, error: null, busy: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Play on...", () => {
  it("shows This device selected, and every target's devices", async () => {
    await render(target("a", [{ id: "1", name: "Kitchen" }]), target("b", [{ id: "2", name: "Laptop" }]));
    expect(host.textContent).toContain("Label a");
    expect(host.textContent).toContain("Label b");
    expect(byName("This device").getAttribute("aria-checked")).toBe("true");
    expect(byName("Kitchen").getAttribute("aria-checked")).toBe("false");
    expect(byName("Laptop")).toBeTruthy();
  });

  it("picking a device selects it and marks it, then This device brings it back", async () => {
    const a = target("a", [{ id: "1", name: "Kitchen" }]);
    await render(a);
    await click(byName("Kitchen"));
    expect(a.select).toHaveBeenCalledWith("1");
    expect(byName("Kitchen").getAttribute("aria-checked")).toBe("true");
    expect(byName("This device").getAttribute("aria-checked")).toBe("false");
    await click(byName("This device"));
    expect(a.select).toHaveBeenLastCalledWith(null);
    expect(byName("This device").getAttribute("aria-checked")).toBe("true");
  });

  it("shows why a switch failed and keeps This device selected", async () => {
    await render(target("a", [{ id: "1", name: "Kitchen" }], { select: vi.fn(async () => Promise.reject(new Error("The device did not respond."))) }));
    await click(byName("Kitchen"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The device did not respond.");
    expect(byName("This device").getAttribute("aria-checked")).toBe("true");
  });

  it("explains an empty or failing target without hiding the others", async () => {
    await render(
      target("a", []),
      target("b", [], { listDevices: vi.fn(async () => Promise.reject(new Error("Could not reach your server."))) }),
      target("c", [{ id: "3", name: "TV" }]),
    );
    expect(host.textContent).toContain("Nothing found");
    expect(host.textContent).toContain("Could not reach your server.");
    expect(byName("TV")).toBeTruthy();
  });

  it("says what to do when no plugin offers an output", async () => {
    await render();
    expect(host.textContent).toContain("No other outputs yet");
    expect(buttons()).toHaveLength(1);
  });

  it("can look again for a target's devices", async () => {
    const a = target("a", [{ id: "1", name: "Kitchen" }]);
    await render(a);
    expect(a.listDevices).toHaveBeenCalledTimes(1);
    await click(host.querySelector('button[aria-label="Look for Label a again"]')!);
    expect(a.listDevices).toHaveBeenCalledTimes(2);
  });

  it("the plugin adds a Play on page and a command that opens it", async () => {
    usePluginHost.getState().register(plugin);
    await usePluginHost.getState().setEnabled("cadence.output-picker", true);
    const { sidebar, commands } = usePluginHost.getState().contributions;
    expect(sidebar.map((s) => s.id)).toContain("play-on");
    const cmd = commands.find((c) => c.id === "open-play-on")!;
    await cmd.run();
    expect(useNav.getState().route).toEqual({ kind: "plugin", itemId: "play-on" });
    await usePluginHost.getState().setEnabled("cadence.output-picker", false);
  });
});
