/**
 * Music Manager: Handles music playback for different game states.
 * Features:
 * - Auto-play next track when multiple tracks exist
 * - Continuous loop playback
 * - Dynamic switching between game contexts
 */

export type GameContext = 'lobby' | 'racer' | 'monsters' | 'leaderboard';

interface MusicContext {
  tracks: string[];
  currentTrackIndex: number;
}

export class MusicManager {
  private audio: HTMLAudioElement;
  private contexts: Record<GameContext, MusicContext> = {
    lobby: {
      tracks: ['/audio/lobby/velvet-arrival.mp3'],
      currentTrackIndex: 0,
    },
    racer: {
      tracks: ['/audio/racer/midnight-apex.m4a', '/audio/racer/red-light-to-green.mp3'],
      currentTrackIndex: 0,
    },
    monsters: {
      tracks: ['/audio/monsters/hero-final-gambit.mp3', '/audio/monsters/one-last-gold-coin.mp3'],
      currentTrackIndex: 0,
    },
    leaderboard: {
      tracks: ['/audio/leaderboard/final-ascent.mp3'],
      currentTrackIndex: 0,
    },
  };

  private currentContext: GameContext | null = null;
  private isPlaying = false;
  private volume = 0.7;
  private isMuted = false;

  constructor() {
    this.audio = new Audio();
    this.audio.addEventListener('ended', () => this.onTrackEnded());
    this.audio.addEventListener('error', (e) => console.error('Audio error:', e));
  }

  /**
   * Switch to a different game context and start playing music
   */
  switchContext(context: GameContext) {
    if (this.currentContext === context && this.isPlaying) {
      return; // Already playing this context
    }

    this.currentContext = context;
    const contextData = this.contexts[context];
    contextData.currentTrackIndex = 0;

    const track = contextData.tracks[0];
    if (track) {
      this.playTrack(track);
      this.isPlaying = true;
    }
  }

  /**
   * Play a specific track
   */
  private playTrack(trackPath: string) {
    this.audio.src = trackPath;
    this.audio.volume = this.volume;
    this.audio.play().catch((err) => console.error('Failed to play track:', err));
  }

  /**
   * Handle track ending - auto-play next track or loop
   */
  private onTrackEnded() {
    if (!this.currentContext) return;

    const contextData = this.contexts[this.currentContext];
    const tracks = contextData.tracks;

    // Move to next track
    contextData.currentTrackIndex = (contextData.currentTrackIndex + 1) % tracks.length;

    // Play the next track (or loop back to first if we've reached the end)
    const nextTrack = tracks[contextData.currentTrackIndex];
    if (nextTrack) {
      this.playTrack(nextTrack);
    }
  }

  /**
   * Pause music
   */
  pause() {
    this.audio.pause();
    this.isPlaying = false;
  }

  /**
   * Resume music
   */
  resume() {
    this.audio.play().catch((err) => console.error('Failed to resume playback:', err));
    this.isPlaying = true;
  }

  /**
   * Stop music
   */
  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.isPlaying = false;
  }

  /**
   * Set volume (0 to 1)
   */
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.audio.volume = this.volume;
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.volume;
  }

  /**
   * Check if music is currently playing
   */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Get current context
   */
  getCurrentContext(): GameContext | null {
    return this.currentContext;
  }

  /**
   * Toggle mute/unmute
   */
  toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.audio.pause();
    } else if (this.isPlaying) {
      this.audio.play().catch((err) => console.error('Failed to resume playback:', err));
    }
    return this.isMuted;
  }

  /**
   * Mute music
   */
  mute(): void {
    if (!this.isMuted) {
      this.isMuted = true;
      this.audio.pause();
    }
  }

  /**
   * Unmute music
   */
  unmute(): void {
    if (this.isMuted) {
      this.isMuted = false;
      if (this.isPlaying) {
        this.audio.play().catch((err) => console.error('Failed to resume playback:', err));
      }
    }
  }

  /**
   * Get mute state
   */
  getIsMuted(): boolean {
    return this.isMuted;
  }
}

// Singleton instance
let musicManager: MusicManager | null = null;

/**
 * Get the global music manager instance
 */
export function getMusicManager(): MusicManager {
  if (!musicManager) {
    musicManager = new MusicManager();
  }
  return musicManager;
}
