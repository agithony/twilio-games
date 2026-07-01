// Editor/garage write authentication. On a PUBLIC deploy the server sets EDITOR_TOKEN and gates all
// /api writes (manifest + maps) — a request must present the token via ?token= or the x-editor-token
// header, else 401. The editor + garage pages are opened with the token in their own URL
// (/garage?token=XXX, /editor?token=XXX); this reads it once and adds it to every write request.
// Local dev (no EDITOR_TOKEN) needs no token — the header is simply absent and writes are open.

/** The editor token from this page's URL (?token=…), or '' if none. Read once at module load. */
const EDITOR_TOKEN = (() => {
  try { return new URLSearchParams(location.search).get('token') ?? ''; } catch { return ''; }
})();

/** Headers to attach to an /api write. Adds x-editor-token only when a token is present, so local
 *  dev (no token) is unaffected. Merge into a fetch() headers object. */
export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return EDITOR_TOKEN ? { ...base, 'x-editor-token': EDITOR_TOKEN } : { ...base };
}

/** Append ?token= to a URL for verbs where a header is awkward (e.g. DELETE via query). Idempotent. */
export function withToken(url: string): string {
  if (!EDITOR_TOKEN) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(EDITOR_TOKEN)}`;
}

/** True when this page was opened with a token (useful for a UI hint). */
export const hasEditorToken = EDITOR_TOKEN.length > 0;
