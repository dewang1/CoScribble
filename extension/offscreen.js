// Runs inside the extension's offscreen document

const api = globalThis.browser || globalThis.chrome;

// roomId to { ws, serverUrl, reconnectAttempts, reconnectTimer, closedByUs }
const sockets = new Map();

// roomId to the most recent {type: 'init', highlights, drawings} snapshot the server sent for that room
const lastSnapshot = new Map();

function statusForReadyState(ws) {
  if (!ws) return 'disconnected';
  if (ws.readyState === WebSocket.OPEN) return 'connected';
  if (ws.readyState === WebSocket.CONNECTING) return 'connecting';
  return 'disconnected';
}

function connect(room, serverUrl, clientId) {
  let entry = sockets.get(room);
  if (entry && entry.ws && (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING)) {
    // Already connected/connecting for this room
    const snapshot = lastSnapshot.get(room);
    if (snapshot) {
      api.runtime.sendMessage({ type: 'wa-off-event', room, event: 'message', payload: snapshot }).catch(() => {});
    } else {
      api.runtime
        .sendMessage({ type: 'wa-off-event', room, event: 'status', status: statusForReadyState(entry.ws) })
        .catch(() => {});
    }
    return;
  }
  entry = entry || { ws: null, serverUrl, clientId, reconnectAttempts: 0, reconnectTimer: null, closedByUs: false };
  entry.serverUrl = serverUrl;
  entry.clientId = clientId;
  entry.closedByUs = false;
  sockets.set(room, entry);
  openSocket(room);
}

function openSocket(room) {
  const entry = sockets.get(room);
  if (!entry) return;

  const url = `${entry.serverUrl}?room=${encodeURIComponent(room)}&clientId=${encodeURIComponent(entry.clientId)}`;
  const ws = new WebSocket(url);
  entry.ws = ws;

  ws.addEventListener('open', () => {
    entry.reconnectAttempts = 0;
    api.runtime.sendMessage({ type: 'wa-off-event', room, event: 'open' }).catch(() => {});
  });

  ws.addEventListener('message', (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (payload && payload.type === 'init') {
      lastSnapshot.set(room, payload);
    }
    api.runtime.sendMessage({ type: 'wa-off-event', room, event: 'message', payload }).catch(() => {});
  });

  ws.addEventListener('close', () => {
    lastSnapshot.delete(room);
    api.runtime.sendMessage({ type: 'wa-off-event', room, event: 'close' }).catch(() => {});
    if (entry.closedByUs) return;
    // Exponential backoff
    entry.reconnectAttempts += 1;
    const delay = Math.min(15000, 500 * 2 ** entry.reconnectAttempts);
    entry.reconnectTimer = setTimeout(() => openSocket(room), delay);
  });

  ws.addEventListener('error', () => {
  });
}

function disconnect(room) {
  const entry = sockets.get(room);
  if (!entry) return;
  entry.closedByUs = true;
  clearTimeout(entry.reconnectTimer);
  if (entry.ws) entry.ws.close();
  sockets.delete(room);
  lastSnapshot.delete(room);
}

function send(room, op) {
  const entry = sockets.get(room);
  if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) return false;
  entry.ws.send(JSON.stringify(op));
  return true;
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'wa-off-connect') {
    connect(msg.room, msg.serverUrl, msg.clientId);
  } else if (msg.type === 'wa-off-disconnect') {
    disconnect(msg.room);
  } else if (msg.type === 'wa-off-send') {
    sendResponse({ sent: send(msg.room, msg.op) });
    return true; // keep the message channel open for the async sendResponse
  }
});
