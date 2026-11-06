/**
 * Offline copy of the member's card (D-09): the pass id and secret live in IndexedDB on the
 * member's own device so the rotating QR works in a basement with no signal. Wiped on sign-out,
 * when the server says the session is gone, and when the pass is revoked.
 * Browser-only; every call fails soft (private mode, blocked storage).
 */
export type StoredCard = {
  tenantId: string;
  userId: string;
  member: { name: string; memberCode: string; hasPhoto: boolean };
  gym: string;
  branch: string;
  membership: {
    planName: string;
    status: string;
    active: boolean;
    endDate: string;
  } | null;
  pass: { passId: string; secret: string; stepSeconds: number } | null;
  passRevoked: boolean;
  /** When the copy was fetched (device clock), and server − device clock difference. */
  syncedAt: number;
  clockOffsetMs: number;
};

const DB = "gym-member";
const STORE = "card";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function loadCard(): Promise<StoredCard | null> {
  const value = await run<StoredCard | undefined>("readonly", (s) =>
    s.get(KEY),
  );
  return value ?? null;
}

export async function saveCard(card: StoredCard): Promise<void> {
  await run("readwrite", (s) => s.put(card, KEY));
}

export async function wipeCard(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY));
}
