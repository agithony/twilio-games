# Lobby Join QR Code

`client/public/brand/join-qr.png` is the browser-public QR image used by the main lobby, Voice Monsters lobby, and Voice Fighter lobby. See the [project README](../../../README.md) for application setup and the [asset credits](../../../assets/CREDITS.md) for the repository provenance ledger.

## Installation

This image ships with the main application and requires no separate installation. Follow the [root installation guide](../../../README.md#installation); Vite copies `client/public/` into the build and serves the image as `/brand/join-qr.png`.

## Usage

Replace the PNG in place to change the destination without changing application code:

```bash
cp /path/to/join-qr.png client/public/brand/join-qr.png
```

Keep the image square and verify it on the actual display and a physical phone. The current file is 600 by 600 pixels; the main lobby displays it in a 240 by 240 pixel card. The application requests `/brand/join-qr.png?v=2`, so update the query version in code if an intermediary cache continues to serve an old image.

The QR should encode the intended call entry point, such as a `tel:` URL for the configured game number. The current `/voice/incoming` flow joins room `4821` immediately for all three games; it does not collect a room code through DTMF. Open the intended shared display before scanning so the call routes to the correct game.

The main and Voice Monsters lobby images hide themselves when loading fails, leaving the written steps visible. The Voice Fighter lobby does not install that image-error fallback, so a missing or invalid file produces a broken image there. The runtime references a PNG specifically; using SVG requires changing the three image references in `client/screens.ts`, `client/battle/monsters.ts`, and `client/fighter/fighter.ts`.

## License

The repository has no root `LICENSE` file. A generated QR may encode operational phone or routing information and should be reviewed before distribution. The current [asset credits](../../../assets/CREDITS.md) do not record provenance for this image. Twilio names and logos in the same directory are brand assets and remain subject to Twilio brand permissions; repository inclusion does not grant trademark or reuse rights.
