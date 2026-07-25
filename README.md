# CoScribble

Highlight, comment on, and draw over any webpage — live, with other people.

CoScribble is a Manifest V3 browser extension that turns any page into a shared canvas. Select text to highlight it and attach a note, or switch to draw mode to sketch, circle, and annotate directly on top of the page. Everything syncs in real time to anyone else looking at the same URL.

## Features

- **Highlights with notes** — select text, pick a color, and optionally attach a note. Click a highlight any time to reopen its note.
- **Freehand drawing tools** — pencil, line, rectangle, ellipse, and an eraser, each with adjustable color, opacity, and brush radius. Hold **Shift** while dragging a line/rect/ellipse to constrain it to straight/square/circular.
- **Undo / redo** — full history stack (`Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y`), including compound operations like erasing a stroke that splits it into pieces.
- **Live collaboration** — highlights, notes, and drawings broadcast to every other tab open on the same page via a small WebSocket server, with a status indicator (`Live`, `Connecting…`, `Offline`) and a live peer count.
- **Resilient anchoring** — highlights are anchored by text offset *and* a quote (with surrounding context), so they can re-locate themselves even if the page's DOM shifts.
- **Per-page persistence** — annotations are saved locally per normalized URL (tracking params like `utm_*`, `fbclid`, `gclid`, etc. are stripped so the same page keeps its annotations regardless of how you arrived at it).
- **Draggable, minimal toolbar** — a small floating control bar that remembers where you last dropped it.
- **Per-tab toggle** — click the toolbar icon to turn CoScribble on/off for the current tab; it resets automatically on navigation.

## How it works

CoScribble has three moving parts:

1. **Content script** (`content.js`) — injected into every page. Owns highlight/drawing rendering, the toolbar UI, local persistence, and conflict resolution.
2. **Background service worker** (`background.js`) — tracks which tabs are enabled, manages room membership (which tabs are viewing which page), and relays realtime messages between content scripts and the offscreen document.
3. **Offscreen document** (`offscreen.js` / `offscreen.html`) — holds the actual WebSocket connections to the sync server. This lives outside the service worker's lifecycle so the connection survives service worker suspension.

Conflicts between simultaneous edits are resolved with **Lamport clocks**: each edit is timestamped with a logical clock + client id, and the highest stamp always wins, with ties broken by client id. The server keeps a canonical, last-write-wins snapshot per room.

A room is identified the normalized page URL. The server keeps each room's state in memory while at least one client is connected.

## Project structure

```
manifest.json      Extension manifest (MV3)
background.js       Service worker: tab state, room bookkeeping, message relay
offscreen.js         Offscreen document: WebSocket connection per room
offscreen.html       Host page for offscreen.js
content.js           Injected UI, rendering, anchoring, local state, CRDT logic
styles.css           Styles for highlights, note icons, and the note popover

server.js            Realtime sync server (Node + ws)
rooms-store.js       Per-room persistence to disk
package.json / package-lock.json
```

## Installation (extension)

1. Clone this repository.
2. Open your browser's extensions page:
   - Chrome/Edge/Brave: `chrome://extensions`
   - Firefox: Support will be added later
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.
5. Pin the extension and click its toolbar icon on any page to turn CoScribble on.

## Running the sync server

Realtime sync requires the included WebSocket server running locally.

```bash
npm install
npm start
```

By default the server listens on port `8787`. Room data is written to a `data/` folder next to `server.js`.

The extension currently points at `ws://localhost:8787`.

## Usage

1. Click the CoScribble toolbar icon to enable it on the current tab.
2. Click **Annotate**, pick a color, then select text on the page to highlight it. Click any highlight to add or edit a note.
3. Click **Draw**, choose a tool, color, opacity, and radius, and draw directly on the page.
4. Use the undo/redo icons (or the keyboard shortcuts) to step back and forward through your changes.
5. The status indicator in the toolbar shows whether you're connected to the sync server and how many others are viewing the same page.
6. Use the trash icon to clear all highlights and drawings from the current page.

## License

MIT License — see LICENSE file for details.
