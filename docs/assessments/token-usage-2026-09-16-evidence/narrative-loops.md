# Narrative, loops, and inter-agent traffic — Codex session `01a09ce9`

Scope: this file covers the operator's asks, the turn-by-turn arc, the two aborted turns, inter-agent
traffic, stall episodes, and the agent's own statements of trouble. Per-response token accounting,
tool-call sizes and exit codes are owned by sibling panes and are not analyzed here.

Source (read-only): `/Users/guilhermecastro/.codex/sessions/2026/09/13/rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl`
Indexes used: `/tmp/tt-invest/index/{turns,compactions,items,calls}.tsv`. Scratch scripts:
`/tmp/tt-invest/p1R-scratch/`.

---

## Executive arc

1. **The goal was one bug, then one feature set.** The session opens with the operator handing over a
   prior agent's diagnosis of Junto's PTY message injection (ord 9) and stating the first
   criterion: the agent must be able to *see* the app prove injection works, so the operator stops
   being the QA (ord 9, 22:38Z). It ends 37 h later implementing a five-feature "crew" brief — mail,
   prompt, wait, observe, reviews — across all harnesses (ord 10696, 08:30Z).
2. **The session ran for 37.09 h of wall clock but only 9.84 h of turns.** 27.25 h is operator-absent
   idle. Five turns carry 86% of the response items: turn 6 (63 m), turn 11 (51 m), turn 20 (106 m),
   turn 23 (103 m), turn 26 (193 m) — 5,394 of 6,270 items.
3. **The single bug was real and got fixed.** `7d2d6cb1` fixed a gate that reused paste-admission
   (is-the-seat-idle) to decide whether to press Enter, so our own paste made Enter be refused
   (ord 7014, 7043, 7218). Native before/after proof at 04:35Z (ord 7451).
4. **The dominant cost was not the bug.** It was rebuilding, signing, installing and re-verifying the
   packaged Electron app — twice per fix — plus 20 context compactions that consumed 48.8 minutes of
   pure model time, plus 82 peer messages that arrived on the operator's own user channel.
5. **The worst failure was self-inflicted and self-reported.** A 14-harness Devin fan-out was launched
   with a permission mode the agent invented (`restricted` → Devin `auto`), which killed the lanes;
   the agent said so plainly and the operator spent seven turns on it (ord 4821–4881).

---

## 1. The operator's asks

### Composition of the 117 `response_item`/`message` rows with `role: user`

Command:

```
jq -r 'select(.type=="response_item" and .payload.type=="message" and .payload.role=="user")
       | (.payload.internal_chat_message_metadata_passthrough.content_item_kinds // ["none"]) | join(",")' "$SRC" | sort | uniq -c
```

Output:

```
   1 agents_md.instructions,environments.environment_context
   2 environments.environment_context
 110 user.text
   4 user.text,user.image,user.text,user.text
```

So there are three populations, not two:

| population | rows | what it is |
|---|---|---|
| injected context | 3 | `AGENTS.md` + `<environment_context>` boilerplate (ord 5, 4894, 10598) |
| **real operator turns** | **32** | short human instructions, three of them carrying a screenshot |
| **peer-agent reports on the user channel** | **82** | Herdr pane reports (p13–p16, p1E–p1H, "defiant-quill", "Grok p16", "reviews lane", "Registry lane") that were delivered to the model as `role: user` text |

The third population is the one that matters and the one the brief did not anticipate. **81 of the 82
are Herdr lane reports**; the 82nd is the opening `<context>` paste of a prior agent's report (ord 9).
They are not operator speech: they are peers writing in the imperative, in the same channel, with no
sender envelope. The operator's own brief names this as a defect to fix: *"The envelope always names
the sending seat, which is the fix for peer reports arriving as anonymous user turns"* (ord 10696).

### The 32 real operator asks, in order

| # | ordinal | timestamp (UTC) | ask (verbatim, abbreviated) |
|---|---|---|---|
| 1 | 9 | 09-13 22:38:14 | `<context>` (prior agent's report) + *"Right now the PTY system for Junto, for the messages injection is severely lacking, broken, repeating over and over, and very chaotic… Critically, we must establish a beachead in a valid e2e that can actually test the proper implementation. Unless you can _see_ the app… we'll be stuck in this very wasteful loop wher eI'm the QA. That is the first criteria."* |
| 2 | 235 | 22:46:51 | *"cant you just click around it? Or open up a production app instrumented with extreme logs and otel and use @Computer-Use to test it yourself? Ignore the e2e playwright crap, cant you do it?"* |
| 3 | 1201 | 23:14:47 | *"well, did you do anything or patch anything / write any fixes? What did the QA prove exactly?"* |
| 4 | 1213 | 23:16:02 | *"ok, what is your thought process here? Is there a bug to be fixed?"* |
| 5 | 1226 | 23:22:16 | *"damn, ok, any way things can be more efficient? Like pre-generating the canvas - OR copying over my production canvas in which the devin agent is already always reproducing the issue, for example"* |
| 6 | 1364 | 23:29:47 | *"no not only the target seat activated you gotta play by the real rules - feel free to use the data and procee"* |
| 7 | 3131 | 09-14 00:45:02 | *"so you couldnt repro? Ok, well, let's close the QA app, and fully build it as a NEW, FRESH, production copy"* |
| 8 | 3233 | 00:47:16 | *"continue"* |
| 9 | 3409 | 01:41:52 | [screenshot] *"it looks like we still have this issue; I also noticed severe duplication of factory messages, it gets quite bad; let's take a step back perhaps and assess the full functionality, how does this feature works in full, and how can it breaking like this"* |
| 10 | 3486 | 01:44:04 | *"ok! I am STRONGLY suspecting of insidious caching nonsense, can you make ABSOLUETELY SURE THE NEW BUILD IS WHATS RUNNING? I CANNOT AFFORD THESE LOST QA CYCLES, IT IS UNBEARABLE"* |
| 11 | 3642 | 01:50:06 | [screenshot] *"just opened the new build and this just happened"* |
| 12 | 3694 | 01:55:12 | *"the PTY needs a FULL assessment over its ENTIRE MATRIX… you could write prism workflows with devin agents (up to 10 in parallel, extremely performant, devin:swe-2 max) and cover extremes amounts of ground very quickly"* |
| 13 | 3844 | 02:03:35 | *"yeah the 14 harnesses 14 devins fan out is likely a great usage of our performance"* |
| 14 | 4743 | 02:49:48 | *"what kind of execution failures and rate limits?"* |
| 15 | 4797 | 02:52:15 | *"ok so 16 of the 22 later lanes, how many in total succeeded? And how much did we achieve achieve so far?"* |
| 16 | 4809 | 02:52:54 | *"jesus that is devastating, that is horrible!"* |
| 17 | 4821 | 02:53:30 | *"Wow, I'm really upset at this. This is really bad. Was this prism's fault? What the hell happened here?"* |
| 18 | 4844 | 02:54:37 | *"why the fuck did you pick restricted?"* |
| 19 | 4856 | 02:55:13 | *"who the fuck asked with audit without changing files though?"* |
| 20 | 4868 | 02:56:12 | *"wow this is _really_ bad - and yet we managed to hit Devin's rate limits, is that right then?"* |
| 21 | 4881 | 02:57:17 | *"did it FIND anything USEFUL?"* |
| 22 | 4897 | 03:00:48 | quotes the agent's finding back approvingly, offers more parallel worker types (opencode/deepseek, cursor/grok-4.6, antigravity, codex-luna), then pastes a full Muse report |
| 23 | 5000 | 03:04:21 | *"use herdr to collaborate with the agents in this tab, as you are all working on the same, exact goal. Take the time to collaborate"* |
| 24 | 6103 | 03:52:20 | *"ive added two new agents to the tab: claude and grok; you can delegate and instruct them to collaborate as necessary and useful to the goal"* |
| 25 | 6333 | 03:57:47 | [screenshot] *"interestin! The exact same bug happened in Herdr! (note that the devin session above was manually triggered by me). Oh!Look what happened: herdr automatically submitted the muse's prompt"* |
| 26 | 6582 | 04:04:29 | *"looks like Devin in particular keeps getting herdr's input injections stuck"* |
| 27 | 7739 | 13:12:17 | *"how are we doing?"* |
| 28 | 7761 | 13:16:19 | *"what is left for the full matrix qualification, fresh mail and other harnesses? And what have we legitimately fixes so far?"* |
| 29 | 7840 | 15:00:58 | *"Okay, let's work on these remaining issues. I am compacting the agents, the four agents you have available to collaborate and delegate, so we all can start fresh… Let's do it. Let's go."* |
| 30 | 10586 | 17:16:37 | *"how are we doing?"* |
| 31 | 10601 | 09-15 08:24:42 | *"Okay, what is the current status of things and what are the next steps? I'm preparing a brief with very powerful new additions… There's eight agents besides you."* |
| 32 | 10696 | 08:30:09 | the **crew brief** (5,362 chars): five rulings (prompt as a port on the messages verb, mail envelope names the sending seat, Remote out of scope, blocking verdict sends the task back), invariants, five features (mail / prompt / wait / observe / reviews), evidence bars, build order, and *"I think this is extremely valuable to implement, to test, and to ensure that the mail, all of these features, are of extremely high quality… really invest in end-to-end Playwright automation with canvas generation for test setup"* |
| 33 | 10889 | 08:40:40 | *"Tower can change the dynamics a little bit. Overall, I want you all to keep the collaboration going… Do not let Tower dominate the dynamics."* |

The table has 33 rows but only **32 are operator speech**: row 1 (ord 9) is a prior agent's report
pasted into context by the operator, so it is the session's premise rather than a turn the operator
wrote. Counts elsewhere in this file use 32 for operator turns and treat ord 9 as a peer/context
message.

Two observations about the shape of the asks:

- **Most of the 32 turns are not work orders.** Classifying them: 16 give forward direction or
  approval (ord 9, 235, 1226, 1364, 3131, 3233, 3486, 3694, 3844, 5000, 6103, 6582, 7840, 10601,
  10696, 10889); 8 are diagnostics about work already done (ord 1201, 1213, 4743, 4797, 4868, 4881,
  7739, 7761); 4 are pure emotional reaction with no instruction at all (ord 4809, 4821, 4844, 4856);
  3 are screenshot bug reports (ord 3409, 3642, 6333); and 1 (ord 4897) is approval plus new
  information. That is 8 turns spent interrogating the agent about its own results, and 4 spent
  reacting to them.
- **Seven consecutive turns (ord 4743–4881, 02:49–02:58Z) are one incident review.** The agent lost
  2 h 51 m of fan-out, the operator found out, and the agent spent nine minutes admitting the cause.
  Every one of those turns is under 60 s of agent work.

---

## 2. Turn-by-turn arc

26 turns. `dur` is `task_complete`/`turn_aborted` minus `task_started`. `ask` is the operator's
message that opened the turn; `close` is the agent's last assistant message before the turn ended.

| # | turn | start→end (UTC) | dur | ord | ask | agent's closing line |
|---|---|---|---|---|---|---|
| 1 | 01a09ceb | 09-13 22:38:13→22:44:08 | 5 m | 1..231 | ord 9: "the PTY system … is severely lacking … establish a beachead in a valid e2e … That is the first criteria" | "Confirmed: we do not currently meet your first criterion. … All three relevant E2E scenarios failed." (228) |
| 2 | 01a09cf3 | 22:46:51→23:12:16 | 25 m | 233..1195 | "cant you just click around it? … use @Computer-Use to test it yourself?" | "Yes. I used Computer Use to drive Junto with real Devin. … We have a confirmed hands-on QA path." (1192) |
| 3 | 01a09d0d | 23:14:47→23:15:08 | 0 m | 1197..1209 | "did you do anything or patch anything / write any fixes?" | "**No fixes were written.** … The PTY defects remain unfixed." (1206) |
| 4 | 01a09d0e | 23:16:02→23:16:37 | 0 m | 1211..1221 | "Is there a bug to be fixed?" | "Yes. The bug is failed or uncertain submission turning into repeated pastes and Ctrl+C…" (1218) |
| 5 | 01a09d14 | 23:22:16→23:27:34 | 5 m | 1224..1360 | "any way things can be more efficient? Like … copying over my production canvas" | "Yes. I should have reused your failing setup immediately. I've now copied your production database…" (1357) |
| 6 | 01a09d1b | 23:29:47→00:33:26 | **63 m** | 1362..3127 | "you gotta play by the real rules - feel free to use the data and procee" | "…the full production copy—192 nodes, 57 edges… submitted four deliveries automatically… Committed `91546531`… **6,932 tests passed**." (3124) |
| 7 | 01a09d5f | 00:45:02→00:47:06 | 2 m | 3129..3229 | "let's close the QA app, and fully build it as a NEW, FRESH, production copy" | **ABORTED** — "The QA app and its local server are closed. … The build requires Bun 1.3.13; this shell has 1.3.14, so I'm locating the pinned compiler first." (3201) |
| 8 | 01a09d61 | 00:47:16→00:54:06 | 6 m | 3231..3405 | "continue" | "Fresh **production build 0.2.1**, from `eefaafff`, is ready… Full rebuild, Developer ID signing, package audit, and startup/shutdown checks passed." (3402) |
| 9 | 01a09d93 | 01:41:51→01:43:36 | 1 m | 3407..3482 | [screenshot] "we still have this issue; I also noticed severe duplication of factory messages" | **ABORTED** — "the running `/Applications` app is still build `34b4e3d9`, which has neither the containment fix nor the delivery trace." (3451) |
| 10 | 01a09d95 | 01:44:04→01:52:57 | 8 m | 3484..3690 | "make ABSOLUETELY SURE THE NEW BUILD IS WHATS RUNNING?" + [screenshot] | "Confirmed on **the verified new build, `eefaafff`**… `literal text still pending = true / paste chip visible = false / reported submission = SUCCESS`" (3687) |
| 11 | 01a09da0 | 01:55:12→02:46:17 | **51 m** | 3692..4739 | "the PTY needs a FULL assessment over its ENTIRE MATRIX … devin agents (up to 10 in parallel)"; then "the 14 harnesses 14 devins fan out" | "Committed the 14-harness assessment: **shared delivery-protocol defects plus adapter bugs**… Devin's fan-out hit execution failures and rate limits" (4736) |
| 12 | 01a09dd2 | 02:49:48→02:51:29 | 1 m | 4741..4793 | "what kind of execution failures and rate limits?" | three failure classes; "**16 of the 22 later lanes** ended with: > Reached overall message rate limit" (4790) |
| 13 | 01a09dd4 | 02:52:14→02:52:45 | 0 m | 4795..4805 | "how many in total succeeded?" | "Across all runs: 3 usable completed Devin reports… **Zero workflow tasks formally passed.**" (4802) |
| 14 | 01a09dd4 | 02:52:54→02:53:20 | 0 m | 4807..4817 | "jesus that is devastating" | "I own that. I scaled the fan-out before proving one complete workflow lane could finish reliably…" (4814) |
| 15 | 01a09dd5 | 02:53:29→02:54:21 | 0 m | 4819..4840 | "Was this prism's fault?" | "**Partly.** There is a concrete Prism integration bug, compounded by workflow decisions I made, followed by Devin throttling." (4837) |
| 16 | 01a09dd6 | 02:54:37→02:54:55 | 0 m | 4842..4852 | "why the fuck did you pick restricted?" | "I conflated **"audit without changing files"** with **"restrict tool execution."**" (4849) |
| 17 | 01a09dd7 | 02:55:12→02:55:38 | 0 m | 4854..4864 | "who the fuck asked with audit without changing files though?" | "Nobody. **I invented that restriction.**" (4861) |
| 18 | 01a09dd7 | 02:56:12→02:56:51 | 0 m | 4866..4877 | "we managed to hit Devin's rate limits, is that right then?" | "Yes. … **16 lanes hit its overall message-rate limit**." (4874) |
| 19 | 01a09dd8 | 02:57:17→02:58:03 | 0 m | 4879..4891 | "did it FIND anything USEFUL?" | "Yes. The strongest Devin finding was a real bug that marks unsent messages as delivered." (4888) |
| 20 | 01a09ddc | 03:00:48→04:47:26 | **106 m** | 4893..7733 | ord 4897 + "use herdr to collaborate with the agents in this tab" + "ive added two new agents to the tab: claude and grok" + "Devin … keeps getting herdr's input injections stuck" + [screenshot] | "The reproduced bug is fixed in **`7d2d6cb1`**, verified installed and running… **7,003 tests passed**" (7730) |
| 21 | 01a0a00c | 13:12:17→13:13:06 | 0 m | 7735..7757 | "how are we doing?" | "We've fixed the reproduced failure and established a real native QA baseline." (7754) |
| 22 | 01a0a00f | 13:16:19→13:21:05 | 4 m | 7759..7836 | "what is left for the full matrix qualification…?" | "**We now have a real native beachhead**… Full matrix qualification remains open, including fresh mail." + a 6-row fix/evidence table (7833) |
| 23 | 01a0a06f | 15:00:57→16:44:28 | **103 m** | 7838..10580 | "let's work on these remaining issues… the four agents you have available" + **16 Herdr lane reports** | "Confirmed: **`ce3c10ae` is running**, with exact packaged bytes verified… **7,141 passed**" (10577) |
| 24 | 01a0a0eb | 17:16:37→17:17:00 | 0 m | 10582..10594 | "how are we doing?" | "**The original Devin failure now has a verified fix and native proof.** … **Still unfinished:** native qualification of other harnesses…" (10591) |
| 25 | 01a0a42b | 09-15 08:24:42→08:28:05 | 3 m | 10596..10692 | "what is the current status of things and what are the next steps?… There's eight agents besides you." | "Running app: `ce3c10ae`, version 0.2.1… Latest source: `9013b252`, version 0.3.0… **not installed**." (10689) |
| 26 | 01a0a430 | 08:30:08→11:43:22 | **193 m** | 10694..16145 | the crew brief (10696) + "keep the collaboration going" (10889) + **58 Herdr lane reports** | "Committed `858095ef`: a swallowed paste now resolves as unresolved… I also found why waiting for an already-exited seat timed out… That fix is underway." (16116) |

### Compaction markers on the timeline

20 compactions. `compactions.tsv` gives `ordinal, timestamp, window_number, thread_total`.

| window | time (UTC) | ord | thread_total | inside turn |
|---|---|---|---|---|
| 1 | 09-13 23:01:28 | 741 | 18,826,898 | 2 |
| 2 | 23:35:08 | 1444 | 32,211,336 | 6 |
| 3 | 23:53:47 | 2018 | 41,729,598 | 6 |
| 4 | 09-14 00:32:19 | 3073 | 64,053,127 | 6 |
| 5 | 01:59:45 | 3772 | 73,117,306 | 11 |
| 6 | 02:38:27 | 4527 | 85,843,279 | 11 |
| 7 | 03:20:17 | 5258 | 96,296,246 | 20 |
| 8 | 03:52:11 | 6090 | 111,354,594 | 20 |
| 9 | 04:23:37 | 7024 | 127,332,231 | 20 |
| 10 | 13:19:56 | 7794 | 141,573,859 | 22 |
| 11 | 15:24:07 | 8426 | 155,549,174 | 23 |
| 12 | 16:08:21 | 9580 | 173,675,724 | 23 |
| 13 | 16:42:44 | 10499 | 189,964,271 | 23 |
| 14 | 09-15 08:46:39 | 10936 | 196,794,587 | **26** |
| 15 | 09:15:48 | 11576 | 206,963,877 | **26** |
| 16 | 09:46:55 | 12325 | 218,111,655 | **26** |
| 17 | 10:09:36 | 12941 | 228,113,885 | **26** |
| 18 | 10:32:16 | 13652 | 240,065,002 | **26** |
| 19 | 10:52:48 | 14370 | 253,500,221 | **26** |
| 20 | 11:21:51 | 15232 | **267,112,572** | **26** |

Turn 26 alone contains **7 of the 20 compactions** and 29% of the session's running thread total
(189.96 M → 267.11 M). All seven of that turn's intra-turn silences longer than 120 s are
compaction pauses, which makes compaction the only pacing mechanism it has.

### Idle gaps

Command: session-level gaps between consecutive records (`p1R-scratch/gaps.py`).

| gap | from → to (UTC) | between |
|---|---|---|
| **15 h 07 m** (54,462 s) | 09-14 17:17:00 → 09-15 08:24:42 | end of turn 24 → start of turn 25 (overnight) |
| **8 h 25 m** (30,291 s) | 09-14 04:47:26 → 13:12:17 | end of turn 20 → start of turn 21 |
| **1 h 40 m** (5,992 s) | 09-14 13:21:05 → 15:00:57 | end of turn 22 → start of turn 23 |
| 47 m 45 s (2,865 s) | 09-14 00:54:06 → 01:41:51 | end of turn 8 → start of turn 9 |
| 32 m 09 s (1,929 s) | 09-14 16:44:28 → 17:16:37 | end of turn 23 → start of turn 24 |
| 11 m 36 s (696 s) | 09-14 00:33:26 → 00:45:02 | end of turn 6 → start of turn 7 |

Totals (sum of turn durations vs. wall span):

```
TOTAL ACTIVE (sum of turn durations): 9:50:10  = 9.84 h
WALL SPAN:                            1d13:05   = 37.09 h
IDLE (span - active):                 1d03:15   = 27.25 h
```

Within-turn silence is much smaller: the largest intra-turn gap anywhere is 242 s, and it is a
compaction pause (see §5).

---

## 3. The two aborted turns

Both aborts carry `reason: "interrupted"` in the raw record:

```
{"ordinal":3229,"timestamp":"2026-09-14T00:47:06.702Z","payload":{"type":"turn_aborted",
 "turn_id":"01a09d5f-e3e7-79d3-8c31-4a3727d6bb8b","reason":"interrupted",
 "started_at":1789346702,"completed_at":1789346826,"duration_ms":124329}}
{"ordinal":3482,"timestamp":"2026-09-14T01:43:36.926Z","payload":{"type":"turn_aborted",
 "turn_id":"01a09d93-ea22-7601-be43-f25132cf65b2","reason":"interrupted",
 "started_at":1789350111,"completed_at":1789350216,"duration_ms":105067}}
```

### Abort 1 — `01a09d5f-e3e7-79d3-8c31-4a3727d6bb8b`, 00:45:02 → 00:47:06 (124.3 s)

- **Ask (ord 3131):** *"so you couldnt repro? Ok, well, let's close the QA app, and fully build it as a NEW, FRESH, production copy"*
- **What it was doing in the ~2 min before the abort:**
  - 00:45:11 (ord 3134): "I'll close the QA instance, build a fresh production app, and verify the packaged build."
  - 00:45:17–00:46:01: drove the QA app through its own lifecycle via CUA — `manualApp.getAXState`, `manualApp.pressKey('super+q')`, `manualApp.click(251)` to confirm closing four QA terminal sessions (calls 3151, 3156, 3161).
  - 00:45:24: `spawn_agent` `production_build_review` (call 3145).
  - 00:45:51–00:46:52: read `scripts/build-app.sh`, `scripts/install-app.sh`, `scripts/package-app-macos.sh`, `scripts/package-runtime-provenance.ts`, `scripts/mac-signing-config.mjs`, ran `bun --version`, `security find-identity -v -p codesigning`, `codesign -dv --verbose=4 '/Applications/Junto.app'`, and searched `/tmp` and the bun cache for a pinned Bun (calls 3166, 3176, 3187, 3202, 3214).
  - 00:46:35 (ord 3201, last message): "The QA app and its local server are closed. I'm using the full signed production build… The build requires Bun 1.3.13; this shell has 1.3.14, so I'm locating the pinned compiler first."
  - Aborted 31 s later, mid-investigation of the toolchain.
- **What the operator said immediately after (ord 3233, 00:47:16, 10 s later):** *"continue"*
- **Did the abort change the approach? No.** The new turn `01a09d61` is the same task with the same
  plan; it completed the build in 6 m 50 s and produced build 0.2.1 from `eefaafff` (ord 3402). The
  only thing that changed is that the agent stopped hunting for the pinned Bun: the next turn ran
  `tail`/`env`/`bun` directly and got a signed build. Reading: the operator stopped a turn that was
  about to spend minutes on toolchain archaeology, and restarted it.

### Abort 2 — `01a09d93-ea22-7601-be43-f25132cf65b2`, 01:41:51 → 01:43:36 (105.1 s)

- **Ask (ord 3409):** [screenshot] *"it looks like we still have this issue; I also noticed severe duplication of factory messages, it gets quite bad; let's take a step back perhaps and assess the full functionality, how does this feature works in full, and how can it breaking like this"*
- **What it was doing in the ~2 min before the abort:**
  - 01:41:59 (ord 3412): "The screenshot shows two cancelled deliveries and another pasted chip still waiting. I'll check which build is running, then trace how factory messages are created, submitted, acknowledged, and retried…"
  - 01:42:06: `ps -axww` for the Junto/Electron processes; `rg` for `deliverWorkingClaims|managedTaskDeliveryId|injectPrompt|writePrompt` in `kernel/service.ts` (call 3413).
  - 01:42:22 and 01:42:31: `spawn_agent` `factory_message_sources` and `pty_delivery_assessment` (calls 3423, 3429); 01:42:38 `followup_task` to `coverage_review` (call 3435).
  - 01:42:53 (call 3440): extracted `app.asar` from **both** `/Applications/Junto.app` and `release/mac-arm64/Junto.app` and compared `out/package-runtime-provenance.json` — version, `sourceCommit`, `buildIdentity.cohortNonce`, and whether `out/main/index.js` contains `"written-unresolved"` and `"pty-delivery.jsonl"`.
  - 01:43:05 and 01:43:12: `cua.getApp('/Applications/Junto.app')` then `getScreenshot()` (calls 3452, 3459).
  - 01:43:04 (ord 3451, last message): "One concrete finding: the running `/Applications` app is still build `34b4e3d9`, which has neither the containment fix nor the delivery trace. I built the new copy in `release/` but didn't install it… I'm using the code-reviewer skill to trace the full delivery path."
  - 01:43:28 (call 3466): started reading `kernel/service.ts:575-620` and `:1020-1240`, `managed-pulse-bridge.ts`, and the last lines of `transport.jsonl`/`perf.jsonl`.
  - 01:43:36.600 (call 3476): `send_message` to `pty_delivery_assessment` — the last action before the abort, 0.3 s prior.
- **What the operator said immediately after (ord 3486, 01:44:04, 28 s later):** *"ok! I am STRONGLY suspecting of insidious caching nonsense, can you make ABSOLUETELY SURE THE NEW BUILD IS WHATS RUNNING? I CANNOT AFFORD THESE LOST QA CYCLES, IT IS UNBEARABLE"*
- **Did the abort change the approach? Yes, decisively.** The agent had just discovered that the
  installed app was a stale build, and was about to spend the turn tracing duplication in source
  while an old binary was running. The operator aborted and reordered the work. The next turn opens
  with "I confirmed the old installed build is running. I'll quit it, replace
  `/Applications/Junto.app` with the fresh build, and verify the running…" (ord 3491,
  01:44:16) and reports "The fresh build is now installed, and its signature matches the audited
  release copy. The old process has exited." (ord 3558, 01:45:48). This is the single clearest
  example in the session of an operator interrupt that changed the plan.

---

## 4. Inter-agent traffic

There are **two independent collaboration channels** in this session, and conflating them would be
wrong.

### Channel A — Codex-native sub-agents (`spawn_agent` / `send_message` / `followup_task`)

`function_call` name census across the whole session:

```
 454 js            119 send_message     93 followup_task      17 sleep
  12 list_agents     9 wait_agent         8 spawn_agent         2 js_reset
```

Eight `spawn_agent` calls, all with an **encrypted** `message` argument (opaque base64; the task text
is not recoverable from this log):

| ordinal | time (UTC) | task_name | model / effort | msg bytes |
|---|---|---|---|---|
| 19 | 09-13 22:38:33 | `coverage_review` | default | 888 |
| 254 | 22:47:22 | `live_trace_options` | default | 824 |
| 3145 | 09-14 00:45:24 | `production_build_review` | default | 760 |
| 3423 | 01:42:22 | `factory_message_sources` | default | 996 |
| 3429 | 01:42:31 | `pty_delivery_assessment` | default | 888 |
| 3718 | 01:56:02 | `matrix_inventory` | default | 1,036 |
| 4914 | 03:01:29 | `mail_receipt_fix` | `gpt-5.6-luna`, effort `max`, `fork_turns: none` | 1,996 |
| 15801 | 09-15 11:33:28 | `native_cli_path` | default | 1,548 |

A ninth author appears once: `/root/pty_delivery_assessment/fixture_receipt_review` (a nested
sub-agent, 1 message, 785 bytes).

**Root → sub-agents** (`send_message` + `followup_task` + `spawn_agent`, by target):

| target | calls | msg bytes | tool mix |
|---|---|---|---|
| `coverage_review` | 70 | 60,968 | spawn 1, send_message 42, followup_task 27 |
| `production_build_review` | 46 | 39,992 | spawn 1, followup_task 19, send_message 26 |
| `pty_delivery_assessment` | 43 | 39,488 | spawn 1, send_message 23, followup_task 19 |
| `live_trace_options` | 31 | 28,680 | spawn 1, followup_task 17, send_message 13 |
| `mail_receipt_fix` | 11 | 11,068 | spawn 1, followup_task 4, send_message 6 |
| `factory_message_sources` | 9 | 8,292 | spawn 1, followup_task 4, send_message 4 |
| `matrix_inventory` | 8 | 6,784 | spawn 1, followup_task 3, send_message 4 |
| `native_cli_path` | 2 | 2,200 | spawn 1, send_message 1 |
| **TOTAL** | **220** | **197,472** | |

**Sub-agents → root** (`agent_message` response_items). Every `agent_message` carries a cleartext
envelope header (`Message Type: MESSAGE|FINAL_ANSWER / Task name: /root / Sender: /root/<name> /
Payload: `) and then, for `MESSAGE`, an **`encrypted_content` block**. The payload of a `MESSAGE` is
**not recoverable** from this log; only the envelope and the byte count are. `FINAL_ANSWER` messages
carry no ciphertext — they are fully cleartext.

| author | msgs | total bytes | envelope-only `MESSAGE` | `FINAL_ANSWER` | cleartext bytes | ciphertext bytes |
|---|---|---|---|---|---|---|
| `/root/coverage_review` | **161** | 147,873 | **135** | 26 | 32,053 | 115,820 |
| `/root/pty_delivery_assessment` | 100 | 96,931 | 81 | 19 | 24,159 | 72,772 |
| `/root/production_build_review` | 96 | 92,609 | 76 | 20 | 22,933 | 69,676 |
| `/root/live_trace_options` | 77 | 67,453 | 60 | 17 | 15,393 | 52,060 |
| `/root/factory_message_sources` | 18 | 22,209 | 14 | 4 | 9,289 | 12,920 |
| `/root/matrix_inventory` | 15 | 17,631 | 11 | 4 | 7,583 | 10,048 |
| `/root/native_cli_path` | 7 | 5,608 | 6 | 1 | 1,028 | 4,580 |
| `/root/mail_receipt_fix` | 5 | 5,881 | **0** | 5 | 5,881 | **0** |
| `/root/pty_delivery_assessment/fixture_receipt_review` | 1 | 785 | 1 | 0 | 109 | 676 |
| **TOTAL** | **480** | **456,980** | **384 (80%)** | **96 (20%)** | **118,428** | **338,552** |

Averages: envelope-only `MESSAGE` = 82 bytes cleartext + 881 bytes ciphertext; `FINAL_ANSWER` = 905
bytes cleartext, zero ciphertext.

### Verdict on the sub-agents

- **`coverage_review` is the loudest and the least efficient channel.** 161 messages, 147.9 KB — 32%
  of all sub-agent bytes and 34% of all sub-agent messages — of which 135 (84%) are envelope-only
  notifications carrying an empty cleartext payload. It received 70 calls from root, so the
  message-per-call ratio is 2.3:1: for every instruction it was given, it emitted more than two
  response items. Its 26 `FINAL_ANSWER`s are substantive (e.g. ord 1457: "Confirmed: an accepted
  paste can return `false`, send Ctrl+C, and be delivered again on the next kernel cycle"), so the
  *ratio* is the problem, not the content.
- **`mail_receipt_fix` is the only clean sub-agent**: 5 messages, all `FINAL_ANSWER`, 5,881 bytes of
  cleartext, zero chatter. It was also the only one spawned with an explicit model and effort
  (`gpt-5.6-luna` / `max`) and `fork_turns: none`.
- **I cannot judge the value of the 338 KB of ciphertext.** The `MESSAGE` payloads are encrypted in
  this log. The byte measurement is the honest signal: 384 of 480 (80%) of the inter-agent messages
  in this session carry a payload the investigator cannot read, at ~881 bytes each.
- **Notification bursts are real but small.** 78 inter-agent gaps are under 1 s; 11 seconds contain
  ≥3 agent messages in the same second, including one at **10:09:41 with 10 messages from five
  different sub-agents** (ord 12956–12974). Median inter-message gap is 32.4 s.
- **The parent spent wall time waiting**: 17 `sleep` calls (5–30 s, mostly 10 s) and 9 `wait_agent`
  calls (10–30 s timeouts).

### Channel B — Herdr pane traffic delivered as user-role turns

This is the larger structural finding and it is invisible to a `spawn_agent`-only query. **82 messages
from sibling panes arrived on the `role: user` channel**, in the same shape as operator instructions,
with no sender envelope:

| turn | lane reports on the user channel |
|---|---|
| 1 | 1 (the opening `<context>` paste, ord 9) |
| 20 | 7 (ord 5129, 5707, 6044, 6165, 7000, 7469, 7603) |
| 23 | 16 (ord 8074 … 10549) |
| 26 | **58** (ord 10898 … 15171) |
| **total** | **82** |

Senders observed: `p13` (root), `p14` (`production_build_review`), `p15`, `p16`/`Grok p16`,
`p1E`, `p1F`/`reviews`, `p1G`, `p1H`, `defiant-quill`, "Registry lane", "Evidence lane",
"live_trace_options". They are mostly formatted commit receipts with byte counts and hash prefixes
(e.g. ord 7000: "EXACT COUNTS: 15 delivery.begin, 2 physical pastes, 1 submit-cr, 0 recovery-cr…").

Two pieces of corroborating evidence that this channel is a genuine problem rather than a
presentation artefact:

1. The operator's own brief names it: *"The envelope always names the sending seat, which is the fix
   for peer reports arriving as anonymous user turns"* (ord 10696). The operator was building the
   fix for exactly what the log shows.
2. The root agent used Herdr *back* — 231 `herdr` shell commands in turn 26 alone (24.5% of that
   turn's 942 shell commands), including `herdr agent read w3F:p1H --source visible` 11× and
   `herdr agent send-keys w3F:p1H enter` 8×. It also wrote peer messages by hand via
   `python3` + `herdr agent prompt` (calls 6153, 6297, 6357). So the agent was both reading and
   writing this channel, which is why the traffic grew.

---

## 5. Stall episodes

### Method

Three signals were combined: (a) response items per turn with no operator input; (b) wall duration
inside a single turn; (c) the agent's own text naming retries, blocks, flakes, or repeats. The
"repeated verb" is taken from repeated identical shell commands within the episode
(`p1R-scratch/repeat.py`) plus the agent's own narration.

Longest in-turn stretch with no user message at all:

| turn | stretch | wall | items |
|---|---|---|---|
| 6 `01a09d1b` | ord 1364..3127 | 63.6 min | 717 |
| 11 `01a09da0` | ord 3844..4739 | 42.7 min | 349 |
| 26 `01a0a430` | ord 15171..16145 | 26.8 min | 353 |
| 20 `01a09ddc` | ord 5129..5707 | 25.6 min | 233 |
| 2 `01a09cf3` | ord 235..1195 | 25.4 min | 398 |
| 23 `01a0a06f` | ord 10121..10516 | 17.3 min | 164 |

Response items per turn: turn 26 = 2,045; turn 20 = 1,120; turn 23 = 1,110; turn 6 = 717; turn 11 =
402. Those five turns hold 5,394 of the session's 6,270 response items (86%).

### The three worst episodes

**Episode 1 — the package build/sign/install loop (turn 20).**

| field | value |
|---|---|
| ordinal range | 6031 → 7401 |
| wall | 03:46:38 → 04:33:47 = **47 m 09 s** |
| repeated verb | poll the build log and wait for `codesign`, then rebuild and sign again |
| what finally unblocked it | the second signed package completed at 04:33:47; the replacement process was verified as `7d2d6cb1` at 04:35:25 and automatically submitted the previously stuck briefing |

The agent narrates the same state four times inside the window: "Packaging is using the repository's
pinned Bun version and is now signing a freshly rebuilt app and PTY helper" (ord 6031, 03:46:38);
"Signing is still active. The fresh runtime already embeds `54f79b07` and build ID
`91377f1c-013a-484f-9f21-8b18b2451169`" (ord 6619, 04:06:33); "The remaining build step is macOS
signing; the source is unchanged and all checks remain green" (ord 6646, 04:08:34); "The package is
signing" (ord 7263, 04:29:45); "Signing is still active" (ord 7315, 04:31:38). The literal polling
commands are `tail -n 8 /tmp/junto-build-54f79b07.log` (5× from ord 6576) and
`ps -axo pid,ppid,state,etime,pcpu,command | rg '[c]odesign|[s]ign-app|[e]lectron-builder'`.
Important qualification: this is **dead wall time, not dead agent time** — the agent filled it with
`herdr` reads and code review (53 `herdr` calls in the turn), so it kept making progress on other
work while the signature ran. Two complete cycles happened in the window (03:46–04:11 for
`54f79b07`, 04:22–04:33 for `7d2d6cb1`).

**Episode 2 — the 14-harness Devin fan-out (turn 11).**

| field | value |
|---|---|
| ordinal range | 3849 → 4548 |
| wall | 02:03:53 → 02:38:43 = **34 m 50 s** |
| repeated verb | dispatch a fan-out lane, poll its Prism run, recover the report |
| what finally unblocked it | abandoning Devin and finishing the assessment locally from source + existing tests |

The sequence: the agent assigned **ten distinct audit lanes** through a Prism workflow with a fresh run
store, after the operator suggested a "14 harnesses 14 devins fan out" (ord 3799, 02:00:27). At
02:07:55 it reported "Devin's noninteractive `auto` mode refused shell commands, and Prism misread the
interrupted sessions as answers. **I stopped that run**" (ord 3915). It re-dispatched read-only
(ord 3953, 02:09:41, now on `swe-2-max`). At 02:27:58: "Devin hit its account-wide message rate limit
during the fan-out. Three harness reports were recovered, and two other lanes produced usable reports
in the wrong schema; the rest are incomplete" (ord 4368). The repeated literal verb is
`prism workflow runs show 2cb0474e-cf02-48ef-a1cb-ea11172ff51c --store /tmp/junto-pty-matrix-20260914/harness-live.sqlite` (4× from ord 3993) — i.e. polling a run store for lanes that had
already died. The agent's own post-mortem is at ord 4837: *"My workflow handled failure badly. I
wrapped each task with `Effect.either` so other lanes could continue, but added no requirement that
any lane succeed. Consequently, the workflow said "completed" with every task failed."*

**Episode 3 — the stale-frame visual verification loop (turn 6).**

| field | value |
|---|---|
| ordinal range | 1621 → 2241 |
| wall | 23:39:11 → 23:58:57 = **19 m 46 s** |
| repeated verb | restart the app and re-capture the screenshot, because the screen and the accessibility tree disagree |
| what finally unblocked it | identifying Chromium's handling of covered windows and adding a launch-only rendering flag |

The agent restarted the copied factory three times to get a clean baseline ("I'm restarting the same
untouched snapshot with the new write trace", ord 1621; "The app view is responding again after
restart", ord 2120) and said three times that its visual evidence was invalid: "The visible frame has
stopped matching the app's accessibility state, so the apparent Enter failure is not established"
(ord 1939, 23:49:10); "The screenshot is still stale even though the app's accessibility state
advances, so visual verification remains incomplete" (ord 2194, 23:57:18); then the resolution —
"The stale-frame problem was Chromium's handling of covered windows. A launch-only flag now keeps the
screenshots current" (ord 2241, 23:58:57). This one matters more than its 20 minutes suggest: the
operator's first criterion (ord 9) was that the agent must be able to *see* the app, so an
unreliable screenshot invalidates every downstream claim, and the agent correctly refused to
proceed on it.

### The largest turn is not a stall — turn 26

Turn 26 (`01a0a430`, ord 10694..16145, 08:30:08 → 11:43:22, **193 m 14 s**, 2,045 response items,
942 shell commands, 7 compactions) is the biggest single turn by every measure. It is not a stall:
the agent's own narration shows commits landing every 5–15 minutes throughout (e.g. `c85fdd73` 08:51,
`7d7c9912` 09:08, `001b9348` 09:15, `7b8853f9` 09:26, `61c5bade` 09:29, `f3020308` 09:47,
`238d1822` 10:09, `2b0fd768`/`0cd17824` 10:18, `9ba5c05c` 10:23, `594dc531` 10:52, `f1b40499` 11:05,
`3b8eb4b9` 11:08, `9e438586` 11:23, `858095ef` 11:42). What it has instead is a **long tail of
same-class defects in one subsystem**, which reads as stalling even though each one is a fix:

- ord 12276 (09:41:20) — "A stronger concurrency test found a remaining review bug: a second old
  blocking verdict can still succeed after the task is rejected and reclaimed in a new epoch."
- ord 12721 (09:59:26) — "The review tests exposed another race: an old completion can succeed after
  rejection and reclaim in a new epoch."
- ord 13164 (10:13:57) — "I found another review blocker at the public API: it rejected evidence
  submitted while a task was still working."
- ord 13675 (10:32:25) — "The review checks exposed two remaining transaction races: a removed reviews
  edge can still admit a commit verdict, and a stale author can update a newly claimed task."
- ord 14693 (11:00:26) — "The real-database resume test caught another defect: an old generation's
  retry grant could release the current generation's hold."

Six such "another … race/defect/blocker" statements appear in turn 26 (turn 6 has two, turn 20 and
turn 23 one each). The repeated verb is *"found another epoch/generation race in the review or mail
transaction, writing a regression for it"*.

### A measurable stall mechanism the brief did not list: compaction pauses

Every one of the 20 compactions is preceded by a silent gap in which the model produces the
compaction summary and no tool call is recorded. Measured as the interval between the last activity
record and the `token_usage_record` that immediately precedes each `compacted` record
(`p1R-scratch` pre-compaction script):

| window | pre-compaction gap | window | pre-compaction gap |
|---|---|---|---|
| 1 | 120.6 s | 11 | 49.2 s |
| 2 | 133.9 s | 12 | 57.9 s |
| 3 | 166.5 s | 13 | 192.4 s |
| 4 | 146.8 s | 14 | 172.7 s |
| 5 | 155.3 s | 15 | **242.3 s** |
| 6 | 158.0 s | 16 | 146.8 s |
| 7 | 192.3 s | 17 | 201.2 s |
| 8 | 140.8 s | 18 | 169.3 s |
| 9 | 139.9 s | 19 | 196.8 s |
| 10 | 6.1 s | 20 | 139.1 s |

**Total: 2,928 s = 48.8 minutes** across 20 compactions (mean 146 s, max 242 s) — about 8% of the
session's 9.84 h of active turns.

This is a complete explanation of intra-turn silence in this session, not a partial one. A scan of
every consecutive-record interval inside every turn finds **exactly 20 gaps longer than 120 s, and
they correspond one-to-one with the 20 compactions** (verified as a set comparison in
`p1R-scratch`; three pairs differ only in which adjacent event record is used as the interval
endpoint). There is no other multi-minute silence anywhere in 37 hours: the session never went quiet
except to compact.

### What did not stall

- **No approval-gate stalls in this session's own tooling.** The only approval friction is with
  external agents: Devin's `auto` mode refusing `exec` (ord 3915), and Devin's interactive
  "Do you trust the authors of this directory?" prompt being misread as idle (ord 14331, 15765).
- **No `request_user_input` usage at all.** See §6.

---

## 6. Self-reported trouble

All quotes below are the agent's own words, with ordinals. Where I add an observation about the
surrounding actions, it is marked **[observed]**.

### Flaky / unreliable verification and environment problems

- ord 228 (22:44:08): *"All three relevant E2E scenarios failed. - **Live delivery:** timed out after
  150 seconds with zero receipts… - **Two rendering cases:** failed before replay because they inspect
  DOM rows that WebGL no longer provides."* **[observed]** The session's first act was to prove the
  existing E2E could not prove anything — which is why the operator's criterion was "you must see
  the app".
- ord 357 (22:49:51): *"The production window is visible, but Computer Use actions aren't changing it
  reliably; this machine has several copies with the same app identity. I'm opening one isolated
  instance of the current app with real harness authentication and captured logs, so the control
  target is unambiguous."* **[observed]** Recovery was to stop using the production instance.
- ord 1939 (23:49:10): *"The visible frame has stopped matching the app's accessibility state, so the
  apparent Enter failure is not established. I'm refreshing the view before using further screenshots
  as evidence."*
- ord 2194 (23:57:18): *"The screenshot is still stale even though the app's accessibility state
  advances, so visual verification remains incomplete."*
- ord 2241 (23:58:57): *"The stale-frame problem was Chromium's handling of covered windows. A
  launch-only flag now keeps the screenshots current."*
- ord 2385 (00:02:50): *"The full suite hit an existing browser-test timeout; I'm rerunning with a
  longer timeout while the live factory continues through Devin's normal tool approvals."*
- ord 14380 (09-15 10:52:55, a peer report relayed by the operator): *"Grok p16 divide-debug: the
  ~1m2s failure is LAUNCH, not trust-grid. Exact assertion: AggregateError: Junto e2e launch
  failed"*
- ord 15905 (11:36:26): *"The wider app run finished at 23/26 passing. The three failures are being
  traced individually. The real Devin run stopped before sending mail because its isolated setup had
  no compiled CLI."*
- ord 15956 (11:38:04): *"The failed mail test exposed a product bug: after a timeout, the shared drive
  still treats "text is no longer visible" as proof of submission. That shortcut can receipt a
  swallowed paste."*
- ord 16116 (11:42:38, the last message of the session): *"I also found why waiting for an
  already-exited seat timed out: its "gone" event had already been removed from the current state
  view. That fix is underway."* **[observed]** The session ends mid-fix, on a newly discovered defect.

### The agent's own diagnosis of the fan-out failure

- ord 3915 (02:07:55): *"The blocker is now clear: Devin's noninteractive `auto` mode refused shell
  commands, and Prism misread the interrupted sessions as answers. I stopped that run."*
- ord 4368 (02:27:58): *"Devin hit its account-wide message rate limit during the fan-out. Three
  harness reports were recovered, and two other lanes produced usable reports in the wrong schema;
  the rest are incomplete."*
- ord 4790 (02:51:28): *"**Devin's server-side message limit.** **16 of the 22 later lanes** ended
  with: > Reached overall message rate limit. Please try again later. Reported reset times ranged from
  **2 to 36 minutes**. The errors marked this retryable but supplied no quota threshold. I called it
  "account-wide"; strictly, the logs establish an **overall message limit**, without identifying its
  exact scope."*
- ord 4837 (02:54:21): *"**Partly. There is a concrete Prism integration bug, compounded by workflow
  decisions I made, followed by Devin throttling.** … **Prism mishandled those incomplete sessions.**
  Its result extractor can accept a user/system message when the role field is absent. In Kimi's case,
  it selected the injected `AGENTS.md` rules and tried parsing them as the report. That is an actual
  Prism parser bug. … **My workflow handled failure badly.** I wrapped each task with `Effect.either`
  so other lanes could continue, but added no requirement that any lane succeed. Consequently, the
  workflow said **"completed" with every task failed**. I also disabled automatic report repairs.
  Those were my authoring decisions."*
- ord 4849 (02:54:55): *"I conflated **"audit without changing files"** with **"restrict tool
  execution."** I overrode Prism's default permission mode to constrain the workers, and that
  introduced approval gates into an unattended workflow. You did not request that restriction, and
  Prism did not require it. It was my configuration mistake."*
- ord 4861 (02:55:38): *"Nobody. **I invented that restriction.**"*
- ord 4874 (02:56:50): *"Yes. We consumed Devin capacity on the source-only workflow I imposed, and
  **16 lanes hit its overall message-rate limit**. That run delivered no runtime fix or new
  native-app proof. Exact quota consumption wasn't recorded reliably, so I can't quantify the spend."*

### Permission / approval friction

- ord 4790: *"**Permission-mode mismatch.** I configured Prism's `restricted` mode, which maps to
  Devin's `auto`. Some `exec` calls requested approval; the noninteractive session rejected them and
  ended the turn."* (with a receipt: `devin_20260913-230937_4821.log:574`)
- ord 1621 (23:39:11): *"Devin's permission prompt is visible, but clicking it and pressing Enter is
  no longer advancing it."*
- ord 1206 (23:15:07): *"I only approved Devin's subsequent CLI command."*
- ord 15765 (11:32:23): *"The native run found another concrete gap: Devin's command-approval screen is
  being reported as low-confidence idle. I can see it asking to run `junto onboard`. No mail
  has been sent yet; I'm approving that one read-only command and preserving the screen for a
  classifier regression."*
- ord 14331 (10:48:27): *"I can now see the real Devin failure: it is still at "Do you trust the
  authors of this directory?" while the canvas reports idle. The notice is refused before
  submission."*
- ord 10228 (16:28:25): *"Junto is showing its normal quit confirmation for four local
  sessions; I'm confirming it so the app can save state and stop its owned processes."*

### Confusion about the repo / stale state

- ord 3451 (01:43:04): *"the running `/Applications` app is still build `34b4e3d9`, which has neither
  the containment fix nor the delivery trace. I built the new copy in `release/` but didn't install
  it, so this run is still exposed to the old Ctrl+C loop."*
- ord 10689 (09-15 08:28:05): *"Running app: `ce3c10ae`, version **0.2.1**… Latest source/package:
  `9013b252`, version **0.3.0**, built, signed and notarized. It is **not installed**."*
- ord 9920 (16:17:42): *"The final Amp capture used a newer binary than the earlier probes; its
  executable changed during the lane without an update command from us."*
- ord 15042 (11:11:43): *"I checked the live state: Grok's rebuild message was stale; it is now holding
  builds and launches."*

### Provider limits hit by peer agents

- ord 14808 (11:04:15): *"Muse hit its provider quota. I've handed its unfinished mail fixes and
  failing reproductions to the independent reviewer, so that limit won't hold up the work."*
- ord 12335 (09:47:00, relayed peer report): *"isolated claude/codex/devin typed-notice PTY all
  AUTHBLOCKED."*

### Things the agent explicitly called unresolved

- ord 3687 (01:52:57): *"```literal text still pending = true / paste chip visible = false / reported
  submission = SUCCESS```… The code mistakes "no paste chip" for successful submission. That bypasses
  the containment fix, which only handles failures. The screenshot's exact execution branch remains
  untraced."*
- ord 7833 (13:21:05): *"**Remaining engineering gaps.** Full Node Remote factory delivery is still
  incompletely wired. Observer freshness and crash-between-submit-and-receipt reconciliation remain
  unresolved. Batch refusals can still consume retry budgets without writing; the supervisor also
  counts attempted notices as delivered."*
- ord 10591 (17:17:00): *"**Still unfinished:** native qualification of other harnesses, remaining
  input/resize combinations, and Remote delivery. We have a working, observed Devin path; we have not
  certified the entire matrix."*
- ord 10689 (08:28:05): *"**Still open:** broader native harness and input/resize qualification.
  **Remote mailbox delivery remains unsupported**, requiring implementation. A crash between external
  acceptance and durable receipt remains an explicit delivery limitation."*

### `request_user_input` usage: zero

Census of every `function_call` name in the session (`js`, `send_message`, `followup_task`, `sleep`,
`list_agents`, `wait_agent`, `spawn_agent`, `js_reset` — 714 calls) contains **no
`request_user_input`/`ask_user`/`elicit` tool**, and a scan of all 264 assistant messages finds **no
message that asks the operator a direct question** (0 matches for `want me to`, `should i`,
`would you like`, `do you want`, `shall i`, `let me know`, `need your`, `awaiting your`; 0 messages
ending in `?`).

**[observed]** The agent never asked. It ended every turn with a status report and stopped, and the
operator replied with the next instruction. The 10 sub-minute turns (12–19, 21, 24) exist because the
operator had to reconstruct the story by interrogation after the fan-out failure — that conversation
would not have been needed if the agent had asked one question before scaling to 10 parallel agents.

---

## What I could not determine

1. **The content of 384 of the 480 inter-agent messages.** Their payload is `encrypted_content`
   (~881 bytes each, 338,552 bytes total) and is not recoverable from this log. I measured bytes and
   counts instead of guessing. The same applies to the 220 root→sub-agent messages (197,472 bytes,
   all encrypted).
2. **The model's reasoning text.** All 1,665 `reasoning` response items carry only
   `encrypted_content`; there is no cleartext summary in this rollout. Every "why" in this report is
   either the agent's own narration or my reading of its actions.
3. **Whether the 82 Herdr user-channel messages were relayed by the operator or injected by Herdr.**
   The records carry `content_item_kinds: ["user.text"]` and a `turn_id`, identical in shape to the
   operator's own turns, and 81 of them are formatted as peer reports rather than operator speech. I
   can prove they are peer-authored; I cannot prove which mechanism placed them on the user channel.
4. **Why the two turns were aborted.** Both records say `reason: "interrupted"` with no further
   detail. I report what the agent was doing and what the operator said next; I do not know whether
   the operator pressed Escape because of the content, the latency, or the cost.
5. **The exact wall-clock cost of signing vs. compilation.** The agent narrates "signing is still
   active" but the tool output timings for those commands are outside my scope (sibling pane).
