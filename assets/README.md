# Assets

Runtime assets are organized by game and role. Do not place GLBs directly in `assets/`.

- `racer/cars/` — selectable Racer vehicles
- `racer/track/` — barriers, boost items, and start/finish gantries
- `maps/` — Racer environments
- `arena/` — Voice Monsters arena
- `fighters/source/` — Fighter character/animation FBXs
- `fighters/maps/` — Fighter environment GLBs
- `fixtures/` — generated test-only GLBs

## How to download from Sketchfab
On any free model page → **Download 3D Model** → choose the **glTF (.glb)** /
"Autoconverted format (glb)" option. One `.glb` file = mesh + textures + animations.

## What to grab
- **Cars** — a dozen or so (these become the player + AI racers)
- **Props** — buildings, trees, signs, etc. (roadside dressing later)
- Optionally distinct models for **barriers** (obstacles to dodge) and **boost pads**

## What happens next
Claude runs `npm run inspect-assets` to scan Racer asset directories — auto-detecting each
model's size and whether it has separate wheel parts — and generates
`assets/manifest.json`. You then arrange/tune them in the `/editor`.

Nothing here is required for the game to run: any role without a model falls
back to the built-in primitive shapes, so you can add models one at a time.

## Licenses
Most free Sketchfab models are CC-BY (free **with attribution**). As models are
added, their author + license get recorded in `assets/CREDITS.md`.
