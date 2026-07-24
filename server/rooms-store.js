'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Room ids are the normalized-URL strings
function filenameFor(roomId) {
  const hash = crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 24);
  return path.join(DATA_DIR, `${hash}.json`);
}

const INDEX_FILE = path.join(DATA_DIR, '_index.json');
function recordIndex(roomId) {
  let index = {};
  try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (e) {
    // no index yet, or it's corrupt — start fresh
  }
  index[path.basename(filenameFor(roomId))] = roomId;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function loadRoom(roomId) {
  try {
    const raw = fs.readFileSync(filenameFor(roomId), 'utf8');
    const parsed = JSON.parse(raw);
    return { highlights: parsed.highlights || [], drawings: parsed.drawings || [] };
  } catch (e) {
    return { highlights: [], drawings: [] };
  }
}

const pendingWrites = new Map(); // roomId to Timeout

function saveRoom(roomId, state) {
  recordIndex(roomId);
  clearTimeout(pendingWrites.get(roomId));
  const timer = setTimeout(() => {
    pendingWrites.delete(roomId);
    const file = filenameFor(roomId);
    const tmp = `${file}.tmp`;
    fs.writeFile(tmp, JSON.stringify(state), (err) => {
      if (err) {
        console.error(`Failed writing room state for ${roomId}:`, err);
        return;
      }
      fs.rename(tmp, file, (renameErr) => {
        if (renameErr) console.error(`Failed to commit room state for ${roomId}:`, renameErr);
      });
    });
  }, 400);
  pendingWrites.set(roomId, timer);
}

module.exports = { loadRoom, saveRoom };
