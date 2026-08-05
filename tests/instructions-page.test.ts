import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../client/instructions/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../client/instructions/instructions.css',import.meta.url),'utf8');
const vite=readFileSync(new URL('../client/vite.config.ts',import.meta.url),'utf8');
const server=readFileSync(new URL('../server/http-server.ts',import.meta.url),'utf8');

describe('Portuguese instructions page', () => {
  it('explains the simple touchscreen, QR, call, AI, and voice flow', () => {
    expect(html).toContain('<html lang="pt-BR"');
    expect(html).toContain('A tela é sensível ao toque');
    expect(html).toContain('código QR');
    expect(html).toContain('números brasileiros (+55)');
    expect(html).toContain('Faça a ligação');
    expect(html).toContain('inteligência artificial');
    expect(html).toContain('seu primeiro nome');
    expect(html.match(/<li>/g)).toHaveLength(6);
  });

  it('uses existing Twilio branding and is registered as a clean route', () => {
    expect(html).toContain('/brand/Twilio_Logo_Bug_White.svg');
    expect(html).toContain('/theme-init.js');
    expect(css).toContain('Twilio Sans Display');
    expect(vite).toContain("instructions: resolve(__dirname, 'instructions/index.html')");
    expect(server).toContain("rel === '/instructions' || rel === '/instructions/'");
  });
});
