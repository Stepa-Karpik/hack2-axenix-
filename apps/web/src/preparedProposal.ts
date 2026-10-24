export interface ProposalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const preparedKey = (projectId: string) =>
  "java-blueprints:prepared-proposal:" + projectId;
export function readPrepared(
  projectId: string,
  storage?: ProposalStorage,
): string | null {
  try {
    const store = storage ?? localStorage,
      id = store.getItem(preparedKey(projectId));
    if (!id) return null;
    if (uuid.test(id)) return id;
    if (store.getItem(preparedKey(projectId)) === id)
      store.removeItem(preparedKey(projectId));
  } catch {}
  return null;
}
export function writePrepared(
  projectId: string,
  id: string,
  storage?: ProposalStorage,
): boolean {
  if (!uuid.test(id)) return false;
  try {
    (storage ?? localStorage).setItem(preparedKey(projectId), id);
    return true;
  } catch {
    return false;
  }
}
/** Best-effort hint cleanup; the server remains authoritative. localStorage has no atomic CAS. */
export function clearPrepared(
  projectId: string,
  expected: string,
  storage?: ProposalStorage,
): boolean {
  try {
    const store = storage ?? localStorage;
    if (store.getItem(preparedKey(projectId)) !== expected) return false;
    store.removeItem(preparedKey(projectId));
    return true;
  } catch {
    return false;
  }
}
