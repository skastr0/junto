# Junto changes

## Unreleased

Draft for 0.11.0, worded from `docs/plans/0.11/README.md` before the tracks
land. Every bullet is checked against the code at the cut, and this line is
deleted at the bump.

Opening the database with 0.11.0 moves it to version <HEAD>, and 0.10.3 then
refuses it as newer than supported. To go back to 0.10.3, open the backup
taken at the upgrade. The steps add the Files node kind, a table that
records which artifacts link to which, artifact labels and their colours,
the tables that keep your view state, the record of where each automation
was, which canvases this machine runs code for, a peer's link key, a seat
control applied at most once, and a signal an automation raises with its form
and due time, and one that rebuilds the stubs so other machines show a Files
node; every node, wire and task is kept as it was. Two steps are groundwork
for a later release and nothing in 0.11.0 reads them: a canvas's authority
tables (seeded) and the scope record of each vault token (empty).
(<HEAD> is read from `CURRENT_STATE_SCHEMA_VERSION` at the cut, 63 on c403df836.)

- Files: a node that opens a folder on this machine as a file tree and opens
  a file in the main pane, laid out like Artifacts. The node keeps the folder
  it was made in, from the region's folder for this machine, and you can
  change it. Other machines see the node as a stub with its position and size,
  and its label only when you wrote one; the folder path never leaves this
  machine.
- Edit code and text in the node: it highlights, edits and saves with Cmd+S.
  If the file changed since you opened it, the save is refused and offers
  reload or keep. Markdown opens in the same live editor as artifacts. Files
  over 5 MB are not opened in the editor.
- Cmd+P opens quick open inside a node's window, with a button in the header:
  file names in Files, items in Artifacts, Tasks and Automations.
- Drop files from Finder on a Files card, on its window, or on a folder in the
  tree, and they are copied into that folder. A name that exists gets " 2",
  " 3" and so on; nothing is moved or overwritten. Dragging inside the tree
  renames.
- PDFs and images preview in the main pane. Any other file offers Open in its
  default app and Reveal in Finder.
- Comment anywhere in a file: on lines of code, on a box on an image, or on a
  box on a PDF page. A line comment finds its lines again after edits by its
  quote.
- Extract to artifact: a box drawn on a PDF page or an image becomes an image
  artifact in an Artifacts node in reach, with a link back to the file, page
  and box.
- Artifact links: type [[ in a document to link another artifact by title, and
  a title that matches nothing offers to create that document. The link is
  stored like a mention and draws as a chip with the artifact's current title,
  so a rename never breaks it. Every artifact lists what links to it, from
  other artifacts' bodies (document text, pad text and sheet cells, with the
  line around the link) as well as from comments and mail. The first launch
  after the upgrade reads the artifacts you already have, so links written
  before it show without an edit. In the CLI,
  `junto artifact create` and `edit` accept [[Title]] and resolve it within the
  seat's reach; no match or more than one is refused with the candidates, and
  `junto artifact show` lists what links to the artifact.
- Artifact labels: give an artifact any number of labels (up to 20) in its
  header, and filter the Artifacts sidebar by one or more; an artifact shows
  when it has all of them, and a label such as project/junto also matches
  project/junto/release. The sidebar shows a count for each label, Cmd+P ranks
  labels after the title, and labels sync across machines like a rename. In the
  CLI, `junto artifact create --label`, `junto artifact label` with --set, --add
  or --remove, and `junto artifact list --label`; `show` lists the labels.
  Artifacts stay one flat list: there are no folders, and a document that links
  its children is the way to build a hub.
- Your arrangement survives a restart: command groups and the slots on the
  hotbar, each Artifacts and Tasks node's filters and picked labels, the item
  each node had open, the folders open in a Files tree, a collapsed sidebar, a
  resized modal, the comments rail and the seat sidebar's open sections all
  come back after a quit, a crash or an update. It is kept on this machine and
  does not travel with a canvas. Text typed in a filter box is not kept.
- Automations read like a sentence: "When a task in Release becomes done".
  The scope lists the task and Artifacts nodes in reach by name, or one item
  by name, and the empty "This task" picker is gone. An automation can watch
  any artifact in a node. Mail, prompt and comment texts are multi-line and
  can name what fired them with values such as `{{task.title}}`, offered by
  Insert value; a value the trigger does not carry is refused when you save.
  A new prompt action asks a seat to act, as `junto msg send --prompt` does,
  where mail only tells it.
- Automations and artifacts: an automation can fire when an artifact in a node
  gains a label or when one carrying a label is edited, and can create an
  artifact in a node, append to one, or set and remove labels on the artifact
  that fired. A write an automation made never fires another.
- Comments on a file follow it when you rename or move it in Junto, in the
  same step as the change on disk: the thread's path and a line comment's file
  move with it, and a box comment keeps its page. A move that would leave the
  node's folder is refused, so a thread never has to leave it. Two limits.
  A rename or move made outside Junto (Finder, git, a script) is unseen, so its
  threads keep the old path and read as moved; a line comment finds its lines
  again once a path matches. And two Files nodes that open the same folder each
  keep their own threads, so a rename through one node carries only its own;
  the other's stay at the old path, as in the outside case.
- The needs-you feed holds work the operator produces. A seat that raises
  `junto blocked` or `junto escalate` can ask for a document with
  `--ask-artifact` or for proof with `--ask-proof`; you write the document in
  the editor inside the signal, or attach text and links as proof, and the
  signal stays open until your reply meets its condition (a document, for
  instance, of at least so many words). A document you write becomes an
  artifact in the Artifacts node the seat named. Asking for a secret waits for a later release.
- Briefings are written as documents: the app briefing, the references and a
  region's instruction open in the same live Markdown editor as artifacts,
  with [[ and @ mentions of artifacts, seats, tasks and the nodes a region
  reaches. A seat running `junto onboard` gets the text as written and, beside
  it, each mention as a reference it can act on, with its current title and
  whether the seat can reach it; a mention that no longer resolves is listed as
  missing.
- Security: Junto's git commands no longer run anything a folder's own git
  config names. A repository you open in the git node or a Files node, a
  downloaded one included, cannot run a file system monitor, a filter driver,
  a signature check or a hooks folder on a read. The git node no longer
  reports dirty work in submodules. A repository whose config names a filter
  driver Junto cannot switch off is refused: Junto does not run git in it and
  says why. A Git LFS file reads as modified in the git node right after a
  clone and after any touch, because that same guard empties its clean filter.
- Security: dropping files into Files copies only the files you actually
  dropped, and never anything from Junto's own folder.

## 0.10.3 — 2026-10-27

Opening the database with 0.10.3 moves it to version 50, and 0.10.2 then
refuses it as newer than supported. To go back to 0.10.2, open the backup
taken at the upgrade. The step rebuilds the wires table and adds a column to
tasks; every wire and task is kept as it was.

- Artifacts: a document is one live markdown surface. Headings, bold, links,
  lists and tables draw as you type; click a line to edit it, move off and it
  renders. Type @ or # for seats, tasks and the artifacts in reach; a mention
  stays a chip on the caret's line and steps over or deletes as one unit, and
  a bang mention draws a preview card of a task, seat, artifact or page.
- Artifacts: the list is a narrow sidebar so an open artifact gets the room,
  the header is one row (title, kind and version, history, tasks, archive),
  and the comments rail opens collapsed to an edge showing the count and the
  faces of the seats that took part. A comment mark in the text opens the
  rail on its thread. A version in History reads rendered.
- Keys: J and K, the arrows, Home, End and Enter move through the feed,
  artifacts and tasks lists alike. In a document Cmd+B bolds, Cmd+E italicises
  (Cmd+I stays the Needs you feed), and Cmd+Shift+M opens the comments rail.
  The Keys button in Artifacts lists the pane's and the editor's keys.
  Stepping between panes skips a collapsed sidebar.
- Artifacts are checked for accessibility: lists hold list items, a heading
  speaks its level, the sheet is one Tab stop with an edit mode, and a removed
  row or cleared cell is said aloud.
- The pad keeps its own drawing engine and gets a toolbar with stencils
  (including a diamond for a decision and a cylinder for a store), a
  selection strip for status, fill, stroke and text, text on any shape, and
  edge labels. A shape shows four ports on hover, and a dragged edge snaps to
  a port or a shape and lands on its facing side with an arrowhead. Paste,
  drop, @ or double-click puts a Junto thing on the pad as a live preview
  card. Pan with two fingers or Space, zoom with a pinch or Cmd and the
  wheel, undo with Cmd+Z and redo with Cmd+Shift+Z. Tab walks the shapes in
  reading order, and the connect tool walks targets by keyboard. Drawing is
  lighter: pointer moves land once per frame.
- Tasks: a task's details are written and read as live markdown, with chips,
  embeds and the @ and # list, in the task pane and when you make a task.
- Tasks: a seat can hold and take any number of open tasks. The
  one-open-task limit is gone, so a seat that finds a missing dependency can
  take it, and a receipt is accepted on any task the seat holds.
- Tasks: a task board can derive into another. In a board's settings, list
  its targets and flip a wire between Flows and Derives. When a task closes
  done, each board it derives into gets a new backlog task with the same
  title, unassigned, and task detail shows where a task came from and what
  was made from it. A derived task fires the target board's task-created
  automations. A derives loop is refused, and two boards hold one wire at
  most. A derives wire draws as still filled arrowheads that breathe;
  flows chevrons keep sliding.
- Task wires: chevrons from side-by-side flows shrink to fit the room between
  them, and the loupe picks a flows wire at the overview as at near and far.

## 0.10.2 — 2026-10-22

- Needs you filters by region with a strip of chips, like the phone's region
  bar. All comes first, then each region with its colour dot and a count of
  what waits. Pick a chip to filter, press it again to show everything. The
  strip scrolls sideways with the wheel and fades at its edges.
- Picking a parent region takes in the regions inside it, and its count adds
  theirs up. The open field matches only itself.
- Region chip words stay readable at 4.5:1 in both themes, hovered and on the
  count pill, including for a region colour typed as a free hex.
- Tasks, artifacts, automations, pages, terminals, git, files and links draw
  on the canvas the way a seat does: its ring round a plain icon of the kind,
  with the node's state in a band outside the ring (finished, open, asks,
  stuck and backlog for tasks; on, off and failed for automations). They are
  the seat's size, so terminals and git nodes are larger than before. A
  terminal still shows its claimed task under the name. Plain files and links
  rest as a ring, an image file keeps its own size, notes keep their card, and
  far out each one shrinks to its ring alone, as a seat does.
- A dependency between tasks draws as a track of open chevrons in ink, half
  again as heavy as other wires, sliding toward the dependent task at every
  zoom and in every state. It stands still when reduced motion is on.

## 0.10.1 — 2026-10-21

Opening the database with 0.10.1 moves it to version 49, and 0.10.0 then
refuses it as newer than supported. To go back to 0.10.0, open the backup
taken at the upgrade. A CLI from 0.10.0 reads the new needs-update answer as
a protocol error; use the CLI that ships with the app.

- Rename any node from the selection card in the bottom bar, pages, links and
  files included. File and link names show on other machines' copies; page
  names stay on this machine.
- Buttons in the top bar of a full-screen panel click again. Before, the
  window's drag strip took the click.
- Collapse the side panel in Tasks, Artifacts and Automations, and widen any
  full-screen panel to full width and back.
- A terminal panel keeps the width you drag it to. Before, a squeezed width
  could stick for the rest of the session. Double-click the grip to forget it.
- The browser: closing a tab updates the tab strip, Close takes the page down
  with the panel, and Stop page stops every tab. The tab strip, address and
  driving mark are redesigned.
- A seat replies to a comment on an artifact or a page from its notice, and
  the reply lands in that thread.
- Commenting on text you have not saved saves the document first. If someone
  else changed it, the comment waits and says how to choose.
- A link to another machine reconnects on its own within seconds after it
  drops, in the window app too, so held mail and signals no longer wait
  minutes. A sleeping Boat machine is woken for held mail the same way.
- A machine on an older build is listed as needing an update instead of
  failing the whole seat or terminal list, and reading one of its seats or
  terminals says it needs an update.
- Threads open at the size of the window, can be maximized, render
  formatting, and read in the body face at a comfortable line length.
- The CLI: a mention that names nothing is sent as plain text and listed in
  the answer instead of refusing the mail. Task errors say what to do next,
  a task comment names who it reached, and task show counts its thread. A
  batch where every item failed answers ok false.

## 0.10.0 — 2026-10-21

Known limits in 0.10: opening a very large file preview reads the whole file
into memory, with no size cap yet. File artifacts can be made from the CLI
only. Tasks canceled at upgrade because their boards were gone open by id but
not by number, and their old history is not shown, though it is kept. A database
older than version 13 is refused, and the refusal does not say to upgrade
through an older release first. After a seat moves to another machine, the new
machine shows that seat's earlier mail once more in its terminal. After a
dropped link to another machine, held mail and signals can wait minutes before
they arrive, and `junto machine status` reconnects it at once. Nothing is lost.

- Tasks, Artifacts and the Browser are on in 0.10. Earlier builds kept them
  off. They are the headline of this release.
- Plan work on Tasks. A task has a number, a state, an assignee and reviewers,
  and reviewers stamp it. A task can depend on tasks on any board in reach.
  The operator can stamp too. A task cannot finish until what it depends on
  is done and its checks are green, and a handoff note and the work it cited
  travel with it when it is sent on. Comments on a task are threads.
- Write and keep documents in Artifacts. The Artifacts node replaces the old
  library, with a document editor, a sheet editor, a pad editor, history and a
  comments rail. Each edit is versioned, and comments are threads that take
  mentions.
- Run work on a schedule with Automations. Set a schedule, a poll, a change or
  a seat's state as the trigger, edit it in the Automations node, and read
  every firing in its history. Only the operator and overseers write
  automations. `junto automation` does the same from the terminal.
- Mention people and seats with `@`, and tasks and artifacts with `#`, in the
  seat thread composer and in review comments. A mention is one unit in the
  field and a chip when read back. A seat mentioned in an answer is copied on
  it.
- Attach a task or an artifact to a signal. It shows in the feed as a chip
  that opens it.
- Reply to a thread and the reply posts to its subject. The notice names that
  subject.
- Use the resource nodes within a seat's reach without drawing an edge to
  them. Seats still connect to seats by wire.
- Open a copy of a canvas with every resource kept as its place and label.
- See a blocked seat on its ring. The mark no longer sits on the wire.
- Start a session knowing what changed. `junto onboard` lists what arrived
  since the last session, and the signal list pages its closed history.
- Browse in Junto with tabs. Take over a page by hand and hand it back to the
  seat, and comment on a page by drawing a box on it.
- Pass `--tab` to `junto browser`, which now answers in the standard envelope.
- Send mail text over 64 KiB as an attached file. It is no longer sent inline.
- Lose a command to another machine cleanly. A write that loses to a newer one
  is refused as stale and names the winner, and a seat on another machine
  queues its commands and sees their state.
- Upgrade a canvas with tasks without losing any. Open tasks whose task board
  no longer exists are canceled and stay in the database, and
  tasks sent on fold into their heads. Wires, seats and regions are unchanged.
- Start agent seats in a working folder. Junto refuses to start an agent seat
  in the home folder, from Add item, the CLI or a remote machine, because the
  harness would meet its trust prompt for the whole account. Terminal seats may
  still open there. No existing seat on the live canvas used home.
- Find older published artifacts gone from view. Junto and the CLI no longer
  show them, and Artifacts replaces them. Their rows stay in the database
  until a later release.
- Remove pinning. The pinned dock and every pin control are gone.
- Remove the Requests node and the bulletin board. Escalate from a seat with
  `junto escalate` as before.
- Remove the Hermes chat integration, its snapshots and the hidden chat
  entry points. Hermes still runs as a terminal seat.
- Remove the task factory, its claim prompt, the reclaim grace and Region
  Pulse.

## 0.9.2 — 2026-10-19

- Answer Needs you from a list and a detail pane. Each item has four answers:
  dismiss, acknowledge, a quiet note, or a reply, each with a key. Quiet-note
  presets are set in Settings.
- Find a seat by urgency. Cmd+K ranks seats on one order, live, newest change
  first within a state, and Cmd+backtick cycles the seats you visited lately.
- Read urgency from one typed ladder, shared by every surface and the phone.
- See wires meet their seats on the phone.
- Keep held mail when a seat moves machines, and start a seat with thousands
  of held mails without stalling the link.
- Send mail across machines past the credit window again.
- Relaunch only after a Junto that is still quitting has finished.

## 0.9.1 — 2026-10-19

- Open the desktop canvas on the phone. The phone draws the canvas as the
  desktop does, with each seat's ring and portrait, live.
- Run Boat sandboxes as machines that sleep when idle and wake for work.
- Pulse rings on wall time, so a ring's beat does not drift with the frame rate.
- Fix the Machines window: the stage, the shelf and the harness lines.
- Mail seats by name. Send batched mail, wait for a reply, read every peer at
  once, and filter the mail list.
- Stop a closed remote link from changing a setting.
- Stop a leftover command from blocking quit or an update install.

## 0.9.0 — 2026-10-19

- Choose how Junto caches: off, manual, auto or hybrid. When a cache has
  expired a banner says so, and a status line shows the mode and its state.
- Keep session notes and marks in the Junto database. Existing note and mark
  files are imported once, then the database is the one place they live.
- Use Threads on the desktop and on the phone.
- Pair the phone once. After pairing it can restore, and it shows your
  machines and the full content of what a seat produced.
- Remove the `--fresh` flag.

## 0.8.2 — 2026-10-18

- Fix Restart and install doing nothing. A short command that exited before
  Junto first read the process table was never marked finished, so quitting
  reported a leftover process, the install stopped, and Junto reopened on the
  old version. Quitting and installing now complete.

## 0.8.1 — 2026-10-18

- Keep the canvas smooth with many seats. Rings turn and pulse on the
  compositor instead of a main-thread loop, each turning ring and the card
  that holds it is its own layer, and zoomed out, seats past a screen's ring
  budget gather into clusters whose rings still turn.
- Start with the renderer accessibility tree off, which cuts pan and idle cost.

## 0.8.0 — 2026-10-17

- Set up each machine from Settings. Providers, Name and startup, and each
  harness's own config are read and written on the machine you choose in the
  Settings sidebar, through that machine's core, here or over the link. A
  machine that cannot be reached shows its last inventory, its age, and the
  typed reason; a write the link dropped says it may not have taken.
- Rank every need on one ladder. Needs you, the rollup on each card, the
  seat's occupancy, and desktop notifications read the same ladder, and a
  stopped seat is listed with it. A seat that raised its hand, one that hit a
  limit, and one waiting on you each have their own tier. A limit the
  harness resumes from on its own does not ask for you.
- See which harnesses and models each machine has. Every machine answers its
  own harness inventory over the link: installed versions, whether each is a
  version Junto was verified against, permission modes, models, and Hermes
  profiles with the model they pin. The palette, re-seat and Customize offer
  the harnesses and models of the machine the seat sits on.
- Say plainly what a seat that is not running will do next: resume or start
  fresh. An isolated Junto home never promises a resume.
- Read a seat's state from its own screen and its own declared signals. Claude,
  Codex and Kimi read their limits, retries, auth errors, context errors and
  compaction; pi, omp, agy and devin report through OSC 7501.
- Attach to, view, start, stop, and read the terminal of a seat on another
  machine over the link, from the window and by command. `junto logs` and
  `junto machine logs` read this machine's log and a linked machine's log.
- Keep a scrubbed, rotated JSON-lines log on every machine, and let a failure
  cross the link whole, with who closed it and why, instead of reading as a
  lost link.
- Add an all-on Preview for checking gated surfaces.
- Fix the core bundle loading on a linked machine (production build,
  jsonc-parser, node-pty).
- Fix a start that failed reading as a changed occupant; the first typed
  cause is shown.
- Fix a seat that queues mail mid-turn for Claude and agy, and Kimi naming its
  session on screen.
- Fix credentials leaking into logs or failures: paths in curly quotes,
  UUIDs, long path tokens and registered secrets are scrubbed.

## 0.7.1 — 2026-10-13

The first published build since 0.6.0. It carries the held 0.7.0 work.

- Turn on Machines: one canvas across machines. Name this machine in
  Settings, set up another machine from the Machines window over SSH, and
  watch each step and its bytes as Junto is sent. The bundle for a machine
  is downloaded when it is needed and checked against the build, so the app
  itself stays small.
- A canvas is changed only by the machine that edits it; other machines hold
  a read-only copy. A seat lives on one machine, starts there, and its mail
  crosses to and from the editing machine, waiting when a machine is out of
  reach.
- A seat's raised hand reaches the operator from any machine, and the
  answer goes back to it.
- Answer a needs-you card quietly, without waking the seat, and pick from
  two replies the seat suggested.
- Filter the needs-you feed by region, and order it.
- Steer mail into a running Cursor or Devin turn, and read Cursor's settled
  follow-up row as idle.
- Run agy seats with working mail delivery and session discovery.
- Step the seat rings once a second, and start managed seats without
  stalling the window.
- Remove the Remote screen, the station, and the fleet pages.
- State schema moves from 13 to 21.

## 0.6.0 — 2026-10-08

- Store a canvas as rows, one per seat, region, wire, and every other kind,
  in place of one saved document. An existing canvas is converted the first
  time this version opens it. The window changes a canvas by sending
  commands, and undo reverses those commands, including stacking order,
  reseats, and batches.
- Add a Briefing page and a References page in Settings. A seat gets the
  briefing at onboard and reads named references on demand, a region's
  references follow its canvas, and an overseer can read and write both.
- Make the canvas faster: a card renders only when its own facts change, a
  drag routes no wire and a drop routes only the wires that moved, and the
  bottom bar, the command group bar, and the minimap follow only what they
  show.
- Read mail, the board, and work independently of the canvas, so they stay
  quick on a large canvas.
- Shorten the words on every Settings page. Terminal is four titled groups
  with switches, Keyboard shortcuts says what each shortcut does, Sound
  names each kind of sound by its own sounds, and Agents has one reset.
- Find a name in Cmd+K by its letters in order.
- Draw keyboard focus as one 2px cyan mark across the app.
- Say a seat's exit reason in plain words, and say in the log why a wake or
  a mail started no seat.
- Fix a seat that asks again taking a second row in Needs you.
- Fix the top bar's actions on the right being pushed out of a narrow
  window.
- Fix a wire's detour crossing a card, and shift-clicking the last selected
  card off leaving it selected.
- Fix the camera being placed more than once when a canvas opens.
- Align Amp seats with Amp's own thread lifecycle.
- The overseer commands now speak the same kinds the canvas stores.
- State schema moves from 11 to 13.

## 0.5.0 — 2026-10-07

- Offboard a seat from the app: ask or offboard now, one seat or many, from
  its card, the bottom bar, and the canvas right-click menus. The old session
  winds down in place while a fresh one takes the seat, and the new session
  is told what the one before it left.
- Add an Offboard section in Settings: the cache window, the two automatic
  rules, the worth-cutting thresholds, and a per-harness switch for the idle
  nudge and auto offboard. Auto offboard acts only as a seat is about to be
  woken.
- Let a needs-you card carry any number of attached files of any size, a
  code block, a diff, a compare, a commit, and a video address. Code and
  diffs draw in place; a video plays only once the operator presses play.
- Review a single commit from a card: Review this commit opens the full
  review and comes back to the same card. A commit takes comments as its own
  review, and comments can be started, moved, and closed from the keyboard.
- Rebuild the agent switcher as an operator modal: each card is the agent's
  portrait, name, line, and where it sits, in the one urgency order.
- Add keys: Cmd+Up lets the keyboard out of a terminal and Cmd+Down gives it
  back, Cmd+B widens the agent's connections, Cmd+Enter opens the selected
  agent, Space and the backtick walk the agents.
- Open a region's Environment and secrets from the bottom bar's region
  strip. A plain terminal inside a region gets that region's environment.
- Make connecting from the bottom bar a searchable list of agents.
- Hold keyboard focus inside the view in front: the canvas under an open
  view is inert, and a focus move made by a key always draws its ring.
- Fix readable colour for words in the bright theme across the app.
- Drop the 32-client limit on the work socket, and make the CLI start
  faster by loading only the selected command family.
- State schema moves from 9 to 11.

## 0.4.0 — 2026-10-06

- Add git review to an agent's git detail: uncommitted, since base, and
  commit views, comments on lines, and sending the review as one mail per
  agent. A pending review lasts for the window and is lost on restart.
- Let a signal carry attached files (`junto escalate`, `blocked`, and
  `feedback` take `--attach`); the needs-you feed previews them. State
  schema moves from 8 to 9.
- Merge what needs the operator into one button, one count, and one list.
- Preview the files an agent names in its text, with a viewer, slideshow,
  and before and after compare.
- Put every app shortcut in one key table: a Keyboard shortcuts section in
  Settings changes them, the macOS menu bar follows them, Cmd+W closes what
  is in front, and Cmd+backtick replaces Control+Tab as the switcher.
- Add Interface size in Settings, Appearance.
- Give a region an environment for the seats inside it, with sources from
  the Keychain or 1Password, and one screen to edit and explain it.
- Onboard a seat by nudge through `junto onboard`; a managed launch no
  longer carries Junto instructions. Seats take the operator's own harness
  arguments, per harness, profile, or seat.
- Rework the agent modal: a one-line header, and a rail of the connected
  agents as their canvas seats.
- Make everything under the front modal inert, and ask destructive
  questions through the working dialog.
- Brighten dim and faint text in the dark theme, with a contrast floor.
- Rest canvas wires faint and unpickable.
- Update Electron to 43.5.0 and patch dependencies with high advisories.
- Stop bundling licence notices in packages.
- Let the packaged smoke run beside an open Junto
  (`JUNTO_SMOKE_BESIDE_LIVE_APP=1`), so a release never needs the app closed.

## 0.3.4 — 2026-09-24

- Drop the support email. The startup data-store failure dialog, SECURITY.md,
  and the issue templates send every report to GitHub issues.
- Name the real reason a seat could not start ("Codex could not start: the
  folder ~/x does not exist") instead of a bare "failed to start".
- Strip Electron's template camera, Bluetooth, and audio-capture purpose
  strings from the macOS Info.plist, so the app declares only the microphone
  string it documents. The packaged-app audit refuses a bundle that still
  declares one.
- Hold the canvas viewport busy gate across bursty pan input, so wheel and
  trackpad pans no longer flicker the chrome and regions.
- Unregister the release build output from LaunchServices after install, so
  `junto://` links and `open -a Junto` resolve to `/Applications`.

## 0.3.3 — 2026-09-18

Built and signed, not published to the update feed. The next published
release carries these changes.

- Stop running the operator's login shell at startup to discover `PATH`.
  Harness lookup reads version-manager install directories instead, so shell
  startup files no longer run under Junto's macOS privacy identity.
- Refuse a managed agent seat whose working directory is missing, and say
  which problem it is.
- Prefer version-manager alias directories and bound repeated shim probes
  when resolving a harness binary.
- Pin the browser's session download path under app state so it never
  resolves `~/Downloads`.
- Resolve the Cursor seat by `cursor-agent`, not the `agent` alias.
- Stop offering the review verdict port when the tasks surface is off in the
  build.
- Add seat awareness behind one build gate, off in official builds.
- Rewrite the README around seats, mail, and drawn structure.

## 0.3.2 — 2026-09-16

First release under the Junto name, published to the macOS update feed. It
also carries the source changes earlier entries listed as unreleased.

- Rename the product to Junto: the app, the `junto` CLI, `~/.junto/`,
  `junto.db`, environment keys (`JUNTO_*`), and the `junto://` scheme.
- Collapse the schema and Station protocols to the Junto version-1 baseline,
  and admit unversioned databases witness-first again.
- Point security contacts and download links at juntoagents.com.
- Prove managed seats from the caller node's terminal binding.
- Add the Hermes terminal seat behind its own harness gate.
- Keep the Electron-only filesystem out of the standalone CLI bundle.
- Stop publishing Linux bootstrap relink source materials.
- Read the operator's authored board title on every projection — canvas card,
  node titles, digest, SVG export, and region rollups — instead of a constant
  kind name, while dash-prefixed topic lines still never leak into titles.
- Settle request resolution idempotently: resolving an already-resolved request
  returns the settled state instead of an error banner, and every raising
  actor ref learns the answer, not just one.
- Fix credential-vault retention corrupting the settings row: patching any
  preference while plaintext secrets await vault migration no longer makes the
  next read fail with a corrupt-settings error.
- Give the artifacts glance an honest empty state ("quiet") like the other
  sinks instead of rendering nothing.
- Make the remote deploy's installed-generation check portable to mawk
  (POSIX awk has no regex interval expressions), so Linux observe no longer
  reports every install absent.
- Authenticate Linux desktop first install with an independently obtained
  bootstrap or reviewed source checkout. Do not extract or execute the
  candidate archive's bundled CLI. Incumbent signed updates are unchanged.
- Stop treating pad shape and ink colors as HTML or CSS. Render only
  hex/`none` paint, serialize SVG with escaped attributes, and drop
  `script-src 'unsafe-inline'` from the renderer CSP.
- Store operator provider credentials outside SQLite and omit them from
  newly minted state backups. Historical backups remain immutable.
  Vault unavailability no longer blocks boot or erases leftover secrets.
- Make project-owned source available under Apache-2.0, with source-build
  instructions and third-party notices.
- Remove purchases, activation, and commercial access checks from desktop and
  experimental Remote startup. Existing databases keep their historical schema.
- Remove the copied Canvas UI Fleet presentation and its unused assets.
- Replace generated sound clips with original, reproducible waveform cues.
- Remove private checkout dependencies and use synthetic development fixtures.
- Separate local source packages from official signing and publication.
- Add signed Linux desktop alpha releases, managed rootless installation, and
  automatic update downloads with an explicit restart to install.
- Bound Linux desktop generation retention to the active generation and live
  staged candidate, with post-readiness collection, disk admission, and a
  Doctor storage check.

macOS remains the primary platform. Linux desktop is alpha. Fleet and Remote
remain experimental and disabled in the default build.
