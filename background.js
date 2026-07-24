
const api = globalThis.browser || globalThis.chrome;

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
  }
});

api.tabs.onRemoved.addListener((tabId) => enabledTabs.delete(tabId));
