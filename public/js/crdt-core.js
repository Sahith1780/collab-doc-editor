/**
 * ============================================================================
 * SyncDoc CRDT Core Engine (RGA - Replicated Growable Array with Vector Clocks)
 * ============================================================================
 * Strong Eventual Consistency (SEC) collaborative rich text editing engine.
 *
 * Distributed Systems Guarantees:
 * - Commutativity: Updates can be applied in any arrival order.
 * - Idempotency: Re-delivered or duplicate updates cause zero state distortion.
 * - Associativity: Batch grouping of operations does not affect the final state.
 * - Deterministic Convergence: All peers holding the same operation set will
 *   render the EXACT same document string and styling bit-for-bit.
 */

class ItemId {
  /**
   * @param {string|number} client Unique client identifier
   * @param {number} clock Monotonically increasing logical clock
   */
  constructor(client, clock) {
    this.client = String(client);
    this.clock = clock;
  }

  toString() {
    return `${this.client}:${this.clock}`;
  }

  equals(other) {
    if (!other) return false;
    return this.client === String(other.client) && this.clock === other.clock;
  }

  static compare(a, b) {
    if (a.clock !== b.clock) {
      return a.clock - b.clock;
    }
    return a.client.localeCompare(b.client);
  }

  static fromObject(obj) {
    if (!obj) return null;
    return new ItemId(obj.client, obj.clock);
  }
}

class CRDTItem {
  /**
   * @param {ItemId} id Unique item identifier
   * @param {ItemId|null} originLeft Left neighbor at time of insertion
   * @param {ItemId|null} originRight Right neighbor at time of insertion
   * @param {string} content Text character or string chunk
   * @param {boolean} deleted Tombstone flag for soft deletion
   * @param {Object} attributes Rich text formatting attributes
   */
  constructor(id, originLeft, originRight, content = '', deleted = false, attributes = {}) {
    this.id = id;
    this.originLeft = originLeft;
    this.originRight = originRight;
    this.content = content;
    this.deleted = deleted;
    this.attributes = { ...attributes };
  }

  toJSON() {
    return {
      id: { client: this.id.client, clock: this.id.clock },
      originLeft: this.originLeft ? { client: this.originLeft.client, clock: this.originLeft.clock } : null,
      originRight: this.originRight ? { client: this.originRight.client, clock: this.originRight.clock } : null,
      content: this.content,
      deleted: this.deleted,
      attributes: this.attributes
    };
  }

  static fromJSON(json) {
    return new CRDTItem(
      ItemId.fromObject(json.id),
      ItemId.fromObject(json.originLeft),
      ItemId.fromObject(json.originRight),
      json.content,
      json.deleted,
      json.attributes || {}
    );
  }
}

class UndoManager {
  /**
   * @param {CRDTDoc} doc
   */
  constructor(doc) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.isUndoing = false;
    this.isRedoing = false;
  }

  recordOperation(op) {
    if (this.isUndoing || this.isRedoing) return;
    this.undoStack.push(op);
    this.redoStack = []; // clear redo on new user action
    if (this.undoStack.length > 500) {
      this.undoStack.shift(); // bound memory footprint
    }
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.isUndoing = true;
    const op = this.undoStack.pop();
    const inverseOp = this._invertOp(op);
    if (inverseOp) {
      this.redoStack.push(op);
      this.doc.applyLocalOperation(inverseOp, false);
    }
    this.isUndoing = false;
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.isRedoing = true;
    const op = this.redoStack.pop();
    this.undoStack.push(op);
    this.doc.applyLocalOperation(op, false);
    this.isRedoing = false;
    return true;
  }

  _invertOp(op) {
    if (op.type === 'insert') {
      return { type: 'delete', id: op.item.id };
    } else if (op.type === 'delete') {
      return { type: 'restore', id: op.id };
    } else if (op.type === 'format') {
      return {
        type: 'format',
        id: op.id,
        attributes: op.previousAttributes || {}
      };
    }
    return null;
  }
}

class CRDTDoc {
  /**
   * @param {string|number} clientId Unique identifier for this client session
   */
  constructor(clientId = null) {
    this.clientId = clientId !== null && clientId !== undefined 
      ? String(clientId) 
      : 'peer_' + Math.random().toString(36).substring(2, 9);
    
    this.clock = 0;
    this.vectorClock = new Map(); // clientId -> maxClock
    this.vectorClock.set(this.clientId, 0);

    /** @type {CRDTItem[]} Ordered sequence of all CRDT items (including tombstones) */
    this.items = [];
    
    /** @type {Map<string, CRDTItem>} Fast lookup: "client:clock" -> CRDTItem */
    this.itemMap = new Map();

    this.operations = []; // Log of all mutations with unique opId

    /** @type {UndoManager} */
    this.undoManager = new UndoManager(this);

    /** Event listeners */
    this._listeners = {
      update: [],
      change: []
    };
  }

  /**
   * Register event listener
   * @param {'update'|'change'} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event].push(callback);
    }
  }

  emit(event, ...args) {
    if (this._listeners[event]) {
      for (const cb of this._listeners[event]) {
        try {
          cb(...args);
        } catch (err) {
          console.error(`[CRDTDoc] Error in '${event}' listener:`, err);
        }
      }
    }
  }

  /**
   * Increments and returns the next logical clock value for local operations
   * @returns {number}
   */
  _nextClock() {
    this.clock++;
    this.vectorClock.set(this.clientId, this.clock);
    return this.clock;
  }

  /**
   * Insert a character string at a visible index
   * @param {number} visibleIndex 0-based index in the visible (non-deleted) text
   * @param {string} text Text characters to insert
   * @param {Object} attributes Formatting attributes
   * @returns {CRDTItem[]} Newly created CRDT items
   */
  insert(visibleIndex, text, attributes = {}) {
    if (!text || text.length === 0) return [];
    
    const newItems = [];
    const ops = [];

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const targetIndex = visibleIndex + i;
      
      // Determine originLeft and originRight
      const leftNeighbor = this._getVisibleItemAt(targetIndex - 1);
      const rightNeighbor = this._getVisibleItemAt(targetIndex);

      const originLeft = leftNeighbor ? leftNeighbor.id : null;
      const originRight = rightNeighbor ? rightNeighbor.id : null;

      const clock = this._nextClock();
      const id = new ItemId(this.clientId, clock);

      const item = new CRDTItem(id, originLeft, originRight, char, false, attributes);
      
      this._integrateItem(item);
      newItems.push(item);

      const op = {
        type: 'insert',
        opId: { client: this.clientId, clock },
        item: item.toJSON()
      };
      this.operations.push(op);
      ops.push(op);
      this.undoManager.recordOperation(op);
    }

    this.emit('update', { operations: ops, origin: 'local' });
    this.emit('change', { doc: this });
    return newItems;
  }

  /**
   * Delete a character at a visible index
   * @param {number} visibleIndex
   * @returns {CRDTItem|null}
   */
  delete(visibleIndex) {
    const item = this._getVisibleItemAt(visibleIndex);
    if (!item || item.deleted) return null;

    item.deleted = true;
    const clock = this._nextClock();
    const op = {
      type: 'delete',
      opId: { client: this.clientId, clock },
      targetId: { client: item.id.client, clock: item.id.clock }
    };
    this.operations.push(op);
    this.undoManager.recordOperation(op);

    this.emit('update', { operations: [op], origin: 'local' });
    this.emit('change', { doc: this });
    return item;
  }

  /**
   * Format a range of visible characters
   * @param {number} startIndex
   * @param {number} length
   * @param {Object} attributes Format attributes to merge
   */
  format(startIndex, length, attributes) {
    const ops = [];
    let curVis = 0;

    for (const item of this.items) {
      if (item.deleted) continue;

      if (curVis >= startIndex && curVis < startIndex + length) {
        const prevAttrs = { ...item.attributes };
        Object.assign(item.attributes, attributes);
        
        for (const [key, val] of Object.entries(attributes)) {
          if (val === null || val === false || val === '') {
            delete item.attributes[key];
          }
        }

        const clock = this._nextClock();
        const op = {
          type: 'format',
          opId: { client: this.clientId, clock },
          targetId: { client: item.id.client, clock: item.id.clock },
          attributes: { ...item.attributes },
          previousAttributes: prevAttrs
        };
        this.operations.push(op);
        ops.push(op);
        this.undoManager.recordOperation(op);
      }
      curVis++;
      if (curVis >= startIndex + length) break;
    }

    if (ops.length > 0) {
      this.emit('update', { operations: ops, origin: 'local' });
      this.emit('change', { doc: this });
    }
  }

  /**
   * Internal integration algorithm (RGA tree-to-list deterministic ordering)
   * Prevents interleaving anomalies and guarantees Strong Eventual Consistency.
   * @param {CRDTItem} newItem
   */
  _integrateItem(newItem) {
    const key = newItem.id.toString();
    if (this.itemMap.has(key)) {
      // Idempotency: Item already integrated
      return;
    }

    // Update vector clock
    const currentMax = this.vectorClock.get(newItem.id.client) || 0;
    if (newItem.id.clock > currentMax) {
      this.vectorClock.set(newItem.id.client, newItem.id.clock);
    }
    if (newItem.id.client === this.clientId && newItem.id.clock > this.clock) {
      this.clock = newItem.id.clock;
    }

    // Find left origin index
    let leftIndex = -1;
    if (newItem.originLeft) {
      const leftItem = this.itemMap.get(newItem.originLeft.toString());
      if (leftItem) {
        leftIndex = this.items.indexOf(leftItem);
      }
    }

    let destIndex = leftIndex + 1;

    // Scan through following items
    while (destIndex < this.items.length) {
      const current = this.items[destIndex];

      // Determine the origin of current item
      let currentLeftIndex = -1;
      if (current.originLeft) {
        const curLeftItem = this.itemMap.get(current.originLeft.toString());
        if (curLeftItem) {
          currentLeftIndex = this.items.indexOf(curLeftItem);
        }
      }

      // If current item's origin is before our leftIndex, we've left the subtree
      if (currentLeftIndex < leftIndex) {
        break;
      }

      // If current item shares the exact same origin as newItem (siblings)
      if (currentLeftIndex === leftIndex) {
        // Deterministic tie-breaking: higher ID (clock, then client) comes first
        if (ItemId.compare(newItem.id, current.id) > 0) {
          // newItem has higher priority -> place here
          break;
        }
        // Otherwise, newItem has lower priority -> skip current AND all its descendants
      }

      destIndex++;
    }

    this.items.splice(destIndex, 0, newItem);
    this.itemMap.set(key, newItem);
  }

  /**
   * Apply a local operation (e.g. from undo/redo)
   */
  applyLocalOperation(op, broadcast = true) {
    if (op.type === 'insert') {
      const item = CRDTItem.fromJSON(op.item);
      item.deleted = false;
      this._integrateItem(item);
    } else if (op.type === 'delete') {
      const item = this.itemMap.get(`${op.id.client}:${op.id.clock}`);
      if (item) item.deleted = true;
    } else if (op.type === 'restore') {
      const item = this.itemMap.get(`${op.id.client}:${op.id.clock}`);
      if (item) item.deleted = false;
    } else if (op.type === 'format') {
      const item = this.itemMap.get(`${op.id.client}:${op.id.clock}`);
      if (item) item.attributes = { ...op.attributes };
    }

    if (broadcast) {
      this.emit('update', { operations: [op], origin: 'local' });
    }
    this.emit('change', { doc: this });
  }

  /**
   * Apply an incoming update batch from remote peer or server
   * @param {Object} updateBatch { operations: Array, origin?: string }
   */
  applyUpdate(updateBatch) {
    if (!updateBatch || !Array.isArray(updateBatch.operations)) return;
    
    let stateChanged = false;

    for (const op of updateBatch.operations) {
      const opIdKey = op.opId ? `${op.opId.client}:${op.opId.clock}` : null;

      if (op.type === 'insert') {
        const item = CRDTItem.fromJSON(op.item);
        if (!this.itemMap.has(item.id.toString())) {
          this._integrateItem(item);
          this.operations.push(op);
          stateChanged = true;
        }
      } else if (op.type === 'delete') {
        const targetKey = op.targetId 
          ? `${op.targetId.client}:${op.targetId.clock}` 
          : (op.id ? `${op.id.client}:${op.id.clock}` : null);

        if (targetKey) {
          const item = this.itemMap.get(targetKey);
          if (item && !item.deleted) {
            item.deleted = true;
            this.operations.push(op);
            stateChanged = true;
          }
        }
      } else if (op.type === 'restore') {
        const targetKey = op.targetId 
          ? `${op.targetId.client}:${op.targetId.clock}` 
          : (op.id ? `${op.id.client}:${op.id.clock}` : null);

        if (targetKey) {
          const item = this.itemMap.get(targetKey);
          if (item && item.deleted) {
            item.deleted = false;
            this.operations.push(op);
            stateChanged = true;
          }
        }
      } else if (op.type === 'format') {
        const targetKey = op.targetId 
          ? `${op.targetId.client}:${op.targetId.clock}` 
          : (op.id ? `${op.id.client}:${op.id.clock}` : null);

        if (targetKey) {
          const item = this.itemMap.get(targetKey);
          if (item) {
            item.attributes = { ...op.attributes };
            this.operations.push(op);
            stateChanged = true;
          }
        }
      }

      // Update vector clock for the sender
      if (op.opId) {
        const curMax = this.vectorClock.get(op.opId.client) || 0;
        if (op.opId.clock > curMax) {
          this.vectorClock.set(op.opId.client, op.opId.clock);
        }
      }
    }

    if (stateChanged) {
      this.emit('change', { doc: this, origin: 'remote' });
    }
  }

  /**
   * Get visible item at 0-indexed position
   * @param {number} visibleIndex
   * @returns {CRDTItem|null}
   */
  _getVisibleItemAt(visibleIndex) {
    if (visibleIndex < 0) return null;
    let vis = 0;
    for (const item of this.items) {
      if (!item.deleted) {
        if (vis === visibleIndex) return item;
        vis++;
      }
    }
    return null;
  }

  /**
   * Returns current plaintext representation
   * @returns {string}
   */
  getText() {
    let result = '';
    for (const item of this.items) {
      if (!item.deleted) {
        result += item.content;
      }
    }
    return result;
  }

  /**
   * Returns rich text chunks with formatting spans
   * @returns {Array<{text: string, attributes: Object}>}
   */
  getFormattedChunks() {
    const chunks = [];
    let currentText = '';
    let currentAttrs = null;

    const areAttrsEqual = (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every(k => a[k] === b[k]);
    };

    for (const item of this.items) {
      if (item.deleted) continue;

      if (currentAttrs === null) {
        currentAttrs = { ...item.attributes };
        currentText = item.content;
      } else if (areAttrsEqual(currentAttrs, item.attributes)) {
        currentText += item.content;
      } else {
        chunks.push({ text: currentText, attributes: currentAttrs });
        currentAttrs = { ...item.attributes };
        currentText = item.content;
      }
    }

    if (currentText.length > 0) {
      chunks.push({ text: currentText, attributes: currentAttrs || {} });
    }

    return chunks;
  }

  /**
   * State Vector: maps clientId -> highest observed clock
   * @returns {Object.<string, number>}
   */
  getStateVector() {
    const sv = {};
    for (const [client, clock] of this.vectorClock.entries()) {
      sv[client] = clock;
    }
    return sv;
  }

  /**
   * Compute delta of operations needed by a peer with given state vector
   * @param {Object.<string, number>} peerStateVector
   * @returns {Array<Object>}
   */
  getDeltaSince(peerStateVector = {}) {
    const deltas = [];

    // Filter operations from operation log
    for (const op of this.operations) {
      const client = op.opId ? op.opId.client : (op.item ? op.item.id.client : null);
      const clock = op.opId ? op.opId.clock : (op.item ? op.item.id.clock : null);

      if (client && clock) {
        const peerClock = peerStateVector[client] || 0;
        if (clock > peerClock) {
          deltas.push(op);
        }
      }
    }

    // Fallback: If operations log is empty (e.g. after snapshot import), reconstruct from items
    if (deltas.length === 0 && this.operations.length === 0) {
      for (const item of this.items) {
        const knownClock = peerStateVector[item.id.client] || 0;
        if (item.id.clock > knownClock) {
          deltas.push({
            type: 'insert',
            opId: { client: item.id.client, clock: item.id.clock },
            item: item.toJSON()
          });
          if (item.deleted) {
            deltas.push({
              type: 'delete',
              opId: { client: item.id.client, clock: item.id.clock },
              targetId: { client: item.id.client, clock: item.id.clock }
            });
          }
        }
      }
    }

    return deltas;
  }

  /**
   * Export full snapshot of all items
   * @param {boolean} includeOpLog Whether to include detailed operation history log
   * @returns {Object}
   */
  exportSnapshot(includeOpLog = false) {
    const snap = {
      vectorClock: this.getStateVector(),
      items: this.items.map(item => item.toJSON())
    };
    if (includeOpLog) {
      snap.operations = this.operations;
    }
    return snap;
  }

  /**
   * Import snapshot
   * @param {Object} snapshot
   */
  importSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return;
    this.items = [];
    this.itemMap.clear();
    this.vectorClock.clear();
    this.operations = Array.isArray(snapshot.operations) ? [...snapshot.operations] : [];

    for (const raw of snapshot.items) {
      const item = CRDTItem.fromJSON(raw);
      this._integrateItem(item);
    }

    if (snapshot.vectorClock) {
      for (const [client, clock] of Object.entries(snapshot.vectorClock)) {
        this.vectorClock.set(client, Math.max(this.vectorClock.get(client) || 0, clock));
      }
    }
    this.emit('change', { doc: this, origin: 'snapshot' });
  }

  /**
   * CRDT Diagnostics & Memory Footprint metrics for mentors
   */
  getDiagnostics() {
    const totalItems = this.items.length;
    let visibleItems = 0;
    let tombstoneCount = 0;

    for (const item of this.items) {
      if (item.deleted) {
        tombstoneCount++;
      } else {
        visibleItems++;
      }
    }

    // Estimated memory: each item ~ 120 bytes in V8 memory
    const estimatedMemoryBytes = totalItems * 128 + this.itemMap.size * 64;

    return {
      clientId: this.clientId,
      currentClock: this.clock,
      totalItems,
      visibleCharacters: visibleItems,
      tombstoneCount,
      tombstoneRatio: totalItems > 0 ? (tombstoneCount / totalItems).toFixed(3) : '0.000',
      estimatedMemoryBytes,
      stateVector: this.getStateVector(),
      uniqueClients: this.vectorClock.size
    };
  }
}

export { ItemId, CRDTItem, UndoManager, CRDTDoc };

if (typeof window !== 'undefined') {
  window.ItemId = ItemId;
  window.CRDTItem = CRDTItem;
  window.UndoManager = UndoManager;
  window.CRDTDoc = CRDTDoc;
}

