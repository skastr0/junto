# TUI Horizons — what owning the PTY master buys Junto beyond agent driving

Scope: terminal automation surface that follows from the settled managed-terminal
design (Junto spawns the full interactive TUI in a PTY it owns, renders via
xterm, drives by writing bytes). Not a relitigation of that design. Every
mechanism below is either read out of this repo, read out of an installed
dependency's own typings/dist, or cited to a vendor/primary doc.

---

## 0 - Where Junto actually stands today (read, not assumed)

Four powers come with the master side: **spawn** (you choose argv + env),
**read every byte**, **maintain the emulated cell grid**, **write bytes**. Junto
has 1, 2 and 4 wired. It has **no grid it can reason about** and **no escape-code
parsing at all**.

| power | state in repo | evidence |
|---|---|---|
| spawn w/ env+argv control | built | `src/main/junto/term/local-host.ts:235–257` — argv/cwd/env assembled; env merge at `:241–245` with `TERM`/`COLORTERM` defaults; shell resolved from `process.env.SHELL` at `:216–217`; pre-spawn shell validation in `src/main/junto/term/shell-policy.ts:33–57` |
| read all bytes | built, pass-through only | `local-host.ts:698–713` `observeData()` — bumps `seq`, appends to journal, re-emits an `output` event. Zero inspection of the payload. |
| replay buffer | built, byte-log not grid | `local-host.ts:200` `MAX_JOURNAL_BYTES = 512 * 1024`; trim loop at `:875–880`. It is a **raw byte ring**, not state. |
| write bytes | built | resize path at `local-host.ts:526–535` journals + emits alongside the pty resize |
| emulated grid | **renderer-only, lifetime-bound** | `src/renderer/components/terminal/TerminalSurface.tsx:207` `new Terminal(...)`, `:266` `term.dispose()` on unmount, `:300`/`:321` writes from live events + journal replay |
| any OSC/CSI parsing | **absent** | `grep -rn "registerOscHandler\|registerCsiHandler\|OSC" src/` → no hits |

Two consequences that shape everything downstream:

1. **The grid dies with the window.** Because the only emulator instance is
   constructed in the renderer and disposed on unmount, *any* automation that
   reads screen state is currently unavailable whenever the node is not mounted —
   which is most of the time on a canvas. A supervision or watcher feature built
   on the renderer grid would be silently non-functional exactly when it matters
   (window closed, node off-viewport, app in tray). **The grid has to move into
   main to be a factory input.** `@xterm/headless` exists for precisely this
   ("keep track of a terminal's state on a remote server where the process is
   hosted" — [npm](https://www.npmjs.com/package/@xterm/headless)) and is *not*
   currently a dependency (`ls node_modules/@xterm/` → `addon-fit`, `xterm` only).
2. **Junto currently throws away structure it is already receiving.** Every
   harness and every well-behaved CLI already emits titles, bells, mode switches,
   and (increasingly) OSC 133 marks into that byte stream. Junto forwards them to
   xterm for painting and discards them as signal. This is the single largest
   cheap win in the whole report.

Tension worth naming, not resolving here: `docs/factory-harness-integration.md`
(`:51`, `:103`, `:318–321`) deliberately routes factory worker state through
ACP/headless *to avoid* scraping. The managed terminal takes the opposite bet by
construction. The reconciliation is that OSC marks are **not** scraping — they are
an in-band structured protocol, closer to ACP than to regex-on-pixels. That
distinction is the load-bearing one for the whole design.

---

## 1 - Semantic prompt marks: OSC 133 / OSC 633

### The mechanism

`OSC 133 ; <kind> [; params] ST` — the FinalTerm/FTCS "semantic prompt" protocol.
Four markers, emitted by the *shell*, consumed by the *terminal*:

| marker | emitted when | meaning |
|---|---|---|
| `A` | before the prompt is printed | prompt start |
| `B` | after prompt, before input | prompt end / input zone begins |
| `C` | pre-execution hook | command output begins |
| `D` [`;exit`] | after command completes | output end + **exit code** |

Optional `L` marks an in-tool input prompt.
([otty VT reference](https://docs.otty.sh/vt/osc/osc-133),
[terminfo.dev OSC index](https://terminfo.dev/osc))

The normative spec is Per Bothner's `semantic-prompts.md`
([gitlab.freedesktop.org](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md)),
which WezTerm links as the definition of "Input, Output and Prompt zones"
([wezterm.org](https://wezterm.org/shell-integration.html)). **Honesty note:** that
URL is currently behind an Anubis access challenge and I could not read it
directly — the marker table above is convergent across four independent
implementers (VS Code, kitty, ghostty, otty), which is strong, but the
*parameter* details below are secondary-sourced and should be treated as
`^ unverified` until the spec itself is read.

Parameters seen in the wild (secondary): `aid=<shell pid>` (application id, for
disambiguating nested shells), `cl=line` (click-to-move-cursor extension),
`redraw=`, `cmdline=`. Ghostty 1.3.0 documents shipping the `click-events`
extension and `cl=line`, and names **Fish 4.1+ and Nushell 0.111+** as emitters
([ghostty 1.3.0 notes](https://ghostty.org/docs/install/release-notes/1-3-0)).

### Who emits, and how it gets there

Nobody emits these by default — they arrive because a terminal **injects shell
integration at spawn**. Three real injection strategies, all readable:

- **kitty**: sets `KITTY_SHELL_INTEGRATION` with space-separated feature
  keywords, then per-shell — zsh via `ZDOTDIR` pointing at kitty's `.zshenv`,
  fish via prepending to `XDG_DATA_DIRS`, bash via POSIX mode + `ENV`. The script
  reads the var at startup **and unsets it** so the environment isn't polluted.
  Emits `OSC 133;A`, `OSC 133;C;cmdline=%q`, `OSC 133;D;%s`, plus
  `OSC 7;kitty-shell-cwd://…`
  ([kitty shell integration](https://sw.kovidgoyal.net/kitty/shell-integration/)).
- **VS Code**: "injects arguments and/or environment variables when the shell
  session launches"; supports bash, fish, pwsh, zsh on macOS/Linux
  ([VS Code docs](https://code.visualstudio.com/docs/terminal/shell-integration)).
  The bash script itself
  ([shellIntegration-bash.sh](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh))
  reads `VSCODE_INJECTION`, `VSCODE_NONCE`, `VSCODE_SHELL_INTEGRATION` (recursion
  guard), `VSCODE_SHELL_LOGIN`; hooks by **wrapping PS1/PS2**
  (`__vsc_custom_PS1="\[$(__vsc_prompt_start)\]$__vsc_original_PS1\[$(__vsc_prompt_end)\]"`),
  **overriding `PROMPT_COMMAND`**, and **`trap '__vsc_preexec_only "$_"' DEBUG`**.
- **iTerm2**: user-installed per-shell scripts (`~/.iterm2_shell_integration.<shell>`)
  sourced from rc files — bash, fish, tcsh, xonsh, zsh
  ([iTerm2 docs](https://iterm2.com/documentation-shell-integration.html)).

### OSC 633 — the VS Code superset

Same A/B/C/D skeleton plus:

- `633;E;<commandline>[;<nonce>]` — **the command line, explicitly, as data.**
  No parsing the prompt line out of the grid.
- `633;P;<Property>=<Value>` — `Cwd`, `IsWindows`, `HasRichCommandDetection`.
- `633;F` / `633;G` — continuation-prompt markers.
- `633;EnvSingleEntry;<key>;<value>;<nonce>` — env deltas.
- Values are escaped: backslashes doubled, `; ` → `\x3b`, control chars → `\xNN`.
- The **nonce** is what makes `E` trustworthy — it "enables VS Code to correlate
  commands with their output across multiple shell invocations," i.e. it
  distinguishes integration-emitted marks from marks a hostile/confused child
  process echoed into the stream.

VS Code also accepts OSC 133 and iTerm2 OSC 1337 for compatibility.

### Could Junto inject this into plain terminal nodes?

Yes, and the injection point already exists and is already the right shape:
`local-host.ts:241–245` merges `{...process.env, ...launch.env, TERM, COLORTERM}`.
Adding `ZDOTDIR`/`ENV`/`XDG_DATA_DIRS` + a `JUNTO_NONCE` there is a few lines.

But three constraints from this repo bind the design:

- **The settled doctrine is ZERO writes to the user's harness config.** That
  doctrine is about *harness* config, and the same logic obviously extends to the
  user's shell rc. So the iTerm2 model (append a `source` line to `~/.zshrc`) is
  **out**. The kitty/VS Code model — ship Junto's own integration script inside
  the app bundle, point the shell at it via env at spawn, have the script chain to
  the user's real rc, then unset the marker var — is **in**, and is the same
  mechanism both of those terminals ship in production.
- **`shell-policy.ts` validates the shell binary but not the shell *family*.**
  Injection is per-family (zsh ≠ bash ≠ fish), and every family needs a different
  var. Resolution from `process.env.SHELL` (`:216–217`) gives a path, not a
  guaranteed family. Fail-open (no injection, no marks) is the correct failure
  mode, and it degrades to exactly today's behavior.
- **Marks must be trust-tagged, not trusted.** Any child process can `printf`
  `\e]133;D;0\a`. Adopt the VS Code nonce discipline: Junto mints a per-session
  nonce at spawn, the injected script includes it, and unnonced marks are treated
  as *presentational* (fine for painting a gutter dot) but never as
  *authoritative* (never gate a task-state transition, never satisfy a proof
  criterion). Mapping to this repo's vocabulary: a nonced `D;<exit>` is admissible
  runtime evidence; an unnonced one is a note.

**Value if built:** every plain terminal node becomes a stream of typed
`(command, cwd, exit code, start→end duration)` records instead of an opaque
scrollback. That is the substrate for most of §4.

---

## 2 - Title + OSC signal taxonomy — what real tools already emit

`ESC ] Ps ; Pt ST` (`ST` = `ESC \` or `BEL`). No central registry, so numbers
collide across vendors ([terminfo.dev](https://terminfo.dev/osc)).

### Universally emitted, zero adoption cost

| code | form | what it carries | Junto use |
|---|---|---|---|
| `0` / `2` | `ESC]0;text ST` / `ESC]2;text ST` | window/icon title | **the cheapest state feed there is.** Many TUIs park progress + activity here. xterm.js surfaces it as a first-class event: `onTitleChange: IEvent<string>` (`xterm.d.ts:999–1003`, "OSC 0 or OSC 2") |
| `7` | `ESC]7;file://HOST/PATH ST` | cwd | per-node cwd badge; correct `cwd` for a station CLI invocation without asking the agent |
| `8` | `ESC]8;params;url ST … ESC]8;;ST` | hyperlink | clickable URLs from tool output — including the dev-server URL, handed over as data instead of regexed. Not supported by Terminal.app; supported by everything else |
| `52` | `ESC]52;c;<base64> ST` | clipboard write | a TUI can hand Junto a payload deliberately. Note: clipboard *read* is refused by ghostty/warp/kitty/Terminal.app — treat write-only |

### Notification / attention family (four competing spellings)

- `OSC 9;<message> ST` — iTerm2-style simple desktop notification
  ([iTerm2 escape codes](https://iterm2.com/documentation-escape-codes.html)).
- `OSC 777;notify;<title>;<body> ST` — the rxvt/urxvt-lineage generic form.
- `OSC 99` — kitty's full protocol: `ESC]99;<metadata>;<payload>ESC\`, metadata as
  colon-separated `key=value` — `i=` id, `d=` done flag, `p=` payload type
  (`title`/`body`/`close`/`icon`/`buttons`/`alive`), `e=` base64, `a=report|focus`,
  `u=` urgency 0/1/2, `w=` auto-close ms, `c=` want-close-event. Chunked at 2048
  raw / 4096 encoded bytes. **Round-trips**: with `a=report` the terminal writes
  activation back to the app as `ESC]99;i=<id>;ESC\`, and button clicks as
  `ESC]99;i=<id>;<button#>ESC\`
  ([kitty notifications](https://sw.kovidgoyal.net/kitty/desktop-notifications/)).
- `OSC 1337;RequestAttention=yes|once|no|fireworks ST` — iTerm2 dock-bounce.

The kitty `a=report` round-trip is the interesting one: it is a **bidirectional**
channel a TUI can use to ask the host for a decision and receive the answer
in-band. That is architecturally the same shape as this repo's
`input-required` attention stoppage, arriving over a standard protocol.

### Progress — `OSC 9;4`

ConEmu-origin, now broadly adopted. `ESC]9;4;st;pr ST`
([ConEmu ANSI codes](https://conemu.github.io/en/AnsiEscapeCodes.html)):

| `st` | meaning |
|---|---|
| `0` | remove progress |
| `1` | normal, `pr` = 0–100 percent |
| `2` | error state (`pr` optional) |
| `3` | indeterminate |
| `4` | paused (`pr` optional) |

Real emitters: **Cargo**, **Gradle 9.4+**, **systemd v257** (`systemd-repart`,
`systemd-sysupdate`/`updatectl`, `importctl`). Real consumers: Windows Terminal,
ConEmu, Ghostty 1.2+, kitty, Konsole, mintty, libVTE. Not (per search) npm/pnpm/
uv/winget/rsync.
([rockorager.dev writeup](https://rockorager.dev/misc/osc-9-4-progress-bars/),
[MS Learn](https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences),
[Gradle 9.4.0 notes](https://docs.gradle.org/9.4.0/release-notes.html),
[systemd v257](https://0pointer.net/blog/announcing-systemd-v257.html))

**Ghostty 1.3.0 gotcha:** `RIS` (full reset) now also resets the progress bar —
i.e. progress state is terminal-lifetime state that a reset clears. Any Junto
progress ring must clear on `RIS`, not linger.

Note the collision hazard: `OSC 9` means "notification" (iTerm2) *and*
`OSC 9;4` means "progress" (ConEmu). kitty has an open issue on exactly this
conflict ([kovidgoyal/kitty#8011](https://github.com/kovidgoyal/kitty/issues/8011)).
Dispatch on the **first sub-parameter**, never on `9` alone.

### iTerm2 `OSC 1337` — the proprietary grab-bag

`SetUserVar=<key>=<base64>`, `CurrentDir=<path>`, `RemoteHost=<user>@<host>`,
`SetMark`, `StealFocus`, `ClearScrollback`, `RequestAttention=…`, `File=<args>`
(inline images / download), `Copy=:<base64>`, `SetBadgeFormat=…`,
`SetKeyLabel=<key>=<value>`, `ShellIntegrationVersion=<v>;<shell>`,
`Custom=id=<secret>:<pattern>`.

Two of these matter for Junto. **`SetUserVar`** is a generic key→value side
channel from any process to the terminal — WezTerm adopted it and fires a
`user-var-changed` event on it ([wezterm](https://wezterm.org/shell-integration.html)).
It is the lowest-ceremony way for a *cooperating* tool to publish structured
state without Junto shipping a protocol. And **`Custom=id=<secret>:<pattern>`**
is iTerm2 arriving independently at the same nonce answer §1 landed on:
proprietary sequences authenticated by a shared secret.

### The underrated feed: CSI mode state, not OSC

This is the finding I did not expect. xterm.js exposes parsed terminal **modes**
as readable state (`xterm.d.ts:1907–1956`), all verified present in the shipped
bundle (`grep -o "synchronizedOutputMode\|2026\|1047\|1048\|1049" node_modules/@xterm/xterm/lib/xterm.js` → all hit):

| mode | sequence | what it tells Junto |
|---|---|---|
| `synchronizedOutputMode` | `CSI ?2026h` | **"a frame is being composed; do not read yet."** typings: "output is buffered and only rendered when the mode is disabled, allowing for atomic screen updates without tearing." A TUI using it is *handing you exact repaint boundaries* — the correct instant to scrape is the `2026l`. This is a far better idle-detection primitive than a debounce timer. |
| `bracketedPasteMode` | `CSI ?2004h` | a readline-style input box is live and accepting paste — a direct, protocol-level signal that the input box exists, which is exactly the gate the state-gated typing design needs |
| `mouseTrackingMode` | `?9h`/`?1000h`/`?1002h`/`?1003h` | app has taken the mouse → full-screen interactive TUI, not a shell at a prompt |
| `applicationCursorKeysMode` | `CSI ?1h` | ditto; also changes which bytes arrow keys must be sent as when *writing* |
| alt buffer | `?47`/`?1047`/`?1048`/`?1049` | see §5 |
| `wraparoundMode` | `CSI ?7h` | needed to interpret line continuation correctly when reconstructing logical lines |

`bracketedPasteMode` + `synchronizedOutputMode` together are a materially
stronger, cheaper, and more portable idle/ready detector than screen scraping —
and they require no cooperation from the harness beyond behaving like a normal
TUI. Both are already parsed by the emulator Junto already ships; nothing reads
them.

---

## 3 - Grid-diff / scrape architecture

### Where the emulator runs (the decision that gates everything)

Today: renderer-only, disposed on unmount (`TerminalSurface.tsx:207`, `:266`).
For automation the grid must be **authoritative and always-on**, which means main.

Shape: `@xterm/headless` instance per live session inside main, fed from the same
`observeData` seam that already exists (`local-host.ts:698`). The renderer keeps
its own display terminal and stays purely presentational — no protocol logic in
the renderer, which also keeps the electron-security posture intact. Cost is one
emulator per session; xterm.js's own documented use case for headless is exactly
"keep track of a terminal's state where the process is running… restore state on
reconnection" via the serialize addon
([@xterm/headless](https://www.npmjs.com/package/@xterm/headless),
[@xterm/addon-serialize](https://www.npmjs.com/package/@xterm/addon-serialize)).

Nice side effect: `addon-serialize` replaces the 512 KB raw-byte journal
(`local-host.ts:200`) with a **state** snapshot. Reattach then costs one write of
a serialized framebuffer instead of replaying up to half a megabyte of bytes
through the parser — and it is correct across a mid-journal trim, which raw
replay is not (a trimmed byte log can start mid-escape-sequence).

### Change detection over the grid

xterm.js gives four coalescing hooks, all already in the installed typings:

- `onWriteParsed: IEvent<void>` (`:967–976`) — "fires at most once per frame,
  after data parsing completes." **This is the natural diff tick.** Not per-byte,
  not per-chunk: per parse-frame.
- `onRender: IEvent<{start, end}>` (`:959–965`) — the **dirty row range**. Renderer
  only (no rendering in headless), but the concept is what you want: diff rows
  `start..end`, not the whole grid.
- `onScroll`, `onLineFeed`, `onResize`, `onCursorMove`, `onBell`, `onTitleChange`
  (`:957`–`:1003`) — cheap structural events.
- `buffer.onBufferChange: IEvent<IBuffer>` (`:1586–1590`) — alt-screen enter/exit.

Read path: `buffer.active` / `.normal` / `.alternate` (`:1569–1591`);
`IBuffer` gives `cursorX/cursorY/viewportY/baseY/length` + `getLine(y)`
(`:1503–1556`); `IBufferLine.translateToString(trimRight?, startCol?, endCol?)`
(`:1624–1632`) and `getCell(x, cell?)` with a reusable cell object to avoid
per-cell allocation (`:1610–1622`). `Terminal.registerMarker(cursorYOffset?)`
(`:1147`) returns an `IMarker` that **tracks a logical line as scrollback moves** —
the right way to pin "where command N started" without storing a row index that
goes stale.

So the rule engine tick is:

```
observeData(bytes)  ->  headless.write(bytes)
                    ->  onWriteParsed  (>= one frame parsed)
                    ->  ? synchronizedOutputMode  ==> defer   // mid-frame, don't read
                    ->  diff(dirty rows) |> match(rules) |> emit(signal)
```

Two disciplines that keep this honest:

1. **Match against grid text, never raw bytes.** Grounded, from this repo's own
   dev dependency: vite prints its URL as
   `  ${green("➜")}  ${bold("Local")}:   ${cyan(url.replace(/:(\d+)\//, (_,p)=>`:${bold(p)}/`))}`
   (`node_modules/vite/dist/node/chunks/logger.js:321–326`). On the wire that is
   `http://localhost:\x1b[1m5173\x1b[22m/` — **the port is wrapped in SGR bold**, so
   a byte-stream regex for `localhost:(\d+)` fails while a grid-text regex
   succeeds trivially. This alone justifies the emulator.
2. **Rules are anchored, bounded, and named.** A rule is
   `(scope, pattern, action)` where scope ∈ `{last line, viewport, region between
   two markers}`. VHS's grammar is a good model of the minimum viable vocabulary:
   `Wait[+Screen][+Line] [@<time>] /regex/`, defaulting to `/>$/`, last line only,
   15 s cap ([charmbracelet/vhs](https://github.com/charmbracelet/vhs)). Note what
   VHS chose: **line-scoped by default, screen-scoped opt-in, always timeout-bounded.**

### Prior art — what each one actually teaches

| system | mechanism | the transferable lesson |
|---|---|---|
| **tmux control mode** (`-CC`) | text protocol on stdin/stdout; every command's output fenced by `%begin <ts> <n> <flags>` … `%end`/`%error`; async notifications prefixed `%`: `%output %pane data`, `%extended-output %pane <ms-behind> : data`, `%pane-mode-changed`, `%window-add/-close/-renamed`, `%session-changed`, `%sessions-changed`, `%layout-change`, `%pause`, `%continue`, `%subscription-changed` ([tmux wiki](https://github.com/tmux/tmux/wiki/Control-Mode)) | (a) **fence every request/response so async notifications can interleave safely** — the guard-line pattern; (b) `%pause`/`%continue` + `refresh-client -f pause-after=<s>` + `%extended-output`'s *milliseconds-behind* metric is a **complete flow-control design**, including telling the client how far behind it is. Junto's herdr inbound frames already carry `seq`/`full` (`src/shared/terminal-session-domain.ts:327–336`) but no lag metric and no pause. |
| **herdr** (third-party, in-tree bridge) | stock NDJSON `terminal session control\|observe`; outbound `terminal.input`/`resize`/`scroll`/`release`, inbound `terminal.frame {bytes, full, seq, width, height}` / `terminal.closed` (`src/shared/terminal-session-domain.ts:245–345`) | frames are already **sequenced and full/delta-tagged** — the wire is diff-ready; nothing on the Junto side consumes the distinction. Per standing rulings herdr stays stock/upstream-only, so its protocol is a *constraint*, not a place to add marks. |
| **expect / pexpect** | `spawn` in a pty, `expect([patterns…])` with `EOF`/`TIMEOUT` sentinels, `before`/`after`/`match` ([pexpect](https://pexpect.readthedocs.io/en/stable/overview.html)) | the canonical **stream-matching failure modes**: `$` doesn't mean end-of-line (TTYs emit `\r\n`); trailing `+`/`*` match non-greedily; `.*` can match zero chars; the matcher cannot look ahead. Every one of these bites a naive "wait for ready" rule. `expect_exact` exists because regex-on-a-stream is a trap. |
| **VHS** | `.tape` DSL over `ttyd`; `Wait[+Screen][+Line] [@time] /re/`, `Type`, `Sleep`, `Set`, `Hide`/`Show`, `Screenshot`, `Require`, `Source` | a **recorded macro format that is executable, diffable, and CI-runnable**. Directly transplantable as the Junto terminal-macro format. `Require` (declare dependencies up front) and `Hide`/`Show` (do work without recording it) are both non-obvious and both necessary. |
| **asciinema v2** | NDJSON: header `{version:2, width, height, timestamp, duration, idle_time_limit, command, title, env, theme}` then `[time, code, data]` with `o` output / `i` input / `m` marker / `r` resize ([docs](https://docs.asciinema.org/manual/asciicast/v2/)) | the **exact schema Junto's journal should have been.** Note `r` resize as a stream event and `m` markers as first-class — Junto's journal already records `output` and `resize` entries with a monotonic `seq` (`local-host.ts:701`, `:526`), so it is ~one field from being valid asciicast, i.e. from being replayable by third-party players. |
| **Warp blocks** | every command+output is a Block, carrying command / output / exit code / cwd / timing; boundaries from shell integration — originally DCS, moved to OSC ([Warp docs](https://docs.warp.dev/terminal/blocks/block-basics/)) | two hard-won details from their Windows writeup ([blog](https://www.warp.dev/blog/building-warp-on-windows)): ConPTY **dropped unrecognized DCS** entirely, and once on OSC the sequences arrived **interleaved out of order with output** — "the shell sending `START_OSC, hello world, END_OSC` could result in Warp receiving `START_OSC, hell, END_OSC, o world`." They forked ConPTY to force-flush. Also: Warp keeps **separate grids per prompt/command/output**, not one scrolling grid. macOS-only Junto dodges the ConPTY bug, but the architectural point stands: **block-structured state is a different data model from a cell grid, and OSC marks are the seam between them.** |

---

## 4 - Product primitives — as Junto nodes, with honest cost

Cost is relative to the machinery the managed terminal already implies (owned
PTY, byte stream, byte writing) **plus** the two additions §0–§3 argue for
(headless grid in main; OSC parse + rule tick). Costs assume both.

### Cheap — nearly free once OSC parsing exists

**a) Command-record stream on every terminal node.**
`entity: terminal` + nonced OSC 133/633 → per-command records
`(cmdline, cwd, exitCode, start, end)`. Everything else in this list is a
projection of this stream. Needs: injection at `local-host.ts:241`, an OSC handler,
`registerMarker` per `C`. No new node kind, no new UI primitive — an existing
terminal node just acquires structure. **This is the keystone; build it first.**

**b) Exit-code → task state.**
A nonced `133;D;<exit>` on a terminal node with a `criteria.mode: "tasks"` edge is
a runtime stamp. Exit 0 → satisfied; non-zero → attention. Fits the existing
physics without new vocabulary — `proof` criteria already means "blocks until
matching runtime stamp." Nonce discipline from §1 is what makes it admissible.

**c) Title + progress rail.**
`onTitleChange` (`xterm.d.ts:999`) plus `OSC 9;4` state → the node's existing
badge/progress chrome. Two handlers, no grid, no rules. Real coverage today for
Cargo / Gradle / systemd; title coverage is near-universal. Must clear on `RIS`.

**d) Notification → canvas attention.**
`OSC 9` / `OSC 777` / `OSC 99` → the existing alert/attention queue
(`src/renderer/lib/alert-attention.ts`, `alert-queue.ts` already exist). If
`OSC 99 a=report` is honored, the round-trip back into the PTY makes a canvas
click an in-band answer to the TUI — the cheapest possible `input-required`
resolution path.

**e) Recorded/replayable terminal macros.**
Junto already writes a sequenced journal of output+resize and already writes
bytes to the master. A macro is: record `(input, output, resize)` in asciicast v2
shape, replay by writing input and gating each step on a VHS-style
`Wait+Line /re/ @timeout`. Both halves exist; the format and the gate are the
work. Ship the format as **asciicast v2** — it is already a standard, already has
players, and the journal is one field away.

### Medium — needs the headless grid + rule engine

**f) Dev-server node.**
Spawn `bun dev`, detect ready, expose URL, restart button, stop on quit. The
grounded detail that makes this *not* trivial, from this repo's own dependency:

- Ready line is `ready in <N> ms`, dim+bold-wrapped
  (`node_modules/vite/dist/node/cli.js:588`).
- URL line is `  ➜  Local:   <cyan url with bold port>`
  (`chunks/logger.js:321–326`) — **regex the grid, not the bytes** (§3).
- Vite **clears the screen on every restart**, and only when
  `process.stdout.isTTY && !process.env.CI` (`chunks/logger.js:262`). Its clear is
  `rows-2` newlines then `cursorTo(0,0)` + `clearScreenDown`
  (`:241–247`). So: (i) a PTY-hosted dev server *does* clear, where a piped
  `-p`-style capture never would — Junto inherits a behavior headless invocation
  never sees; (ii) the ready line scrolls into scrollback and leaves the
  viewport, so a "read the visible screen" rule goes stale on the first HMR
  restart. **Pin it with `registerMarker` at detection time, don't re-read the
  viewport.**

Strictly better than regex when available: `OSC 8` gives the URL as data, `OSC 7`
gives cwd, `OSC 9;4` gives build progress. Rule order should be
`marks first, grid regex as documented fallback` — same three-feed layering the
harness state design already uses, applied to plain tools.

**g) Log-watcher node.**
`entity: watcher` already exists in the schema vocabulary (`src/shared/canvas.ts`
ether entity kinds include `watcher`), and the kernel already has an
edge-detection discipline with three laws (derived state, app-local memory,
arming only in the running app). A terminal-fed watcher is that same kernel
primitive with a different predicate source: rule matches on the grid diff →
region pulse / attention flag. The three laws transfer unchanged — in particular
"restart re-baselines, no latent fire" is exactly right for a scrollback rule.

**h) Long-running process supervision.**
`(exit code, duration, restart count)` per supervised child → task state, with
restart policy. Depends on (a)+(b). The honest hard part is not detection but
**policy**: restart-on-crash is a machine-safety-adjacent decision (a crash-loop
is a resource attack on the operator's machine), so it needs a bound and it needs
to route through the sealed process-signal plane
(`src/main/junto/process-signal.ts`) rather than growing its own kill path.

### Expensive / taste-bound — do not bundle with the above

**i) Command palettes typed into any terminal.**
Mechanically trivial (write bytes; the machinery is already there for agent
driving). Everything hard is product: what is in the palette, when is it safe to
type (§2's `bracketedPasteMode` + `synchronizedOutputMode` gate is the mechanism,
but the *policy* is judgment), and how the operator avoids typing into the wrong
pane. This is a design question wearing an engineering costume — the same
state-gated-typing problem already settled for agents, re-opened for humans.

**Deliberately not proposed:** structured block UI à la Warp (separate grids per
block — a rendering rewrite, and the settled design is xterm rendering);
inline-image / file-transfer support (`OSC 1337;File=`); clipboard *read*; any
DCS-based protocol (Warp's evidence is that DCS is the fragile choice).

### Dependency order

```
(a) command records  >>=  (b) exit->task  &  (c) title/progress  &  (d) notify
(a) >>= (e) macros
headless grid in main  >>=  (f) dev-server  &  (g) log-watcher
(a) & (b) >>= (h) supervision
(i) escalate — product decision, not a build
```

---

## 5 - Risks and limits

**Alternate screen vs scrollback.** `?1049`/`?1047`/`?47` switch to the alt
buffer; all three are implemented in the shipped xterm bundle (verified by grep).
xterm.js exposes `buffer.alternate` and `buffer.type: 'normal' | 'alternate'`
(`xterm.d.ts:1503–1591`). The hard limit: **the alt buffer has no scrollback.**
A full-screen TUI (vim, htop, and every harness TUI in the v1 list) paints into a
buffer whose history does not exist, so "search the last 500 lines for the ready
message" is meaningless there. Rules must declare which buffer they apply to, and
`onBufferChange` must invalidate buffer-scoped state on every switch. Corollary:
`registerMarker` positions taken in the normal buffer do not survive an alt-screen
excursion in any meaningful way. Related knob: `scrollOnEraseInDisplay`
(`:253–258`) makes `ED2` push erased text to scrollback (PuTTY behavior) — that
would preserve vite's cleared ready line, at the cost of diverging from what the
user sees in their own terminal. Two different truths; pick one deliberately.

**Resize storms.** Resize is expensive at three layers at once: `pty.resize` →
`SIGWINCH` → the child repaints its whole screen → a large byte burst → the
emulator reflows. Junto currently journals *and* emits on every resize
(`local-host.ts:526–535`), so a drag-resize multiplies through the whole chain.
Mitigations: debounce/coalesce at the geometry source; treat the burst window as
"grid not trustworthy" and suppress rule evaluation; note that xterm.js
`reflowCursorLine` defaults to **false** "because shells usually handle this
themselves" (`:209–214`) — meaning during resize the grid and the child
transiently disagree about the cursor line, so any rule anchored to the last line
is *wrong* mid-resize, not merely stale. kitty advertising "glitch-free window
resizing" as a *shell-integration* feature is the tell that this is genuinely hard
and needs shell cooperation. Also: node-pty ships experimental flow control
(`handleFlowControl`, `flowControlPause` default XOFF `\x13`, `flowControlResume`
default XON `\x11` — `node_modules/node-pty/typings/node-pty.d.ts`), which is the
lever for backpressure; tmux's `%pause`/`%continue` + milliseconds-behind is the
design to copy if it becomes necessary.

**Unicode and wide chars.** `IBufferCell.getWidth()` returns `1` normally, `2`
for CJK/wide, **`0` for the cell immediately following a wide cell**
(`xterm.d.ts:1638–1646`). So column arithmetic, `translateToString(_, startCol,
endCol)` slicing, and any "read the box at columns 4–40" rule all break on wide
glyphs and emoji unless width is respected. `IBufferLine.length` "may exceed
columns as the line array may not be trimmed after a resize" (`:1602–1608`) —
compare against `Terminal.cols`, never trust `length`. Unicode width is *itself*
version-dependent and pluggable (`unicode.activeVersion`,
`IUnicodeVersionProvider.wcwidth(cp): 0|1|2`, `charProperties` — `:1871–1902`), so
a headless grid in main and the display grid in the renderer **must be pinned to
the same Unicode version** or they will disagree about layout, and a rule that
passes in the headless grid will not match what the operator sees.
`rescaleOverlappingGlyphs` (`:216–231`) exists because ambiguous-width chars are a
known unsolved case. Agent TUIs are heavy emoji users; this is a live risk, not a
theoretical one.

**Escape-sequence framing and trust.** Junto's journal is a **raw byte ring with
a byte-budget trim** (`local-host.ts:200`, `:875–880`), so a trimmed journal can
begin mid-escape-sequence and corrupt a replayed grid. A serialized state
snapshot has no such failure mode. Separately: `registerOscHandler` / DCS payloads
are buffered whole up to a 10 MB xterm.js limit (`:1819–1835`, `:1849–1864`) — a
hostile or buggy child can force multi-megabyte accumulation per sequence. And
the Warp finding stands as a warning even off-Windows: OSC delivery is not
guaranteed to be ordered relative to surrounding output on every PTY
implementation, so **never infer ordering from arrival order alone** — carry the
nonce and, where available, the `aid=`.

**Performance budget.** Per-session cost of the proposed main-side grid: one
emulator + `scrollback` rows (default **1000**, `:246–251`). Ticks are
per-parse-frame (`onWriteParsed`, "at most once per frame"), not per byte, so a
firehose costs frames not bytes — but rule evaluation over `scrollback × cols`
cells is the thing that must stay bounded. Rules should be **row-scoped by
default and marker-anchored**, mirroring VHS's line-default and xterm's
`onRender` dirty range. `getCell(x, cell?)` takes a reusable cell object
explicitly "to avoid creating new objects for every cell" — the API is telling you
the allocation pattern that matters. Two blunt budget rules worth setting up
front: cap concurrent supervised sessions, and make every rule carry a timeout
(VHS's 15 s default is a reasonable starting point).

**Async parser handlers.** OSC/CSI/DCS handlers may return a `Promise`, but the
typings warn: "Downside of an async handler is a rather bad throughput
performance, thus use async handlers only as a last resort" (`:1795–1804`). Mark
handling must be synchronous — enqueue, don't await.

---

## 6 - Open questions for the operator

1. **Does shell-integration injection clear the zero-config doctrine?** The
   settled rule is zero writes to the *harness* config. Injection as designed
   writes nothing to disk — it is env-only at spawn, chaining to the user's real
   rc, marker var unset by the script (kitty's exact mechanism). Confirm that
   reading of the doctrine before this is built on.
2. **Does the headless grid in main move, or duplicate?** Moving authority to main
   makes the renderer purely presentational and fixes the lifetime bug; duplicating
   means two grids that must agree on Unicode version and geometry forever. This is
   an architecture call, not an implementation detail.
3. **Is an unnonced OSC 133 mark admissible as anything?** Proposal above:
   presentational yes, authoritative never. That is a trust-plane ruling.
4. **Journal → asciicast v2?** It is ~one field of work and buys a standard format
   with third-party players; it also changes a durability-adjacent artifact shape.

---

## Sources

- [WezTerm — Shell Integration](https://wezterm.org/shell-integration.html)
- [VS Code — Terminal Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)
- [VS Code `shellIntegration-bash.sh`](https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh)
- [Per Bothner — semantic-prompts.md (normative OSC 133 spec; Anubis-gated, unread)](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md)
- [otty — OSC 133 / FTCS reference](https://docs.otty.sh/vt/osc/osc-133)
- [terminfo.dev — OSC index](https://terminfo.dev/osc)
- [kitty — Shell integration](https://sw.kovidgoyal.net/kitty/shell-integration/)
- [kitty — Desktop notifications (OSC 99)](https://sw.kovidgoyal.net/kitty/desktop-notifications/)
- [kitty#8011 — OSC 9;4 vs OSC 9 conflict](https://github.com/kovidgoyal/kitty/issues/8011)
- [iTerm2 — Proprietary escape codes](https://iterm2.com/documentation-escape-codes.html)
- [iTerm2 — Shell integration](https://iterm2.com/documentation-shell-integration.html)
- [ConEmu — ANSI escape codes (OSC 9;N origin)](https://conemu.github.io/en/AnsiEscapeCodes.html)
- [rockorager — OSC 9;4 progress bars](https://rockorager.dev/misc/osc-9-4-progress-bars/)
- [Microsoft Learn — progress bar sequences](https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences)
- [Gradle 9.4.0 release notes](https://docs.gradle.org/9.4.0/release-notes.html)
- [systemd v257 announcement](https://0pointer.net/blog/announcing-systemd-v257.html)
- [Ghostty 1.3.0 release notes](https://ghostty.org/docs/install/release-notes/1-3-0)
- [tmux — Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode)
- [pexpect — Overview](https://pexpect.readthedocs.io/en/stable/overview.html)
- [charmbracelet/vhs](https://github.com/charmbracelet/vhs)
- [asciinema — asciicast v2 format](https://docs.asciinema.org/manual/asciicast/v2/)
- [Warp — Block basics](https://docs.warp.dev/terminal/blocks/block-basics/)
- [Warp — Bringing Warp to Windows (DCS/OSC, ConPTY ordering)](https://www.warp.dev/blog/building-warp-on-windows)
- [@xterm/headless (npm)](https://www.npmjs.com/package/@xterm/headless)
- [@xterm/addon-serialize (npm)](https://www.npmjs.com/package/@xterm/addon-serialize)

Local primary artifacts read: `node_modules/@xterm/xterm/typings/xterm.d.ts`,
`node_modules/@xterm/xterm/lib/xterm.js` (mode support verified by grep),
`node_modules/node-pty/typings/node-pty.d.ts`,
`node_modules/vite/dist/node/cli.js`,
`node_modules/vite/dist/node/chunks/logger.js`,
plus the repo files cited inline.
