# Monster sprites

Drop real creature art here to replace the procedural placeholders. **No code change needed** — the
battle renderer auto-discovers these files at runtime.

## Files

Two views per monster: `front` (the enemy, facing you) and `back` (your monster, from behind).

```
<id>_front.gif   or   <id>_front.png
<id>_back.gif    or   <id>_back.png
```

The renderer tries **`.gif` first, then `.png`** for each — so an **animated GIF wins** when both
exist. If neither is present, that monster keeps its generated placeholder. You can add files one at
a time.

## The 8 monster ids

`sparkmouse` · `embertail` · `shellback` · `thornling` · `galecoil` · `voltcrest` · `dazeduck` · `psyclone`

So a full set is 16 files, e.g. `embertail_front.gif`, `embertail_back.png`, …

## Art tips

- **Transparent background** — the spinning 3D arena shows through behind the creature.
- **Roughly square**, ideally pixel-art; the canvas scales with nearest-neighbor (`image-rendering: pixelated`), so crisp pixels stay crisp.
- ~96px+ is plenty; it's drawn small (Game Boy resolution) and integer-scaled.
- **GIF transparency is 1-bit** (hard edges only). If you need soft/anti-aliased edges *and* animation, use an **APNG** saved with a `.png` extension — it animates in modern browsers and keeps full alpha.
- The engine already adds motion to static art (a lunge on attack, a flash on hit), so a still PNG isn't lifeless.
