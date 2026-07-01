import { parseManifest, EMPTY_MANIFEST } from '../../shared/asset-manifest';
import type { Manifest } from '../../shared/asset-manifest';
import { authHeaders } from './editor-auth';

/** GET the working manifest from the server, parsed/validated like the game loader. */
export async function fetchManifest(): Promise<Manifest> {
  const res = await fetch('/api/manifest');
  if (!res.ok) return { ...EMPTY_MANIFEST };
  return parseManifest(await res.text());
}

/** POST the manifest back to the server; returns the stored (re-validated) copy. THROWS on a non-OK
 *  response (e.g. 401 unauthorized on a token-gated deploy) so callers can surface a real error
 *  instead of silently reporting success — the "reorder/save didn't stick" bug. */
export async function saveManifest(m: Manifest): Promise<Manifest> {
  const res = await fetch('/api/manifest', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(m),
  });
  if (!res.ok) {
    const detail = res.status === 401 ? 'unauthorized — open this page with ?token=YOUR_EDITOR_TOKEN' : `HTTP ${res.status}`;
    throw new Error(`save failed: ${detail}`);
  }
  return res.json();
}

/** List the GLB files available to assign to a role. Falls back to []. */
export async function fetchAssets(): Promise<string[]> {
  try {
    const res = await fetch('/api/assets');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}
