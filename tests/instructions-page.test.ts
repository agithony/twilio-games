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
    expect(html).toContain('Toque no jogo para começar.');
    expect(html).toContain('Toque no jogo na tela principal para começar.');
    expect(html).toContain('código QR');
    expect(html).toContain('números brasileiros (+55)');
    expect(html).toContain('Faça a ligação');
    expect(html).toContain('inteligência artificial');
    expect(html).toContain('seu primeiro nome');
    expect(html).toContain('Escolha lutadores e movimentos usando sua voz.');
    expect(html).toContain('Aguarde sua vez para jogar na tela.');
    expect(html).not.toContain('Voltar aos jogos');
    expect(html).not.toMatch(/<footer>[\s\S]*?href="\/"/);
    expect(html).not.toMatch(/Escolha carros|monstros, lutadores/);
    expect(html).not.toMatch(/Escolha um jogo|jogos disponíveis/);
    expect(html.match(/<li>/g)).toHaveLength(6);
  });

  it('uses existing Twilio branding and is registered as a clean route', () => {
    expect(html).toContain('/brand/Twilio_Logo_Bug_White.svg');
    expect(html).toContain('/theme-init.js');
    expect(css).toContain('Twilio Sans Display');
    expect(css).toContain('@media(max-width:480px)');
    expect(vite).toContain("instructions: resolve(__dirname, 'instructions/index.html')");
    expect(server).toContain("rel === '/instructions' || rel === '/instructions/'");
  });
});
