# Waste ledger — addressable waste in the root rollout

Pane `w3F:p1Q`. Question: of the root's input tokens, how much is *avoidable* and what are the causes?

**Scope note, first, because it changes every number:** the root rollout is **live and still
growing**. Round 1 read it at 16,146 lines / 1,900 responses. `SESSION2.md` read it at 1,929 responses /
284,839,426 input. While I worked it grew a further turn (`01a0a865`, task_started
2026-09-16T04:07:29Z) and was adding ~90 KB every 40 s. I froze a snapshot and every number below is
against it:

```bash
SRC=~/.codex/sessions/2026/09/13/rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl
cp "$SRC" /tmp/tt-wl/root-snapshot.jsonl
wc -l < /tmp/tt-wl/root-snapshot.jsonl ; shasum -a 256 /tmp/tt-wl/root-snapshot.jsonl | cut -c1-32
# -> 16480 lines, sha256 5c2ce267f0937da8f22cf9e63ff6c67d…
jq -r 'select(.type=="token_usage_record") | [.payload.usage.input_tokens,.payload.usage.total_tokens] | @tsv' \
  /tmp/tt-wl/root-snapshot.jsonl | awk -F'\t' '{n++;i+=$1;t+=$2} END{printf "responses=%d input=%d total=%d\n",n,i,t}'
# -> responses=1936 input=286044802 total=286762168   (21 compactions, 22 windows)
```

| | responses | input tokens | total |
|---|---|---|---|
| round 1 (16,146 lines) | 1,900 | 280,736,459 | 281,420,258 |
| `SESSION2.md` | 1,929 | 284,839,426 | — |
| **this snapshot** | **1,936** | **286,044,802** | **286,762,168** |

**All percentages below use 286,044,802.** The assignment's 284,839,426 is 0.42% lower; every share
moves by less than half a point. The drift itself is a finding: any total quoted for this session is
already stale.

---

## The answer

| | tokens | share of input |
|---|---|---|
| **Avoidable — defensible floor** | **47,870,342** | **16.7%** |
| **Avoidable — including the failed fan-out** | **~54,000,000** | **~18.9%** |
| Inherent to the session as run | ~232,000,000 | ~81% |

Verdict: **not pathological, but clearly unoptimised at the margin.** The mechanism — 1,936 responses
each re-reading a ~148K context — is inherent to a long, evidence-heavy agentic session. What is *not*
inherent is that the context was inflated by a compaction defect worth **14.2% of the session on its
own**, plus ~2.5% of round trips that returned nothing.

## Ranked ledger

Every row is a measured quantity, not an estimate, except where marked. Rows marked ⚠ overlap and
must not be summed.

| # | cause | tokens | % of input | how measured |
|---|---|---|---|---|
| 1 | **Floor growth: compaction retains user-channel content permanently** | **40,721,127** | **14.24%** | floor-excess decomposition, §1 |
| 1a | ⚠ — of which the 82 peer reports | 16,816,898 | 5.88% | retained-text allocation, §1 |
| 1b | ⚠ — of which the 4 operator screenshots | 15,944,329 | 5.57% | residual after text, §1 |
| 1c | ⚠ — of which the operator's own text | 3,656,532 | 1.28% | retained-text allocation, §1 |
| 1d | ⚠ — of which a modelling constant | 4,303,368 | 1.50% | window-2 residual, §1 |
| 2 | ⚠ **Peer-report channel, full cost** | **18,162,580** | **6.35%** | retention-aware amortization, §2 |
| 3 | **Failed fan-out episode** (ord 3849..4548, 34 m 38 s) | **12,211,212** | 4.27% | Σ input over responses in span, §5 |
| 4 | Build/sign wait (ord 6031..7401, 47 m 00 s) | 22,077,345 | 7.72% | Σ input over responses in span, §5 |
| 5 | `agent_message` amortized (480 items, 446 KB) | 5,477,803 | 1.92% | window-limited amortization, §4 |
| 6 | **exec calls that returned nothing** (51 calls) | **3,331,905** | 1.17% | Σ context of the 21 finished-empty calls, §6 |
| 7 | **Re-run waste**, amortized | **3,817,310** | 1.33% | normalized repeats × window multiplier, §7 |
| 8 | Output truncation | ≤ ~500,000 | ≤0.17% | 18 capped records; retries not measurable, §8 |
| 9 | The 348 zero-token results (93 exit-0) | covered by rows 6–7 | — | §6 |

**Avoidable floor** = row 1 + row 6 + row 7 = 40,721,127 + 3,331,905 + 3,817,310 = **47,870,342
(16.74%)**. Row 8 (≤0.5M) is excluded because its retry cost is not measurable; it is inside the
generous figure. Row 2 is row 1a restated in a different accounting frame — do not add it. Rows 3
and 4 are time slices of the same mechanism, not separate categories; I argue below that half of row 3
is avoidable and almost none of row 4 is.

---

## 1. The floor growth — 40,721,127 (14.24%)

The floor is the minimum context in a window (what compaction leaves behind). It is the mechanism
round 1 identified; I re-derived it on the snapshot and it reproduces exactly.

```bash
python3 /tmp/tt-wl/windows.py
# responses=1936  input=286044802  windows=22  compactions=21
# floor cost = 101,666,407 (35.54%)
# growth     = 184,378,395 (64.46%)
# win  1  104 resp  floor=31480  ... win 21 106 resp floor=80823 ... win 22 30 resp floor=79751
# floor at window 1 = 31480; floor cost = 101,666,407; excess over session-start floor = 40,721,127
```

Round-1 cross-check: my window 1 (104 responses, floor 31,480), window 5 (76, 36,240), window 10
(101, 50,641), window 15 (65, 57,023) and window 20 (88, 75,523) are **identical** to round 1's table.
Window 21 shows 106 responses here vs 100 in round 1 — the live session added 6 more before compaction
21 fired at ordinal 16,207. The floors match to the token.

**Retention is the cause, and I verified it independently rather than taking it from round 1:**

```bash
python3 - <<'PY'   # retained user messages per compaction, from replacement_history
# ... prints, per compaction: retained_user count
PY
# retained_user per compaction: 3, 7, 7, 7, 13, 14, 25, 27, 32, 36, 40, 49, 51, 58, 70, 82, 98, 105, 108, 115, 116
```

Monotonic, never shrinking. The final compaction (ordinal 16,207) retains 116 user-channel messages,
all distinct. Reconciling that against the 122 top-level `role: user` rows: 115 of the 116 map to a
top-level row and one is a row the compaction synthesised; the 7 top-level rows absent from the
retained set are 4 injected-context rows (ord 5, 4894, 10598, 16150) and the 3 operator messages that
arrived after that compaction (16238, 16323, 16414). **No peer report is ever dropped: all 82 are
retained at the final compaction.**

Floor growth tracks retained text: `floor_w − 31,480` rises from 3,789 (window 2) to 49,343
(window 21) while retained text chars/4 rises from 1,440 to 34,117 — the gap is the four screenshots'
image tokens, which the transcript does not record.

### Allocation of the 40.72M by retained content

```bash
python3 /tmp/tt-wl/floor_alloc.py
#         peer:   16,816,898  (5.88% of input)
#     operator:    3,656,532  (1.28%)
#     residual:   20,247,697  (7.08%)
#        TOTAL:   40,721,127  (14.24%)
# peer share of the floor excess = 41.3%
```

The residual splits into the screenshots and a constant. Using window 2's residual (2,349 tokens, when
no screenshot was retained) as the constant:

```
screenshots = 20,247,697 − 2,349 × 1,832 responses = 15,944,329   (5.57%)
constant    = 2,349 × 1,832                        =  4,303,368   (1.50%)
```

Per-screenshot token cost works out at ~3,200–4,000 tokens each (the residual per response grows from
2,349 with zero images to 15,226 with four). **The four screenshots cost about the same as all 82 peer
reports combined** — 15.9M vs 16.8M. Round 1 flagged the screenshots as unremovable context but could
not measure them; this is that measurement, and it rests on the constant-residual assumption above.

---

## 2. The peer-report channel, measured

### Classification

The 122 `role: user` rows split 4 injected / 36 operator / 82 peer. I classified them with a
task_started-boundary rule (the first non-injected user message after a `task_started` is the
operator's; anything else mid-turn is peer traffic) plus an explicit, listed adjudication of the
mid-turn cases:

```bash
python3 /tmp/tt-wl/peer_channel.py
# role:user rows: 122 {'injected': 4, 'peer': 82, 'operator': 36}
# ordinals <=16145 (round-1 range): Counter({'peer': 82, 'operator': 32, 'injected': 3})
# PEER MESSAGES: 82   text chars total: 121706   image chars total: 565658
# per-turn distribution (peer):
#     1 msgs     5574 chars  turn 01a09ceb   (turn 1)
#     7 msgs     8587 chars  turn 01a09ddc   (turn 20)
#    16 msgs    18445 chars  turn 01a0a06f   (turn 23)
#    58 msgs    89100 chars  turn 01a0a430   (turn 26)
```

The 10 operator overrides (3642, 3844, 5000, 6103, 6333, 6582, 10889, 16238, 16323, 16414) and the one
peer override (ord 9) are listed with their reasons in `peer_channel.py`. **Validation:** restricted to
the round-1 range this classifier reproduces the narrative agent's independently-derived counts
exactly — 32 operator, 82 peer, and the same per-turn split 1 / 7 / 16 / 58.

### Size

| | value |
|---|---|
| messages | 82 |
| text chars | 121,706 |
| ≈ tokens (chars/4) | **30,426** single-pass |
| image chars | 565,658 (one message, ord 14812) |
| largest message | ord 11085, 5,615 chars (reviews lane p1F) |
| 2nd | ord 9, 5,574 chars (prior agent's report, the session premise) |
| 3rd | ord 14812, 5,148 chars + a screenshot (Grok p16) |

Senders:

| sender | msgs | chars | ≈ tokens |
|---|---|---|---|
| p15 | 20 | 26,122 | 6,530 |
| Grok p16 | 13 | 20,951 | 5,238 |
| crew lane (CRW-xxx) | 13 | 24,164 | 6,041 |
| unlabelled | 11 | 20,571 | 5,143 |
| defiant-quill (Devin) | 8 | 7,623 | 1,906 |
| reviews lane (p1F) | 8 | 10,384 | 2,596 |
| other pane (p13–p1H) | 3 | 3,941 | 985 |
| named lane / Ack / p16 / p1H | 6 | 7,950 | 1,988 |

### Amortized cost

Two models, because the retention finding makes them diverge:

```bash
python3 /tmp/tt-wl/amortize.py
# peer text tokens (chars/4): 30,426
# amortized (a) retention-aware : 18,162,580  (6.35% of input)
# amortized (b) window-limited  :  1,345,683  (0.47% of input)
```

- **(a) retention-aware** — every response after arrival, to the end of the session. Correct here,
  because compaction retains user messages permanently: 18,162,580 (6.35%).
- **(b) window-limited** — round 1's growth method, which stops at the next compaction: 1,345,683
  (0.47%). Understates by 13.5× **because of the retention defect**.

The difference between (a) and (b) — 16.82M — is exactly the peer channel's share of the floor excess
in §1. That is the cleanest statement of the defect: **had peer reports arrived on a channel compaction
can drop, they would have cost 1.35M instead of 18.16M.**

Top offenders under model (a):

| ordinal | ≈ tokens | × responses | cost | message |
|---|---|---|---|---|
| 9 | 1,394 | 1,936 | 2,697,816 | prior agent's `<context>` report (the premise) |
| 11085 | 1,404 | 565 | 793,119 | reviews lane (p1F) seam + first-board blocking finding |
| 5129 | 492 | 1,290 | 634,035 | Devin/defiant-quill scope report |
| 10955 | 991 | 578 | 572,798 | CRW-009 contract-vs-tree findings |
| 10898 | 896 | 584 | 523,410 | CRW-007 harness seam |
| 7000 | 488 | 1,067 | 520,162 | trace read, exact counts |

### Duplication with Codex sub-agent reports

```bash
python3 /tmp/tt-wl/dup.py
# distinct 8-hex ids in peer reports : 114
# distinct 8-hex ids in sub-agent msgs: 68
# ids present in BOTH                : 7 (6% of peer ids)
# peer messages sharing an id with a sub-agent report: 10 (9007 chars = 2,252 tok single-pass)
```

**Genuine fact duplication with Codex sub-agent reports is low — about 6%**, and only 10 of the 82
messages repeat an identifier a Codex sub-agent had already reported. The two channels were doing
different work: the Codex sub-agents reviewed coverage/PTY delivery, the Herdr lanes were the operator's
own crew (p15 mail, Grok p16 composer adapters, reviews p1F, defiant-quill trace).

**I cannot establish duplication properly, and I will not guess.** 384 of the 480 `agent_message`
payloads are `encrypted_content` (338,552 of 456,980 bytes, 74% by bytes / 80% by count). My test can
only see the 96 cleartext messages. If the encrypted 80% restates what the peer reports said, true
duplication could be up to ~5× the 6% I measured. **The duplication question is not answerable from
this log.**

---

## 3. `agent_message` items — 5,477,803 (1.92%)

```bash
python3 /tmp/tt-wl/ledger.py
# 1. agent_message  n=480  bytes=456980  single_pass_tokens=114,245
#    amortized (window-limited): 5,477,803  (1.915%)
```

480 items, 456,980 bytes, 114,245 tokens single-pass. Unlike user messages, `agent_message` items are
**not** retained by compaction (they do not appear in `replacement_history`), so the window-limited
model is the right one: **5,477,803 (1.92%)**.

Round 1 found 135 of `coverage_review`'s 161 messages were envelope-only notifications with empty
payloads. Those cost bytes in the transcript but almost no tokens — 82 bytes cleartext each. The
5.48M is driven by the cleartext `FINAL_ANSWER` messages, not by the chatter.

---

## 4. Failed fan-out episode — 12,211,212 (4.27%)

```bash
python3 - <<'PY'
# Σ input_tokens for responses with ordinal in [3849, 4548]
PY
# fan-out      ord 3849..4548: responses=  84 tokens=  12,211,212  02:03:59Z -> 02:38:37Z
```

84 responses over 34 m 38 s, 12,211,212 tokens (4.27%). This is the Prism/Devin 14-harness fan-out
launched with an invented permission mode (`restricted` → Devin `auto`), which refused shell commands;
Prism then read interrupted sessions as answers and reported the workflow "completed" with every task
failed. The operator spent the next seven turns on it.

**How much is avoidable is a judgment, not a measurement.** The span includes the diagnosis that
produced the finding, and the agent would have spent *some* responses on that work regardless. I would
put half of it — ~6.1M — in the avoidable column, and say so plainly rather than claim the whole
12.2M.

---

## 5. Build/sign wait — 22,077,345 (7.72%)

```bash
# build/sign   ord 6031..7401: responses= 170 tokens=  22,077,345  03:46:41Z -> 04:33:41Z
```

170 responses over 47 m 00 s, 22,077,345 tokens. The round-1 forensics found the mechanism:
`bash scripts/build-app.sh --target mac --sign` was started **4 times** and polled **23 times** over
257 s, and every poll returned zero tokens because the script redirects to a log.

**Almost none of this is avoidable in the way the peer channel is.** Verifying a signed, packaged
Electron app requires building and signing it; the operator explicitly demanded native proof and said
"these lost QA cycles… it is UNBEARABLE". The genuinely wasteful part is the *duplicate* builds (4
signed builds where 2 fixes were verified) and the silent-polling pattern, which I put at roughly a
quarter of the span — **~5M** — with low confidence. I do not count it in the defensible floor.

---

## 6. Calls that returned nothing — 3,331,905 (1.17%)

```bash
# exec calls whose every result was empty: 51  (pure finished-empty: 21, contains a background start: 30)
# response-context cost of the pure finished-empty calls: 3,331,905 (1.165%)
# of those, every result exited 0: 15  cost=2,400,775
```

51 `exec` calls returned no output at all. 30 of them started a background process (legitimate — the
process was still running). **21 finished and returned nothing**; 15 of those had every command exit 0.
Each such call is one model response whose entire purpose was to read a ~150K context and learn nothing:
**3,331,905 (1.17%)**.

The assignment cites 348 zero-token results (14.9%), 93 exit-0. The object-level count is 348; the
per-row view I can attribute is 215, and 93 exit-0 empties — **the 93 matches exactly**, which
cross-validates both counts. Most of the 348 sit inside otherwise-productive batched calls and cost no
extra response; only the 21 whole-call-empty ones cost a response.

---

## 7. Re-run waste — 3,817,310 (1.33%)

```bash
python3 - <<'PY'
# normalized-identical command groups: instances after the first × window multiplier
PY
# re-run waste: single-pass=64,127  amortized(window-limited)=3,817,310 (1.3345%)
```

Confirmed negligible, as round 1 expected: 64,127 single-pass tokens (0.02% of input), 3.82M once
amortized (1.33%). The 101 groups are dominated by `git status --short` ×44 and `herdr agent read`
polls. This is the smallest line in the ledger and it should not be optimised first.

---

## 8. Output truncation — ≤ ~500,000 (≤0.17%)

18 `exec` records hit the harness's ~40,150-byte output cap, dropping 258,809 declared tokens of
command results. **Correction to round 1:** my earlier file says the harness "cuts the script's JSON
mid-string". It does not. I re-measured:

```bash
# 18 capped records, ~40,150 bytes each, delivering 49 COMPLETE chunk objects
# ord  25: 40,024 bytes, 2 complete chunks, 1 result dropped
# ord 4554: 39,992 bytes, 4 complete chunks, 0 dropped
# total complete chunks delivered=49  results dropped=12
```

The blobs end cleanly at chunk boundaries (`"}}`). The harness drops **trailing results**, it does not
corrupt JSON. Of the 55 commands involved, ≥12 results were dropped entirely.

Token waste is small and mostly unmeasurable: the delivered payload (~180,675 tokens single-pass) was
legitimate content, and only the dropped results forced re-runs. Round 1 confirmed 2 clean
re-runs-after-truncation out of 18. I put this line at **≤0.5M** and flag it as a *retry driver*, not a
token sink. What it really costs is correctness risk: the model saw a truncation notice with no exit
code and could not tell success from failure.

---

## 9. Cross-check: the 113.5M inherited-context tax

**The arithmetic is confirmed. The label is not.**

```bash
python3 /tmp/tt-wl/inherit_tax.py
# rollouts scanned: 27   descendants of 01a09ce9-…: 15
# /root/coverage_review                737 resp  first_ctx  31600  input 100,908,894  tax  23,289,200
# /root/production_build_review        506 resp  first_ctx  36546  input  67,341,737  tax  18,492,276
# /root/pty_delivery_assessment        429 resp  first_ctx  39853  input  60,124,323  tax  17,096,937
# ... (all 15 rows reproduce SESSION2.md's table exactly)
# TOTAL                                3127              input 417,424,677  tax 113,465,903
# coordinator's figure: 113,500,000
# this cross-check    : 113,465,903   delta = -34,097 (-0.03%)
```

I read the 15 descendant rollouts independently and reproduced every lane's response count, first
context and input total from `SESSION2.md` exactly. `Σ first_ctx × responses = 113,465,903`, against the
coordinator's 113,500,000 — **a rounding difference of 34,097 tokens, −0.03%. The arithmetic is right.**

I also tested the method, not just the sum. A tighter bound, `Σ min(first_ctx, ctx_i)` — which would
capture any lane whose compaction dropped its inherited prefix — gives 113,462,005, i.e. 99.997% of the
upper bound. No lane ever compacts below its initial context.

**But `first_ctx × responses` is not an "inherited-context tax".** The initial context of a sub-agent is
mostly the same fixed startup every Codex agent pays — `skills_instructions`, the AGENTS.md injection,
`world_state`, `multi_agent_role` — not the parent's history. The measured evidence:

- `coverage_review`, spawned 6 s into the session, has a first context of 31,600 tokens. The root's own
  floor at that moment was 31,480. Its initial context contains exactly one inherited item: the
  5,574-char `<context>` paste (1,394 tokens). So ~30,200 tokens of its 31,600 is fresh startup.
- `native_cli_path`, spawned on day 3, has a first context of 81,078. The root's floor then was 80,823
  with ~49,343 tokens of retained user content. So its inherited part is ~50,000 and its fresh startup
  the same ~30,000.
- The child's first context is consistently *smaller* than the parent's live context at spawn
  (e.g. `claim_identity_review`: parent 209,293, child 41,610). The fork copies the parent's
  **compacted** history, not its live context.

Using a fresh-startup baseline of 30,206 (measured from the lane that inherited least) gives an
inherited tax of **19,011,373**; using the root's own session-start floor of 31,480 gives **15,028,943**.

> **Cross-check verdict: the 113.5M arithmetic is confirmed to within 0.03%, but it measures "each
> lane's initial context re-read", of which the genuinely inherited parent history is only
> ~15–19M (13–17%). The other ~94–98M is each sub-agent's own fixed startup context, which the root
> also pays and which is not a fleet tax. The label overstates the inherited share by roughly 5–7×.**

One consequence worth carrying into the lane audit: because the inherited prefix *is* the parent's
retained floor, the peer-report/screenshot defect compounds into the fleet. Of the ~15–19M inherited
tax, roughly 80% traces to the same retained content that drives §1. (Inference, not measurement.)

**Also: the fleet has grown.** My scan finds **20** descendants now, not 15 — `landing_deploy`,
`platform_test_skips` and three unnamed lanes appeared during this investigation, from the live turn.
`Σ first_ctx × responses` over the current 20 lanes is 116,770,691.

---

## 10. Verdict: the split, and the assumption that drives it

| | tokens | share |
|---|---|---|
| **Avoidable — defensible floor** (rows 1, 6, 7, 8) | **47,870,342** | **16.7%** |
| + half the failed fan-out (row 3) | +6,105,606 | +2.1% |
| + duplicate builds / silent polling (part of row 5) | +~5,000,000 | +1.7% |
| **Avoidable — generous** | **~59,000,000** | **~20.6%** |
| **Inherent** | **~227,000,000** | **~79%** |

What is inherent: 1,936 responses, 1,857 tool calls, a context that averaged 148K, 332 `sed -n` reads
and 280 `rg` calls — an evidence-heavy verification workload in which the operator explicitly required
native, byte-level proof before accepting any claim. At the session's measured 28.5M input tokens per
active hour, a 37-hour effort of this shape lands near 280M on its own.

What is not inherent:
1. **Compaction retaining every user-channel message** — 40.7M (14.2%), of which the peer reports are
   16.8M and four screenshots 15.9M. Both are config-level fixes, and both were named by the operator
   himself in the crew brief.
2. **Round trips that returned nothing** — 3.3M (1.2%) from 21 calls that finished empty, plus 3.8M
   (1.3%) of re-runs.
3. **One failed fan-out** — ~6M (2.1%) avoidable of a 12.2M span.

**The assumption that most affects the split is the evidence standard.** If "native proof for every
claim" was a requirement — and the operator stated it as one, twice, in escalating terms — then the
read/verify loop is the work and ~79% is inherent. If a cheaper standard had been acceptable (run the
e2e suite, trust it), the response count could plausibly have halved, and roughly 140M would move to
the avoidable column. Nothing in the log settles which standard was necessary; that is an operator
judgment, and it dominates every other number here.

The second-most-affecting assumption is the retention attribution itself. It rests on a verified
mechanism (retention is monotonic and never drops a user message; floor tracks retained text at
r = 0.971) but on an inferred apportionment — the peer/screenshot/operator split is by retained text
tokens, with the screenshots recovered as a residual. If the residual constant is mis-estimated, rows
1b and 1d trade against each other; row 1's total does not move.

**Cost caveat.** 97.2% of the input was cache-served, so a token ledger overstates the bill. At the
~10× cache discount round 1 assumed, the 40.7M floor excess costs ~4.1M input-equivalents against a
~35M input-equivalent total — about 12% of the bill rather than 14%. The ranking does not change.

---

## What I could not determine

1. **Duplication of peer content with Codex sub-agent reports.** 384 of 480 `agent_message` payloads are
   encrypted (74% of bytes). My identifier-overlap test sees only the cleartext 96 and returns 6%;
   the true figure could be up to ~5× higher. Not answerable from this log.
2. **The screenshots' true token cost.** Recovered as a residual (15.9M), not measured — the transcript
   records image bytes, not image tokens. The estimate depends on the window-2 residual constant.
3. **Whether the fan-out and build episodes were avoidable in principle.** I report span totals, which
   are measured, and split them by judgment, which is not.
4. **Whether all 18 truncated records were compensated.** Round 1 confirmed 2 clean re-runs; the other
   16 may have been recovered by narrower re-reads I did not trace.
5. **A stable denominator.** The rollout is live; it grew 1.2M input tokens during this analysis. All
   shares here are against the frozen snapshot, and they will drift down as the session continues.
