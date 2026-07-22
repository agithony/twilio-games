import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readClient = (path: string) => readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8');

describe('standalone and station display UX', () => {
  it('labels station game selection as automatic without simulated card focus', () => {
    const home = readClient('home.ts');
    const css = readClient('home.css');
    expect(home).toContain("selectionEyebrow: 'Automatic selection'");
    expect(home).toContain("selectionTitle: 'The next arena is selected automatically.'");
    expect(home).not.toContain("classList.toggle('focused'");
    expect(css).not.toContain('.game-card.focused');
  });

  it('does not use captured station auth for a standalone Fighter display', () => {
    const home = readClient('home.ts');
    const fighter = readClient('fighter/fighter.ts');
    expect(home).toMatch(/if \(standaloneMode\) \{[\s\S]*?return;[\s\S]*?\}\s*render\(\(await fetchPublicStation/);
    expect(fighter).toContain('stationDisplay.active ? stationDisplay.displayToken');
  });

  it('allows Racer and Monsters menus to scroll in a narrow viewport', () => {
    const racer = readClient('racer.css');
    const monsters = readClient('monsters.css');
    expect(racer).toMatch(/@media \(max-width: 520px\)[\s\S]*?#screens \{[^}]*overflow-y: auto/);
    expect(racer).toContain('grid-template-columns: repeat(2,minmax(0,1fr)) !important');
    expect(monsters).toMatch(/@media \(max-width: 520px\)[\s\S]*?#overlay \{[^}]*overflow-y: auto/);
    expect(monsters).toContain('grid-auto-rows: minmax(150px,auto)');
  });

  it('keeps a join QR discoverable between recruiting and gameplay', () => {
    const html = readClient('index.html');
    const home = readClient('home.ts');
    const stationDisplay = readClient('station-display.ts');
    expect(html).toContain('id="persistentJoinQr"');
    expect(home).toContain("station.phase==='ATTRACT'||station.phase==='RECRUITING'");
    expect(home).toContain("document.getElementById('persistentJoinQr')");
    expect(stationDisplay).toContain("setRailVisible(railMode !== 'hidden')");
  });
});
