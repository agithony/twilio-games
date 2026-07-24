export const ARCADE_CONFIG_UPDATED_EVENT = 'arcade_config_updated' as const;
export const ARCADE_STATION_UPDATED_EVENT = 'arcade_station_updated' as const;
export const ARCADE_READY_ENTRY_ADDED_EVENT = 'arcade_ready_entry_added' as const;

export type ArcadeConfigUpdatedEvent = Readonly<{
  type: typeof ARCADE_CONFIG_UPDATED_EVENT;
  version: number;
}>;

export type ArcadeStationUpdatedEvent = Readonly<{
  type: typeof ARCADE_STATION_UPDATED_EVENT;
  revision: number;
}>;

export type ArcadeReadyEntryAddedEvent = Readonly<{
  type: typeof ARCADE_READY_ENTRY_ADDED_EVENT;
  revision: number;
  displayName: string;
  admission: 'coin' | 'ready';
}>;

export type ArcadeEvent = ArcadeConfigUpdatedEvent | ArcadeStationUpdatedEvent | ArcadeReadyEntryAddedEvent;
export type ArcadeEventSubscriber = (event: ArcadeEvent) => void | Promise<void>;

export interface ArcadeEventPublisher {
  publish(event: ArcadeEvent): void;
}

export function createArcadeConfigUpdatedEvent(version: number): ArcadeConfigUpdatedEvent {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('arcade config event version must be a positive safe integer');
  }
  return Object.freeze({ type: ARCADE_CONFIG_UPDATED_EVENT, version });
}

export function createArcadeStationUpdatedEvent(revision: number): ArcadeStationUpdatedEvent {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('arcade station event revision must be a positive safe integer');
  }
  return Object.freeze({ type: ARCADE_STATION_UPDATED_EVENT, revision });
}

export function createArcadeReadyEntryAddedEvent(
  revision: number,
  displayNameInput: string,
  admission: 'coin' | 'ready',
): ArcadeReadyEntryAddedEvent {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('ready entry event revision must be positive');
  const displayName = displayNameInput.trim().slice(0, 50);
  if (!displayName) throw new TypeError('ready entry event display name is required');
  if (admission !== 'coin' && admission !== 'ready') throw new TypeError('ready entry event admission is invalid');
  return Object.freeze({ type: ARCADE_READY_ENTRY_ADDED_EVENT, revision, displayName, admission });
}

export class ArcadeEventHub implements ArcadeEventPublisher {
  private readonly subscribers = new Set<ArcadeEventSubscriber>();
  private closed = false;

  constructor(private readonly onSubscriberError?: (error: unknown) => void) {}

  subscribe(subscriber: ArcadeEventSubscriber): () => void {
    if (this.closed) throw new Error('arcade event hub is closed');
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(event: ArcadeEvent): void {
    if (this.closed) return;

    // Rebuild each event so callers cannot attach internal state or actor fields.
    const safeEvent = event.type === ARCADE_CONFIG_UPDATED_EVENT
      ? createArcadeConfigUpdatedEvent(event.version)
      : event.type === ARCADE_STATION_UPDATED_EVENT
        ? createArcadeStationUpdatedEvent(event.revision)
        : createArcadeReadyEntryAddedEvent(event.revision, event.displayName, event.admission);
    for (const subscriber of [...this.subscribers]) {
      try {
        const result = subscriber(safeEvent);
        void Promise.resolve(result).catch(error => this.report(error));
      } catch (error) {
        this.report(error);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.subscribers.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private report(error: unknown): void {
    try {
      this.onSubscriberError?.(error);
    } catch {
      // Error reporting must not break publication isolation.
    }
  }
}

export { ArcadeEventHub as EventHub };
