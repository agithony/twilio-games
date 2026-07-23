import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';

const readClient = (path: string) => readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8');
const home = readClient('home.ts');
const html = readClient('index.html');

function mp4TopLevelBoxes(bytes: Buffer): string[] {
  const boxes: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const shortSize = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : shortSize || bytes.length - offset;
    if (size < 8 || offset + size > bytes.length) break;
    boxes.push(type);
    offset += size;
  }
  return boxes;
}

describe('home preview media and standalone catalog', () => {
  it('keeps the Racer preview below 2 MiB with fast-start metadata', () => {
    const asset = new URL('../client/public/video/vr-demo.mp4', import.meta.url);
    expect(statSync(asset).size).toBeLessThan(2 * 1024 * 1024);
    const boxes = mp4TopLevelBoxes(readFileSync(asset));
    expect(boxes).toContain('moov');
    expect(boxes).toContain('mdat');
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  });

  it('uses exact ConversationRelay product copy in fallback and both locales', () => {
    const english = 'Powered by Twilio ConversationRelay. Your voice is the controller.';
    const portuguese = 'Com tecnologia Twilio ConversationRelay. Sua voz é o controle.';
    expect(html).toContain(`<p id="standaloneDescription">${english}</p>`);
    expect(home).toContain(`standaloneDescription: '${english}'`);
    expect(home).toContain(`standaloneDescription: '${portuguese}'`);
    expect(`${html}\n${home}`).not.toContain('Choose a game on the shared screen. Players call from any phone and use their voices as controllers.');
  });

  it('keeps future concepts outside the playable catalog and entirely noninteractive', () => {
    const future = /<section class="standalone-future"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(future.match(/<article\b/g)).toHaveLength(2);
    expect(future.match(/<h2 id="voice(?:Trivia|Karaoke)Title">Voice (?:Trivia|Karaoke)<\/h2>/g)).toEqual([
      '<h2 id="voiceTriviaTitle">Voice Trivia</h2>',
      '<h2 id="voiceKaraokeTitle">Voice Karaoke</h2>',
    ]);
    expect(future).toContain('Coming soon');
    expect(future).not.toMatch(/<(?:a|button|input|select|textarea)\b|\bhref=|\btabindex=|\bdata-game=/i);
    expect(html.indexOf('id="standaloneGames"')).toBeLessThan(html.indexOf('class="standalone-future"'));
  });

  it('builds standalone video nodes only once and never requests autoplay', () => {
    const launcher = /function renderStandaloneLauncher\(\): void \{[\s\S]*?\n\}/.exec(home)?.[0] ?? '';
    expect(launcher).toContain('if (standaloneGames.childElementCount > 0) return;');
    expect(launcher).toContain('standaloneGames.append(');
    expect(launcher).not.toContain('replaceChildren');
    expect(`${html}\n${home}`).not.toMatch(/\bautoplay\b/i);
  });

  it('plays only active-view previews and honors constrained clients', () => {
    const playback = /function previewPlaybackAllowed\(\): boolean \{[\s\S]*?function show/.exec(home)?.[0] ?? '';
    expect(playback).toContain('reducedMotionPreference.matches');
    expect(playback).toContain('previewConnection?.saveData');
    expect(playback).toContain("['slow-2g', '2g']");
    expect(playback).toContain("document.visibilityState !== 'hidden'");
    expect(playback).toContain('activeView.contains(video)');
    expect(playback).toContain("if(source&&!video.getAttribute('src'))video.src=source");
    expect(playback).toContain('video.pause()');
    expect(playback).toContain('if (video.paused)');
    expect(home.match(/\.play\(/g)).toHaveLength(1);
    expect(html.match(/preload="none"/g)).toHaveLength(3);
    expect(home).toContain('preload="none"');
    expect(`${html}\n${home}`).not.toMatch(/<video\s+src=/);
    expect(home).toContain("document.addEventListener('visibilitychange',syncPreviewPlayback)");
    expect(home).toContain("if(standaloneMode){renderStandaloneLauncher();show('standalone');}");
    expect(home).toContain("document.body.classList.toggle('standalone-mode',standaloneMode)");
  });
});
