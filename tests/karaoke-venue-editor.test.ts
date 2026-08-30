import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const hub = readFileSync(new URL('../client/editor/hub.ts', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../client/editor/karaoke-venue-editor.ts', import.meta.url), 'utf8');
const timingEditor = readFileSync(new URL('../client/editor/karaoke-timing-editor.ts', import.meta.url), 'utf8');

describe('Voice Karaoke venue editor surface', () => {
  it('is linked from the unified hub without propagating editor tokens', () => {
    expect(hub).toContain('href="?game=karaoke"');
    expect(hub).not.toContain('tokenQ');
    expect(hub).toContain("game === 'karaoke'");
    expect(hub).toContain("import('./karaoke-venue-editor')");
    expect(hub).toContain("import('./karaoke-timing-editor')");
  });

  it('provides audio-backed per-word start, stop, sustain, and target movement controls', () => {
    for (const control of [
      'id="ktSong"', 'id="ktPlay"', 'id="ktAudition"', 'id="ktScrub"', 'id="ktLoop"',
      'id="ktTimelineViewport"', 'data-edge="start"', 'data-edge="end"',
      'id="ktStart"', 'id="ktEnd"', 'data-nudge="move:-100"', 'id="ktSave"',
    ]) expect(timingEditor).toContain(control);
    expect(timingEditor).toContain("fetch('/api/karaoke-timings'");
    expect(timingEditor).toContain("'If-Match': this.etag");
    expect(timingEditor).toContain('karaokeTimingConfigFromSongs');
    expect(timingEditor).toContain('parseKaraokeSong');
    expect(timingEditor).toContain('applyKaraokeWordTimingGroupDrag');
    expect(timingEditor).toContain("className = 'marquee'");
  });

  it('provides transform, camera, anchor, highway, lighting, and safe-save controls', () => {
    for (const control of [
      'id="kvRole"', 'data-mode="translate"', 'data-mode="rotate"', 'data-mode="scale"',
      'id="kvFrame"', 'id="kvReset"', 'id="kvCameraMode"', 'id="kvSetCamera"',
      'id="kvCapturePreview"',
      'id="kvSongTime"', 'id="kvIntensity"', 'id="kvDrumMode"', 'id="kvSpot"',
      'id="kvHide"', 'id="kvSave"',
    ]) expect(editor).toContain(control);
    expect(editor).toContain("fetch('/api/karaoke-asset-files'");
    expect(editor).toContain("fetch('/api/karaoke-venue'");
    expect(editor).toContain('if (!this.loaded)');
    expect(editor).toContain('parseKaraokeVenueConfig(this.config)');
    expect(editor).toContain('authHeaders');
    expect(editor).toContain('promptForToken');
    expect(editor).not.toContain('this.config = parseKaraokeVenueConfig(await response.json()');
  });

  it('loads real GLBs through shared normalization and retains procedural replacements', () => {
    expect(editor).toContain('this.loader.loadAsync(spec.url)');
    expect(editor).toContain('normalizeKaraokeAsset(spec, source)');
    expect(editor).toContain('visual ?? this.fallback(role)');
    expect(editor).toContain("karaokeDrumAnchor(this.roots.get('stage')!, this.scene)");
  });
});
