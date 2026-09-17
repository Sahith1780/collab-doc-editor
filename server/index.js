/**
 * ============================================================================
 * SyncDoc Real-Time Collaborative Server (CRDT WebSocket Relay & Persistence)
 * ============================================================================
 * Zero-dependency, ultra-lightweight Node.js server.
 * - Native RFC 6455 WebSocket implementation
 * - Multi-document room multiplexing
 * - Bidirectional CRDT state synchronization
 * - Local disk snapshot persistence (`server/storage/<room>.json`)
 * - Built-in static HTTP server for the rich web client
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { CRDTDoc } from '../public/js/crdt-core.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STORAGE_DIR = path.join(__dirname, 'storage');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Room Registry
// RoomName -> { clients: Set<WebSocketClient>, doc: CRDTDoc, saveTimeout: Timeout }
const rooms = new Map();

function getOrCreateRoom(roomName) {
  if (!rooms.has(roomName)) {
    const doc = new CRDTDoc('server_' + roomName);
    
    // Load persisted state if exists
    const storagePath = path.join(STORAGE_DIR, `${encodeURIComponent(roomName)}.json`);
    if (fs.existsSync(storagePath)) {
      try {
        const raw = fs.readFileSync(storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (data.snapshot) {
          doc.importSnapshot(data.snapshot);
          console.log(`[Storage] Restored room "${roomName}" from disk (${doc.items.length} items)`);
        }
      } catch (err) {
        console.error(`[Storage] Failed to load snapshot for "${roomName}":`, err);
      }
    }

    rooms.set(roomName, {
      name: roomName,
      clients: new Set(),
      doc,
      saveTimeout: null
    });
  }
  return rooms.get(roomName);
}

function scheduleRoomPersistence(room) {
  if (room.saveTimeout) clearTimeout(room.saveTimeout);
  room.saveTimeout = setTimeout(() => {
    try {
      const storagePath = path.join(STORAGE_DIR, `${encodeURIComponent(room.name)}.json`);
      const payload = {
        name: room.name,
        savedAt: Date.now(),
        snapshot: room.doc.exportSnapshot()
      };
      fs.writeFileSync(storagePath, JSON.stringify(payload, null, 2), 'utf8');
      console.log(`[Storage] Auto-saved room "${room.name}" snapshot to disk.`);
    } catch (err) {
      console.error(`[Storage] Auto-save failed for "${room.name}":`, err);
    }
  }, 1000);
}

// ============================================================================
// MIME Types & Static HTTP Server
// ============================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsedUrl.pathname;

  if (pathname === '/') {
    pathname = '/index.html';
  }

  // API endpoint: Get diagnostic health check
  if (pathname === '/api/health') {
    const activeRooms = [];
    for (const [name, r] of rooms.entries()) {
      activeRooms.push({
        room: name,
        activeClients: r.clients.size,
        totalItems: r.doc.items.length,
        visibleChars: r.doc.getText().length
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), rooms: activeRooms }));
    return;
  }

  const filePath = path.join(PUBLIC_DIR, pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

// ============================================================================
// Lightweight RFC 6455 WebSocket Server Implementation
// ============================================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  if (parsedUrl.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const roomName = parsedUrl.searchParams.get('room') || 'default-doc';
  const clientId = parsedUrl.searchParams.get('client') || 'peer_' + Math.random().toString(36).substring(2, 8);

  const digest = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${digest}`
  ];

  socket.write(headers.join('\r\n') + '\r\n\r\n');

  // Register client
  const client = new WebSocketConnection(socket, roomName, clientId);
  const room = getOrCreateRoom(roomName);
  room.clients.add(client);
  console.log(`[WebSocket] Client "${clientId}" joined room "${roomName}" (Total: ${room.clients.size})`);

  client.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleClientMessage(client, room, msg);
    } catch (e) {
      console.error('[WebSocket] Invalid JSON received:', e);
    }
  });

  client.on('close', () => {
    room.clients.delete(client);
    console.log(`[WebSocket] Client "${clientId}" left room "${roomName}" (Remaining: ${room.clients.size})`);
    
    // Broadcast peer departure awareness
    broadcastToRoom(room, client, {
      type: 'awareness',
      room: roomName,
      payload: { clientID: clientId, state: null }
    });
  });
});

function handleClientMessage(sender, room, msg) {
  if (msg.type === 'sync-step-1') {
    // Client sent its state vector.
    // Respond with missing deltas the server has that the client lacks.
    const clientSV = msg.stateVector || {};
    const missingOps = room.doc.getDeltaSince(clientSV);

    sender.sendJSON({
      type: 'sync-step-2',
      room: room.name,
      operations: missingOps,
      serverStateVector: room.doc.getStateVector()
    });

    // Also ask client for any ops server is missing
    const serverSV = room.doc.getStateVector();
    sender.sendJSON({
      type: 'sync-step-1',
      room: room.name,
      stateVector: serverSV
    });
  } else if (msg.type === 'sync-step-2' || msg.type === 'update') {
    // Apply incoming delta to server's in-memory CRDT copy
    if (Array.isArray(msg.operations) && msg.operations.length > 0) {
      room.doc.applyUpdate({ operations: msg.operations });
      scheduleRoomPersistence(room);

      // Broadcast update to all other connected peers in the room
      broadcastToRoom(room, sender, {
        type: 'update',
        room: room.name,
        operations: msg.operations
      });
    }
  } else if (msg.type === 'awareness') {
    // Relay awareness presence / cursor to peers
    broadcastToRoom(room, sender, msg);
  } else if (msg.type === 'ping') {
    sender.sendJSON({
      type: 'pong',
      timestamp: msg.timestamp
    });
  }
}

function broadcastToRoom(room, sender, message) {
  for (const client of room.clients) {
    if (client !== sender) {
      client.sendJSON(message);
    }
  }
}

// Low-level RFC 6455 Frame Parser and Sender
class WebSocketConnection {
  constructor(socket, roomName, clientId) {
    this.socket = socket;
    this.roomName = roomName;
    this.clientId = clientId;
    this.buffer = Buffer.alloc(0);
    this._listeners = { message: [], close: [] };

    this.socket.on('data', (chunk) => this._handleData(chunk));
    this.socket.on('end', () => this._emit('close'));
    this.socket.on('error', () => this._emit('close'));
  }

  on(event, cb) {
    if (this._listeners[event]) this._listeners[event].push(cb);
  }

  _emit(event, ...args) {
    if (this._listeners[event]) {
      for (const cb of this._listeners[event]) cb(...args);
    }
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  send(text) {
    if (this.socket.destroyed) return;
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;

    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (e) {
      // socket may have closed
    }
  }

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;

      let offset = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < 4) break;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) break;
        payloadLength = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskingKeyLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskingKeyLength + payloadLength) {
        break; // Wait for full frame
      }

      let maskKey = null;
      if (masked) {
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = this.buffer.subarray(offset, offset + payloadLength);
      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        this.socket.end();
        this._emit('close');
        return;
      } else if (opcode === 0x09) {
        // Ping frame -> reply with Pong
        const pong = Buffer.from([0x8a, 0x00]);
        this.socket.write(pong);
      } else if (opcode === 0x01) {
        // Text frame
        const str = payload.toString('utf8');
        this._emit('message', str);
      }
    }
  }
}

// Start Server
server.listen(PORT, () => {
  console.log(`
===================================================================
  SyncDoc CRDT Collaborative Server Running!
  URL: http://localhost:${PORT}
  WebSocket: ws://localhost:${PORT}/ws?room=default-doc
  Persistence: Enabled (Disk storage at server/storage/)
===================================================================
  Open http://localhost:${PORT} in your browser to start editing!
===================================================================
`);
});
