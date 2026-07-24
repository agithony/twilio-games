export type StationPhase = 'ATTRACT' | 'RECRUITING' | 'GAME_SELECTION' | 'LOCKED' | 'LAUNCHING' | 'PLAYING' | 'RESULTS';

export interface PublicStation {
  phase: StationPhase;
  revision: number;
  activeGame: 'racer' | 'monsters' | 'fighter' | null;
  deadline: string | null;
  currentReadyCount: number;
  nextReadyCount: number;
  roster: readonly { position: number; displayName: string; status: string }[];
  games: readonly {
    id: 'racer' | 'monsters' | 'fighter';
    capacity: number;
    choices: number;
    playNow: number;
    overflow: number;
  }[];
  launch: {
    game: 'racer' | 'monsters' | 'fighter';
    route: string;
    roomCode: string;
    matchId: string;
    generation: number;
  } | null;
  results: readonly {displayName:string;rank:number|null;durationSeconds:number|null;won:boolean|null;completed:boolean;score:number|null}[];
  resultSource:'ENGINE'|'RECOVERY'|'LEGACY_UNAVAILABLE'|null;
}

export interface PublicArcadeConfig {
  arcade: { mode: 'off' | 'coin_only' | 'lead_capture'; cabinetId: string };
  registration: { termsAcknowledgementRequired: boolean };
  channels: {
    voice: boolean;
    sms: boolean;
    whatsapp: boolean;
    voiceNumbers: Readonly<Record<'en-US' | 'pt-BR', string | null>>;
  };
  coins: { startingBalance: number; chargePolicy: 'per_player' | 'per_match' | 'host_sponsors' | 'free' };
  station: {
    timings: { recruitingSeconds:number;hardDeadlineSeconds:number;selectionSeconds:number;lockedSeconds:number;launchTimeoutSeconds:number;resultsSeconds:number;postGameRecruitingSeconds:number };
    games: Record<'racer'|'monsters'|'fighter',{enabled:boolean}>;
    automaticSelection: { policy:'best_fit_rotation'|'round_robin'|'fixed_priority';order:readonly ('racer'|'monsters'|'fighter')[] };
    qrRail: 'auto'|'always'|'hidden';
  };
}

export interface StationAdmissionEvent {
  type:'arcade_ready_entry_added';
  revision:number;
  displayName:string;
  admission:'coin'|'ready';
}

export function voiceNumberForLocale(
  config: { phoneNumber?: unknown; voiceNumbers?: Partial<Record<'en-US' | 'pt-BR', unknown>> },
  locale: 'en-US' | 'pt-BR',
): string {
  if (config.voiceNumbers && Object.prototype.hasOwnProperty.call(config.voiceNumbers, locale)) {
    const localized = config.voiceNumbers[locale];
    return typeof localized === 'string' ? localized : '';
  }
  return typeof config.phoneNumber === 'string' ? config.phoneNumber : '';
}

export function watchVoiceNumber(
  locale: 'en-US' | 'pt-BR',
  apply: (number: string) => void,
): () => void {
  let generation = 0;
  let stopped = false;
  const refresh = async () => {
    const request = ++generation;
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) return;
      const config = await response.json() as Parameters<typeof voiceNumberForLocale>[0];
      if (!stopped && request === generation) apply(voiceNumberForLocale(config, locale));
    } catch {
      // Keep the last known number until the event stream reconnects or polling succeeds.
    }
  };
  const source = new EventSource('/api/arcade/events');
  source.addEventListener('arcade_config_updated', () => void refresh());
  source.addEventListener('open', () => void refresh());
  const polling = setInterval(() => void refresh(), 30_000);
  void refresh();
  return () => {
    stopped = true;
    generation += 1;
    clearInterval(polling);
    source.close();
  };
}

const DISPLAY_TOKEN_STORAGE_KEY = 'twilio-games-display-token';
const DISPLAY_TOKEN_REJECTED_KEY = 'twilio-games-display-token-rejected';

export function storeDisplayToken(token: string): boolean {
  try {
    sessionStorage.setItem(DISPLAY_TOKEN_STORAGE_KEY, token);
    sessionStorage.removeItem(DISPLAY_TOKEN_REJECTED_KEY);
    return sessionStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) === token;
  } catch {
    try {
      sessionStorage.removeItem(DISPLAY_TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(DISPLAY_TOKEN_REJECTED_KEY);
    } catch { /* Storage is unavailable; no stronger cleanup is possible. */ }
    return false;
  }
}

export function rejectDisplayToken(token: string | null): boolean {
  try {
    sessionStorage.setItem(DISPLAY_TOKEN_REJECTED_KEY, '1');
    if (!token || sessionStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) === token) {
      sessionStorage.removeItem(DISPLAY_TOKEN_STORAGE_KEY);
    }
    return sessionStorage.getItem(DISPLAY_TOKEN_REJECTED_KEY) === '1'
      && (!token || sessionStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) !== token);
  } catch {
    return false;
  }
}

export function displayTokenWasRejected(): boolean {
  try {
    return sessionStorage.getItem(DISPLAY_TOKEN_REJECTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function readDisplayToken(): string | null {
  try {
    if (sessionStorage.getItem(DISPLAY_TOKEN_REJECTED_KEY) === '1') return null;
    return sessionStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function captureDisplayToken(): string | null {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (fragment.has('displayToken')) {
    fragment.delete('displayToken');
    url.hash = fragment.toString();
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return readDisplayToken();
}

export class StationRequestError extends Error {
  constructor(readonly status: number) {
    super(`station request failed (${status})`);
  }
}

export async function fetchPublicStation(displayToken?: string | null): Promise<{ station: PublicStation; etag: string }> {
  const response = await fetch(
    displayToken ? '/api/arcade/station/display' : '/api/arcade/station/public',
    {
      cache: 'no-store',
      ...(displayToken ? { headers: { 'X-Arcade-Display-Token': displayToken } } : {}),
    },
  );
  if (!response.ok) throw new StationRequestError(response.status);
  return { station: await response.json() as PublicStation, etag: response.headers.get('etag') ?? '' };
}

export async function fetchPublicArcadeConfig(): Promise<PublicArcadeConfig> {
  const response = await fetch('/api/arcade/config/public', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Twilio Games settings request failed (${response.status})`);
  return response.json() as Promise<PublicArcadeConfig>;
}

export function effectivePublicVisitorBaseUrl(configuredBaseUrl?: unknown, pageHref?: string): string {
  const fallback = new URL('http://localhost/');
  let page = fallback;
  try {
    page = new URL(pageHref ?? globalThis.location?.href ?? fallback.href, fallback);
  } catch {
    // A malformed browser URL should not prevent a QR code from rendering.
  }
  const pageOrigin = page.protocol === 'http:' || page.protocol === 'https:' ? page.origin : fallback.origin;
  for (const candidate of [configuredBaseUrl, page.searchParams.get('joinBaseUrl'), pageOrigin]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const url = new URL(candidate, pageOrigin);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch {
      // Try the next source, ending with the current browser origin.
    }
  }
  return pageOrigin;
}

export function stationJoinUrl(stationId: string, locale: string, baseUrl?: string | null): string {
  const url = new URL('/join', effectivePublicVisitorBaseUrl(baseUrl));
  url.searchParams.set('station', stationId);
  url.searchParams.set('locale', locale);
  return url.toString();
}

export function stationLaunchUrl(
  station: PublicStation,
  stationId: string,
  locale: string,
  joinBaseUrl?: string | null,
): string | null {
  if (!station.launch) return null;
  const url = new URL(station.launch.route, globalThis.location?.origin ?? 'http://localhost');
  url.searchParams.set('display', '1');
  url.searchParams.set('room', station.launch.roomCode);
  url.searchParams.set('locale', locale);
  url.searchParams.set('station', stationId);
  url.searchParams.set('match', station.launch.matchId);
  url.searchParams.set('launchGeneration', String(station.launch.generation));
  url.searchParams.set('joinBaseUrl', effectivePublicVisitorBaseUrl(joinBaseUrl));
  return url.toString();
}

export function subscribeToStation(onUpdate: () => void, onAdmission?: (event:StationAdmissionEvent) => void): () => void {
  const source = new EventSource('/api/arcade/events');
  source.addEventListener('arcade_station_updated', onUpdate);
  source.addEventListener('arcade_config_updated', onUpdate);
  source.addEventListener('open', onUpdate);
  source.addEventListener('arcade_ready_entry_added',event=>{
    try{
      const value=JSON.parse((event as MessageEvent<string>).data) as Partial<StationAdmissionEvent>;
      if(value.type==='arcade_ready_entry_added'&&typeof value.revision==='number'
        &&Number.isSafeInteger(value.revision)&&value.revision>0
        &&typeof value.displayName==='string'&&value.displayName.trim().length>0&&value.displayName.length<=50
        &&(value.admission==='coin'||value.admission==='ready'))onAdmission?.(value as StationAdmissionEvent);
    }catch{/* Ignore malformed event payloads. */}
  });
  return () => source.close();
}

export function idempotencyKey(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}
