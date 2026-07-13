import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeAudio {
  src: string;
  muted = false;
  volume = 1;
  currentTime = 0;
  preload = '';
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  private listeners = new Map<string, () => void>();
  addEventListener = vi.fn((type: string, listener: () => void) => { this.listeners.set(type, listener); });
  constructor(src = '') { this.src = src; }
  emit(type: string): void { this.listeners.get(type)?.(); }
}

let audioInstances: FakeAudio[] = [];
let storageValues: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  audioInstances = [];
  storageValues = new Map();
  vi.stubGlobal('Audio', vi.fn(function AudioStub(src = '') {
    const audio = new FakeAudio(src);
    audioInstances.push(audio);
    return audio;
  }));
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => storageValues.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storageValues.set(key, value); }),
    removeItem: vi.fn((key: string) => { storageValues.delete(key); }),
    clear: vi.fn(() => { storageValues.clear(); }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MusicManager mute behavior', () => {
  it('plays Break the Guard for the Fighter context', async () => {
    const { MusicManager } = await import('../client/music-manager');
    const music = new MusicManager();
    const audio = audioInstances[0]!;

    music.switchContext('fighter');

    expect(audio.src).toBe('/audio/fighter/music/break-the-guard.mp3');
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('switches to victory music for the Fighter celebration', async () => {
    const { MusicManager } = await import('../client/music-manager');
    const music = new MusicManager();
    const audio = audioInstances[0]!;

    music.switchContext('fighter');
    music.switchContext('fighter-victory');

    expect(audio.src).toBe('/audio/fighter/music/victory.mp3');
    expect(audio.play).toHaveBeenCalledTimes(2);

    audio.emit('ended');
    expect(music.getIsPlaying()).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('persists mute from the home page into a fresh Voice Monsters page load', async () => {
    const firstPage = await import('../client/music-manager');
    firstPage.getMusicManager().toggleMute();

    vi.resetModules();
    const gamePage = await import('../client/music-manager');
    const music = gamePage.getMusicManager();
    const audio = audioInstances.at(-1)!;

    expect(music.getIsMuted()).toBe(true);
    music.switchContext('monsters');

    expect(audio.src).toBe('/audio/monsters/hero-final-gambit.mp3');
    expect(audio.muted).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('stays silent if muted before the Voice Monsters music context starts', async () => {
    const { MusicManager } = await import('../client/music-manager');
    const music = new MusicManager();
    const audio = audioInstances[0]!;

    music.toggleMute();
    audio.play.mockClear();
    music.switchContext('monsters');

    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.muted).toBe(true);
    expect(music.getIsMuted()).toBe(true);

    music.toggleMute();
    expect(audio.muted).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('does not restart music when a muted Voice Monsters page switches contexts', async () => {
    const { MusicManager } = await import('../client/music-manager');
    const music = new MusicManager();
    const audio = audioInstances[0]!;

    music.switchContext('lobby');
    expect(audio.play).toHaveBeenCalledTimes(1);

    music.toggleMute();
    expect(audio.pause).toHaveBeenCalledTimes(1);

    audio.play.mockClear();
    music.switchContext('monsters');

    expect(audio.src).toBe('/audio/monsters/hero-final-gambit.mp3');
    expect(audio.muted).toBe(true);
    expect(audio.play).not.toHaveBeenCalled();
    expect(music.getIsMuted()).toBe(true);

    music.toggleMute();
    expect(audio.muted).toBe(false);
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('does not resume playback while muted', async () => {
    const { MusicManager } = await import('../client/music-manager');
    const music = new MusicManager();
    const audio = audioInstances[0]!;

    music.switchContext('monsters');
    music.toggleMute();
    audio.play.mockClear();

    music.resume();

    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.muted).toBe(true);
    expect(music.getIsMuted()).toBe(true);
  });
});

describe('SoundEffectsManager mute behavior', () => {
  it('uses only Fighter punch sounds for punches and the kick sound for kicks', async () => {
    const { SoundEffectsManager } = await import('../client/sound-effects');
    const sfx = new SoundEffectsManager();

    sfx.playFighterPunch();
    sfx.playFighterPunch();
    sfx.playFighterPunch();
    sfx.playFighterKick();

    const played = audioInstances.filter(audio => audio.play.mock.calls.length).map(audio => audio.src);
    expect(played).toEqual([
      '/audio/fighter/sfx/punch-light.mp3',
      '/audio/fighter/sfx/punch-impact.mp3',
      '/audio/fighter/sfx/punch-heavy.mp3',
      '/audio/fighter/sfx/kick-medium.mp3',
    ]);
  });

  it('suppresses battle sound effects while the global music toggle is muted', async () => {
    const { getMusicManager } = await import('../client/music-manager');
    const { SoundEffectsManager } = await import('../client/sound-effects');

    getMusicManager().mute();
    const sfx = new SoundEffectsManager();
    audioInstances.forEach(audio => audio.play.mockClear());

    sfx.playSelect();
    expect(audioInstances.some(audio => audio.play.mock.calls.length > 0)).toBe(false);

    getMusicManager().unmute();
    sfx.playSelect();
    expect(audioInstances.some(audio => audio.play.mock.calls.length > 0)).toBe(true);
  });
});
