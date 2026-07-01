// Level configs (maps.json) must survive deploys. In prod the live file lives on the persistent
// Azure Files mount (data/maps.json), NOT in the image — so editor-authored levels aren't clobbered
// when a new image ships. On first boot the persistent copy doesn't exist yet, so we SEED it once
// from the image's bundled assets/maps/maps.json. seedMapsPlan() is the pure decision: given whether
// the persistent file exists (+ its content) and the bundled default, decide what to write.
import { describe, it, expect } from 'vitest';
import { seedMapsPlan } from '../server/maps-seed';

describe('seedMapsPlan', () => {
  it('seeds from the bundled defaults when the persistent file is ABSENT (first boot)', () => {
    const plan = seedMapsPlan({ liveExists: false, liveText: null, bundledText: '{"Silver Lake":{}}' });
    expect(plan).toEqual({ write: true, contents: '{"Silver Lake":{}}' });
  });

  it('does NOT overwrite an existing persistent file (preserves prod-authored levels)', () => {
    const plan = seedMapsPlan({ liveExists: true, liveText: '{"Drift":{}}', bundledText: '{"Silver Lake":{}}' });
    expect(plan).toEqual({ write: false });
  });

  it('re-seeds when the persistent file exists but is EMPTY / whitespace (never leave it blank)', () => {
    expect(seedMapsPlan({ liveExists: true, liveText: '   ', bundledText: '{"Silver Lake":{}}' }))
      .toEqual({ write: true, contents: '{"Silver Lake":{}}' });
    expect(seedMapsPlan({ liveExists: true, liveText: '', bundledText: '{"Silver Lake":{}}' }))
      .toEqual({ write: true, contents: '{"Silver Lake":{}}' });
  });

  it('re-seeds when the persistent file is CORRUPT (unparseable JSON) rather than serving nothing', () => {
    const plan = seedMapsPlan({ liveExists: true, liveText: '{not json', bundledText: '{"Silver Lake":{}}' });
    expect(plan).toEqual({ write: true, contents: '{"Silver Lake":{}}' });
  });

  it('does NOT re-seed a valid-but-empty object (author deleted every level on purpose)', () => {
    const plan = seedMapsPlan({ liveExists: true, liveText: '{}', bundledText: '{"Silver Lake":{}}' });
    expect(plan).toEqual({ write: false });
  });

  it('no-ops when there are no bundled defaults to seed from', () => {
    expect(seedMapsPlan({ liveExists: false, liveText: null, bundledText: null })).toEqual({ write: false });
    expect(seedMapsPlan({ liveExists: false, liveText: null, bundledText: '   ' })).toEqual({ write: false });
  });
});
