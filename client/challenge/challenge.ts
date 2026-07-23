export {};

let token = '';
try { token = decodeURIComponent(location.hash.slice(1)); } catch { /* Invalid link handled below. */ }
history.replaceState(history.state, '', `${location.pathname}${location.search}`);

const button = document.getElementById('claim') as HTMLButtonElement;
const statusElement = document.getElementById('status')!;
const portuguese = new URLSearchParams(location.search).get('locale')?.toLowerCase().startsWith('pt') === true;
if (portuguese) {
  document.documentElement.lang = 'pt-BR';
  document.getElementById('title')!.textContent = 'Resgate suas moedas.';
  document.getElementById('description')!.textContent = 'Confirme abaixo para adicionar a recompensa ao seu saldo e depois abrir o link do desafio.';
  button.textContent = 'Resgatar moedas e continuar';
}
if (!token || token.length > 4096) {
  button.disabled = true;
  statusElement.textContent = 'This reward link is invalid or incomplete. Reply MORE for a fresh link.';
}

button.addEventListener('click', async () => {
  button.disabled = true;
  statusElement.textContent = 'Adding coins...';
  try {
    const response = await fetch('/api/arcade/challenges/redeem', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json() as {
      destinationUrl?: unknown;
      rewardCoins?: unknown;
      error?: { message?: unknown };
    };
    if (!response.ok || typeof payload.destinationUrl !== 'string') {
      throw new Error(typeof payload.error?.message === 'string' ? payload.error.message : 'The reward could not be claimed.');
    }
    statusElement.textContent = `Added ${String(payload.rewardCoins ?? '')} coin${payload.rewardCoins === 1 ? '' : 's'}. Opening challenge...`;
    location.replace(payload.destinationUrl);
  } catch (error) {
    statusElement.textContent = error instanceof Error ? error.message : 'The reward could not be claimed. Reply MORE for a fresh link.';
    button.disabled = false;
  }
});
