const api = globalThis.browser || globalThis.chrome;

// Tracks which tabs currently have the extension turned on
const enabledTabs = new Set();

function setBadge(tabId, on) {
  api.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
  if (on) api.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
}

api.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const nextEnabled = !enabledTabs.has(tab.id);
  if (nextEnabled) enabledTabs.add(tab.id);
  else enabledTabs.delete(tab.id);
  setBadge(tab.id, nextEnabled);

  try {
    await api.tabs.sendMessage(tab.id, { type: 'wa-toggle', enabled: nextEnabled });
  } catch (err) {
    // Content script may not be present
  }
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    enabledTabs.delete(tabId);
    setBadge(tabId, false);
    leaveRoom(tabId);
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
  leaveRoom(tabId);
});

// Realtime relay

const OFFSCREEN_URL = 'offscreen.html';
let offscreenReadyPromise = null;

async function ensureOffscreen() {
  if (offscreenReadyPromise) return offscreenReadyPromise;
  offscreenReadyPromise = (async () => {
    const existing = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing && existing.length > 0) return;
    await api.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification:
        "Hold a persistent WebSocket connection for realtime annotation sync, outside the service worker's lifecycle and the host page's CSP.",
    });
  })();
  return offscreenReadyPromise;
}

// Route server message for a room to every tab viewing the room
// Tell the offscreen document when a room has no tabs left and socket can be closed
const tabRooms = new Map();
const roomTabs = new Map();

function joinRoom(tabId, room) {
  leaveRoom(tabId);
  tabRooms.set(tabId, room);
  if (!roomTabs.has(room)) roomTabs.set(room, new Set());
  roomTabs.get(room).add(tabId);
}

function leaveRoom(tabId) {
  const room = tabRooms.get(tabId);
  if (!room) return;
  tabRooms.delete(tabId);
  const tabs = roomTabs.get(room);
  if (tabs) {
    tabs.delete(tabId);
    if (tabs.size === 0) {
      roomTabs.delete(room);
      api.runtime.sendMessage({ type: 'wa-off-disconnect', room }).catch(() => {});
    }
  }
}

function tellTabs(room, message) {
  const tabs = roomTabs.get(room);
  if (!tabs) return;
  tabs.forEach((tabId) => {
    api.tabs.sendMessage(tabId, message).catch(() => {});
  });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // From a content script
  if (msg.type === 'wa-rt-connect') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    joinRoom(tabId, msg.room);
    ensureOffscreen().then(() => {
      api.runtime
        .sendMessage({
          type: 'wa-off-connect',
          room: msg.room,
          serverUrl: msg.serverUrl,
          clientId: msg.clientId,
        })
        .catch(() => {});
    });
    return;
  }

  if (msg.type === 'wa-rt-disconnect') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    leaveRoom(tabId);
    return;
  }

  if (msg.type === 'wa-rt-send') {
    ensureOffscreen().then(() => {
      api.runtime.sendMessage({ type: 'wa-off-send', room: msg.room, op: msg.op }).catch(() => {});
    });
    return;
  }

  // From the offscreen document
  if (msg.type === 'wa-off-event') {
    const { room, event, payload } = msg;
    if (event === 'open') {
      tellTabs(room, { type: 'wa-rt-status', status: 'connected' });
    } else if (event === 'close') {
      tellTabs(room, { type: 'wa-rt-status', status: 'disconnected' });
    } else if (event === 'message') {
      tellTabs(room, { type: 'wa-rt-incoming', payload });
    }
    return;
  }
});
