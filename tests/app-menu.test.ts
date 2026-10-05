import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { appMenuTemplate } from "../src/main/junto/app-menu";
import { menuKeyOf, type MenuKey } from "../src/shared/key-table";

const items = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  template.flatMap((menu) => (menu.submenu as MenuItemConstructorOptions[]).filter((item) => item.type !== "separator"));

const build = (packaged: boolean, sendKey: (key: MenuKey) => void = () => undefined) =>
  appMenuTemplate({ productName: "Junto", packaged, sendKey });

describe("the app menu", () => {
  it("carries only the system conventions and Junto's own shortcuts", () => {
    const all = items(build(true));
    expect(all.flatMap((item) => (item.role ? [item.role] : []))).toEqual([
      "about",
      "hide",
      "unhide",
      "quit",
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "minimize",
    ]);
    expect(all.flatMap((item) => (item.accelerator ? [item.accelerator] : []))).toEqual([
      "Cmd+=",
      "Cmd+-",
      "Cmd+0",
      "Cmd+`",
      "Cmd+Shift+`",
      "Cmd+W",
    ]);
  });

  it("has no reload, no interface zoom and no full screen chord in the app people use", () => {
    const roles = items(build(true)).map((item) => item.role);
    for (const role of ["reload", "forceReload", "toggleDevTools", "zoomIn", "zoomOut", "resetZoom", "togglefullscreen", "close"]) {
      expect(roles).not.toContain(role);
    }
    for (const item of items(build(true))) expect(item.accelerator ?? "").not.toMatch(/Ctrl|Control/);
  });

  it("adds reload and the developer tools in development builds only", () => {
    const roles = items(build(false)).map((item) => item.role);
    expect(roles).toContain("reload");
    expect(roles).toContain("toggleDevTools");
  });

  it("hands a table item's chord to the page instead of acting on it", () => {
    const sendKey = vi.fn();
    const next = items(build(true, sendKey)).find((item) => item.label === "Next Agent That Needs You")!;
    (next.click as () => void)();
    expect(sendKey).toHaveBeenCalledWith({ accelerator: "Cmd+`", keyCode: "`", modifiers: ["meta"] });
  });
});

describe("menuKeyOf", () => {
  it("writes a chord as the menu bar does and as a key to send", () => {
    expect(menuKeyOf("Cmd+Shift+Backquote")).toEqual({
      accelerator: "Cmd+Shift+`",
      keyCode: "`",
      modifiers: ["meta", "shift"],
    });
    expect(menuKeyOf("Cmd+W")).toEqual({ accelerator: "Cmd+W", keyCode: "w", modifiers: ["meta"] });
    expect(menuKeyOf("Cmd+Digit")).toBeNull();
  });
});
