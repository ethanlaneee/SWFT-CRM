// ════════════════════════════════════════════════
// WebSocket client registry — team messaging
// Maps uid → Set of active WebSocket connections
// ════════════════════════════════════════════════

const clients = new Map();

function addClient(uid, ws) {
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(ws);
}

function removeClient(uid, ws) {
  if (!clients.has(uid)) return;
  clients.get(uid).delete(ws);
  if (clients.get(uid).size === 0) clients.delete(uid);
}

function broadcastToUser(uid, data) {
  if (!clients.has(uid)) return;
  const payload = JSON.stringify(data);
  for (const ws of clients.get(uid)) {
    try {
      if (ws.readyState === 1) ws.send(payload); // 1 = OPEN
    } catch (_) {}
  }
}

module.exports = { addClient, removeClient, broadcastToUser };
