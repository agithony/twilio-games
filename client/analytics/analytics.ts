import type { AnalyticsGame, AnalyticsReport } from '../../shared/analytics';

const auth = el<HTMLElement>('auth'), dashboard = el<HTMLElement>('dashboard');
const fromInput = el<HTMLInputElement>('from'), toInput = el<HTMLInputElement>('to'), gameInput = el<HTMLSelectElement>('game');
const download = el<HTMLButtonElement>('download'), status = el<HTMLElement>('status'), authMessage = el<HTMLElement>('auth-message');
const today = new Date(), prior = new Date(today.getTime() - 29 * 86_400_000);
toInput.value = iso(today); fromInput.value = iso(prior);
el('apply').addEventListener('click', () => void refresh());
el('logout').addEventListener('click', () => void logout());
download.addEventListener('click', () => void downloadPdf());
void checkSession();

async function checkSession(): Promise<void> {
  const reason = new URLSearchParams(location.search).get('auth');
  if (reason) history.replaceState(null, '', '/analytics');
  try {
    const response = await fetch('/api/analytics/session');
    const session = await response.json() as { authenticated: boolean; analyticsAuthorized: boolean; configured: boolean; email?: string };
    if (session.authenticated && session.analyticsAuthorized) {
      auth.hidden = true; dashboard.hidden = false; download.disabled = false;
      el('user').textContent = session.email ?? ''; await refresh(); return;
    }
    if (session.authenticated && !session.analyticsAuthorized) authMessage.textContent = 'This account is authorized for Arcade operations, not private activation analytics.';
    else if (!session.configured) authMessage.textContent = 'Google OAuth is not configured for this deployment.';
    else if (reason === 'email_not_allowed') authMessage.textContent = 'That verified Google account is not authorized. Use a @twilio.com account.';
    else if (reason) authMessage.textContent = 'Google sign-in could not be completed. Please try again.';
  } catch { authMessage.textContent = 'The authentication service is unavailable.'; }
  lock();
}

async function refresh(): Promise<void> {
  status.textContent = 'Loading activation report...';
  try {
    const response = await fetch(`/api/analytics?${query()}`);
    if (response.status === 401) { lock(); return; }
    if (!response.ok) throw new Error(await response.text());
    const report = await response.json() as AnalyticsReport;
    download.disabled = false; status.textContent = `${report.range.days} day report · generated ${new Date(report.generatedAt).toLocaleString()}`;
    render(report);
  } catch (error) { status.textContent = `Report failed: ${(error as Error).message}`; }
}

function render(report: AnalyticsReport): void {
  const s = report.summary;
  el('kpis').innerHTML = [kpi(number(s.participants), 'Engaged participants'), kpi(number(s.sessions), 'Sessions started'),
    kpi(`${Math.round(s.completionRate * 100)}%`, 'Completion rate'), kpi(duration(s.playSeconds), 'Active play time'),
    kpi(number(s.voiceCommands), 'Voice commands')].join('');
  renderTrend(report); renderGames(report); renderSelections(report);
  el('insights').innerHTML = report.insights.map(text => `<li>${escapeHtml(text)}</li>`).join('');
}

function renderTrend(report: AnalyticsReport): void {
  const points = report.trend, width = 760, height = 250, pad = 30;
  const max = Math.max(1, ...points.flatMap(point => [point.participants, point.sessions]));
  const x = (index: number) => pad + (points.length <= 1 ? 0 : index / (points.length - 1) * (width - pad * 2));
  const y = (value: number) => height - pad - value / max * (height - pad * 2);
  const coords = (field: 'participants' | 'sessions') => points.map((point, index) => `${x(index)},${y(point[field])}`).join(' ');
  const labels = points.filter((_, index) => index === 0 || index === points.length - 1 || (points.length > 8 && index % Math.ceil(points.length / 6) === 0));
  el('trend').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily participants and sessions">
    ${[0,.25,.5,.75,1].map(value => `<line class="axis" x1="${pad}" y1="${y(max*value)}" x2="${width-pad}" y2="${y(max*value)}"/><text x="2" y="${y(max*value)+3}">${Math.round(max*value)}</text>`).join('')}
    <polyline class="data-line line-red" points="${coords('participants')}"/><polyline class="data-line line-blue" points="${coords('sessions')}"/>
    ${labels.map(point => { const index = points.indexOf(point); return `<text text-anchor="middle" x="${x(index)}" y="${height-5}">${point.date.slice(5)}</text>`; }).join('')}</svg>`;
}

function renderGames(report: AnalyticsReport): void {
  const labels: Record<AnalyticsGame,string> = { racer:'Racer', monsters:'Monsters', fighter:'Fighter' };
  const max = Math.max(1, ...Object.values(report.games).map(value => value.sessions));
  el('games').innerHTML = (Object.entries(report.games) as [AnalyticsGame, AnalyticsReport['games'][AnalyticsGame]][]).map(([game,value]) =>
    `<div class="game-row"><span class="game-name">${labels[game]}</span><span class="bar"><i style="width:${value.sessions/max*100}%"></i></span><span class="game-value">${number(value.sessions)}<small>${Math.round(value.completionRate*100)}% complete</small></span></div>`).join('');
}

function renderSelections(report: AnalyticsReport): void {
  const groups = [['Maps',report.selections.maps],['Characters',report.selections.characters],['Vehicles',report.selections.vehicles]] as const;
  el('selections').innerHTML = groups.map(([label,items]) => `<div class="selection-group"><h3>${label}</h3><div class="chips">${items.length ? items.slice(0,5).map(item => `<span class="chip">${escapeHtml(title(item.name))}<b>${item.count}</b></span>`).join('') : '<span class="chip">No data yet</span>'}</div></div>`).join('');
}

async function downloadPdf(): Promise<void> {
  download.disabled = true; download.textContent = 'Building report...';
  try {
    const response = await fetch(`/api/analytics.pdf?${query()}`);
    if (response.status === 401) { lock(); return; }
    if (!response.ok) throw new Error(await response.text());
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = `twilio-games-${fromInput.value}-${toInput.value}.pdf`; link.click(); URL.revokeObjectURL(url);
  } catch (error) { status.textContent = `PDF failed: ${(error as Error).message}`; }
  finally { if (!dashboard.hidden) { download.disabled = false; download.textContent = 'Download PDF'; } }
}

async function logout(): Promise<void> { await fetch('/auth/logout', { method: 'POST' }); el('user').textContent = ''; lock(); }
function lock(): void { auth.hidden = false; dashboard.hidden = true; download.disabled = true; }
function query(): string { return new URLSearchParams({ from: fromInput.value, to: toInput.value, game: gameInput.value }).toString(); }
function kpi(value:string,label:string): string { return `<article class="kpi"><strong>${value}</strong><span>${label}</span></article>`; }
function duration(seconds:number): string { const hours = Math.floor(seconds/3600), minutes = Math.floor(seconds%3600/60); return hours ? `${hours}h ${minutes}m` : `${minutes}m`; }
function number(value:number): string { return new Intl.NumberFormat().format(value); }
function title(value:string): string { return value.replace(/[-_]+/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase()); }
function iso(date:Date): string { return date.toISOString().slice(0,10); }
function escapeHtml(value:string): string { const node=document.createElement('span'); node.textContent=value; return node.innerHTML; }
function el<T extends HTMLElement = HTMLElement>(id:string): T { return document.getElementById(id) as T; }
