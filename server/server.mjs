import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.PATH_OF_IDLE_STATS_DATA_DIR?.trim() || join(root, 'data');
const eventLog = join(dataDirectory, 'events.jsonl');
const databasePath = join(dataDirectory, 'path-of-idle-stats.sqlite');
const scannerBackupDirectory = join(dataDirectory, 'scanner-state-backups');
const webRoot = join(root, 'dist', 'dashboard', 'browser');
const gameDirectory = process.env.PATH_OF_IDLE_GAME_DIR?.trim() || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PathOfIdle';
const telemetryDirectory = join(gameDirectory, 'BepInEx', 'PathOfIdleStats');
// Runtime exports are authoritative on player installs. The project data folder
// remains a fallback for developers who generated a complete offline icon cache.
const iconRoots = [join(telemetryDirectory, 'icons'), join(root, 'data', 'icons')];
const requestedPort = Number(process.env.PATH_OF_IDLE_STATS_PORT ?? 43127);
const port = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 43127;
const snapshotRequest = join(telemetryDirectory, 'snapshot.request');
const combatSnapshotRequest = join(telemetryDirectory, 'combat-snapshot.request');
const catalogRequest = join(telemetryDirectory, 'catalog.request');
const codexRequest = join(telemetryDirectory, 'codex.request');
const inventoryRequest = join(telemetryDirectory, 'inventory.request');
const iconProgressFile = join(telemetryDirectory, 'icons.progress.json');
const clients = new Set();
const state = { connected: false, gameRunning: false, updatedAt: null, snapshotUpdatedAt: null, inventoryUpdatedAt: null, inventoryItemAdded: null, iconProgress: null, heroes: [], slots: [], resources: [], sanctum: null, inventory: [], battles: [], events: [], catalogs: {} };
let codexSnapshot = { updatedAt: null, items: [], affixPools: [], rarities: [] };
let lastGameHeartbeat = 0;
const pendingCombatSnapshots = new Map();
await mkdir(dataDirectory, { recursive: true });
try {
  const savedIconProgress = JSON.parse(await readFile(iconProgressFile, 'utf8'));
  if (Number.isInteger(savedIconProgress?.total) && Number.isInteger(savedIconProgress?.completed)) state.iconProgress = savedIconProgress;
} catch { }
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  CREATE TABLE IF NOT EXISTS scanner_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS battle_history_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    history_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runtime_migrations (
    migration_key TEXT PRIMARY KEY,
    completed_at TEXT NOT NULL
  );
`);
const readScannerStateStatement = database.prepare('SELECT state_json, updated_at FROM scanner_state WHERE id = 1');
const writeScannerStateStatement = database.prepare(`
  INSERT INTO scanner_state (id, state_json, updated_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
`);
const readBattleHistoryStatement = database.prepare('SELECT history_json, updated_at FROM battle_history_state WHERE id = 1');
const writeBattleHistoryStatement = database.prepare(`
  INSERT INTO battle_history_state (id, history_json, updated_at) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET history_json = excluded.history_json, updated_at = excluded.updated_at
`);
const readMigrationStatement = database.prepare('SELECT completed_at FROM runtime_migrations WHERE migration_key = ?');
const writeMigrationStatement = database.prepare(`
  INSERT OR REPLACE INTO runtime_migrations (migration_key, completed_at) VALUES (?, ?)
`);
const battleHistoryMigrationKey = 'battle-history-from-events-jsonl-v1';

function battleSlot(event) {
  const slot = Number(event?.payload?.battleIndex);
  return Number.isInteger(slot) && slot >= 0 && slot <= 2 ? slot : null;
}

function retainBattleHistory(events) {
  const perSlot = new Map();
  return events.filter(event => {
    if (event?.type !== 'battle.ended') return false;
    const slot = battleSlot(event);
    if (slot == null) return false;
    const count = perSlot.get(slot) ?? 0;
    if (count >= 50) return false;
    perSlot.set(slot, count + 1);
    return true;
  });
}

function deduplicateBattleHistory(events) {
  const seen = new Set();
  return retainBattleHistory(events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function readBattleHistory() {
  const row = readBattleHistoryStatement.get();
  if (!row) return null;
  const parsed = JSON.parse(row.history_json);
  if (!Array.isArray(parsed)) throw new Error('Persisted battle history is not an array.');
  return { battles: retainBattleHistory(parsed), updatedAt: row.updated_at };
}

function persistBattleHistory(battles) {
  const retained = retainBattleHistory(battles);
  const updatedAt = new Date().toISOString();
  writeBattleHistoryStatement.run(JSON.stringify(retained), updatedAt);
  return retained;
}

async function readNewestLegacyBattles(newerThan = null) {
  let file;
  try { file = await open(eventLog, 'r'); } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const battles = [];
  const perSlot = new Map();
  const cutoff = newerThan ? Date.parse(newerThan) : Number.NaN;
  let reachedCutoff = false;
  const chunkSize = 1024 * 1024;
  let remainder = Buffer.alloc(0);
  try {
    let position = (await file.stat()).size;
    while (position > 0 && !reachedCutoff && [0, 1, 2].some(slot => (perSlot.get(slot) ?? 0) < 50)) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      const data = Buffer.concat([chunk.subarray(0, bytesRead), remainder]);
      let lineEnd = data.length;
      for (let index = data.length - 1; index >= 0; index--) {
        if (data[index] !== 10) continue;
        const line = data.subarray(index + 1, lineEnd).toString('utf8').replace(/\r$/, '').trim();
        lineEnd = index;
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          const eventTime = Date.parse(event?.timestamp);
          if (Number.isFinite(cutoff) && Number.isFinite(eventTime) && eventTime <= cutoff) {
            reachedCutoff = true;
            break;
          }
          const slot = event?.type === 'battle.ended' ? battleSlot(event) : null;
          if (slot == null || (perSlot.get(slot) ?? 0) >= 50) continue;
          perSlot.set(slot, (perSlot.get(slot) ?? 0) + 1);
          battles.push(event);
        } catch { }
      }
      remainder = data.subarray(0, lineEnd);
    }
    if (!reachedCutoff && position === 0 && remainder.length > 0) {
      try {
        const event = JSON.parse(remainder.toString('utf8').replace(/\r$/, '').trim());
        const slot = event?.type === 'battle.ended' ? battleSlot(event) : null;
        if (slot != null && (perSlot.get(slot) ?? 0) < 50) battles.push(event);
      } catch { }
    }
  } finally { await file.close(); }
  return retainBattleHistory(battles);
}

async function deleteLegacyEventLog() {
  try { await unlink(eventLog); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function initializeBattleHistory() {
  const stored = readBattleHistory();
  if (readMigrationStatement.get(battleHistoryMigrationKey)) {
    state.battles = stored?.battles ?? [];
    return;
  }
  const legacyBattles = await readNewestLegacyBattles(stored?.updatedAt ?? null);
  const migrated = stored ? deduplicateBattleHistory([...legacyBattles, ...stored.battles]) : legacyBattles;
  state.battles = persistBattleHistory(migrated);
  await deleteLegacyEventLog();
  writeMigrationStatement.run(battleHistoryMigrationKey, new Date().toISOString());
  console.log('Legacy event log removed after battle history migration.');
}

await initializeBattleHistory();

function readScannerState() {
  const row = readScannerStateStatement.get();
  if (!row) return null;
  return { state: JSON.parse(row.state_json), updatedAt: row.updated_at };
}

function validateScannerState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Scanner state must be a JSON object.');
  if (!Array.isArray(value.filters) || !Array.isArray(value.groups)) throw new Error('Scanner state requires filters and groups arrays.');
  if (value.filters.some(filter => !filter || typeof filter !== 'object' || typeof filter.id !== 'string')) throw new Error('Every scanner filter requires a string id.');
  if (value.groups.some(group => !group || typeof group !== 'object' || typeof group.id !== 'string')) throw new Error('Every scanner group requires a string id.');
  return { ...value, schemaVersion: Number(value.schemaVersion) || 1, autoEnabled: value.autoEnabled === true };
}

async function persistScannerState(value, onlyIfEmpty = false) {
  const normalizedState = validateScannerState(value);
  const existing = readScannerState();
  if (onlyIfEmpty && existing) return { imported: false, ...existing };
  if (!existing) {
    await mkdir(scannerBackupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(scannerBackupDirectory, `initial-browser-import-${timestamp}.json`), JSON.stringify(normalizedState, null, 2), 'utf8');
  }
  const updatedAt = new Date().toISOString();
  writeScannerStateStatement.run(JSON.stringify(normalizedState), updatedAt);
  return { imported: !existing, state: normalizedState, updatedAt };
}

function applyEvent(event) {
  state.connected = true;
  state.updatedAt = event.timestamp;
  if (event.type === 'heartbeat') {
    lastGameHeartbeat = Date.now();
    state.gameRunning = true;
  }
  if (!event.type.startsWith('catalog.') && !event.type.startsWith('snapshot.') && event.type !== 'heartbeat') {
    state.events.unshift(event);
    state.events = state.events.slice(0, 100);
  }
  if (event.type.startsWith('snapshot.') && event.type !== 'snapshot.icon-progress') state.snapshotUpdatedAt = event.timestamp;
  if (event.type === 'snapshot.icon-progress') state.iconProgress = event.payload ?? null;
  if (event.type === 'snapshot.heroes') state.heroes = event.payload?.heroes ?? event.payload ?? [];
  if (event.type === 'snapshot.slots') state.slots = event.payload?.slots ?? [];
  if (event.type === 'snapshot.resources') {
    state.resources = event.payload?.resources ?? [];
    state.sanctum = event.payload?.sanctum ?? state.sanctum;
  }
  if (event.type === 'snapshot.inventory') {
    state.inventory = event.payload?.items ?? event.payload ?? [];
    state.inventoryUpdatedAt = event.timestamp;
  }
  if (event.type === 'inventory.item-added') state.inventoryItemAdded = event;
  if (event.type === 'snapshot.codex') codexSnapshot = { updatedAt: event.timestamp, ...(event.payload ?? {}) };
  if (event.type.startsWith('catalog.')) state.catalogs[event.type.slice(8)] = event.payload?.entries ?? [];
  if (event.type === 'battle.ended') {
    state.resources = event.payload?.resources ?? state.resources;
    state.sanctum = event.payload?.sanctum ?? state.sanctum;
    state.battles = persistBattleHistory([event, ...state.battles]);
  }
  const message = `data: ${JSON.stringify(publicState(false))}\n\n`;
  for (const client of clients) client.write(message);
}

function publicState(includeInventory = true) {
  const { catalogs, ...live } = state;
  if (includeInventory) return live;
  const { inventory, ...streamable } = live;
  return streamable;
}

async function requestCombatSnapshot(heroUniqueId) {
  if (pendingCombatSnapshots.size > 0) throw Object.assign(new Error('A combat snapshot is already in progress.'), { statusCode: 409 });
  const requestId = randomUUID();
  await mkdir(dirname(combatSnapshotRequest), { recursive: true });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCombatSnapshots.delete(requestId);
      reject(Object.assign(new Error('The game did not return the combat snapshot in time.'), { statusCode: 504 }));
    }, 5000);
    pendingCombatSnapshots.set(requestId, { resolve, timeout });
    writeFile(combatSnapshotRequest, JSON.stringify({ requestId, heroUniqueId }), 'utf8').catch(error => {
      clearTimeout(timeout);
      pendingCombatSnapshots.delete(requestId);
      reject(error);
    });
  });
}

function completeCombatSnapshot(event) {
  const requestId = event?.payload?.requestId;
  const pending = typeof requestId === 'string' ? pendingCombatSnapshots.get(requestId) : null;
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pendingCombatSnapshots.delete(requestId);
  pending.resolve(event.payload);
  return true;
}

function broadcastState() {
  const message = `data: ${JSON.stringify(publicState(false))}\n\n`;
  for (const client of clients) client.write(message);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 10_000_000) throw new Error('Event body exceeds 10 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, app: 'path-of-idle-stats', updatedAt: state.updatedAt });
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, publicState());
    if (request.method === 'GET' && url.pathname === '/api/catalogs') return json(response, 200, state.catalogs);
    if (request.method === 'GET' && url.pathname === '/api/codex') return json(response, 200, codexSnapshot);
    if (request.method === 'GET' && url.pathname === '/api/scanner/state') {
      const stored = readScannerState();
      return json(response, 200, stored ? { exists: true, ...stored } : { exists: false, state: null, updatedAt: null });
    }
    if (request.method === 'POST' && url.pathname === '/api/scanner/state/import') {
      const result = await persistScannerState(JSON.parse(await readBody(request)), true);
      return json(response, result.imported ? 201 : 200, result);
    }
    if (request.method === 'PUT' && url.pathname === '/api/scanner/state') {
      return json(response, 200, await persistScannerState(JSON.parse(await readBody(request))));
    }
    if (request.method === 'POST' && url.pathname === '/api/catalogs/refresh') {
      await mkdir(dirname(catalogRequest), { recursive: true });
      await writeFile(catalogRequest, new Date().toISOString(), 'utf8');
      return json(response, 202, { requested: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/codex/refresh') {
      await mkdir(dirname(codexRequest), { recursive: true });
      await writeFile(codexRequest, new Date().toISOString(), 'utf8');
      return json(response, 202, { requested: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/inventory/refresh') {
      await mkdir(dirname(inventoryRequest), { recursive: true });
      await writeFile(inventoryRequest, new Date().toISOString(), 'utf8');
      return json(response, 202, { requested: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/snapshot') {
      await mkdir(dirname(snapshotRequest), { recursive: true });
      await writeFile(snapshotRequest, new Date().toISOString(), 'utf8');
      return json(response, 202, { requested: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/combat-snapshot') {
      const body = JSON.parse(await readBody(request));
      const heroUniqueId = Number(body?.heroUniqueId);
      if (!Number.isInteger(heroUniqueId) || heroUniqueId <= 0) return json(response, 400, { error: 'A valid heroUniqueId is required.' });
      try { return json(response, 200, await requestCombatSnapshot(heroUniqueId)); }
      catch (error) { return json(response, error?.statusCode ?? 500, { error: error?.message ?? 'Combat snapshot failed.' }); }
    }
    if (request.method === 'DELETE' && /^\/api\/battles\/[0-2]$/.test(url.pathname)) {
      const slot = Number(url.pathname.slice(-1));
      state.battles = persistBattleHistory(state.battles.filter(battle => battleSlot(battle) !== slot));
      broadcastState();
      return json(response, 200, { reset: true, slot });
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(publicState(false))}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/events') {
      const event = JSON.parse(await readBody(request));
      if (!event || typeof event.type !== 'string') return json(response, 400, { error: 'type is required' });
      event.timestamp ??= new Date().toISOString();
      if (event.type === 'snapshot.combat') {
        completeCombatSnapshot(event);
        return json(response, 202, { accepted: true });
      }
      if (event.type.startsWith('catalog.')) {
        const catalogDirectory = join(dataDirectory, 'catalogs');
        await mkdir(catalogDirectory, { recursive: true });
        await import('node:fs/promises').then(({ writeFile }) => writeFile(join(catalogDirectory, event.type.slice(8) + '.json'), JSON.stringify(event.payload), 'utf8'));
      } else if (event.type !== 'heartbeat' && event.type !== 'battle.ended' && !event.type.startsWith('snapshot.')) {
        await appendFile(eventLog, JSON.stringify(event) + '\n', 'utf8');
      }
      applyEvent(event);
      return json(response, 202, { accepted: true });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/assets/icons/')) {
      const filename = url.pathname.slice('/assets/icons/'.length);
      if (!/^[a-f0-9]{64}\.png$/.test(filename)) return json(response, 400, { error: 'invalid icon path' });
      let icon = null;
      for (const iconRoot of iconRoots) {
        try { icon = await readFile(join(iconRoot, filename)); break; } catch { }
      }
      if (!icon) return json(response, 404, { error: 'icon not exported yet' });
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      response.end(icon);
      return;
    }

    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = normalize(join(webRoot, requested));
    if (!filePath.startsWith(webRoot)) return json(response, 403, { error: 'forbidden' });
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(join(webRoot, 'index.html')));
    }
  } catch (error) {
    json(response, 500, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Path of Idle Stats: http://127.0.0.1:${port}`);
  console.log(`Event log: ${eventLog}`);
});

const gameHeartbeatTimer = setInterval(() => {
  const running = lastGameHeartbeat > 0 && Date.now() - lastGameHeartbeat < 5000;
  if (state.gameRunning === running) return;
  state.gameRunning = running;
  broadcastState();
}, 1000);
gameHeartbeatTimer.unref();
