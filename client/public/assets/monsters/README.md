# Voice Monsters Sprites

This directory contains the browser-public front and back art for the eight Voice Monsters defined by `shared/monster-roster.ts`. It currently has 16 animated GIFs, one complete pair per monster. See the [project README](../../../../README.md) for application setup and the [asset credits](../../../../assets/CREDITS.md) for the repository provenance ledger.

## Installation

These sprites ship with the main application and require no separate installation. Follow the [root installation guide](../../../../README.md#installation); Vite serves this directory at `/assets/monsters/`.

## Usage

Name each file with a stable roster ID and view:

```text
<id>_front.gif
<id>_back.gif
<id>_front.png
<id>_back.png
```

`front` is the opponent-facing view and `back` is the player's rear view. Valid IDs are `sparkmouse`, `embertail`, `shellback`, `thornling`, `galecoil`, `voltcrest`, `dazeduck`, and `psyclone`. The current inventory is GIF-only: each ID has one front and one back GIF, with no PNG files. Filenames use these IDs rather than localized display names.

The battle renderer paints the hand-authored canvas sprite from `client/battle/monster-art.ts` immediately, then tries GIF first and PNG second for each monster and view. The first asset that loads replaces the placeholder, so GIF wins when both exist and the canvas remains when both fail. Monster-selection portraits use the same candidate order for their front view. An unknown roster ID with a valid type degrades to a simple tinted shape. The roster and candidate order are covered by the roster and sprite-source tests. No manifest or code change is needed when replacing an existing filename.

Sprite names do not define spoken game commands. During monster selection, callers choose by localized monster name or number. During battle, `attack`, `guard`, `item`, and `taunt` drive the root menu; after `attack`, a move is selected by its roster-defined name or a number from `1` through `4`. Those names, aliases, and actions come from shared roster, localization, and intent code, so replacing an image cannot change them.

Use transparent, roughly square artwork. The UI renders sprites with nearest-neighbor scaling. GIF transparency has hard one-bit edges; an animated PNG stored with a `.png` extension can retain full alpha in supporting browsers. Static PNGs still receive the battle renderer's attack and hit motion.

## License

The repository has no root `LICENSE` file. Inclusion here does not establish permission to reuse or redistribute a sprite. The current [asset credits](../../../../assets/CREDITS.md) do not record the source, author, or license for these GIFs. Record and verify that provenance before public redistribution or replacement with third-party art.
