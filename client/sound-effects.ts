/**
 * Sound Effects Manager: Handles in-game sound effects
 * Features:
 * - Plays sound effects with optional volume control
 * - Prevents sound overlaps (e.g., multiple crash sounds at once)
 * - Respects mute state from music manager
 */

import { getMusicManager } from './music-manager';

export class SoundEffectsManager {
  private sounds: Map<string, HTMLAudioElement> = new Map();
  private lastPlayTime: Map<string, number> = new Map();
  private debounceMs = 100; // Minimum time between same sound plays
  private volume = 1.0;

  constructor() {
    // Pre-load all sound effects
    this.loadSound('crash', '/audio/sfx/crash.mp3');
    this.loadSound('powerup', '/audio/sfx/powerup.mp3');
    this.loadSound('turbo', '/audio/sfx/turbo.mp3');
    this.loadSound('countdown', '/audio/sfx/countdown.mp3');
    this.loadSound('select', '/audio/sfx/select.mp3');

    // Battle attack SFX by element type
    this.loadSound('attack-electric', '/audio/sfx/attack-electric.mp3');
    this.loadSound('attack-fire', '/audio/sfx/attack-fire.mp3');
    this.loadSound('attack-water', '/audio/sfx/attack-water.mp3');
    this.loadSound('attack-grass', '/audio/sfx/attack-grass.mp3');
    this.loadSound('attack-psychic', '/audio/sfx/attack-psychic.mp3');

    // Battle action SFX
    this.loadSound('item-potion', '/audio/sfx/item-potion.mp3');
    this.loadSound('taunt', '/audio/sfx/taunt.mp3');
    this.loadSound('guard', '/audio/sfx/guard.mp3');
  }

  /**
   * Load a sound effect
   */
  private loadSound(key: string, path: string): void {
    const audio = new Audio(path);
    audio.preload = 'auto';
    audio.addEventListener('error', (e) => console.error(`Failed to load sound ${key}:`, e));
    this.sounds.set(key, audio);
  }

  /**
   * Play a sound effect
   */
  private playSound(key: string): void {
    const audio = this.sounds.get(key);
    if (!audio) {
      console.warn(`Sound not found: ${key}`);
      return;
    }

    // Check if music is muted
    if (getMusicManager().getIsMuted()) return;

    // Debounce rapid repeated plays of the same sound
    const now = Date.now();
    const lastPlay = this.lastPlayTime.get(key) ?? 0;
    if (now - lastPlay < this.debounceMs) return;
    this.lastPlayTime.set(key, now);

    // Reset and play
    audio.currentTime = 0;
    audio.volume = this.volume;
    audio.play().catch((err) => console.error(`Failed to play sound ${key}:`, err));
  }

  /**
   * Play crash sound (barrier hit)
   */
  playCrash(): void {
    this.playSound('crash');
  }

  /**
   * Play power-up sound (boost collected)
   */
  playPowerUp(): void {
    this.playSound('powerup');
  }

  /**
   * Play turbo sound (power activated)
   */
  playTurbo(): void {
    this.playSound('turbo');
  }

  /**
   * Play countdown sound
   */
  playCountdown(): void {
    this.playSound('countdown');
  }

  /**
   * Play menu select sound
   */
  playSelect(): void {
    this.playSound('select');
  }

  /**
   * Play attack sound based on move type
   */
  playAttack(type: string): void {
    const key = `attack-${type}`;
    if (this.sounds.has(key)) {
      this.playSound(key);
    } else {
      // Fallback: types without a dedicated sound use electric
      this.playSound('attack-electric');
    }
  }

  /**
   * Play guard sound
   */
  playGuard(): void {
    this.playSound('guard');
  }

  /**
   * Play item/potion sound
   */
  playItem(): void {
    this.playSound('item-potion');
  }

  /**
   * Play taunt sound
   */
  playTaunt(): void {
    this.playSound('taunt');
  }

  /**
   * Set volume (0 to 1)
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.sounds.forEach(audio => {
      audio.volume = this.volume;
    });
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.volume;
  }
}

// Singleton instance
let sfxManager: SoundEffectsManager | null = null;

/**
 * Get the global sound effects manager instance
 */
export function getSoundEffectsManager(): SoundEffectsManager {
  if (!sfxManager) {
    sfxManager = new SoundEffectsManager();
  }
  return sfxManager;
}
