/**
 * identity.ts — persisted client identity. The clientId survives reloads
 * (reconnect-after-refresh keeps exactly one cursor, FR-6/FR-7); the name
 * is a convenience, persisted once the user sets it.
 */
const CLIENT_ID_KEY = "live-room:clientId";
const NAME_KEY = "live-room:name";

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / storage disabled
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* best-effort only */
  }
}

export function loadClientId(): string {
  const existing = safeGet(CLIENT_ID_KEY);
  if (existing !== null && existing.length > 0) return existing;
  const id = crypto.randomUUID();
  safeSet(CLIENT_ID_KEY, id);
  return id;
}

export function loadName(): string | undefined {
  const name = safeGet(NAME_KEY)?.trim();
  return name && name.length > 0 ? name.slice(0, 24) : undefined;
}

export function saveName(name: string): void {
  const trimmed = name.trim().slice(0, 24);
  if (trimmed.length > 0) safeSet(NAME_KEY, trimmed);
}
