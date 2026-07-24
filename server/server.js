'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { loadRoom, saveRoom } = require('./rooms-store');

const PORT = process.env.PORT || 8787;
const EVICT_AFTER_MS = 10 * 60 * 1000; // free memory for rooms nobody is viewing

// roomId to { state: {highlights, drawings}, clients: Map<ws, clientId>, idleTimer }
const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { state: loadRoom(roomId), clients: new Map(), idleTimer: null };
    rooms.set(roomId, room);
  }
  clearTimeout(room.idleTimer);
  return room;
}

function scheduleEviction(roomId, room) {
  clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => rooms.delete(roomId), EVICT_AFTER_MS);
}

function broadcast(room, payload, exceptWs) {
  const msg = JSON.stringify(payload);
  for (const client of room.clients.keys()) {
    if (client !== exceptWs && client.readyState === client.OPEN) client.send(msg);
  }
}

function broadcastPresence(roomId, room) {
  broadcast(room, { type: 'presence', count: room.clients.size }, null);
}

// Higher lamport wins. Ties broken by clientId
function stampWins(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.lamport !== b.lamport) return a.lamport > b.lamport;
  if (a.clientId !== b.clientId) return a.clientId > b.clientId;
  return true;
}

// Applies one op to a room's canonical state, mirroring applyOp() in content.js
function applyOp(state, op) {
  switch (op.kind) {
    case 'upsert_highlight': {
      let h = state.highlights.find((x) => x.id === op.id);
      if (!h) {
        h = {
          id: op.id,
          anchor: op.anchor,
          color: op.color,
          createdAt: op.createdAt,
          note: '',
          _presenceStamp: op.stamp,
          _noteStamp: op.stamp,
          _deleted: false,
        };
        state.highlights.push(h);
      } else if (stampWins(op.stamp, h._presenceStamp)) {
        h.anchor = op.anchor;
        h.color = op.color;
        h.createdAt = op.createdAt;
        h._deleted = false;
        h._presenceStamp = op.stamp;
      }
      break;
    }
    case 'delete_highlight': {
      const h = state.highlights.find((x) => x.id === op.id);
      if (h && stampWins(op.stamp, h._presenceStamp)) {
        h._deleted = true;
        h._presenceStamp = op.stamp;
      }
      break;
    }
    case 'update_note': {
      const h = state.highlights.find((x) => x.id === op.id);
      if (h && stampWins(op.stamp, h._noteStamp)) {
        h.note = op.note;
        h.updatedAt = op.updatedAt;
        h._noteStamp = op.stamp;
      }
      break;
    }
    case 'upsert_drawing': {
      let d = state.drawings.find((x) => x.id === op.id);
      if (!d) {
        d = { ...op.data, id: op.id, _presenceStamp: op.stamp, _deleted: false };
        state.drawings.push(d);
      } else if (stampWins(op.stamp, d._presenceStamp)) {
        Object.assign(d, op.data);
        d._deleted = false;
        d._presenceStamp = op.stamp;
      }
      break;
    }
    case 'delete_drawing': {
      const d = state.drawings.find((x) => x.id === op.id);
      if (d && stampWins(op.stamp, d._presenceStamp)) {
        d._deleted = true;
        d._presenceStamp = op.stamp;
      }
      break;
    }
    default:
      break; // unknown op kind, ignore
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('CoScribble realtime server is running.\n');
});

const wss = new WebSocketServer({ server });

// Heartbeat to detect dead socket
const HEARTBEAT_INTERVAL_MS = 30000;

function heartbeat() {
  this.isAlive = true;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const clientId = url.searchParams.get('clientId') || Math.random().toString(36).slice(2);

  if (!roomId) {
    ws.close(4000, 'Missing room');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  const room = getRoom(roomId);
  room.clients.set(ws, clientId);

  // New clients get a full snapshot first so they can reconcile against local cache
  ws.send(JSON.stringify({ type: 'init', highlights: room.state.highlights, drawings: room.state.drawings }));
  broadcastPresence(roomId, room);

  ws.on('message', (raw) => {
    let op;
    try {
      op = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!op || typeof op.kind !== 'string') return;

    applyOp(room.state, op);
    saveRoom(roomId, room.state);
    broadcast(room, op, ws);
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcastPresence(roomId, room);
    if (room.clients.size === 0) scheduleEviction(roomId, room);
  });
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, () => {
  console.log(`CoScribble realtime server listening on :${PORT}`);
});
