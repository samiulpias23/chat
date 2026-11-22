// ==============================================================================
// INDEXEDDB CIPHERTEXT CACHE (ZERO-EGRESS MEDIA OPTIMIZATION)
// Caches ONLY encrypted bytes (.enc) so 15s lock unlock consumes 0 extra egress
// ==============================================================================

const DB_NAME = 'chataf_cipher_cache';
const DB_VERSION = 1;
const STORE_NAME = 'ciphertext_blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB not supported or running server-side.'));
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedCiphertext(path: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(path);
      req.onsuccess = () => {
        resolve(req.result ? req.result.buffer : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedCiphertext(path: string, buffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({ path, buffer, timestamp: Date.now() });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Non-fatal if IDB write fails (e.g. private browsing mode)
  }
}

export async function removeCachedCiphertext(path: string): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(path);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    });
  } catch {
    // Non-fatal
  }
}
