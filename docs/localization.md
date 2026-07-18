# Localization

Twilio Games supports US English (`en-US`) and Brazilian Portuguese (`pt-BR`) across the home page,
the three playable game displays, deterministic voice commands, Conversation Relay transcription,
and spoken responses.

## How Locale Is Selected

The browser resolves its display locale in this order:

1. The `locale` URL parameter, such as `?locale=pt-BR`.
2. The saved `twilio-games-locale` browser preference.
3. The closest supported browser language.
4. US English.

The language picker appears only on the home page. It saves the choice and reloads the home page with
the locale in the URL; launched game links retain it. A game display also sends its locale when it
joins the room WebSocket.

An incoming phone call uses the selected game's active display locale. If no localized display is
connected, the server uses `DEFAULT_LOCALE`, which defaults to `en-US`. Each call receives matching
Conversation Relay `transcriptionLanguage`, `ttsLanguage`, command hints, and `commandLocale`. Spoken
text frames include the same language code.

Choose the display language on the home page before launching a game or accepting calls.

## Locale Architecture

| Concern | Source |
|---|---|
| Supported locales and Twilio language profiles | `shared/i18n/locales.ts` |
| Translation, formatting, and Unicode command normalization | `shared/i18n/translate.ts` |
| Shared navigation and music labels | `shared/i18n/common.ts` |
| Home catalog | `shared/i18n/home.ts` |
| Voice Racer catalog | `shared/i18n/racer.ts` |
| Voice Monsters catalog | `shared/i18n/monsters.ts` |
| Voice Fighter catalog | `shared/i18n/fighter.ts` |
| Browser locale persistence and picker | `client/i18n.ts` |
| Conversation Relay language attributes | `server/twiml.ts` |
| Display-to-call locale routing | `server/http-server.ts` |

Game commands remain locale-neutral internally. For example, both `left` and `esquerda` become
`MOVE_LEFT`; both `punch` and `soco` become the Fighter command `punch`. This keeps room state,
analytics, protocols, and replays independent of translated labels.

Content IDs also remain stable. Arena, fighter, monster, move, car, and track names are translated
for display and speech without changing IDs or persisted English keys such as `cyberpunk-city` and
`Silver Lake`. Voice matching accepts both English and localized aliases, plus selection numbers.

## Adding A Language

1. Add its BCP 47 code and Twilio STT/TTS languages to `shared/i18n/locales.ts`.
2. Add a complete catalog entry to every file under `shared/i18n/`.
3. Add command aliases, cardinal words, and ordinal words to `server/voice-intent.ts`,
   `shared/battle-intent.ts`, and `shared/fighter-intent.ts`.
4. Add menu navigation, name-introduction, help, and selection phrases to the three voice sessions.
5. Add localized STT hints in `HttpServer.voiceHints()`.
6. Add content aliases for proper names that callers may translate.
7. Add table-driven command tests, catalog tests, and a real Conversation Relay call test.
8. Test long labels, screen-reader text, browser speech synthesis, noisy phone audio, and every
   supported STT model with native speakers.

Use Unicode normalization rather than ASCII-only regular expressions. Keep translated display names
out of persisted IDs and protocol actions.

## Configuration

| Variable | Behavior |
|---|---|
| `DEFAULT_LOCALE` | Locale used without an active localized display; defaults to `en-US` |
| `CR_TTS_VOICE` | Default ElevenLabs voice ID |
| `CR_TTS_VOICE_PT_BR` | Optional Brazilian Portuguese voice ID; empty uses Relay's `pt-BR` default |

The Azure deployment reads all three values from GitHub repository variables. Validate provider
language/model availability before enabling a new locale in production.
