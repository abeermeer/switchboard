# Brag Plan: Switchboard

## What is this app?
A local-first AI gateway: one OpenAI-compatible endpoint in front of 16 LLM providers, which
picks the cheapest healthy one per request, fails over automatically when a provider dies, and
stores the reasoning behind every decision.

## The angle
Every AI gateway claims "smart routing." None of them will tell you *why* it picked what it
picked. Switchboard stores the arithmetic — every candidate it considered, every weighted
factor, and the exact reason each loser was excluded — and renders it.

So the video is not "look at my features." It is **showing the receipts**. A provider dies
mid-request, the user never notices, and then we open the box and show precisely why the
replacement won. Every number on screen is real output from the running product.

## Hook (first 2-3 seconds)
A dark terminal. One line of JSON types out: `"model": "auto"`. Then a red `429` slams onto
Groq. Beat. The line lands: **"Your provider just went down."**

The hook works because it is the reader's actual fear, stated in two seconds, with a real
HTTP status code rather than a marketing claim.

## Key moments (the middle)
- **The failover nobody saw.** `x-switchboard-attempts: 4` and
  `x-switchboard-fallback-reason: Credential rejected (401/403)` — real response headers from a
  verified run — resolve to a green 200 from a different provider. Payoff line: *"You didn't."*
- **The decision trace.** Four ranked candidates arrive one at a time with real scores
  (`0.925`, `0.820`, `0.780`, `0.483`), each carrying its actual factor note —
  *"free tier, $0.00 projected"*, *"~2200 tok/s typical"*. This is the differentiator and gets
  the most screen time.
- **The exclusion.** One greyed row with the real reason:
  `kimi-k2-instruct → Costs $1.50/MTok, over the $0/MTok ceiling`. Showing what *lost* is more
  convincing than showing what won.
- **The bill.** `17 models eligible · $0.000000` — free-first routing, stated as a number.

## Outro / punchline
The endpoint URL and the honest claim: **"One endpoint. 16 providers. Every decision on the
record."** Then the mark and the repo.

## User flow worth showing
entry → key action → result, as a real request:
1. A client sends `model: "auto"` to `127.0.0.1:7272/v1`.
2. The first provider 429s; the router silently walks to the next candidate.
3. A 200 comes back, and the dashboard's decision trace explains the whole path.

Scenes 1–4 are that flow. This is the product working, not the product described.

## Tone
- Preset: `polished`
- Creative direction: an engineer quietly showing you the receipts
- Interpretation: confidence through restraint. Few scenes, long holds, real monospace data
  doing the talking. No exclamation marks, no swooshes, no gradient mesh. The drama comes from
  a red `429` turning into a green `200`, and from numbers that are obviously real.

## Format: landscape — 1920x1080
## Duration: 20s

## Visual identity (from the project)
- Background: `#0a0b0d` (the dashboard's dark surface)
- Surface: `#121417` · elevated `#181b1f`
- Accent: `#f0912f` (copper — the brass patch-panel metaphor the product is named for)
- Text: `#e9ebee` · muted `#9aa1ac` · faint `#6b727d`
- Success: `#3ecf8e` · Failure: `#ff6169`
- Display font: system sans (`ui-sans-serif, Segoe UI`) — matches the dashboard exactly
- Body/data font: monospace (`ui-monospace, Cascadia Mono, Consolas`) — most of the frame is
  data, so mono carries the video
- Strongest visual element: the ranked candidate list with per-factor score bars, and the
  copper accent used *only* on the winner

## Share copy (draft)
Every AI gateway says "smart routing." Mine shows its work — every candidate, every weighted
factor, and the exact reason each one lost. One endpoint, 16 providers, free tiers first.

## Audio direction
- Role: warm low bed with restrained motion-matched accents
- Music: `happy-beats-business-moves-vol-10-by-ende-dot-app.mp3` (110 BPM, clean pulse)
- Music treatment: start at 0.0s, sit low (~0.22 gain) so the data reads as the subject, brief
  duck under the `429` beat for contrast, fade out over the final 1.5s
- Music cue guidance: preset cue file read. Beat interval 0.546s.
  Target strong cues: **0.27s** (hook type-on), **3.55s** (the 429 hit), **6.28s** (the green
  200 resolve), **12.56s** (winner row locks), **18.01s** (outro mark).
  Sequential reveals use **every-other-beat (1.09s)** so each candidate row clears the 0.8s
  reading floor: rows land at 9.29 · 10.38 · 11.47 · 12.56.
- Audio-reactive treatment: subtle — the copper accent on the winning row may breathe with bass
  energy. No waveform bars, no visualiser.
- SFX posture: sparse and dry. One key-tick cluster on the typed line, one low failure thud on
  the 429, one soft confirm on the 200, one click per candidate row. Nothing else.
- Audio-coupled moments: the typed `"model": "auto"`, the 429 impact, the 200 resolve, the four
  sequential candidate rows.
- Restraint rule: no risers, no whooshes, no impact reverb tails. If a sound would feel at home
  in a crypto ad, it does not belong here.

## Storyboard

### Scene 1 — The failure — 4.0s
Dark `#0a0b0d` frame, near-empty. A monospace request block sits centred, dim:
`POST /v1/chat/completions` and beneath it `"model": "auto"` typing out character by character.
At ~3.5s a red `429 Too Many Requests` badge slams onto a `groq` row and the row desaturates.
Hook line settles bottom-left in display sans: **"Your provider just went down."** (holds 1.4s)
Sequential/interaction: yes — the `"model": "auto"` value types character by character; the 429
badge arrives as a single hard hit on the beat.
Audio intent: quiet and ordinary, then one dry low thud that makes the failure feel physical.
Audio-coupled idea: key ticks under the typing; failure thud snapped to the 3.55s strong cue.
Music: low, unobtrusive, already running.
Transition mood: hard cut → Scene 2

### Scene 2 — The recovery — 3.5s
Same frame, no camera move — the point is that nothing dramatic happened. The dead `groq` row
stays greyed; a `cerebras` row slides in beneath it and resolves to a green `200`. Two real
response headers fade in as mono text:
`x-switchboard-attempts: 4`
`x-switchboard-fallback-reason: Credential rejected (401/403)`
Payoff line replaces the hook: **"You didn't."** (holds 1.3s)
Sequential/interaction: yes — headers arrive one after the other, ~0.55s apart.
Audio intent: relief without celebration. One soft confirm, nothing triumphant.
Audio-coupled idea: confirm tone on the 200 at the 6.28s strong cue.
Music: unchanged, comes back up from the duck.
Transition mood: soft crossfade → Scene 3

### Scene 3 — The decision trace — 6.5s
The centrepiece, and the scene the whole video exists for. Header line, small and muted:
`17 eligible · 5 excluded`. Then four candidate rows arrive one by one on every other beat
(9.29 · 10.38 · 11.47 · 12.56), each holding ≥1.09s. Each row is real:

```
0.925  groq       openai/gpt-oss-20b     free      $0.000000
0.820  cerebras   llama3.1-8b            free      $0.000000
0.780  deepseek   deepseek-coder         cheap     $0.001128
0.483  google     gemini-2.5-pro         standard  $0.010249
```

The top row is copper-accented with a filled score bar; the rest are muted. Beneath the winner,
two real factor chips fade in: `tier · free tier` and `throughput · ~2200 tok/s typical`.
Scene label, top-left: **"Every candidate. Every factor."**
Sequential/interaction: yes — four rows, one per every-other-beat, then the full set holds ~1.5s
so the ranking can actually be read as a set.
Audio intent: methodical and calm — the sound of a system being deliberate.
Audio-coupled idea: one dry click per row arrival; winner row lands on the 12.56s strong cue.
Music: steady, the pulse carries the row rhythm.
Transition mood: clean wipe → Scene 4

### Scene 4 — What lost, and why — 3.0s
One greyed, struck-through row centred with its real exclusion reason in copper:
`kimi-k2-instruct-0905` → **`Costs $1.50/MTok, over the $0/MTok ceiling`** (holds 1.5s)
Beneath it, small: **"It even tells you what it rejected."**
Sequential/interaction: none — a single held statement. This scene is deliberately still.
Audio intent: a small negative-space moment. Almost nothing.
Audio-coupled idea: none — silence here is the point.
Music: continues, uninterrupted.
Transition mood: soft crossfade → Scene 5

### Scene 5 — Outro — 3.0s
The Switchboard mark (the patch-panel jack: four dots, one copper curve) draws in over
`#0a0b0d`. Wordmark **Switchboard** in display sans. Beneath it, mono and muted:
`http://127.0.0.1:7272/v1` then `github.com/abeermeer/switchboard`
Final line, held to the end: **"One endpoint. 16 providers. Every decision on the record."**
Sequential/interaction: yes — the mark's connecting curve draws left-to-right over ~0.6s.
Audio intent: settle and stop. No stinger.
Audio-coupled idea: mark completes on the 18.01s strong cue; music fades from 18.5s.
Music: fade to silence over the last 1.5s.
Transition mood: hold to black

**Total: 4.0 + 3.5 + 6.5 + 3.0 + 3.0 = 20.0s**

**Music mood for this video:** restrained, warm, low — a pulse to move against, never the subject
**Audio summary:** an ordinary hum, one dry thud when the provider dies, a soft confirm when the
system saves it, four measured clicks while it explains itself, then a clean fade.
