// Editor/garage write authentication. On a PUBLIC deploy the server sets EDITOR_TOKEN and gates all
// /api writes (manifest + maps) — a request must present the token via ?token= or the x-editor-token
// header, else 401. To avoid URL juggling, the token is resolved from (in order): the page URL
// (?token=…), then localStorage (remembered from a previous entry). If a write still 401s, callers
// call promptForToken() which asks once, stores it, and lets the caller retry. Local dev (no
// EDITOR_TOKEN) needs no token — the header is simply absent and writes are open.

const LS_KEY = 'voiceRacer.editorToken';

function readInitial(): string {
  try {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) { localStorage.setItem(LS_KEY, fromUrl); return fromUrl; }   // URL wins + is remembered
    return localStorage.getItem(LS_KEY) ?? '';
  } catch { return ''; }
}

let editorToken = readInitial();

/** Headers to attach to an /api write. Adds x-editor-token only when a token is known, so local dev
 *  (no token) is unaffected. Merge into a fetch() headers object. */
export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return editorToken ? { ...base, 'x-editor-token': editorToken } : { ...base };
}

/** Append ?token= to a URL for verbs where a header is awkward (e.g. DELETE via query). */
export function withToken(url: string): string {
  if (!editorToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(editorToken)}`;
}

/** Ask the user for the editor token (once), remember it, and return whether one was entered. Callers
 *  invoke this after a 401, then retry the write. Returns false if the user cancelled. */
export function promptForToken(): boolean {
  let entered = '';
  try { entered = (prompt('This deploy requires an editor token to save. Paste your EDITOR_TOKEN:') ?? '').trim(); } catch { entered = ''; }
  if (!entered) return false;
  editorToken = entered;
  try { localStorage.setItem(LS_KEY, entered); } catch { /* private mode: keep it in memory only */ }
  return true;
}

/** True when we currently hold a token (URL or remembered). */
export const hasEditorToken = () => editorToken.length > 0;
