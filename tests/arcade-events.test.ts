import { describe, expect, it, vi } from 'vitest';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  ARCADE_STATION_UPDATED_EVENT,
  ArcadeEventHub,
  createArcadeConfigUpdatedEvent,
  createArcadeStationUpdatedEvent,
} from '../server/arcade-events';

describe('ArcadeEventHub', () => {
  it('publishes an immutable, minimal configuration event and supports unsubscribe', () => {
    const hub = new ArcadeEventHub();
    const subscriber = vi.fn();
    const unsubscribe = hub.subscribe(subscriber);

    hub.publish({
      type: ARCADE_CONFIG_UPDATED_EVENT,
      version: 3,
      updatedBy: 'private@example.com',
    } as never);

    expect(subscriber).toHaveBeenCalledOnce();
    const event = subscriber.mock.calls[0]![0];
    expect(event).toEqual({ type: 'arcade_config_updated', version: 3 });
    expect(Object.isFrozen(event)).toBe(true);

    unsubscribe();
    hub.publish(createArcadeConfigUpdatedEvent(4));
    expect(subscriber).toHaveBeenCalledOnce();
  });

  it('publishes only the station revision and strips attached aggregate data', () => {
    const hub = new ArcadeEventHub();
    const subscriber = vi.fn();
    hub.subscribe(subscriber);
    hub.publish({
      type: ARCADE_STATION_UPDATED_EVENT,
      revision: 9,
      players: [{ phone: '+14155550100' }],
    } as never);

    expect(subscriber).toHaveBeenCalledWith(createArcadeStationUpdatedEvent(9));
    expect(subscriber.mock.calls[0]![0]).toEqual({ type: 'arcade_station_updated', revision: 9 });
  });

  it('isolates synchronous and asynchronous subscriber failures', async () => {
    const errors: unknown[] = [];
    const hub = new ArcadeEventHub(error => errors.push(error));
    const healthy = vi.fn();
    hub.subscribe(() => { throw new Error('sync failure'); });
    hub.subscribe(async () => { throw new Error('async failure'); });
    hub.subscribe(healthy);

    expect(() => hub.publish(createArcadeConfigUpdatedEvent(2))).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(healthy).toHaveBeenCalledOnce();
    expect(errors.map(error => (error as Error).message).sort()).toEqual([
      'async failure',
      'sync failure',
    ]);
  });

  it('clears subscribers and rejects new subscriptions when closed', () => {
    const hub = new ArcadeEventHub();
    const subscriber = vi.fn();
    hub.subscribe(subscriber);
    hub.close();

    hub.publish(createArcadeConfigUpdatedEvent(2));
    expect(subscriber).not.toHaveBeenCalled();
    expect(hub.isClosed).toBe(true);
    expect(() => hub.subscribe(() => undefined)).toThrow(/closed/);
  });
});
