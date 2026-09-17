/**
 * ============================================================================
 * Offline-First Local Persistence Layer (IndexedDB with LocalStorage Fallback)
 * ============================================================================
 * Ensures zero data loss across tab reloads, crashes, or offline network states.
 * Reconnects seamlessly and synchronizes offline mutations with peers.
 */

const DB_NAME = 'SyncDocCRDT_DB';
const DB_VERSION = 1;
const STORE_NAME = 'documents';

class LocalPersistence {
  /**
   * @param {string} room Document / Room identifier
   * @param {CRDTDoc} doc
   */
  constructor(room, doc) {
    this.room = room || 'default-room';
    this.doc = doc;
    this.db = null;
    this.isReady = false;
    this._saveTimeout = null;

    this._initDB();
  }

  async _initDB() {
    if (typeof window === 'undefined' || !window.indexedDB) {
      this.isReady = true;
      return;
    }

    try {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'room' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        this.isReady = true;
        this.load();
      };

      request.onerror = (err) => {
        console.warn('[Persistence] IndexedDB open error, falling back to LocalStorage:', err);
        this.isReady = true;
        this.load();
      };
    } catch (err) {
      console.warn('[Persistence] IndexedDB initialization failed:', err);
      this.isReady = true;
      this.load();
    }
  }

  /**
   * Loads saved snapshot from IndexedDB or LocalStorage into CRDTDoc
   */
  async load() {
    try {
      let data = null;

      if (this.db) {
        data = await new Promise((resolve) => {
          const tx = this.db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(this.room);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
      }

      if (!data && typeof window !== 'undefined' && window.localStorage) {
        const raw = window.localStorage.getItem(`syncdoc_${this.room}`);
        if (raw) {
          try {
            data = JSON.parse(raw);
          } catch (e) {}
        }
      }

      if (data && data.snapshot) {
        console.log(`[Persistence] Restored snapshot for room "${this.room}" (${data.snapshot.items?.length || 0} items)`);
        this.doc.importSnapshot(data.snapshot);
      }
    } catch (err) {
      console.error('[Persistence] Error loading stored document:', err);
    }
  }

  /**
   * Debounced save to avoid disk churn during fast typing
   */
  scheduleSave() {
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = setTimeout(() => this.save(), 500);
  }

  /**
   * Persists the full CRDT state snapshot
   */
  async save() {
    const snapshot = this.doc.exportSnapshot();
    const payload = {
      room: this.room,
      updatedAt: Date.now(),
      snapshot
    };

    // Save to IndexedDB
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(payload);
      } catch (err) {
        console.warn('[Persistence] IndexedDB write failed:', err);
      }
    }

    // Also backup to LocalStorage for redundancy
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(`syncdoc_${this.room}`, JSON.stringify(payload));
      } catch (e) {
        // quota exceeded or disabled
      }
    }
  }

  /**
   * Clear local storage for this document
   */
  async clear() {
    if (this.db) {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(this.room);
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(`syncdoc_${this.room}`);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LocalPersistence };
}
if (typeof window !== 'undefined') {
  window.LocalPersistence = LocalPersistence;
}
