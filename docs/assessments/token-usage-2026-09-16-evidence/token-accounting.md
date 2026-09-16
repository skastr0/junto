# Token accounting — where the 281M tokens went

Coordinator slice (`w3F:p1P`). All numbers reproducible from
`/tmp/tt-invest/index/usage.tsv`, `tokens.tsv`, `turns.tsv`, `compactions.tsv` and the raw rollout.
Source: `/Users/guilhermecastro/.codex/sessions/2026/09/13/rollout-2026-09-13T19-36-10-01a09ce9-ea56-7123-8596-5aa8368e82db.jsonl`

## Headline

**281,420,258 tokens burned in 9.84 h of active work (28.5M input tokens per active hour).**
The burn is not a runaway loop in the ordinary sense — it is 1900 model responses each re-reading a
~148K-token context. The amplification factor is the story:

| measure | value |
|---|---|
| total tokens | 281,420,258 |
| input tokens | 280,736,459 |
| output tokens | 683,799 |
| reasoning output tokens | 202,318 (29.6% of output) |
| cached input tokens | 272,969,472 (97.23% of input) |
| **uncached (genuinely new) input** | **7,766,987** |
| model responses | 1900 |
| average context per response | 147,756 tokens |
| **amplification: input ÷ new input** | **36.1×** |

Every token of genuinely new content was re-read an average of **35 more times**. That is the whole
mechanism.

## Receipts

Global totals:

```
$ awk -F'\t' 'NR>1{i+=$5;c+=$6;o+=$8;r+=$9;t+=$10;n++} END{...}' index/usage.tsv
responses=1900  input=280736459  cached=272969472  output=683799  reasoning=202318
total=281420258  cache_hit=97.23%  uncached_input=7766987
```

Independent check against the session's own counter — exact match:

```
$ tail -1 index/usage.tsv   -> thread_total=281420258
$ awk -F'\t' 'NR>1{s+=$10} END{print s}' index/usage.tsv   -> 281420258
```

A second, independently-maintained counter (`event_msg/token_count`, last event at
2026-09-15T11:43:22Z) reports `total_tokens=276,706,947`, `input=276,142,090`,
`cached=269,463,424`, `output=564,857`, `reasoning=202,318`. The two counters agree within 1.7%
on input. The 281M figure is the one that matches the thread ledger, so it is the one quoted above.

## The floor is 35% of the burn, and it grew 2.6× over the session

Decomposing each window (the span between two compactions) into a fixed floor — the smallest
context seen in that window, i.e. the system prompt + AGENTS.md + whatever the compaction retained
— and the conversation growth above it:

```
fixed floor x responses      98,788,939   35.2%
growth above floor x resp   181,946,580   64.8%
```

The floor per window climbed monotonically:

| window | responses | floor (tokens) | floor cost |
|---|---|---|---|
| 1 | 104 | 31,480 | 3,273,920 |
| 5 | 76 | 36,240 | 2,754,240 |
| 10 | 101 | 50,641 | 5,114,741 |
| 15 | 65 | 57,023 | 3,706,495 |
| 20 | 88 | 75,523 | 6,646,024 |
| 21 | 100 | **80,823** | **8,082,300** |

By the end, every one of the 100 responses in the final window carried an **80,823-token floor that
compaction could not remove** — 2.6× the 31,480-token floor the session started with. The
compaction residue itself became a significant, permanent tax.

## Why the floor grew: compaction retains every user message verbatim

This is the root cause of the 35.2% floor, and it is a real defect rather than an inherent cost.

`compacted.payload.replacement_history` is what survives a compaction. Comparing its retained user
messages against the whole transcript:

```
$ jq -r 'select(.ordinal==15232) | .payload.replacement_history[] | select(.type=="message" and .role=="user") | .id' ... | sort > retained20
$ jq -r 'select(.type=="response_item" and .payload.type=="message" and .payload.role=="user") | .payload.id' ... | sort > alluser
$ wc -l retained20 alluser     ->  115 / 117
```

**115 of the 117 user messages in the session are retained verbatim at the final compaction.** The
retained set never shrinks, so it only accumulates. Retained text volume:

| compaction | retained text chars | post-compaction floor (tokens) |
|---|---|---|
| 2 | 77,730 | 35,269 |
| 5 | 78,194 | 36,240 |
| 10 | 91,711 | 50,641 |
| 15 | 122,753 | 57,023 |
| 18 | 180,981 | 73,249 |
| 20 | 208,268 | 75,523 |
| 21 | 208,268 | 80,823 |

Retained text grew **2.68×**, the floor grew **2.29×**, and the two track each other at
**Pearson r = 0.971** across all 20 windows. A simple model, `floor ≈ 31,480 + retained_text_chars/4`,
predicts the floor within ~6,900 tokens on average.

**Cost of the growth:** the floor cost 98,788,939 tokens across 1900 responses. Had the floor stayed
at its session-start value of 31,480, it would have cost 59,812,000. The excess —
**38,976,939 tokens, 13.88% of the entire session's input** — was spent purely on the growth of the
compaction-retained floor.

### Four operator screenshots are unremovable context

Four of the retained messages are images, and they dominate the retained bytes:

| message id | image | serialized chars |
|---|---|---|
| `msg_01a09d93-ebd9-7030-9e8f-8ee11e9aac4a` | CleanShot 2026-09-13 at 22.40.23@2x.png | 1,481,300 |
| `msg_01a09d9b-74bf-79b2-bffb-64c6b5656ea4` | CleanShot 2026-09-13 at 22.48.41@2x.png | 1,034,933 |
| `msg_01a09e10-5c8f-7de3-9528-b60770fb2a64` | CleanShot 2026-09-14 at 00.56.53@2x.png | 571,315 |
| `msg_01a0a4bd-5f8c-7220-8b66-92b8fc7fe274` | /tmp/isolated-devin-seat.png | 554,725 |

These are `content_types: ["input_text","input_image","input_text","input_text"]` — 3.64 MB of
base64 across four screenshots, **93.9% of all bytes retained at the final compaction**. They entered
the retained set between compaction 4 and compaction 5 (they were not present in compaction 4's
retained history) and were never dropped. Because compaction keeps every user message, an operator
screenshot is permanent context for the rest of the session.

Their token cost is charged as image tokens, which this transcript does not record, so the count is
not measurable from the data — but at any plausible per-image cost they are re-sent on every one of
the ~1400 responses after compaction 5.

### The fixed part of the floor

Each of the 21 full `world_state` records re-injects a ~65 KB block:

| key | chars (first) | chars (last) |
|---|---|---|
| `agents_md` | 39,918 | 39,918 |
| `host_skills` | 22,371 | 22,367 |
| `permissions` | 1,577 | 1,577 |
| other (17 keys) | ~1,180 | ~1,517 |
| **total** | **65,047** | **65,379** |

One lands at session start and one after each of the 20 compactions, so the AGENTS.md and skills
instructions are re-injected 21 times. Together with the 21,261-char `base_instructions` system
prompt, that is the ~31,480-token fixed floor the session starts at.

## Compaction lost effectiveness steadily

`compactions.tsv` + the response immediately before and after each compaction:

| compaction | context before | context after | saved |
|---|---|---|---|
| 1 | 244,241 | 35,269 | 85.6% |
| 5 | 229,224 | 42,985 | 81.2% |
| 10 | 228,511 | 48,852 | 78.6% |
| 15 | 227,095 | 65,733 | 71.1% |
| 20 | 215,695 | **80,823** | **62.5%** |

Compaction was triggered at a consistent ~215–244K (the window is 258,400), but each cycle reset to
a higher floor. The recovery ratio decayed from 85.6% to 62.5%. Twenty compactions, each one
strictly less effective than the last.

## Cost is not where the raw count is

Raw token count is dominated by cheap cache reads. The expensive components are small in count:

- uncached input 7,766,987 (2.8% of input tokens)
- output 683,799 (0.24% of total)

If cache reads bill at roughly a tenth of fresh input — **assumption, not verified from a price
sheet** — then uncached input would be ~22% of input-side cost while being 2.8% of input tokens.
Practical consequence: optimising the *number of responses* and the *floor* attacks the bill, not
the raw 281M number.

## Cache misses track idle gaps, not context size

Cache hit rate bucketed by the gap since the previous response:

| gap | responses | avg context | hit rate | uncached |
|---|---|---|---|---|
| <5 s | 51 | 120,678 | 97.9% | 127,490 |
| 5–30 s | 1589 | 145,215 | 97.9% | 4,947,711 |
| 30–120 s | 223 | 165,703 | 97.0% | 1,124,260 |
| **2–10 min** | **31** | 203,082 | **82.2%** | **1,118,355** |
| 10–60 min | 3 | 76,842 | 49.6% | 116,222 |
| **>1 h** | **3** | 118,705 | **6.5%** | **332,949** |

Only 37 responses (1.9%) followed a gap longer than 2 minutes, yet they account for **1,567,526
uncached tokens — 20.2% of all uncached input**. The steady-state cost is the 5–30 s bucket:
4,947,711 uncached over 1589 responses ≈ 3,114 new tokens per response, which is simply the tool
output appended since the last response.

The three worst single cache misses, each the first response after a long idle, paid full price on a
large context:

| ordinal | timestamp | context | uncached | hit |
|---|---|---|---|---|
| 7793 | 2026-09-14T13:19:56Z | 228,511 | 215,711 | 5.6% |
| 7746 | 2026-09-14T13:12:47Z | 210,167 | 203,383 | 3.2% |
| 5900 | 2026-09-14T03:41:40Z | 197,600 | 197,600 | 0.0% |

Ordinals 7746 and 7793 sit at the 8.42 h idle gap (04:47 → 13:12) and at compaction 10. Turn
`01a0a00c` (13:12:17, two responses) burned 421,419 input of which 204,587 was uncached — a 48.6%
miss rate, the worst turn in the session by a wide margin.

## Four turns are 79.5% of the burn

| # | turn | responses | input | uncached | output | reasoning | avg ctx | active |
|---|---|---|---|---|---|---|---|---|
| 26 | `01a0a430-11df-79c2-ad41-75946d9871a2` | 571 | 89,543,069 | 1,986,205 | 253,049 | 56,207 | 156,817 | 3.22 h |
| 20 | `01a09ddc-2f0a-78b0-a621-2cfeb1a203a1` | 344 | 50,671,292 | 1,589,308 | 118,961 | 38,584 | 147,300 | 1.78 h |
| 23 | `01a0a06f-82c0-7f81-bac8-bc3f4855c087` | 340 | 48,562,650 | 1,225,306 | 114,659 | 42,920 | 142,831 | 1.73 h |
| 6 | `01a09d1b-0098-74a0-a4bb-fdc1cae61c13` | 234 | 34,263,609 | 1,087,033 | 63,427 | 24,713 | 146,425 | 1.06 h |
| | **subtotal** | **1489** | **223,040,620** | | | | | **7.79 h** |

223,040,620 / 280,736,459 = **79.5% of all input tokens** came from these four turns. Turn 26 alone
is 31.9% of the session. All four ran at a sustained 27.8–32.3M input tokens per active hour, so the
burn rate was essentially constant — the variance is entirely in how long each turn ran.

## Closing the loop with tool-call forensics: what tool output really cost

The tool-forensics agent measured that all 2,329 shell commands produced under 2M original tokens and
delivered ~1,507,000 tokens to the model — **0.54% of the session's input tokens** — and correctly
left the amortized question open. Here is the answer, using two measured quantities plus one
composition ratio.

The floor decomposition already measured the accumulated-context cost exactly:

```
fixed floor x responses      98,788,939   35.2%   (measured)
growth above floor          181,946,580   64.8%   (measured)
```

"Growth above floor" is by definition the amortized cost of everything appended during a window:
each appended token is re-read once per remaining response in its window. So the amortized cost of
all appended content is **181,946,580 tokens**, and attributing it by the byte composition of
appended items:

| component | share of appended item bytes | amortized cost | share of session input |
|---|---|---|---|
| tool output (`custom_tool_call_output` + `function_call_output`) | 64.3% | ~117.0M | **~41.7%** |
| encrypted reasoning | 24.2% | ~44.0M | ~15.7% |
| tool call inputs | 8.3% | ~15.1M | ~5.4% |
| messages (operator + peer) | 2.5% | ~4.5M | ~1.6% |
| agent messages | 0.8% | ~1.5M | ~0.5% |

So the honest resolution of the two findings: tool output is 0.54% of the input tokens *when sent
once*, but roughly **42% of the session's input tokens when its re-read cost is included**. It is
both a rounding error and the single largest line item — because the amplification applies to it.
Tool output being cheap to produce says nothing about what it costs to keep in context.

**Method caveat.** This is a composition-based attribution: the 181.9M growth total is measured, the
64.3% split is a byte share (bytes are a proxy for tokens, and items can be truncated before
entering context). I also tried a per-response amortization model that treats uncached input as
"content appended at this response"; it over-predicts the session total by 37.8%, so it is not
reliable and I am not using it. Treat the ~42% as an estimate within a few points, not a
measurement.

**Index defect found by the forensics agent.** My `build_index.py` only kept result objects with a
*top-level* `exit_code`, but the session wraps most results as
`{"i":0,"status":"fulfilled","value":{...exit_code...}}`. `outputs.tsv` therefore covers ~70% of
command results (1,493 of ~2,125). The forensics agent re-derived a complete join under `/tmp/tt-fw/`
and its numbers supersede mine for anything command-level. My token accounting does not depend on
`outputs.tsv`, so it is unaffected.

## The burn is a function of tool calls, almost exactly

The tightest relationship in the data: tool calls per turn vs input tokens per turn.

```
turn                                    resp  calls     in_tokens  tok/call resp/call
01a09cf3-b0ad-7f00-959e-8ffc10c8c962     145    143    23,627,720   165,228      1.01
01a09d1b-0098-74a0-a4bb-fdc1cae61c13     234    230    34,263,609   148,972      1.02
01a09ddc-2f0a-78b0-a621-2cfeb1a203a1     344    340    50,671,292   149,033      1.01
01a0a06f-82c0-7f81-bac8-bc3f4855c087     340    336    48,562,650   144,531      1.01
01a0a430-11df-79c2-ad41-75946d9871a2     571    564    89,543,069   158,764      1.01
total                                 1,900  1,857   280,736,459   151,177      1.01
```

**Pearson r(tool calls in turn, input tokens in turn) = 0.9985** across the 17 turns that made calls,
and `responses ÷ tool calls` is 1.01 — the session is a strict one-model-response-per-tool-call loop.

That gives the whole model in one line:

> 1,857 tool calls × 151,177 average input tokens per call = 280.7M input tokens.

Every tool call re-reads the entire context. The token burn is therefore `tool_calls × context_size`,
and both factors are large here: 1,857 calls, and a context that averaged 151K because compaction
only ever reset it to a floor that grew from 31K to 81K.

## The counterfactual is linear

Because burn ≈ Σ (responses × average context), input tokens scale linearly with the context
ceiling that compaction enforces:

| average context | input tokens | vs actual |
|---|---|---|
| 147,756 (actual) | 280,736,459 | — |
| 110,817 | 210,552,344 | −70,184,114 |
| 73,878 | 140,368,229 | −140,368,229 |
| 36,939 | 70,184,114 | −210,552,344 |

Two levers, each linear and each multiplicative with the other: **fewer responses** (i.e. fewer,
batched tool calls) and **a lower context ceiling** (i.e. compact earlier, and keep the retained
floor from growing).

## What actually entered the context

`response_item` byte volume, which is the material the context is built from:

| kind | count | bytes | share |
|---|---|---|---|
| `custom_tool_call_output` | 1143 | 7,379,052 | 47.1% |
| `reasoning` (encrypted) | 1665 | 3,783,556 | 24.2% |
| `function_call_output` | 714 | 2,687,534 | 17.2% |
| `custom_tool_call` | 1143 | 997,885 | 6.4% |
| `message` | 411 | 390,156 | 2.5% |
| `function_call` | 714 | 300,035 | 1.9% |
| `agent_message` | 480 | 118,428 | 0.8% |
| **total** | | **15,656,646** | |

Tool output is 64.3% of everything that enters the context. Encrypted reasoning is a surprising
24.2% — it is carried in the transcript and re-sent, even though its cleartext is not stored. The
byte→token conversion is a proxy (roughly 4 bytes/token, and base64 inflates the reasoning blobs),
so treat the shares as directional; the measured uncached-input figure of 7,766,987 tokens is the
authoritative count of new material.

## Summary of the mechanism

1. The session ran 26 turns over 37 h wall (9.84 h active) and made ~1857 tool calls.
2. Each tool call costs one full context re-read. 1900 responses × ~148K average context = 280.7M.
3. The context sat near the 258K ceiling before every one of 20 compactions, and compaction reset to
   a floor that grew from 31K to 81K, so the tax on every subsequent response grew with it.
4. 35.2% of all input tokens are the floor re-read 1900 times; 64.8% is conversation growth.
5. 97.23% of input was served from cache, so the raw number overstates the bill — but a 36×
   amplification factor on new content is real, and the four mega-turns set the burn rate.
