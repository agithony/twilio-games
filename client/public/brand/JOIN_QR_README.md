# Join QR Assets

This directory contains three browser-public QR PNGs. Runtime-generated QR codes handle normal joins; the PNGs provide a standalone fallback and deployment-specific station artwork. See the [project README](../../../README.md) for application setup and the [asset credits](../../../assets/CREDITS.md) for the repository provenance ledger.

## Inventory

| File | Dimensions | Runtime role |
|---|---:|---|
| `join-qr.png` | 600 by 600 | Fallback when a standalone game cannot generate a QR for its locale-specific voice number |
| `arcade-en.png` | 600 by 600 | English station join QR for the production `ARCADE-01` deployment |
| `arcade-pt.png` | 1200 by 1200 | Brazilian Portuguese station join QR for the production `ARCADE-01` deployment |

## Installation

These assets ship with the main application and require no separate installation. Follow the [root installation guide](../../../README.md#installation). Vite copies the files into the build and serves them from `/brand/`.

## Usage

### Standalone Joins

Voice Racer, Voice Monsters, and Voice Fighter watch the configured number for the display locale. When a number is available, each game generates a 520-pixel QR data URL for `tel:<number>` with medium error correction. The browser updates that QR when the runtime configuration changes.

`/brand/join-qr.png?v=2` is only the fallback. A standalone lobby uses it when its locale has no configured number or when `QRCode.toDataURL()` fails. Replacing the PNG changes that fallback image; it does not replace the normal generated QR or update the written phone number.

The dialed locale-specific number determines the call locale when it maps uniquely to `en-US` or `pt-BR`. Standalone call routing then uses the most recently opened `display=1` game connection and the standalone room fallback. Standalone display registration does not validate the station display token. This open-display recency rule does not route station-managed calls.

### Station Joins

Generated station QR codes encode an HTTP join URL, not a `tel:` URL:

```text
/join?station=<station-id>&locale=<locale>
```

The home and player views generate this QR at 520 pixels. The in-game station rail generates the same station-and-locale URL at 420 pixels. All views use the configured public visitor origin when available, and station-client tests cover asset selection plus generated-URL fallback.

For station `ARCADE-01` on the configured production origin, `stationQrAsset()` selects `arcade-en.png` or `arcade-pt.png` before generating a QR. Those committed PNGs encode `https://twil.io/arcade-en?qr=1` and `https://twil.io/arcade-pt?qr=1`; the short links redirect to the locale-specific `/join` URLs. `resolveStationQrImage()` probes the selected image and generates the direct station join URL if the image cannot load. Other station IDs and origins always use a generated QR. There is no general image-element error-handler contract beyond this explicit resolution step.

Scanning a station QR starts the `/join` registration, wallet, and queue flow. When the caller reaches an active match, the server routes the call from its persisted station assignment to the selected game and that match's dynamically generated engine room. The launched display receives the same assigned room. Replacing a PNG cannot override those assignments or bind callers to a fixed room.

### Updating The Files

Keep every replacement square and test it from the deployed public origin on a physical phone. Update `join-qr.png` only as a safe fallback for the current standalone voice entry point. Update `arcade-en.png` and `arcade-pt.png` together with their `twil.io` redirect destinations and the final production `/join` URLs and locale parameters.

The standalone fallback references include `?v=2`. Increment that query in `client/screens.ts`, `client/battle/monsters.ts`, and `client/fighter/fighter.ts` only when an intermediary continues to serve an obsolete fallback image.

## License

The repository has no root `LICENSE` file. A generated QR may encode operational phone or routing information and should be reviewed before distribution. The current [asset credits](../../../assets/CREDITS.md) do not record provenance for these images. Twilio names and logos in the same directory remain subject to Twilio brand permissions; repository inclusion does not grant trademark or reuse rights.
