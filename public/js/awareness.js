/**
 * ============================================================================
 * Live Awareness Protocol (Multi-user Cursors & Selection Highlighting)
 * ============================================================================
 * Tracks live presence, cursor positions, selections, and peer identities.
 * Inspired by y-protocols/awareness.
 */

const VIBRANT_COLORS = [
  '#2563eb', // Blue
  '#7c3aed', // Purple
  '#db2777', // Pink
  '#ea580c', // Orange
  '#059669', // Emerald
  '#0284c7', // Sky
  '#d97706', // Amber
  '#4f46e5', // Indigo
  '#e11d48', // Rose
  '#0d9488'  // Teal
];

const RANDOM_NAMES = [
  'Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Claude Shannon',
  'Margaret Hamilton', 'Donald Knuth', 'Linus Torvalds', 'Leslie Lamport',
  'Barbara Liskov', 'Tim Berners-Lee', 'Radia Perlman', 'John von Neumann'
];

class Awareness {
  /**
   * @param {CRDTDoc} doc
   */
  constructor(doc) {
    this.doc = doc;
    this.clientID = doc.clientId;

    // Pick a deterministic or random identity
    const colorIndex = Math.abs(this._hashString(this.clientID)) % VIBRANT_COLORS.length;
    const nameIndex = Math.abs(this._hashString(this.clientID)) % RANDOM_NAMES.length;

    this.localState = {
      user: {
        name: RANDOM_NAMES[nameIndex],
        color: VIBRANT_COLORS[colorIndex],
        colorLight: VIBRANT_COLORS[colorIndex] + '33', // 20% opacity for selection tint
        initials: this._getInitials(RANDOM_NAMES[nameIndex])
      },
      cursor: null, // { index: number }
      selection: null, // { start: number, end: number }
      updatedAt: Date.now()
    };

    /** @type {Map<string, Object>} peerID -> peerState */
    this.states = new Map();
    this.states.set(this.clientID, this.localState);

    this._listeners = {
      change: []
    };

    // Periodically clean up stale peers (heartbeat timeout: 15s)
    if (typeof window !== 'undefined') {
      setInterval(() => this._pruneStalePeers(), 5000);
    }
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  _getInitials(name) {
    return name
      .split(' ')
      .map(part => part[0])
      .join('')
      .toUpperCase()
      .substring(0, 2);
  }

  on(event, cb) {
    if (this._listeners[event]) {
      this._listeners[event].push(cb);
    }
  }

  emit(event, ...args) {
    if (this._listeners[event]) {
      for (const cb of this._listeners[event]) {
        cb(...args);
      }
    }
  }

  /**
   * Update local cursor and selection range
   * @param {number|null} cursorIndex
   * @param {{start: number, end: number}|null} selectionRange
   */
  setLocalCursor(cursorIndex, selectionRange = null) {
    this.localState.cursor = cursorIndex !== null ? { index: cursorIndex } : null;
    this.localState.selection = selectionRange;
    this.localState.updatedAt = Date.now();
    this.states.set(this.clientID, this.localState);

    this.emit('change', {
      added: [],
      updated: [this.clientID],
      removed: [],
      origin: 'local'
    });
  }

  /**
   * Update local user profile
   * @param {string} name
   */
  setLocalUserName(name) {
    if (!name) return;
    this.localState.user.name = name;
    this.localState.user.initials = this._getInitials(name);
    this.localState.updatedAt = Date.now();
    this.states.set(this.clientID, this.localState);

    this.emit('change', {
      added: [],
      updated: [this.clientID],
      removed: [],
      origin: 'local'
    });
  }

  /**
   * Encode local awareness state for network broadcast
   */
  encodeLocalState() {
    return {
      clientID: this.clientID,
      state: this.localState
    };
  }

  /**
   * Apply incoming remote peer awareness update
   * @param {Object} payload { clientID, state }
   */
  applyRemoteState(payload) {
    if (!payload || !payload.clientID || payload.clientID === this.clientID) return;

    const { clientID, state } = payload;
    const isNew = !this.states.has(clientID);

    if (state === null) {
      // Peer disconnected
      if (this.states.has(clientID)) {
        this.states.delete(clientID);
        this.emit('change', {
          added: [],
          updated: [],
          removed: [clientID],
          origin: 'remote'
        });
      }
      return;
    }

    state.updatedAt = Date.now();
    this.states.set(clientID, state);

    this.emit('change', {
      added: isNew ? [clientID] : [],
      updated: isNew ? [] : [clientID],
      removed: [],
      origin: 'remote'
    });
  }

  /**
   * Returns list of all active peer states excluding self
   */
  getRemoteStates() {
    const list = [];
    for (const [id, state] of this.states.entries()) {
      if (id !== this.clientID) {
        list.push({ clientID: id, ...state });
      }
    }
    return list;
  }

  /**
   * Returns count of all connected peers including self
   */
  getPeerCount() {
    return this.states.size;
  }

  _pruneStalePeers() {
    const now = Date.now();
    const removed = [];

    for (const [id, state] of this.states.entries()) {
      if (id !== this.clientID && now - (state.updatedAt || 0) > 15000) {
        this.states.delete(id);
        removed.push(id);
      }
    }

    if (removed.length > 0) {
      this.emit('change', {
        added: [],
        updated: [],
        removed,
        origin: 'prune'
      });
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Awareness, VIBRANT_COLORS, RANDOM_NAMES };
}
if (typeof window !== 'undefined') {
  window.Awareness = Awareness;
  window.VIBRANT_COLORS = VIBRANT_COLORS;
  window.RANDOM_NAMES = RANDOM_NAMES;
}
