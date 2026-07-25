# Localization

Twilio Games supports US English (`en-US`) and Brazilian Portuguese (`pt-BR`) across the home page, all three game displays, deterministic voice commands, Conversation Relay transcription, and spoken responses.

## Display Locale

The browser resolves its display locale in this order:

1. The `locale` URL parameter, such as `?locale=pt-BR`.
2. The saved `twilio-games-locale` browser preference.
3. The closest supported browser language.
4. US English.

The language picker appears on the home page. It saves the choice, reloads the home page with the locale parameter, and preserves that locale in launched game links. Each game display also sends its locale when it joins a room WebSocket. Station join URLs include both `station` and `locale` parameters.

## Call Locale And Routing

The server chooses a call's locale in this order:

1. The locale mapped uniquely to the Twilio `To` number that the caller dialed.
2. The preferred locale of the routed game's display in the routed room, then another localized connection in that room.
3. `DEFAULT_LOCALE`, which defaults to `en-US`.

The dialed locale-specific number takes precedence over a display locale. `ArcadeApi.voiceLocaleForNumber()` returns a locale only when exactly one configured locale uses the normalized E.164 number. A shared legacy fallback number therefore does not identify a locale by itself.

Routing and locale selection remain separate decisions. In station mode, the persisted caller assignment selects the game and its dynamically generated engine room; display recency does not participate. In standalone mode, the most recently opened `display=1` connection selects the game, and the normal standalone room fallback selects the room. Standalone display registration does not validate the station display token. After that route exists, the server applies the locale precedence above.

The selected locale drives the Conversation Relay `transcriptionLanguage`, `ttsLanguage`, hints, `locale`, and `commandLocale` values. Server text frames carry the same language code. `CR_TTS_VOICE_PT_BR` can select a Portuguese ElevenLabs voice; when it is empty, Relay uses its `pt-BR` default.

## Source Map

| Concern | Source |
|---|---|
| Supported locales, fallback resolution, and Twilio language profiles | `shared/i18n/locales.ts` |
| Translation, formatting, and Unicode command normalization | `shared/i18n/translate.ts` |
| Shared navigation and music labels | `shared/i18n/common.ts` |
| Home, Racer, Monsters, and Fighter catalogs | `shared/i18n/home.ts`, `shared/i18n/racer.ts`, `shared/i18n/monsters.ts`, `shared/i18n/fighter.ts` |
| Browser locale persistence and picker | `client/i18n.ts` |
| Locale-specific lobby number and QR updates | `client/station-client.ts` and the three game entry points |
| Dialed-number, station, standalone-display, room, and locale routing | `server/http-server.ts` and `server/arcade-api.ts` |
| Conversation Relay language attributes and custom parameters | `server/twiml.ts` |

## Command And Number Parsers

Commands remain locale-neutral after parsing. For example, `left` and `esquerda` both become `MOVE_LEFT`, while `punch` and `soco` both become the Fighter command `punch`. Room state, analytics, protocols, and replays therefore do not depend on translated labels.

| Game concern | Parser source |
|---|---|
| Racer gameplay command tokens | `server/voice-intent.ts` |
| Racer cardinal, ordinal, digit, and fuzzy car/map selection | `server/game-host.ts` |
| Racer flow words, late gameplay prompts, and Relay hints | `server/http-server.ts` |
| Monsters root actions, move numbers, and move-name matching shared by browser and server | `shared/battle-intent.ts` |
| Monsters flow words, monster selection numbers/names, and caller-name parsing | `server/battle-voice.ts` |
| Fighter combat commands, repeated counts, and command chains | `shared/fighter-intent.ts` |
| Fighter roster/map selection numbers, ordinals, names, and aliases | `server/fighter-voice.ts` |

Content IDs also remain stable. Arena, fighter, monster, move, car, and track names are translated for display and speech without changing IDs or persisted English keys such as `cyberpunk-city` and `Silver Lake`. Voice selection accepts supported localized aliases, canonical names, and selection numbers according to the parser responsible for that game phase.

## Adding A Language

1. Add its BCP 47 code and Twilio STT/TTS profile to `shared/i18n/locales.ts`.
2. Add a complete catalog entry to every file under `shared/i18n/`.
3. Extend each applicable parser listed above with commands, cardinals, ordinals, flow words, names, and aliases.
4. Add localized menu navigation, introductions, help, and selection responses to the Racer, Monsters, and Fighter voice sessions.
5. Add STT hints and number words in `HttpServer.voiceHints()` and `selectionNumberHints()`.
6. Configure and validate a distinct locale voice number when the dialed number must select the locale.
7. Add table-driven parser and catalog tests plus a real Conversation Relay call test.
8. Test long labels, screen-reader text, browser speech synthesis, noisy phone audio, and every supported STT model with native speakers.

Use Unicode normalization rather than ASCII-only regular expressions. Keep translated display names out of persisted IDs and protocol actions.

## Configuration

| Setting | Behavior |
|---|---|
| Runtime `channels.voiceNumbers.en-US` and `.pt-BR` | Locale-specific public voice numbers used by lobbies and dialed-number locale detection |
| `GAME_PHONE_NUMBER` | Legacy fallback only when neither runtime locale number is configured; a shared fallback cannot identify one locale uniquely |
| `DEFAULT_LOCALE` | Call fallback when neither the dialed number nor the routed display identifies a locale; defaults to `en-US` |
| `CR_TTS_VOICE` | English ElevenLabs voice ID; empty uses the Relay default |
| `CR_TTS_VOICE_PT_BR` | Brazilian Portuguese ElevenLabs voice ID; empty uses Relay's `pt-BR` default |

The Azure deployment reads the environment values from GitHub repository variables. Operators manage `channels.voiceNumbers` in runtime Arcade settings. Validate provider language, model, voice, and number availability before enabling a new locale in production.
