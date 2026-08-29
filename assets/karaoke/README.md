# Voice Karaoke Production Assets

Voice Karaoke is fully playable with procedural fallbacks, and the five optimized GLBs below are
the progressive runtime visuals. English uses the licensed recording documented below; Brazilian
Portuguese continues to use synthesized development music.

## Release GLB Models

| File | Contents | Embedded animation | Exact Sketchfab URL | Exact author | Exact license |
|---|---|---|---|---|---|
| `assets/karaoke/stage.glb` | Stage, speakers, microphones, and the drum kit hierarchy named `batteria` | None | https://sketchfab.com/3d-models/stage-75918ce264ca4362adb3aa7d87a88f37 | [MEC CAD](https://sketchfab.com/meccad) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `assets/karaoke/lead-singer.glb` | Lead front-stage performer | `Mixamo` | https://sketchfab.com/3d-models/freddie-mercury-965ebf37fb364b73abb91f6d63e49e08 | [Gerwerni](https://sketchfab.com/gerwerni) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `assets/karaoke/backup-singer.glb` | Equal front-stage performer with microphone | `Animation` | https://sketchfab.com/3d-models/animated-model-singing-with-microphone-in-hand-dade090dddcb4d1b8614972b2133d22e | [LasquetiSpice](https://sketchfab.com/LasquetiSpice) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `assets/karaoke/drummer.glb` | Drummer only; the kit comes from `stage.glb` | `mixamo.com` | https://sketchfab.com/3d-models/playing-drums-22c1e9e36d6a4bb6b122cb95dc06d025 | [kodexar](https://sketchfab.com/kodexar) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `assets/karaoke/guitarist.glb` | Guitarist with embedded guitar | `Animation` | https://sketchfab.com/3d-models/animated-musical-trem-playing-guitar-loop-7dde986b68834de6b5a9deff6819d3f1 | [LasquetiSpice](https://sketchfab.com/LasquetiSpice) | [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) |

The source pages and GLB-embedded attribution metadata agree on each title, author, source URL, and
license. Release asset tests pin that metadata so optimization cannot silently remove or change it.

The committed release GLBs are optimized derivatives using Draco geometry and WebP textures. Legacy
specular/gloss materials are converted to the metal/rough workflow supported by the current Three.js
runtime. Raw originals remain only in gitignored `assets/karaoke/_raw/`; they are an authoring
boundary and must not be served or committed. The stage optimization deliberately preserves
`batteria` and its child meshes so the runtime can derive the drummer anchor.

The drummer release keeps the raw source's full mesh topology: optimization disables simplification,
flattening, joining, and palette conversion so layered eyes, face, beard, and hair remain intact.

`assets/karaoke/venue.json` is the immutable image seed for the venue editor. The server validates it
with the same exact-key parser used for editor writes, then seeds `data/karaoke-venue.json` only when
the live copy is missing or invalid. Runtime model URLs are generated solely from validated direct
GLB basenames. Use `/editor?game=karaoke` to edit the live copy; valid live data is never overwritten
by a redeploy seed.

The runtime normalizes visible finite bounds rather than trusting source units. Only the real stage
GLB rotates `Math.PI` around Y after normalization; the camera, procedural stage, and performers
retain the +Z audience convention. The stage targets a 14-unit width and 8.9-unit depth centered at
`(0, 0, -3)`. Performer target heights are 2.22 (lead),
2.22 (backup), 2.15 (drummer), and 2.2 (guitarist). Lead and backup placements are balanced at
`(-1.35, 0.58, -0.25)` and `(1.35, 0.58, -0.25)`. The drummer uses the transformed `batteria`
bounds center, its minimum Y, and 0.18 units behind its post-rotation minimum Z. The current release
asset resolves to approximately `(-0.048, 0.659, -4.990)`. If that lookup fails, the
documented local fallback anchor is `(0, 0.58, -2.55)`.

Each role loads independently through `/draco/` and falls back after 20 seconds without blocking
the song or another role. Performer clips loop on absolute song time; horizontal hip root motion is
pinned while vertical performance motion is retained. The real stage always suppresses the
procedural drum kit, while a failed drummer retains only the animated procedural person. Versioned
model URLs bypass stale hour-cached GLBs. Runtime diagnostics report the lead's 17 original
materials and all 25 embedded WebP textures as loaded; no blanket replacement material is applied.

The audience uses 126 deterministic low-poly human silhouettes. Separate instanced head and torso
meshes plus three instanced cheering-arm poses keep varied heights, skin tones, shirts, poses, and
stage-intensity motion to five crowd draw calls.

During a performance, a deterministic concert director cuts among editor-relative venue wides,
crowd angles, lead and backup singer closeups, guitarist features, low-stage shots, and a finale
wide. Drummer closeups are intentionally excluded. Each shot adds a small absolute-time dolly or
handheld drift, while the lyric highway renders through a separate fixed camera so its target never
moves with the background. Reduced-motion mode freezes both concert direction and performer clips.

## Song Package

For each 45-second song, provide:

- A licensed instrumental master without guide vocals or target-note tones.
- A 44.1 or 48 kHz WAV master plus a browser delivery MP3 or M4A.
- Final lyrics with explicit display, synchronization, public-performance, telephony, and distribution rights.
- Word-level start/end timestamps in milliseconds.
- One target MIDI note per word, including sustained duration.
- BPM, downbeat offset, time signature, and song locale.
- A private guide-vocal reference for chart authoring; do not ship it in the backing mix.
- Optional square cover art and a 10-second attract-mode preview.

Place browser audio at `client/public/audio/karaoke/<song-id>/backing.mp3`. Add its root-relative URL and chart to `shared/karaoke-songs.ts`. Production songs need a provenance entry in `assets/CREDITS.md` before enablement.

### Current licensed recording

`assets/karaoke/_raw/audio/classic.MP3` is the local vocal timing source for *Never Gonna Give You Up*
by Rick Astley. `assets/karaoke/_raw/audio/classic-instrumental.mp4` is the local production backing
source. Chroma/DTW alignment found a different master with the same arrangement.
`classic-instrumental-45s.mp3` uses instrumental seconds 74.199 through 119.319, tempo-corrected by
`1.002227`, and trimmed to the vocal chart's exact 45-second window. Validation leaves approximately
38 ms of offset and less than 0.005% residual tempo drift. The user confirmed all required rights.

`assets/karaoke/_raw/audio/thousand-miles.mp3` is the local full-length source for *A Thousand Miles*
by Vanessa Carlton. `thousand-miles-45s.mp3` uses source seconds 18.000 through 63.000: the first
verse pickup, pre-chorus, and complete first chorus with clean musical lead-in and tail. Synced line
boundaries were matched to this 237.494-second recording before word windows were authored. The user
confirmed all required rights. Waveform correlation against the exact-duration official vocal
reference measured the supplied instrumental 424 ms later. Forced Whisper attention alignment against
album and single vocal previews supplies individual opening and chorus word boundaries; strong
instrumental onsets anchor the intervening pre-chorus. The four-lane MIDI contour remains provisional
pending isolated-vocal pitch calibration.

### Browser A/V calibration

Open `/editor?game=karaoke&tool=timing` to author persistent per-word timing overrides for every
runtime song. The editor plays and scrubs the production audio against a zoomable four-lane timeline.
Drag a target to move its complete window, drag its left edge to change the onset, and drag its right
edge to change the stop/sustain length. Drag across empty timeline space to marquee-select a section,
or Shift-click two words to select their complete range; dragging any selected target offsets that
section while preserving its internal timing. Exact millisecond fields and 10/100 ms nudge controls
are available in the inspector. Saves write only changed word boundaries to `data/karaoke-timings.json`;
lyrics, lanes, pitch, credits, and audio metadata remain compiled and cannot be changed by this tool.
The server validates non-overlapping 100-5000 ms windows, protects concurrent saves with ETags, and
applies accepted changes to future performances without changing an active round's chart snapshot.

Run the game server and Vite client in separate terminals with `npm run dev:server` and
`npm run dev:client`. Use these exact URLs:

- Guide-vocal calibration: `http://localhost:5173/karaoke.html?guide=1&locale=en-US`, then press `P`
- Instrumental verification: `http://localhost:5173/karaoke.html?locale=en-US`, then press `P`
- Production-safety check: `http://localhost:5173/karaoke.html?guide=1&locale=en-US`
- Display-safety check: `http://localhost:5173/karaoke.html?guide=1&display=1&locale=en-US`

The Vite development server exposes local-only `assets/karaoke/_raw/audio/classic-45s.mp3` at the
guide URL; the ignored authoring directory is absent from production builds and images. Guide mode is
also restricted to loopback page origins. In guide mode, select *Never Gonna Give You Up* and enable audio. Each word tile should reach the
target on the first consonant. If the tile arrives first, choose **Lyrics later**. If the voice
arrives first, choose **Lyrics earlier**. Adjust in 20 ms steps, replay the song, and keep the
smallest repeatable correction. Positive visual delay means the lyrics move later. The rail reports
the browser's estimated device output latency separately; do not copy that number into the visual
offset automatically.

The visual offset is clamped to +/-300 ms and stored locally as
`voice-karaoke-visual-offset-ms`. Reset it from the rail before testing another output device, or run
`localStorage.removeItem('voice-karaoke-visual-offset-ms')` in that page's developer console. Confirm
the instrumental URL preserves the chosen visual alignment. Confirm the two safety URLs show no
guide label or calibration rail; `guide=1` never changes the runtime catalog, station display, or
production backing source.

For the deterministic real-browser check, run `node tools/smoke-karaoke.mjs` while both development
servers are running. It verifies the presentation clock is monotonic, requests the versioned guide
source, and confirms the compact judgment rail has reserved space outside the stage and HUD.

The word windows follow the supplied synced line boundaries. Their four-lane MIDI contour is a
conservative provisional chart only. Final target pitches must be calibrated against an isolated
guide vocal before pitch-scoring accuracy is considered production-ready.

## Acceptance

Before enabling Karaoke, test both locale phone numbers on several real handsets and carriers. Measure clock calibration, word judgments, low/high voices, speakerphone bleed, silence, dropped media, callback retries, and a display reconnect during a song. Raw Media Stream audio must remain memory-only and must not be logged or persisted.

Production lyric verification uses a direct Deepgram streaming connection and requires `DEEPGRAM_API_KEY` because Karaoke is enabled by default. The server sends only the caller's inbound 8 kHz mu-law Media Stream, never `classic-instrumental-45s.mp3`, another backing track, or outbound call audio. Recognized words are normalized and reduced to bounded chart evidence in memory; raw audio and recognized transcripts are not written to application storage or logs. Credential-free local development retains the timing/pitch fallback, but production startup and deployment fail closed without the key.

Deepgram is a third-party audio processor. The phone flow discloses this processing and requires the caller to say Start before handoff. Review the Deepgram project's region, retention, model-improvement, and data-processing settings before operation. The application's memory-only handling does not override Deepgram's service-side processing or retention policy.
