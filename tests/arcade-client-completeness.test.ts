import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const arcade = readFileSync(new URL('../client/arcade/arcade.ts', import.meta.url), 'utf8');
const arcadeHtml = readFileSync(new URL('../client/arcade/index.html', import.meta.url), 'utf8');
const arcadeCss = readFileSync(new URL('../client/arcade/arcade.css', import.meta.url), 'utf8');
const join = readFileSync(new URL('../client/join/join.ts', import.meta.url), 'utf8');
const stationClient = readFileSync(new URL('../client/station-client.ts', import.meta.url), 'utf8');

describe('Arcade client completeness', () => {
  it('keeps every static client DOM lookup backed by rendered markup', () => {
    const ids = new Set([...arcadeHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
    const lookups = [...arcade.matchAll(/\bel(?:<[^>]+>)?\('([^']+)'\)/g)].map(match => match[1]!);
    expect([...new Set(lookups)].filter(id => !ids.has(id))).toEqual([]);
  });

  it('routes no-lead browser players back to join without offering browser registration', () => {
    expect(arcade).toContain("currentConfig.arcade.mode==='coin_only'&&redirectNoLeadPlayer()");
    expect(arcade).toContain('effectivePublicVisitorBaseUrl(state.deployment?.publicBaseUrl)');
    expect(arcade).toContain('location.replace(`${target.pathname}${target.search}`)');
    expect(join).toMatch(/if \(arcade\.arcade\.mode === 'lead_capture'\) \{[\s\S]*?'Continue in browser'/);
  });

  it('keeps lead-capture player state live over station/config SSE with polling fallback', () => {
    expect(arcade).toContain('startPlayerUpdates()');
    expect(arcade).toContain("events.addEventListener('arcade_station_updated'");
    expect(arcade).toContain("events.addEventListener('arcade_config_updated'");
    expect(arcade).toContain('startPlayerPolling()');
    expect(arcade).toContain('refreshPlayerConfiguration().catch(showError),5000');
    expect(arcade).toContain("maybe<StationView>('/api/arcade/station/me')");
    const playerRefresh = /async function refreshPlayerConfiguration\(\)[\s\S]*?\n}/.exec(arcade)?.[0] ?? '';
    expect(playerRefresh).not.toContain('.reset()');
  });

  it('only presents a localized call action for an admitted player with a call number', () => {
    expect(stationClient).toContain('termsAcknowledgementRequired: boolean');
    expect(arcade).toContain('callNumber:string|null');
    expect(arcade).toContain("station?.ready?.status==='ADMITTED'?station.callNumber?.trim():''");
    expect(arcade).toContain('callNow.href=`tel:${callNumber}`');
    expect(arcade).toContain('Call now · ${callNumber}');
    expect(arcade).toContain('Ligue agora · ${callNumber}');
    expect(arcadeHtml).toContain('id="call-now"');
    expect(arcadeCss).toContain('.call-now{');
  });

  it('follows public terms and starting-balance settings without promising a zero grant', () => {
    expect(arcadeHtml).toContain('id="terms-field"');
    expect(arcade).toContain("show('terms-field',termsRequired);termsInput.required=termsRequired");
    expect(arcade).toContain('const startingBalance=freePlay?0:state.config?.coins.startingBalance??0');
    expect(arcade).toContain("playerText('Continue','Continuar')");
    expect(arcade).not.toContain('Registration complete. Earn a coin to join the ready pool.');
    expect(arcadeHtml).not.toContain('Register and receive coin');
  });

  it('shows and validates effective operator channel capabilities', () => {
    expect(arcadeHtml).toContain('id="admin-voice"');
    expect(arcade).toContain("state.deployment=await api<DeploymentConfig>('/api/config')");
    expect(arcade).toContain("(settings.channels as AdminConfig['channels']).voice=el<HTMLInputElement>('admin-voice').checked");
    expect(arcade).toContain('deploymentChannelNumber');
    expect(arcade).toContain('effectiveVoiceNumbers');
    expect(arcade).toContain("selectedMode==='coin_only'&&!smsReady&&!whatsappReady");
    expect(arcade).toContain("selectedMode!=='off'&&!(settings.channels as AdminConfig['channels']).voice");
    expect(arcade).toContain("selectedMode!=='off'&&!voiceReady");
    expect(arcade).toContain("return number?'Ready':'Add a phone number'");
  });

  it('explains the mandatory no-lead acknowledgement before readiness', () => {
    expect(join).toContain('You must reply YES to acknowledge the terms before replying');
    expect(join).toContain('Você deve responder SIM para aceitar os termos antes de responder');
    expect(join).toContain("freePlay ? 'READY' : 'COIN'");
    expect(join).toContain("freePlay ? 'PRONTO' : 'MOEDA'");
  });
});
