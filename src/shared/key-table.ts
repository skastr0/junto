/**
 * The key table: every keyboard shortcut in Junto, as data. The dispatcher
 * (renderer lib/key-dispatcher) resolves keydowns against it, and the help
 * and the shortcuts settings page read the same rows.
 *
 * Chords
 * - A chord is a string: modifiers in the order Cmd, Ctrl, Alt, Shift, then
 *   one key, joined by "+" ("Cmd+K", "Cmd+Shift+Backquote", "Slash").
 * - "Digit" stands for any of 1 to 9; the resolver says which.
 * - Digits and the backtick are read from the physical key, so layouts that
 *   need Shift for them still reach the chord. Everything else is read from
 *   the character the layout types.
 *
 * Where a shortcut is live
 * - canvas: the canvas has the keyboard, nothing is being typed.
 * - terminal: focus is in a terminal.
 * - field: focus is in any other field the operator types in.
 * - working: a working modal or Settings is open, focus is not in a field.
 * - operator: an operator modal (search, the needs-you feed) is open.
 * - dialog: a dialog is in front. It asks a question and waits, so nothing
 *   acts under it but opening search or the feed and closing what is in front.
 * - switcher: the urgency switcher is up, which means Cmd is being held.
 *
 * Laws the resolver holds for every row
 * - A chord with no Cmd or Control is a typed character: it never fires
 *   while the operator is typing, a terminal included.
 * - On macOS the app's chords are Cmd chords. Control belongs to the shell.
 * - Elsewhere there is no Cmd: today's Control chords are kept as they were.
 */

export type KeyContext =
  | "canvas"
  | "terminal"
  | "field"
  | "working"
  | "operator"
  | "dialog"
  | "switcher";

export const KEY_CONTEXTS: ReadonlyArray<KeyContext> = [
  "canvas",
  "terminal",
  "field",
  "working",
  "operator",
  "dialog",
  "switcher",
];

// The switcher is not part of "everywhere": while it is up, its own rows
// decide what each key means.
const EVERYWHERE: ReadonlyArray<KeyContext> = ["canvas", "terminal", "field", "working", "operator"];
// The few chords that also answer under a dialog.
const OVER_DIALOGS: ReadonlyArray<KeyContext> = [...EVERYWHERE, "dialog"];
// Everywhere but under search or the feed: nothing behind an operator modal acts.
const UNDER_NO_MODAL: ReadonlyArray<KeyContext> = ["canvas", "terminal", "field", "working"];
const NOT_TYPING: ReadonlyArray<KeyContext> = ["canvas", "working", "operator"];

/** Where the shortcuts page lists a shortcut: by where its chord works. */
export type ShortcutArea =
  | "Anywhere"
  | "Search and feed"
  | "Quick capture"
  | "Canvas"
  | "Agent and terminal"
  | "Inside a node"
  | "Inside quick open"
  | "Inside search"
  | "Inside quick capture"
  | "Inside the needs-you feed"
  | "Inside a list"
  | "Inside a preview"
  | "Inside an artifact"
  | "Inside a file"
  | "Inside a document"
  | "Inside a sheet"
  | "Inside the drawing pad"
  | "Inside a page"
  | "Writing a message";

export const SHORTCUT_AREAS: ReadonlyArray<ShortcutArea> = [
  "Anywhere",
  "Search and feed",
  "Quick capture",
  "Canvas",
  "Agent and terminal",
  "Inside a node",
  "Inside quick open",
  "Inside search",
  "Inside quick capture",
  "Inside the needs-you feed",
  "Inside a list",
  "Inside a preview",
  "Inside an artifact",
  "Inside a file",
  "Inside a document",
  "Inside a sheet",
  "Inside the drawing pad",
  "Inside a page",
  "Writing a message",
];

export type ShortcutId =
  | "search.open"
  | "search.slash"
  | "feed.open"
  | "capture.open"
  | "groups.assign"
  | "groups.recall"
  | "groups.jump"
  | "alerts.next"
  | "git.review"
  | "urgency.next"
  | "urgency.previous"
  | "switcher.next"
  | "switcher.previous"
  | "switcher.commit"
  | "switcher.cancel"
  | "mirrors.next"
  | "mirrors.previous"
  | "canvas.undo"
  | "canvas.redo"
  | "canvas.zoomIn"
  | "canvas.zoomOut"
  | "canvas.zoomReset"
  | "front.close"
  | "rail.toggle"
  | "comments.toggle"
  | "pane.next"
  | "pane.previous"
  | "quickOpen.open"
  | "files.save"
  | "canvas.open"
  | "page.address"
  | "page.reload"
  | SurfaceKeyId;

/**
 * Keys a surface handles itself (the feed, search, the preview viewer, the
 * drawing pad, the canvas camera). They are listed here so the shortcuts
 * page and the help show them and a changed shortcut cannot land on one,
 * but the dispatcher never acts on them: the modal stack already routes
 * those keys to the surface that is open.
 */
export type SurfaceKeyId =
  | "canvas.pan"
  | "canvas.delete"
  | "canvas.escape"
  | "canvas.magnify"
  | "inSearch.move"
  | "inSearch.mode"
  | "inSearch.go"
  | "inSearch.open"
  | "inCapture.move"
  | "inCapture.open"
  | "inCapture.node"
  | "inCapture.new"
  | "inCapture.search"
  | "inCapture.route"
  | "inList.next"
  | "inList.previous"
  | "inList.first"
  | "inList.last"
  | "inList.open"
  | "inArtifacts.move"
  | "inArtifacts.extend"
  | "inArtifacts.menu"
  | "inQuickOpen.move"
  | "inQuickOpen.open"
  | "inFeed.reply"
  | "inFeed.openAgent"
  | "inFeed.quickReply"
  | "inFeed.dismiss"
  | "inFeed.acknowledge"
  | "inFeed.quietNote"
  | "inPreview.step"
  | "inPreview.compare"
  | "inPreview.zoom"
  | "inDocument.write"
  | "inDocument.stop"
  | "inDocument.mention"
  | "inDocument.bold"
  | "inDocument.italic"
  | "inDocument.follow"
  | "inDocument.thread"
  | "inSheet.move"
  | "inSheet.extend"
  | "inSheet.edit"
  | "inSheet.commit"
  | "inSheet.cancel"
  | "inSheet.across"
  | "inSheet.type"
  | "inSheet.clear"
  | "inPad.tool"
  | "inPad.pan"
  | "inPad.order"
  | "inPad.delete"
  | "inPad.nudge"
  | "inPad.label"
  | "inPad.undo"
  | "inPad.redo"
  | "inPad.duplicate"
  | "inPad.escape"
  | "inPad.next"
  | "inPad.prev"
  | "message.send"
  | "message.sendQuietly";

export type ShortcutDef = {
  readonly id: ShortcutId;
  readonly area: ShortcutArea;
  /** The action's name, a few plain words. */
  readonly name: string;
  /** What it does, in product words. */
  readonly does: string;
  /** Default chords on macOS. */
  readonly mac: ReadonlyArray<string>;
  /** Default chords elsewhere. */
  readonly other: ReadonlyArray<string>;
  readonly where: ReadonlyArray<KeyContext>;
  /** Where it is live off macOS, when that differs. */
  readonly whereOther?: ReadonlyArray<KeyContext>;
  /** Acts again on every auto-repeat while the chord is held. */
  readonly repeats?: true;
  /** Also runs when this modifier is let go. */
  readonly onRelease?: "Cmd";
  /** Its chord must hold Cmd: letting Cmd go is what opens the chosen agent. */
  readonly needsCmd?: true;
  /** Why the chord cannot be changed, in a few words. Absent: it can. */
  readonly fixed?: string;
  /** The surface handles these keys itself; the dispatcher leaves them alone. */
  readonly surface?: true;
  /** Key caps to show in place of the chords, when the chords alone read badly. */
  readonly shown?: ReadonlyArray<ReadonlyArray<string>>;
};

const SHORTCUTS: ReadonlyArray<ShortcutDef> = [
  {
    id: "search.open",
    name: "Open search",
    area: "Search and feed",
    does: "Open search, or close it when it is open",
    mac: ["Cmd+K"],
    other: ["Ctrl+K"],
    where: OVER_DIALOGS,
    // Ctrl+K in a shell kills to the end of the line.
    whereOther: ["canvas", "field", "working", "operator", "dialog"],
  },
  {
    id: "search.slash",
    name: "Open search with one key",
    area: "Search and feed",
    does: "Open search",
    mac: ["Slash"],
    other: ["Slash"],
    where: NOT_TYPING,
  },
  {
    id: "feed.open",
    name: "Open the needs-you feed",
    area: "Search and feed",
    does: "Open the needs-you feed, or close it when it is open",
    mac: ["Cmd+I"],
    other: ["Ctrl+I"],
    where: OVER_DIALOGS,
    whereOther: ["canvas", "field", "working", "operator", "dialog"],
  },
  {
    id: "capture.open",
    name: "Start a capture",
    area: "Quick capture",
    does: "Open quick capture with the caret in a new document, or close it when it is open",
    mac: ["Cmd+T"],
    other: ["Ctrl+T"],
    where: OVER_DIALOGS,
    // Ctrl+T transposes two characters in a shell.
    whereOther: ["canvas", "field", "working", "operator", "dialog"],
  },
  {
    id: "groups.assign",
    name: "Save a command group",
    area: "Canvas",
    does: "Save the selection as command group 1 to 9",
    mac: ["Cmd+Digit"],
    other: ["Ctrl+Digit"],
    where: ["canvas"],
  },
  {
    id: "groups.recall",
    name: "Go to a command group",
    area: "Canvas",
    does: "Go to command group 1 to 9; press again to step through its agents",
    mac: ["Digit"],
    other: ["Digit"],
    where: ["canvas"],
  },
  {
    id: "groups.jump",
    name: "Jump to a command group",
    area: "Agent and terminal",
    does: "Jump to command group 1 to 9; press again for its next agent",
    mac: ["Cmd+Digit"],
    // Off macOS there is no Cmd, and Ctrl plus a digit is the shell's.
    other: [],
    where: ["terminal", "field", "working"],
  },
  {
    id: "alerts.next",
    area: "Canvas",
    name: "Next agent on the canvas",
    does: "Go to the next agent on the canvas, most urgent first",
    mac: ["Space", "Backquote"],
    other: ["Space", "Backquote"],
    // Canvas only: inside a working modal Space belongs to the surface.
    where: ["canvas"],
  },
  {
    id: "urgency.next",
    name: "Next agent, most urgent first",
    area: "Anywhere",
    does: "Step through every agent, most urgent first: hold Cmd, tap to step, let go to open it",
    mac: ["Cmd+Backquote"],
    other: [],
    where: ["canvas", "terminal", "field", "working", "switcher"],
    repeats: true,
    needsCmd: true,
  },
  {
    id: "urgency.previous",
    name: "Previous agent",
    area: "Anywhere",
    does: "Step back through the agents, towards the most urgent",
    mac: ["Cmd+Shift+Backquote"],
    other: [],
    where: ["canvas", "terminal", "field", "working", "switcher"],
    repeats: true,
    needsCmd: true,
  },
  // While the switcher is up Cmd is held, so its keys are Cmd chords.
  {
    id: "switcher.next",
    name: "Switcher: next agent",
    area: "Agent and terminal",
    does: "In the switcher, move to the next agent",
    mac: ["Cmd+ArrowDown", "Cmd+ArrowRight", "Cmd+J", "Cmd+L"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
    repeats: true,
  },
  {
    id: "switcher.previous",
    name: "Switcher: previous agent",
    area: "Agent and terminal",
    does: "In the switcher, move to the previous agent",
    mac: ["Cmd+ArrowUp", "Cmd+ArrowLeft", "Cmd+K", "Cmd+H"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
    repeats: true,
  },
  {
    id: "switcher.commit",
    name: "Switcher: open the agent",
    area: "Agent and terminal",
    does: "In the switcher, open the chosen agent",
    mac: ["Cmd+Enter"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
    onRelease: "Cmd",
  },
  {
    id: "switcher.cancel",
    name: "Switcher: cancel",
    area: "Agent and terminal",
    does: "In the switcher, close it and stay where you were",
    mac: ["Cmd+Escape"],
    other: [],
    where: ["switcher"],
    fixed: "Cmd is held while the switcher is up",
  },
  {
    id: "git.review",
    name: "Open the git review",
    area: "Agent and terminal",
    does: "Open the git review for the agent in front, or close it",
    mac: ["Cmd+G"],
    other: [],
    where: ["terminal", "field", "working"],
  },
  {
    id: "mirrors.next",
    name: "Next connected terminal",
    area: "Anywhere",
    does: "Go to the next connected agent terminal",
    mac: ["Cmd+BracketRight"],
    other: [],
    where: UNDER_NO_MODAL,
  },
  {
    id: "mirrors.previous",
    name: "Previous connected terminal",
    area: "Anywhere",
    does: "Go to the previous connected agent terminal",
    mac: ["Cmd+BracketLeft"],
    other: [],
    where: UNDER_NO_MODAL,
  },
  // Canvas only: a surface in front (the drawing pad, a browser page) has its
  // own undo, and Cmd+Z must never edit the canvas behind it.
  {
    id: "canvas.undo",
    name: "Undo",
    area: "Canvas",
    does: "Undo the last canvas change",
    mac: ["Cmd+Z"],
    other: ["Ctrl+Z"],
    where: ["canvas"],
  },
  {
    id: "canvas.redo",
    name: "Redo",
    area: "Canvas",
    does: "Redo the canvas change that was undone",
    mac: ["Cmd+Shift+Z"],
    other: ["Ctrl+Shift+Z"],
    where: ["canvas"],
  },
  // Zoom moves the canvas camera, never the size of the whole interface.
  {
    id: "canvas.zoomIn",
    name: "Zoom the canvas in",
    area: "Canvas",
    does: "Zoom the canvas in",
    mac: ["Cmd+Equal", "Cmd+Plus"],
    other: [],
    where: ["canvas"],
  },
  {
    id: "canvas.zoomOut",
    name: "Zoom the canvas out",
    area: "Canvas",
    does: "Zoom the canvas out",
    mac: ["Cmd+Minus"],
    other: [],
    where: ["canvas"],
  },
  {
    id: "canvas.zoomReset",
    name: "Canvas at 100 percent",
    area: "Canvas",
    does: "Show the canvas at 100 percent",
    mac: ["Cmd+0"],
    other: [],
    where: ["canvas"],
  },
  {
    id: "rail.toggle",
    area: "Agent and terminal",
    name: "Show or hide the agent's connections",
    does: "Widen or narrow the list of connected agents beside the agent in front",
    mac: ["Cmd+B"],
    other: [],
    where: ["terminal", "working"],
  },
  // Not Cmd+B: in a document that is bold, as every editor has it.
  {
    id: "comments.toggle",
    area: "Inside an artifact",
    name: "Show or hide the comments",
    does: "Open or close the artifact's comments",
    mac: ["Cmd+Shift+M"],
    other: ["Ctrl+Shift+M"],
    where: ["working", "field"],
  },
  // An artifact's list, content and comments, or an automation's list and
  // detail: the keyboard steps between the panes that show.
  {
    id: "pane.next",
    area: "Inside an artifact",
    name: "Next pane",
    does: "Move the keyboard to the next pane: the list, the content, the comments",
    mac: ["Cmd+Alt+ArrowRight"],
    other: ["Ctrl+Alt+ArrowRight"],
    where: ["working", "field"],
  },
  {
    id: "pane.previous",
    area: "Inside an artifact",
    name: "Previous pane",
    does: "Move the keyboard to the previous pane",
    mac: ["Cmd+Alt+ArrowLeft"],
    other: ["Ctrl+Alt+ArrowLeft"],
    where: ["working", "field"],
  },
  // The node modal in front, not the canvas: quick open searches what the
  // node holds, and there is nothing to search with no node open.
  {
    id: "quickOpen.open",
    area: "Inside a node",
    name: "Quick open",
    does: "Find a file or an item in the node in front, by typing its name",
    mac: ["Cmd+P"],
    other: ["Ctrl+P"],
    where: ["working", "field"],
  },
  // The Files node's own save. Never a terminal: there Control+S is XOFF.
  {
    id: "files.save",
    area: "Inside a file",
    name: "Save the file",
    does: "Save the file open in the Files node",
    mac: ["Cmd+S"],
    other: ["Ctrl+S"],
    where: ["working", "field"],
  },
  {
    id: "canvas.open",
    area: "Canvas",
    name: "Open the selected agent",
    does: "Open what is selected on the canvas, as a double-click does",
    mac: ["Cmd+Enter"],
    other: ["Ctrl+Enter"],
    where: ["canvas"],
  },
  {
    id: "front.close",
    name: "Close what is in front",
    area: "Anywhere",
    does: "Close what is in front, one layer at a time; with nothing open, close the window",
    mac: ["Cmd+W"],
    // Ctrl+W deletes a word in the shell.
    other: [],
    where: OVER_DIALOGS,
  },
  // A page in front: its chrome or the page itself has the keyboard. The page
  // view's keys never reach this document, so these also ride the menu bar.
  {
    id: "page.address",
    area: "Inside a page",
    name: "Go to the address bar",
    does: "Put the keyboard in the page's address bar, its address selected",
    mac: ["Cmd+L"],
    other: ["Ctrl+L"],
    where: ["working", "field"],
  },
  {
    id: "page.reload",
    area: "Inside a page",
    name: "Reload the page",
    does: "Load the page in front again",
    mac: ["Cmd+R"],
    other: ["Ctrl+R"],
    where: ["working", "field"],
  },
];

/** Why a surface's own key cannot be changed here. */
const SURFACE_FIXED = "Built into this screen";

const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;

const surfaceKey = (
  row: Omit<ShortcutDef, "other" | "fixed" | "surface" | "mac"> & {
    readonly keys: ReadonlyArray<string>;
    /** Off macOS, when the chord differs (Cmd becomes Ctrl). */
    readonly keysOther?: ReadonlyArray<string>;
  },
): ShortcutDef => {
  const { keys, keysOther, ...rest } = row;
  return { ...rest, mac: keys, other: keysOther ?? keys, fixed: SURFACE_FIXED, surface: true };
};

const SURFACE_KEYS: ReadonlyArray<ShortcutDef> = [
  surfaceKey({
    id: "canvas.pan",
    area: "Canvas",
    name: "Pan the canvas",
    does: "Pan the canvas; hold Shift to go faster",
    keys: [...ARROWS, "W", "A", "S", "D", ...ARROWS.map((key) => `Shift+${key}`), "Shift+W", "Shift+A", "Shift+S", "Shift+D"],
    shown: [["Arrow keys"], ["W", "A", "S", "D"]],
    where: ["canvas"],
  }),
  surfaceKey({
    id: "canvas.delete",
    area: "Canvas",
    name: "Delete the selection",
    does: "Delete what is selected on the canvas",
    keys: ["Backspace", "Delete"],
    where: ["canvas"],
  }),
  surfaceKey({
    id: "canvas.escape",
    area: "Canvas",
    name: "Close or clear",
    does: "Close what is open, or clear the selection",
    keys: ["Escape"],
    where: ["canvas", "working", "operator", "dialog"],
  }),
  surfaceKey({
    id: "canvas.magnify",
    area: "Canvas",
    name: "Read nearby nodes",
    does: "Hold to read the nodes near the pointer at a readable size",
    keys: [],
    shown: [["Alt"]],
    where: ["canvas"],
  }),
  surfaceKey({
    id: "inSearch.move",
    area: "Inside search",
    name: "Move through the results",
    does: "Move through the search results",
    keys: ["ArrowDown", "ArrowUp"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inSearch.mode",
    area: "Inside search",
    name: "Agents or actions",
    does: "Switch search between agents and actions",
    keys: ["Tab"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inSearch.go",
    area: "Inside search",
    name: "Go to the result",
    does: "Go to the search result on the canvas, or open it when search is over an open agent",
    keys: ["Enter"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inSearch.open",
    area: "Inside search",
    name: "Open the result",
    does: "Open the search result, wherever search was opened from",
    keys: ["Cmd+Enter"],
    keysOther: ["Ctrl+Enter"],
    where: ["operator"],
  }),

  // Quick capture is an operator modal too: the list and its preview on the
  // left, the editor on the right. The keys act on the row in focus, never
  // while the caret is in the editor, where they are the editor's own.
  surfaceKey({
    id: "inCapture.move",
    area: "Inside quick capture",
    name: "Move through the list",
    does: "Move through the captures; the preview follows the row",
    keys: ["ArrowDown", "ArrowUp"],
    shown: [["Arrow keys"]],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inCapture.open",
    area: "Inside quick capture",
    name: "Edit the capture",
    does: "Edit the focused capture in place",
    keys: ["Enter"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inCapture.node",
    area: "Inside quick capture",
    name: "Open it in its node",
    does: "Open the focused capture in its own node",
    keys: ["Cmd+Enter"],
    keysOther: ["Ctrl+Enter"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inCapture.new",
    area: "Inside quick capture",
    name: "Start another capture",
    does: "Start another capture; the one in front stays saved",
    keys: ["Cmd+N"],
    keysOther: ["Ctrl+N"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inCapture.search",
    area: "Inside quick capture",
    name: "Go to the search field",
    does: "Put the keyboard in the search field",
    keys: ["Cmd+L"],
    keysOther: ["Ctrl+L"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inCapture.route",
    area: "Inside quick capture",
    name: "Move it to another node",
    does: "Move the focused capture to another Artifacts node",
    keys: ["M"],
    where: ["operator"],
  }),

  // Every list: the feed, the artifacts, the tasks (lib/list-nav). A list
  // adds its own keys under its own area.
  surfaceKey({
    id: "inList.next",
    area: "Inside a list",
    name: "Next row",
    does: "Move to the next row in a list",
    keys: ["J", "ArrowDown"],
    where: ["working", "operator"],
  }),
  surfaceKey({
    id: "inList.previous",
    area: "Inside a list",
    name: "Previous row",
    does: "Move to the previous row in a list",
    keys: ["K", "ArrowUp"],
    where: ["working", "operator"],
  }),
  surfaceKey({
    id: "inList.first",
    area: "Inside a list",
    name: "First row",
    does: "Move to the first row in a list",
    keys: ["Home"],
    where: ["working", "operator"],
  }),
  surfaceKey({
    id: "inList.last",
    area: "Inside a list",
    name: "Last row",
    does: "Move to the last row in a list",
    keys: ["End"],
    where: ["working", "operator"],
  }),
  surfaceKey({
    id: "inList.open",
    area: "Inside a list",
    name: "Open the row",
    does: "Open the row and put the keyboard in it",
    keys: ["Enter"],
    where: ["working", "operator"],
  }),

  // The Artifacts node's list adds its own (0.11.1, 10): move rows to another
  // node, and pick more than one row to move together.
  surfaceKey({
    id: "inArtifacts.move",
    area: "Inside an artifact",
    name: "Move to another node",
    does: "Move the focused artifact, or the picked ones, to another Artifacts node",
    keys: ["M"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inArtifacts.extend",
    area: "Inside an artifact",
    name: "Pick more rows",
    does: "Pick the next or previous artifact as well, to move them together",
    keys: ["Shift+ArrowDown", "Shift+ArrowUp"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inArtifacts.menu",
    area: "Inside an artifact",
    name: "Open the row's menu",
    does: "Open the menu of the focused artifact in the list",
    keys: ["Shift+F10", "ContextMenu"],
    where: ["working"],
  }),

  // Quick open is a field the operator types in, so its moves are the ones a
  // combobox owns: arrows without a modifier, and Enter to open the match.
  surfaceKey({
    id: "inQuickOpen.move",
    area: "Inside quick open",
    name: "Move through the matches",
    does: "Move through the files or items that match what is typed",
    keys: ["ArrowDown", "ArrowUp"],
    where: ["field", "working"],
  }),
  surfaceKey({
    id: "inQuickOpen.open",
    area: "Inside quick open",
    name: "Open the match",
    does: "Open the file or item that is picked",
    keys: ["Enter"],
    where: ["field", "working"],
  }),
  surfaceKey({
    id: "inFeed.reply",
    area: "Inside the needs-you feed",
    name: "Reply",
    does: "Reply to the selected item, or open its agent when there is nothing to answer",
    keys: ["Enter"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inFeed.openAgent",
    area: "Inside the needs-you feed",
    name: "Open the agent",
    does: "Open the agent of the selected item",
    keys: ["O"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inFeed.quickReply",
    area: "Inside the needs-you feed",
    name: "Send a quick reply",
    does: "Send quick reply 1 to 9 to the selected item",
    keys: ["Digit"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inFeed.dismiss",
    area: "Inside the needs-you feed",
    name: "Dismiss",
    does: "Dismiss the selected item; it closes and the seat is not told",
    keys: ["D"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inFeed.acknowledge",
    area: "Inside the needs-you feed",
    name: "Acknowledge",
    does: "Acknowledge the selected item with no note; the seat is not woken",
    keys: ["A"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inFeed.quietNote",
    area: "Inside the needs-you feed",
    name: "Send a quiet note",
    does: "Send quiet note 1 to 9 to the selected item; the seat is not woken",
    keys: ["Shift+Digit"],
    where: ["operator"],
  }),
  surfaceKey({
    id: "inPreview.step",
    area: "Inside a preview",
    name: "Next or previous",
    does: "Go to the next or previous preview",
    keys: ["ArrowRight", "ArrowLeft"],
    where: ["working", "operator"],
  }),
  surfaceKey({
    id: "inPreview.compare",
    area: "Inside a preview",
    name: "Compare",
    does: "Compare the two versions of a preview",
    keys: ["C"],
    where: ["working", "operator"],
  }),
  surfaceKey({
    id: "inPreview.zoom",
    area: "Inside a preview",
    name: "Zoom",
    does: "Zoom the preview",
    keys: ["Z"],
    where: ["working", "operator"],
  }),

  surfaceKey({
    id: "inDocument.write",
    area: "Inside a document",
    name: "Write",
    does: "Write in the document, the caret back where it was",
    keys: ["Enter"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inDocument.stop",
    area: "Inside a document",
    name: "Stop writing",
    does: "Stop writing and read the document; Escape again closes",
    keys: ["Escape"],
    where: ["field"],
  }),
  surfaceKey({
    id: "inDocument.mention",
    area: "Inside a document",
    name: "Name a seat or page",
    does: "Name a seat or a page; Enter or Tab picks it",
    keys: [],
    shown: [["@"]],
    where: ["field"],
  }),
  surfaceKey({
    id: "inDocument.bold",
    area: "Inside a document",
    name: "Bold",
    does: "Make the selection bold, or plain again",
    keys: ["Cmd+B"],
    keysOther: ["Ctrl+B"],
    where: ["field"],
  }),
  // Not Cmd+I: that opens the needs-you feed from every field. Not
  // Cmd+Shift+I: off macOS it is the developer tools in a dev build.
  surfaceKey({
    id: "inDocument.italic",
    area: "Inside a document",
    name: "Italic",
    does: "Make the selection italic, or plain again",
    keys: ["Cmd+E"],
    keysOther: ["Ctrl+E"],
    where: ["field"],
  }),
  surfaceKey({
    id: "inDocument.follow",
    area: "Inside a document",
    name: "Open the link",
    does: "Open the link at the caret: a seat, task or artifact, or a web page",
    keys: ["Cmd+Enter"],
    keysOther: ["Ctrl+Enter"],
    where: ["field"],
  }),
  surfaceKey({
    id: "inDocument.thread",
    area: "Inside a document",
    name: "Open the comment",
    does: "Open the comment thread on the quote at the caret",
    // Not Cmd+Alt+M: macOS can read it as Minimize All.
    keys: ["Cmd+Shift+O"],
    keysOther: ["Ctrl+Shift+O"],
    where: ["field"],
  }),
  surfaceKey({
    id: "inSheet.move",
    area: "Inside a sheet",
    name: "Move the cell",
    does: "Move to the next cell up, down, left or right",
    keys: [...ARROWS],
    shown: [["Arrow keys"]],
    where: ["working"],
  }),
  surfaceKey({
    id: "inSheet.extend",
    area: "Inside a sheet",
    name: "Extend the selection",
    does: "Grow the selection by a cell",
    keys: ARROWS.map((key) => `Shift+${key}`),
    shown: [["Shift and arrows"]],
    where: ["working"],
  }),
  surfaceKey({
    id: "inSheet.edit",
    area: "Inside a sheet",
    name: "Edit the cell",
    does: "Edit the cell",
    keys: ["Enter", "F2"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inSheet.commit",
    area: "Inside a sheet",
    name: "Keep the edit",
    does: "Keep the edit and move down a cell",
    keys: ["Enter"],
    where: ["field"],
  }),
  surfaceKey({
    id: "inSheet.cancel",
    area: "Inside a sheet",
    name: "Drop the edit",
    does: "Drop the edit, the cell as it was",
    keys: ["Escape"],
    where: ["field"],
  }),
  surfaceKey({
    id: "inSheet.across",
    area: "Inside a sheet",
    name: "Move across",
    does: "Move to the next or previous cell in the row, keeping an edit first",
    keys: ["Tab", "Shift+Tab"],
    where: ["working", "field"],
  }),
  surfaceKey({
    id: "inSheet.type",
    area: "Inside a sheet",
    name: "Type over the cell",
    does: "Start an edit with the character typed",
    keys: [],
    shown: [["Any letter or digit"]],
    where: ["working"],
  }),
  surfaceKey({
    id: "inSheet.clear",
    area: "Inside a sheet",
    name: "Clear the cell",
    does: "Clear the cell",
    keys: ["Delete", "Backspace"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.tool",
    area: "Inside the drawing pad",
    name: "Pick a tool",
    does: "Pick a tool: select, box, ellipse, triangle, label, comment, image, ink, connect",
    keys: ["V", "R", "O", "T", "L", "P", "I", "D", "A"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.pan",
    area: "Inside the drawing pad",
    name: "Pan the drawing",
    does: "Hold Space and drag to pan the drawing",
    keys: [],
    shown: [["Space and drag"]],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.order",
    area: "Inside the drawing pad",
    name: "Send back or bring forward",
    does: "Send the selected shape back or bring it forward",
    keys: ["BracketLeft", "BracketRight"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.delete",
    area: "Inside the drawing pad",
    name: "Delete the shape",
    does: "Delete the selected shape",
    keys: ["Delete", "Backspace"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.nudge",
    area: "Inside the drawing pad",
    name: "Nudge the shape",
    does: "Nudge the selected shape; hold Shift to move it further",
    keys: [...ARROWS, ...ARROWS.map((key) => `Shift+${key}`)],
    shown: [["Arrow keys"]],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.label",
    area: "Inside the drawing pad",
    name: "Edit the text",
    does: "Edit the text of the selected shape, or the label of the selected edge",
    keys: ["Enter"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.undo",
    area: "Inside the drawing pad",
    name: "Undo in the drawing",
    does: "Undo the last change to the drawing",
    keys: ["Cmd+Z"],
    keysOther: ["Ctrl+Z"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.redo",
    area: "Inside the drawing pad",
    name: "Redo in the drawing",
    does: "Redo the change to the drawing that was undone",
    keys: ["Cmd+Shift+Z"],
    keysOther: ["Ctrl+Shift+Z"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.duplicate",
    area: "Inside the drawing pad",
    name: "Duplicate",
    does: "Duplicate the selected shape, a little down and right",
    keys: ["Cmd+D"],
    keysOther: ["Ctrl+D"],
    where: ["working"],
  }),
  // Only with a shape selected or the connect tool up; otherwise Tab leaves the pad.
  surfaceKey({
    id: "inPad.next",
    area: "Inside the drawing pad",
    name: "Next shape",
    does: "Select the next shape; with the connect tool, the next target",
    keys: ["Tab"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.prev",
    area: "Inside the drawing pad",
    name: "Previous shape",
    does: "Select the previous shape; with the connect tool, the previous target",
    keys: ["Shift+Tab"],
    where: ["working"],
  }),
  surfaceKey({
    id: "inPad.escape",
    area: "Inside the drawing pad",
    name: "Step back",
    does: "Stop what is under way, then back to the select tool, then clear the selection, then close",
    keys: ["Escape"],
    where: ["working"],
  }),
  surfaceKey({
    id: "message.send",
    area: "Writing a message",
    name: "Send",
    does: "Send the message being written",
    keys: ["Cmd+Enter"],
    keysOther: ["Ctrl+Enter"],
    where: ["field"],
  }),
  surfaceKey({
    id: "message.sendQuietly",
    area: "Writing a message",
    name: "Send quietly",
    does: "Send quietly: answered, the seat is not woken",
    keys: ["Cmd+Shift+Enter"],
    keysOther: ["Ctrl+Shift+Enter"],
    where: ["field"],
  }),
];

/** Every key in the product: the dispatched shortcuts, then each surface's own. */
export const KEY_TABLE: ReadonlyArray<ShortcutDef> = [...SHORTCUTS, ...SURFACE_KEYS];

/**
 * Chords Junto never binds and a rebind must refuse: the system's, the
 * field's own editing keys, and the ones held back for later.
 */
export const RESERVED_CHORDS: ReadonlyArray<{ readonly chord: string; readonly why: string }> = [
  { chord: "Cmd+Q", why: "macOS quits the app" },
  { chord: "Cmd+H", why: "macOS hides the app" },
  { chord: "Cmd+M", why: "macOS minimizes the window" },
  { chord: "Cmd+Tab", why: "macOS switches apps" },
  { chord: "Cmd+Space", why: "macOS opens Spotlight" },
  { chord: "Cmd+C", why: "Copy" },
  { chord: "Cmd+V", why: "Paste" },
  { chord: "Cmd+X", why: "Cut" },
  { chord: "Cmd+A", why: "Select all" },
  { chord: "Cmd+O", why: "Held for a later Junto shortcut" },
];

// --- chords ------------------------------------------------------------------

export type KeyEventLike = {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

const DIGIT_CODE = /^(?:Digit|Numpad)([1-9])$/;

const NAMED_KEYS: Readonly<Record<string, string>> = {
  " ": "Space",
  Spacebar: "Space",
  "/": "Slash",
  "[": "BracketLeft",
  "]": "BracketRight",
  "`": "Backquote",
  "=": "Equal",
  "+": "Plus",
  "-": "Minus",
};

// Characters some layouts only reach with Shift: Shift is not part of them.
const SHIFT_BLIND = new Set(["Slash", "Plus"]);

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"]);

/** The digit (1 to 9) a keydown names, from the physical key, or null. */
export const digitOfKey = (event: Pick<KeyEventLike, "key" | "code">): number | null => {
  const fromCode = event.code ? DIGIT_CODE.exec(event.code) : null;
  if (fromCode) return Number(fromCode[1]);
  // No physical code (synthetic events): fall back to the character.
  if (!event.code && event.key.length === 1 && event.key >= "1" && event.key <= "9") {
    return Number(event.key);
  }
  return null;
};

const keyNameOf = (event: Pick<KeyEventLike, "key" | "code">): string | null => {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const digit = digitOfKey(event);
  if (digit !== null) return String(digit);
  if (event.code === "Backquote") return "Backquote";
  if (event.code === "Space") return "Space";
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
};

/** The chord a keydown is, or null for a modifier pressed alone. */
export const chordOfKey = (event: KeyEventLike): string | null => {
  const name = keyNameOf(event);
  if (name === null) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push("Cmd");
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && !SHIFT_BLIND.has(name)) parts.push("Shift");
  parts.push(name);
  return parts.join("+");
};

/**
 * True when the chord would type a character: no Cmd and no Control in it.
 * Alt alone does not make a chord: on macOS Option and a key types a
 * character, and the shell moves by word with Alt.
 */
export const isBareChord = (chord: string): boolean =>
  !chord
    .split("+")
    .slice(0, -1)
    .some((part) => part === "Cmd" || part === "Ctrl");

const digitFamily = (chord: string): string | null => {
  const at = chord.lastIndexOf("+");
  const key = chord.slice(at + 1);
  return key.length === 1 && key >= "1" && key <= "9" ? `${chord.slice(0, at + 1)}Digit` : null;
};

// --- resolve -----------------------------------------------------------------

export type KeyOverrides = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * The chords a shortcut answers to here: the operator's own, else the
 * default. A stored chord the system or the terminal owns is never answered,
 * whatever wrote it.
 */
export const chordsFor = (
  def: ShortcutDef,
  mac: boolean,
  overrides: KeyOverrides = {},
): ReadonlyArray<string> => {
  const own = def.fixed === undefined ? overrides[def.id] : undefined;
  return own ? own.filter((chord) => reservedReason(chord, mac) === null) : mac ? def.mac : def.other;
};

const liveIn = (def: ShortcutDef, mac: boolean): ReadonlyArray<KeyContext> =>
  mac ? def.where : (def.whereOther ?? def.where);

export type KeySituation = {
  readonly mac: boolean;
  readonly context: KeyContext;
  /** Focus is in a field the operator types in (terminals included). */
  readonly typing: boolean;
};

export type KeyHit = {
  readonly id: ShortcutId;
  /** 1 to 9, for a chord written with "Digit". */
  readonly digit?: number;
};

/** The shortcut a chord means in this situation, or null when it is not ours. */
export const resolveChord = (
  chord: string,
  situation: KeySituation,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyHit | null => {
  if (situation.typing && isBareChord(chord)) return null;
  const family = digitFamily(chord);
  for (const def of table) {
    // A surface's own keys are not ours to act on.
    if (def.surface || !liveIn(def, situation.mac).includes(situation.context)) continue;
    const chords = chordsFor(def, situation.mac, overrides);
    if (chords.includes(chord)) return { id: def.id };
    if (family !== null && chords.includes(family)) {
      return { id: def.id, digit: Number(chord.slice(chord.lastIndexOf("+") + 1)) };
    }
  }
  return null;
};

/** The shortcut that runs when a held modifier is let go here, or null. */
export const resolveRelease = (
  modifier: "Cmd",
  situation: KeySituation,
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyHit | null => {
  const def = table.find(
    (row) => row.onRelease === modifier && liveIn(row, situation.mac).includes(situation.context),
  );
  return def ? { id: def.id } : null;
};

/** True when the shortcut acts again on auto-repeat. */
export const shortcutRepeats = (
  id: ShortcutId,
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): boolean => table.find((row) => row.id === id)?.repeats === true;

/** The shortcut a keydown means in this situation, or null. */
export const resolveKey = (
  event: KeyEventLike,
  situation: KeySituation,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyHit | null => {
  const chord = chordOfKey(event);
  return chord === null ? null : resolveChord(chord, situation, overrides, table);
};

// --- conflicts ---------------------------------------------------------------

export type KeyConflict = {
  readonly chord: string;
  readonly context: KeyContext;
  readonly ids: readonly [ShortcutId, ShortcutId];
};

/** Two chords one keydown could mean: the same, or a digit and the digit row. */
export const chordsOverlap = (a: string, b: string): boolean =>
  a === b || digitFamily(b) === a || digitFamily(a) === b;

/** Two shortcuts that would answer the same chord in the same place. */
export const keyConflicts = (
  mac: boolean,
  overrides: KeyOverrides = {},
  table: ReadonlyArray<ShortcutDef> = KEY_TABLE,
): KeyConflict[] => {
  const out: KeyConflict[] = [];
  table.forEach((a, index) => {
    for (const b of table.slice(index + 1)) {
      // Two surfaces are never open at once in a way the contexts can tell
      // apart; a surface's keys only matter against a shortcut.
      if (a.surface && b.surface) continue;
      const shared = liveIn(a, mac).filter((context) => liveIn(b, mac).includes(context));
      if (shared.length === 0) continue;
      for (const chord of chordsFor(a, mac, overrides)) {
        if (!chordsFor(b, mac, overrides).some((other) => chordsOverlap(chord, other))) continue;
        for (const context of shared) out.push({ chord, context, ids: [a.id, b.id] });
      }
    }
  });
  return out;
};

/** Why a chord cannot be bound, or null when it is free to bind. */
export const reservedReason = (chord: string, mac: boolean): string | null => {
  const held = RESERVED_CHORDS.find((entry) => entry.chord === chord);
  if (held) return held.why;
  if (mac && /(?:^|\+)Ctrl\+/.test(chord)) return "Control belongs to the terminal";
  return null;
};

// --- the app menu ------------------------------------------------------------

const MENU_KEY: Readonly<Record<string, string>> = {
  Backquote: "`",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Minus: "-",
};

const MENU_MODIFIER = { Cmd: "meta", Ctrl: "control", Alt: "alt", Shift: "shift" } as const;

export type MenuKey = {
  /** The chord as an Electron accelerator. */
  readonly accelerator: string;
  /** The same chord as an input event, to hand it to the page. */
  readonly keyCode: string;
  readonly modifiers: ReadonlyArray<(typeof MENU_MODIFIER)[keyof typeof MENU_MODIFIER]>;
};

/** A chord as the macOS menu bar writes and sends it; null for a digit row. */
export const menuKeyOf = (chord: string): MenuKey | null => {
  const parts = chord.split("+");
  const name = parts[parts.length - 1]!;
  if (name === "Digit") return null;
  const key = MENU_KEY[name] ?? name;
  const held = parts.slice(0, -1) as ReadonlyArray<keyof typeof MENU_MODIFIER>;
  return {
    accelerator: [...held, key].join("+"),
    keyCode: key.length === 1 ? key.toLowerCase() : key,
    modifiers: held.map((part) => MENU_MODIFIER[part]),
  };
};

// --- display -----------------------------------------------------------------

const MAC_GLYPH: Readonly<Record<string, string>> = { Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

const KEY_LABEL: Readonly<Record<string, string>> = {
  Backquote: "`",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Equal: "=",
  Plus: "+",
  Minus: "-",
  Digit: "1 to 9",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const KEY_SPOKEN: Readonly<Record<string, string>> = {
  Backquote: "backtick",
  Slash: "slash",
  BracketLeft: "left bracket",
  BracketRight: "right bracket",
  Equal: "equals",
  Plus: "plus",
  Minus: "minus",
  Digit: "1 to 9",
  ArrowUp: "up arrow",
  ArrowDown: "down arrow",
  ArrowLeft: "left arrow",
  ArrowRight: "right arrow",
};

/** A chord said aloud: "Command Shift K". */
export const chordSpoken = (chord: string): string =>
  chord
    .split("+")
    .map((part) => (part === "Cmd" ? "Command" : part === "Ctrl" ? "Control" : part === "Alt" ? "Option" : KEY_SPOKEN[part] ?? part))
    .join(" ");

/** A chord as the key caps to show, in order. */
export const chordKeyCaps = (chord: string, mac: boolean): string[] =>
  chord.split("+").map((part) => (mac ? MAC_GLYPH[part] : undefined) ?? KEY_LABEL[part] ?? part);
