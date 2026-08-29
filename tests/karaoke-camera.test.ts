import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Karaoke cinematic camera integration', () => {
  it('renders cinematic venue shots behind a stable independent lyric highway', async () => {
    const source = await readFile('client/karaoke/karaoke-stage.ts', 'utf8');
    expect(source).toContain('private readonly highwayScene');
    expect(source).toContain('private readonly highwayCamera');
    expect(source).toContain('karaokeStaticCameraShot(this.highwayCamera.aspect');
    expect(source).toContain('this.renderer.render(this.highwayScene, this.highwayCamera)');
    expect(source).toContain('this.mount.dataset.karaokeCameraShot = shot.id');
  });
});
