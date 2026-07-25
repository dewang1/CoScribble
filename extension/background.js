// Cross-browser shim
const api = globalThis.browser || globalThis.chrome;

// Persistent bookkeeping

const STATE_KEY = 'wa-bg-state';
let statePromise = null;

function emptyState() {
  return { enabledTabs: [], tabRooms: {}, roomTabs: {} };
}

async function loadState() {
  if (!statePromise) {
    statePromise = (async () => {
      try {
        const stored = await api.storage.session.get(STATE_KEY);
        return stored[STATE_KEY] || emptyState();
      } catch (e) {
        // Storage.session unavailable in this browser
        // Fall back to a fresh in-memory-only state
        return emptyState();
      }
    })();
  }
  return statePromise;
}

async function saveState(state) {
  statePromise = Promise.resolve(state);
  try {
    await api.storage.session.set({ [STATE_KEY]: state });
  } catch (e) {
  }
}

function setBadge(tabId, on) {
  api.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
  if (on) api.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
}

api.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const state = await loadState();
  const enabledSet = new Set(state.enabledTabs);
  const nextEnabled = !enabledSet.has(tab.id);
  if (nextEnabled) enabledSet.add(tab.id);
  else enabledSet.delete(tab.id);
  state.enabledTabs = [...enabledSet];
  await saveState(state);
  setBadge(tab.id, nextEnabled);

  try {
    await api.tabs.sendMessage(tab.id, { type: 'wa-toggle', enabled: nextEnabled });
  } catch (err) {
    // Content script may not be present
  }
});

// A fresh navigation means the content script re-injects in a disabled state
api.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const state = await loadState();
    const enabledSet = new Set(state.enabledTabs);
    enabledSet.delete(tabId);
    state.enabledTabs = [...enabledSet];
    await saveState(state);
    setBadge(tabId, false);
    await leaveRoom(tabId);
  }
});

api.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  const enabledSet = new Set(state.enabledTabs);
  enabledSet.delete(tabId);
  state.enabledTabs = [...enabledSet];
  await saveState(state);
  await leaveRoom(tabId);
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

// Lets us route incoming server message for a room to every tab viewing the room
// Tell the offscreen document when a room has no tabs left and its socket can be closed
async function joinRoom(tabId, room) {
  await leaveRoom(tabId); // in case tab was already in a different room
  const state = await loadState();
  state.tabRooms[tabId] = room;
  if (!state.roomTabs[room]) state.roomTabs[room] = [];
  if (!state.roomTabs[room].includes(tabId)) state.roomTabs[room].push(tabId);
  await saveState(state);
}

async function leaveRoom(tabId) {
  const state = await loadState();
  const room = state.tabRooms[tabId];
  if (!room) return;
  delete state.tabRooms[tabId];
  const tabs = state.roomTabs[room];
  if (tabs) {
    const idx = tabs.indexOf(tabId);
    if (idx !== -1) tabs.splice(idx, 1);
    if (tabs.length === 0) {
      delete state.roomTabs[room];
      api.runtime.sendMessage({ type: 'wa-off-disconnect', room }).catch(() => {});
    }
  }
  await saveState(state);
}

async function tellTabs(room, message) {
  const state = await loadState();
  const tabs = state.roomTabs[room];
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
    joinRoom(tabId, msg.room).then(() =>
      ensureOffscreen().then(() => {
        api.runtime
          .sendMessage({
            type: 'wa-off-connect',
            room: msg.room,
            serverUrl: msg.serverUrl,
            clientId: msg.clientId,
          })
          .catch(() => {});
      })
    );
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
    const { room, event, payload, status } = msg;
    if (event === 'open') {
      tellTabs(room, { type: 'wa-rt-status', status: 'connected' });
    } else if (event === 'status') {
      // Sent when offscreen.js is asked to connect a room that already has a live socket
      tellTabs(room, { type: 'wa-rt-status', status });
    } else if (event === 'close') {
      tellTabs(room, { type: 'wa-rt-status', status: 'disconnected' });
    } else if (event === 'message') {
      tellTabs(room, { type: 'wa-rt-incoming', payload });
    }
    return;
  }
});
