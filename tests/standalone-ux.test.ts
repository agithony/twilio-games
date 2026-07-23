import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const readClient = (path: string) => readFileSync(new URL(`../client/${path}`, import.meta.url), 'utf8');

describe('standalone and station display UX', () => {
  it('presents station game selection as a player vote with automatic fallback', () => {
    const home = readClient('home.ts');
    const css = readClient('home.css');
    expect(home).toContain("selectionEyebrow: 'Player choice'");
    expect(home).toContain("selectionTitle: 'Choose the next game.'");
    expect(home).toContain('If time runs out or votes tie, the station chooses automatically.');
    expect(home).not.toContain("classList.toggle('focused'");
    expect(css).not.toContain('.game-card.focused');
  });

  it('does not use captured station auth for a standalone Fighter display', () => {
    const home = readClient('home.ts');
    const fighter = readClient('fighter/fighter.ts');
    const refresh = /async function refresh\(\)[\s\S]*?\n}/.exec(home)?.[0] ?? '';
    expect(refresh.indexOf('if (standaloneMode)')).toBeLessThan(refresh.indexOf('fetchPublicStation(displayToken)'));
    expect(refresh).toMatch(/if \(standaloneMode\) \{[\s\S]*?return;/);
    expect(fighter).toContain('stationDisplay.active ? stationDisplay.displayToken : null');
    expect(fighter).not.toContain("params.get('hostToken')");
    expect(fighter).toContain("pageUrl.searchParams.delete('hostToken')");
    expect(fighter).not.toContain("t('lobby.room', { room: roomCode })");
    expect(fighter).toContain('connection.spectate(roomCode');
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
    expect(home).toContain("station.phase==='ATTRACT'||station.phase==='RECRUITING'||station.phase==='RESULTS'");
    expect(home).toContain("station.phase === 'RESULTS' ? station.nextReadyCount : station.currentReadyCount");
    expect(home).toContain("document.getElementById('persistentJoinQr')");
    expect(stationDisplay).toContain("setRailVisible(railMode !== 'hidden')");
  });

  it('requires explicit confirmation before a messaging challenge link grants coins', () => {
    const html = readClient('challenge/index.html');
    const script = readClient('challenge/challenge.ts');
    expect(html).toContain('Claim coins and continue');
    expect(script).toContain("history.replaceState(history.state, '', `${location.pathname}${location.search}`)");
    expect(script).toContain("button.addEventListener('click'");
    expect(script).toContain("fetch('/api/arcade/challenges/redeem'");
    expect(script).not.toMatch(/dispatchEvent|button\.click\(|form\.submit\(/);
    expect(script.indexOf('history.replaceState')).toBeLessThan(script.indexOf("fetch('/api/arcade/challenges/redeem'"));
  });
});
