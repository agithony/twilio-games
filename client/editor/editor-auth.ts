// Editor/garage authentication. A credential may be supplied once in a #token= fragment. Token
// parameters are always scrubbed from the query, but never accepted there. The credential is
// remembered locally and sent only through x-editor-token. Local dev remains open without a token.

const LS_KEY = 'voiceRacer.editorToken';

export interface ConsumedEditorToken {
  token: string;
  scrubbedPath: string | null;
}

export function consumeEditorToken(url: URL): ConsumedEditorToken {
  const queryHasToken = url.searchParams.has('token');
  const hashParams = new URLSearchParams(url.hash.slice(1));
  const hashHasToken = hashParams.has('token');
  const hashToken = hashParams.get('token')?.trim() ?? '';

  if (!queryHasToken && !hashHasToken) return { token: '', scrubbedPath: null };
  url.searchParams.delete('token');
  if (hashHasToken) {
    hashParams.delete('token');
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : '';
  }
  return {
    token: hashToken,
    scrubbedPath: `${url.pathname}${url.search}${url.hash}`,
  };
}

function readInitial(): string {
  let fromUrl = '';
  try {
    const consumed = consumeEditorToken(new URL(location.href));
    fromUrl = consumed.token;
    if (consumed.scrubbedPath !== null) {
      history.replaceState(history.state, '', consumed.scrubbedPath);
    }
  } catch { /* URL/history access may be unavailable in embedded contexts. */ }
  if (fromUrl) {
    try { localStorage.setItem(LS_KEY, fromUrl); } catch { /* Keep it in memory for this page. */ }
    return fromUrl;
  }
  try { return localStorage.getItem(LS_KEY) ?? ''; } catch { return ''; }
}

let editorToken = readInitial();

/** Headers to attach to an /api write. Adds x-editor-token only when a token is known, so local dev
 *  (no token) is unaffected. Merge into a fetch() headers object. */
export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return editorToken ? { ...base, 'x-editor-token': editorToken } : { ...base };
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

/** True when we currently hold a token (initial entry, prompt, or remembered). */
export const hasEditorToken = () => editorToken.length > 0;
