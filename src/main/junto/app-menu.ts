import type { MenuItemConstructorOptions } from "electron";
import { KEY_TABLE, chordsFor, menuKeyOf, type MenuKey, type ShortcutId } from "../../shared/key-table";

/**
 * The macOS menu bar, Junto first. Electron installs a stock menu for an app
 * that sets none, and that menu carries shortcuts nobody chose (reload the
 * window, zoom the whole interface, full screen on a Control chord). This
 * one carries only what Junto defines:
 *
 * - the system's own conventions: hide, quit, minimize, and the Edit items
 *   that make copy and paste work in fields and terminals;
 * - shortcuts from the key table, so the menu shows the same chords the
 *   dispatcher answers. A table item hands its chord to the page as a
 *   keydown, so the table stays the one place a chord is resolved. macOS
 *   keeps Cmd+backtick for itself unless a menu item claims it, which is why
 *   the urgency switcher is here;
 * - in development builds only: reload and the developer tools.
 */

type TableItem = { readonly id: ShortcutId; readonly label: string };

const VIEW_ITEMS: ReadonlyArray<TableItem> = [
  { id: "canvas.zoomIn", label: "Zoom Canvas In" },
  { id: "canvas.zoomOut", label: "Zoom Canvas Out" },
  { id: "canvas.zoomReset", label: "Canvas at 100 Percent" },
];

const AGENT_ITEMS: ReadonlyArray<TableItem> = [
  { id: "urgency.next", label: "Next Agent That Needs You" },
  { id: "urgency.previous", label: "Previous Agent That Needs You" },
];

const WINDOW_ITEMS: ReadonlyArray<TableItem> = [{ id: "front.close", label: "Close" }];

export type AppMenuInput = {
  readonly productName: string;
  /** False in development builds, which also get reload and developer tools. */
  readonly packaged: boolean;
  /** Hand a chord to the focused window's page as a keydown. */
  readonly sendKey: (key: MenuKey) => void;
};

export const appMenuTemplate = (input: AppMenuInput): MenuItemConstructorOptions[] => {
  const fromTable = (items: ReadonlyArray<TableItem>): MenuItemConstructorOptions[] =>
    items.flatMap(({ id, label }) => {
      const def = KEY_TABLE.find((row) => row.id === id);
      const chord = def ? chordsFor(def, true)[0] : undefined;
      const key = chord === undefined ? null : menuKeyOf(chord);
      return key === null ? [] : [{ label, accelerator: key.accelerator, click: () => input.sendKey(key) }];
    });
  const separator: MenuItemConstructorOptions = { type: "separator" };
  return [
    {
      label: input.productName,
      submenu: [{ role: "about" }, separator, { role: "hide" }, { role: "unhide" }, separator, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...fromTable(VIEW_ITEMS),
        ...(input.packaged ? [] : [separator, { role: "reload" as const }, { role: "toggleDevTools" as const }]),
      ],
    },
    { label: "Agents", submenu: fromTable(AGENT_ITEMS) },
    { label: "Window", submenu: [{ role: "minimize" }, ...fromTable(WINDOW_ITEMS)] },
  ];
};
