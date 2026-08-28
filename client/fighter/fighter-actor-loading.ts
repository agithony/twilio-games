import type { FighterState } from '../../shared/fighter-protocol';

const ACTOR_PHASES = new Set<FighterState['phase']>(['loading', 'intro', 'countdown', 'fight']);

export interface FighterActorLoadContext {
  key: string;
  p1Id: string;
  p2Id: string;
}

export function fighterActorLoadContext(state: FighterState | null): FighterActorLoadContext | null {
  if (!state || !ACTOR_PHASES.has(state.phase)) return null;
  const p1Id = state.players.find(player => player.side === 'p1')?.fighterId;
  const p2Id = state.players.find(player => player.side === 'p2')?.fighterId;
  if (!p1Id || !p2Id) return null;
  return { key: `${state.loadingGeneration}:${p1Id}:${p2Id}`, p1Id, p2Id };
}

export class FighterActorLoadCoordinator {
  private key = '';
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fallbackAfterMs: number) {}

  start(
    key: string,
    load: () => Promise<void>,
    isCurrent: () => boolean,
    onReady: () => void,
    onFallback: (error?: unknown) => void,
  ): void {
    if (key === this.key) return;
    this.clear();
    this.key = key;
    const revision = this.revision;
    const useFallback = (error?: unknown) => {
      if (revision !== this.revision || key !== this.key || !isCurrent()) return;
      this.clear();
      onFallback(error);
    };
    this.timer = setTimeout(() => useFallback(), this.fallbackAfterMs);
    void Promise.resolve().then(load).then(() => {
      if (revision !== this.revision || key !== this.key || !isCurrent()) return;
      this.clear();
      onReady();
    }, useFallback);
  }

  clear(): void {
    this.revision += 1;
    this.key = '';
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
