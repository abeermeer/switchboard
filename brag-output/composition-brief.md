# Hyperframes Composition Brief: Switchboard

## Objective
Create a short launch-style brag video for **Switchboard**, a local-first AI gateway.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20s

## Source Material
- Project root: `C:\Users\brosp\Downloads\omnirouter`
- Primary files read: `src/app/globals.css` (token layer), `src/components/shell/Sidebar.tsx`
  (the mark), `src/lib/router/score.ts` (factor names and notes), `README.md`, plus real
  captured output from a verified run of the gateway.
- Product name: **Switchboard**
- Tagline / strongest claim: *One endpoint. 16 providers. Every decision on the record.*
- Key UI to recreate: the **decision trace** — a ranked candidate list where each row is
  `score · provider · model · tier · projected cost`, the winner accented in copper with a
  filled score bar, and per-factor chips beneath it.

### Copy that must appear verbatim
Every string below is real output from the running product. Do not paraphrase, round, or
"improve" any number — their credibility is the entire point of the video.

```
"model": "auto"
429 Too Many Requests
200 OK
x-switchboard-attempts: 4
x-switchboard-fallback-reason: Credential rejected (401/403)
17 eligible · 5 excluded
0.925  groq       openai/gpt-oss-20b     free      $0.000000
0.820  cerebras   llama3.1-8b            free      $0.000000
0.780  deepseek   deepseek-coder         cheap     $0.001128
0.483  google     gemini-2.5-pro         standard  $0.010249
tier · free tier
throughput · ~2200 tok/s typical
kimi-k2-instruct-0905
Costs $1.50/MTok, over the $0/MTok ceiling
http://127.0.0.1:7272/v1
github.com/abeermeer/switchboard
```

Headline lines (display sans, these are written for the video):
```
Your provider just went down.
You didn't.
Every candidate. Every factor.
It even tells you what it rejected.
One endpoint. 16 providers. Every decision on the record.
```

## Creative Direction
- Tone preset: `polished`
- Creative direction: an engineer quietly showing you the receipts
- Interpretation: confidence through restraint. Five scenes, long holds, real monospace data
  carrying most of the frame. The drama is a red `429` becoming a green `200` — nothing needs
  to be added on top of it. No exclamation marks, no swooshes, no gradient mesh, no confetti.
- Angle: every AI gateway claims "smart routing," and none will tell you *why* it chose what it
  chose. Switchboard stores the arithmetic — every candidate, every weighted factor, and the
  exact reason each loser was excluded — and renders it. The video shows the receipts: a
  provider dies, the user never notices, then the box is opened to show precisely why the
  replacement won.
- Hook: a dim terminal, `"model": "auto"` typing out, then a red `429` slamming onto the `groq`
  row and the line **"Your provider just went down."**
- Outro / punchline: **"One endpoint. 16 providers. Every decision on the record."** with the
  mark and the repo URL.
- Avoid:
  - Generic SaaS language ("streamline", "supercharge", "seamless")
  - Abstract filler visuals — no particle fields, no floating orbs, no world maps
  - Any redesign of the product's visual identity; match the dashboard exactly
  - Fabricating or prettifying numbers

## Visual Identity
Taken directly from `src/app/globals.css` (dark theme tokens).

- Background: `#0a0b0d`
- Surface: `#121417` · elevated: `#181b1f` · border: `#24282e`
- Text: `#e9ebee` · muted: `#9aa1ac` · faint: `#6b727d`
- Accent (copper): `#f0912f` · soft: `#2a1c0d` · border: `#4d3418`
- Success: `#3ecf8e` · Failure: `#ff6169` · Warning: `#f0b429`
- Display font: `ui-sans-serif, -apple-system, "Segoe UI", system-ui` (matches the dashboard)
- Body/data font: `ui-monospace, "Cascadia Mono", Consolas, monospace` — most of the frame is
  data, so mono carries the video
- Visual references from the project:
  - The **mark**: a rounded square in `--accent-soft` with an `--accent-border` stroke, four
    dots (two solid copper, two at 0.35 opacity), and a copper curve connecting the top-left
    dot to the bottom-right — a patch-panel jack. Source: `src/components/shell/Sidebar.tsx`.
  - **Copper is used sparingly** — the winning row, the score bar, one exclusion reason. It is
    an accent, never decoration. Everything else is neutral.
  - Numeric columns are tabular-aligned and right-set, as in the dashboard's tables.

## Storyboard
Use the storyboard in `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. **The failure** — 4.0s — `"model": "auto"` types out; a red `429` hits the `groq` row;
   "Your provider just went down." must be readable.
2. **The recovery** — 3.5s — a `cerebras` row resolves green `200`; the two real
   `x-switchboard-*` headers appear; "You didn't." must be readable.
3. **The decision trace** — 6.5s — the centrepiece. `17 eligible · 5 excluded`, then four
   candidate rows arriving one at a time, winner copper with a filled score bar, two factor
   chips beneath. The full set must hold long enough to read as a ranking.
4. **What lost** — 3.0s — one struck-through row with its real exclusion reason.
5. **Outro** — 3.0s — the mark draws in, wordmark, endpoint, repo, final claim.

## Audio
- Audio role: warm low bed with restrained motion-matched accents
- Audio arc: an ordinary hum → one dry thud when the provider dies → a soft confirm when the
  system recovers → four measured clicks while it explains itself → a clean fade
- Music: `happy-beats-business-moves-vol-10-by-ende-dot-app.mp3` (110 BPM)
- Music treatment: start at 0.0s, sit low (~0.22 gain) so the data reads as the subject, brief
  duck under the `429`, fade out over the final 1.5s
- Music cue guidance: bundled preset read from
  `~/.claude/skills/brag/assets/music/cues/happy-beats-business-moves-vol-10-by-ende-dot-app.music-cues.json`
  Tempo 109.96 BPM, beat interval 0.546s.
  - Strong cues to consider locking (use 3, not all): **3.55s** (429 impact), **6.28s** (200
    resolve), **12.56s** (winner row locks), **18.01s** (mark completes).
  - Beat grid for the four sequential candidate rows: **9.29 · 10.38 · 11.47 · 12.56** —
    every *other* beat (1.09s apart) so each row clears the 0.8s reading floor. Do not put
    these on consecutive beats; 0.546s outruns reading.
- Audio-reactive treatment: **subtle** — the copper accent on the winning row and the mark's
  glow may breathe with bass/RMS energy. No waveform bars, no equalizer, no particles.
- Audio-coupled moments:
  - Scene 1 — typed `"model": "auto"` — key ticks under the typing
  - Scene 1 — the `429` — one dry low failure thud, beat-locked
  - Scene 2 — the `200` — one soft confirm, beat-locked
  - Scene 3 — four candidate rows — one dry click per row on the beat grid
  - Scene 5 — the mark completing — no stinger; let the music fade carry it
- SFX selection guidance: sparse and dry. Match the motion that actually exists after the
  animation is built. Prefer short, low high-frequency-risk files — this is a restrained,
  professional edit and a bright sound would break it. Nothing with a reverb tail. If a sound
  would feel at home in a crypto ad, it does not belong here.
- SFX analysis guidance: use `~/.claude/skills/brag/assets/sfx/sfx-analysis.md` if present;
  prefer low high-frequency-risk entries for the four repeated row clicks.
- Exact SFX choice: Hyperframes chooses filenames, timestamps, density and volume based on the
  implemented animation.
- Audio files: copy the chosen music and any selected SFX into
  `brag-output/composition/assets/`.

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition
contract + `data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design
spec, beats, audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and
`hyperframes-cli` (lint/check/render). /brag is its own workflow: do not enter the
`hyperframes` entry-point intent interview and do not route into its generic promo /
launch-video workflow. Prefer native Hyperframes conventions over anything in `/brag`.

Requirements:
- Show at least one real UI element from the source project — the decision trace in Scene 3 is
  that element, and it is non-negotiable.
- Keep all text readable in the final render. Scene 3 carries four data rows plus a header and
  two chips in 6.5s; if that cannot be made readable, cut a chip rather than speeding it up.
- Keep the video within 15-25 seconds (target 20s).
- Include the planned music/SFX layer.
- Treat `/brag` audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual
  animation exists.
- Treat music cue metadata as optional timing hints. Lock 3 strong cues, not more. Ignore any
  cue that hurts readability or the product story.
- Sequential candidate rows snap to the every-other-beat grid above (±0.10s), marked
  `// beat-grid`. Major moments land within ±0.15s of a strong cue, marked `// beat-locked`.
- Wire at least one visual element to the audio data (winner-row accent or mark glow). If
  extraction is unavailable, document it and skip — do not block the render.
- Use local assets for audio and any runtime dependencies.
- Run `npx hyperframes check` before render — it is brag's single gate.
