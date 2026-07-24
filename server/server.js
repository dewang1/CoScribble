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

// Applies one op to a room's canonical state
function applyOp(state, op) {
  switch (op.type) {
    case 'add_highlight':
      if (!state.highlights.some((h) => h.id === op.highlight.id)) {
        state.highlights.push(op.highlight);
      }
      break;
    case 'update_note': {
      const h = state.highlights.find((h) => h.id === op.id);
      if (h) {
        h.note = op.note;
        h.updatedAt = op.updatedAt;
      }
      break;
    }
    case 'delete_highlight':
      state.highlights = state.highlights.filter((h) => h.id !== op.id);
      break;
    case 'add_drawing':
      if (!state.drawings.some((d) => d.id === op.drawing.id)) {
        state.drawings.push(op.drawing);
      }
      break;
    case 'erase_drawings': {
      const removed = new Set(op.removedIds || []);
      state.drawings = state.drawings.filter((d) => !removed.has(d.id));
      (op.addedDrawings || []).forEach((d) => state.drawings.push(d));
      break;
    }
    case 'clear':
      state.highlights = [];
      state.drawings = [];
      break;
    default:
      break; // unknown op type
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Web Annotator realtime server is running.\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const clientId = url.searchParams.get('clientId') || Math.random().toString(36).slice(2);

  if (!roomId) {
    ws.close(4000, 'Missing room');
    return;
  }

  const room = getRoom(roomId);
  room.clients.set(ws, clientId);

  // New/reconnecting clients always get a full snapshot first so they can reconcile
  ws.send(JSON.stringify({ type: 'init', highlights: room.state.highlights, drawings: room.state.drawings }));
  broadcastPresence(roomId, room);

  ws.on('message', (raw) => {
    let op;
    try {
      op = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!op || typeof op.type !== 'string') return;

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

server.listen(PORT, () => {
  console.log(`Web Annotator realtime server listening on :${PORT}`);
});
