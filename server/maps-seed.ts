// Pure decision for seeding the persistent maps file (data/maps.json on the Azure Files mount) from
// the image's bundled defaults (assets/maps/maps.json). No fs here — the http layer reads the two
// files, calls this, and does the atomic write. See http-server.seedMapsFile() for the wiring.
//
// WHY: level configs authored in the PROD editor must survive deploys. The live file therefore lives
// on the persistent mount, not in the image. On first boot that file is absent, so we copy the
// git-shipped defaults into it ONCE. Thereafter the editor owns the persistent copy and deploys never
// touch it — fixing the "prod-authored levels wiped on every deploy" data-loss bug.

export interface SeedInputs {
  liveExists: boolean;        // does the persistent data/maps.json exist?
  liveText: string | null;    // its contents (null if absent/unreadable)
  bundledText: string | null; // the image's assets/maps/maps.json contents (null if absent)
}
export type SeedPlan = { write: true; contents: string } | { write: false };

/** True when `text` is a valid JSON object with at least the shape of a maps file (parseable object).
 *  An empty {} counts as intentional (author deleted every level) — we don't clobber that. */
function isUsableMaps(text: string | null): boolean {
  if (text === null) return false;
  const trimmed = text.trim();
  if (trimmed === '') return false;            // blank file → not usable, re-seed
  try {
    const o = JSON.parse(trimmed);
    return !!o && typeof o === 'object' && !Array.isArray(o);   // {} is usable (intentional-empty)
  } catch {
    return false;                              // corrupt JSON → re-seed rather than serve nothing
  }
}

/** Decide whether to seed the persistent maps file from the bundled defaults. Seed ONLY when the
 *  persistent copy is missing/blank/corrupt AND we have usable bundled defaults to copy. Never
 *  overwrites a valid persistent file (that's where prod-authored levels live). */
export function seedMapsPlan(inp: SeedInputs): SeedPlan {
  if (isUsableMaps(inp.liveText)) return { write: false };   // persistent copy is good — leave it
  if (!isUsableMaps(inp.bundledText)) return { write: false }; // nothing usable to seed from
  return { write: true, contents: inp.bundledText!.trim() };
}
