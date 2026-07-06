# Music Setup Guide

This document describes the music system for Twilio Games.

## Audio Files

The following music tracks have been added to the project in `/client/public/audio/`:

### Voice Racer (in-game)
- `racer/midnight-apex.m4a` - Primary in-game track
- `racer/red-light-to-green.mp3` - Secondary in-game track

Both tracks play automatically in sequence and loop continuously.

### Voice Monsters (in-game)
- `monsters/hero-final-gambit.mp3` - Primary battle track
- `monsters/one-last-gold-coin.mp3` - Secondary battle track

Both tracks play automatically in sequence and loop continuously.

### Lobby & Home Screen
- `lobby/velvet-arrival.mp3` - Lobby background music

### Leaderboard & Winning Music
- `leaderboard/final-ascent.mp3` - Leaderboard and results screen music

## Music System Architecture

The music system is powered by the `MusicManager` class (`/client/music-manager.ts`), which provides:

### Features
- **Automatic playlist progression**: When multiple tracks exist for a context, the next track plays automatically when the current one ends
- **Continuous looping**: Playlists loop indefinitely
- **Context-aware playback**: Different music plays based on game state
- **Singleton pattern**: A global instance manages music across the entire application
- **Volume control**: Adjustable volume from 0 to 1

### Game Contexts

| Context | File | Tracks |
|---------|------|--------|
| `lobby` | home.ts, main.ts, battle/monsters.ts | Velvet Arrival |
| `racer` | main.ts | Midnight Apex, Red Light to Green |
| `monsters` | battle/monsters.ts | Hero Final Gambit, One Last Gold Coin |
| `leaderboard` | main.ts, battle/monsters.ts | Final Ascent |

### Integration Points

#### Voice Racer (play.html)
- Switches to `racer` context when the race starts (countdown → racing phase)
- Switches to `lobby` context when showing the lobby
- Switches to `leaderboard` context when showing results

#### Voice Monsters (monsters.html)
- Switches to `monsters` context during the battle phase
- Switches to `lobby` context in the lobby
- Switches to `leaderboard` context for results

#### Home Screen (index.html)
- Initializes with `lobby` context on page load

## API Usage

```typescript
import { getMusicManager } from './music-manager';

const musicManager = getMusicManager();

// Switch music context
musicManager.switchContext('lobby');  // or 'racer', 'monsters', 'leaderboard'

// Control playback
musicManager.pause();
musicManager.resume();
musicManager.stop();

// Volume control
musicManager.setVolume(0.5);  // 0 to 1
const volume = musicManager.getVolume();

// Status
const isPlaying = musicManager.getIsPlaying();
const currentContext = musicManager.getCurrentContext();
```

## Adding New Tracks

To add new music tracks:

1. **Add files**: Place `.mp3` or `.m4a` files in the appropriate subdirectory under `/client/public/audio/`

2. **Update MusicManager**: Modify the `contexts` configuration in `music-manager.ts`:
   ```typescript
   private contexts: Record<GameContext, MusicContext> = {
     // ... existing contexts
     newContext: {
       tracks: ['/audio/path/track1.mp3', '/audio/path/track2.mp3'],
       currentTrackIndex: 0,
     },
   };
   ```

3. **Add type**: If adding a new game context, update the `GameContext` type in `music-manager.ts`

## Supported Audio Formats

The system supports:
- `.mp3` (MPEG Audio)
- `.m4a` (MPEG-4 Audio)
- Any format supported by the HTML5 Audio API

## Troubleshooting

### Music not playing
- Check browser console for audio errors
- Verify audio files are in the correct `/client/public/audio/` subdirectories
- Ensure the browser hasn't blocked autoplay (some browsers require user interaction first)

### Tracks not switching
- Verify the context is being switched at the correct game state transitions
- Check that the phase/state detection logic is correct for the game flow

### Audio cutting off between tracks
- This is normal behavior in the HTML5 Audio API; there may be a brief pause between tracks

---

## Sound Effects System

The game includes a comprehensive sound effects system that plays context-appropriate audio for in-game events.

### Sound Effects

All sound effects are located in `/client/public/audio/sfx/`:

| Event | File | Trigger |
|-------|------|---------|
| **Crash** | `crash.mp3` | Car hits a barrier |
| **Power-Up** | `powerup.mp3` | Car collects a boost |
| **Turbo** | `turbo.mp3` | Car activates power/nitro dash |
| **Countdown** | `countdown.mp3` | Pre-race 3-2-1-GO countdown |

### Sound Effects Manager

The `SoundEffectsManager` class (`/client/sound-effects.ts`) handles:
- Pre-loading all sound effects for instant playback
- Debouncing rapid repeated plays (prevents sound overlap)
- Respecting the music mute state (SFX mute when music is muted)
- Volume control (0 to 1)

### Integration Points

#### Voice Racer (main.ts)
- **Crash**: Plays when `hit` event occurs
- **Power-Up**: Plays when `boost_taken` event occurs
- **Turbo**: Plays when player's `powerActive` becomes > 0
- **Countdown**: Plays when `countdown` event occurs (synced with displayed number)

### API Usage

```typescript
import { getSoundEffectsManager } from './sound-effects';

const sfx = getSoundEffectsManager();

// Play specific sounds
sfx.playCrash();
sfx.playPowerUp();
sfx.playTurbo();
sfx.playCountdown();

// Volume control
sfx.setVolume(0.8);  // 0 to 1
const volume = sfx.getVolume();
```

### Mute Behavior

- Sound effects automatically respect the music mute state
- When music is muted via the toggle button, SFX are also silenced
- Unmuting music re-enables SFX

### Adding New Sound Effects

To add new in-game sound effects:

1. **Add audio file**: Place the `.mp3` file in `/client/public/audio/sfx/`

2. **Load in SoundEffectsManager**:
   ```typescript
   private loadSound(key: string, path: string): void {
     // Already called in constructor for all effects
   }
   ```

3. **Add play method**:
   ```typescript
   playNewEffect(): void {
     this.playSound('newEffect');
   }
   ```

4. **Trigger from event handlers**: Call the method when the appropriate game event occurs

### Troubleshooting

### Sounds not playing
- Check browser console for audio loading errors
- Verify audio files are in `/client/public/audio/sfx/`
- Ensure music is not muted
- Some browsers may block autoplay without user interaction (click the page first)

### Sound cutting off or overlapping
- The debounce mechanism (100ms) prevents rapid overlaps
- Adjust `debounceMs` in `SoundEffectsManager` if needed

### Volume issues
- Ensure SFX volume is set appropriately with `setVolume()`
- Check system/browser volume levels
