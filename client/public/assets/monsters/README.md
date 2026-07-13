# Voice Monsters Sprites

This directory contains the browser-public front and back art for the eight Voice Monsters. It currently has 16 animated GIFs, one complete pair per monster. See the [project README](../../../../README.md) for application setup and the [asset credits](../../../../assets/CREDITS.md) for the repository provenance ledger.

## Installation

These sprites ship with the main application and require no separate installation. Follow the [root installation guide](../../../../README.md#installation); Vite serves this directory at `/assets/monsters/`.

## Usage

Name each file with a roster ID and view:

```text
<id>_front.gif
<id>_back.gif
<id>_front.png
<id>_back.png
```

`front` is the opponent-facing view and `back` is the player's rear view. Valid IDs are `sparkmouse`, `embertail`, `shellback`, `thornling`, `galecoil`, `voltcrest`, `dazeduck`, and `psyclone`.

The battle renderer tries GIF first and PNG second for each monster and view, so GIF wins when both exist. If both requests fail, it draws the hand-authored canvas sprite from `client/battle/monster-art.ts`; an unknown roster ID degrades to a simple tinted shape. The selection and battle screens use the same candidate order. No manifest or code change is needed when replacing an existing filename.

Use transparent, roughly square artwork. The UI displays sprites with nearest-neighbor scaling. GIF transparency has hard one-bit edges; an animated PNG stored with a `.png` extension can retain full alpha in supporting browsers. Static PNGs still receive the battle renderer's attack and hit motion.

## License

The repository has no root `LICENSE` file. Inclusion here does not establish permission to reuse or redistribute a sprite. The current [asset credits](../../../../assets/CREDITS.md) do not record the source, author, or license for these GIFs. Record and verify that provenance before public redistribution or replacement with third-party art.
