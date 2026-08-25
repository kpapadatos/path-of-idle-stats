import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

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
const state = {
  connected: false, gameRunning: false, updatedAt: null, snapshotUpdatedAt: null, slotsUpdatedAt: null,
  modVersion: null, iconProgress: null, heroes: [], slots: [], resources: [], sanctum: null, battles: [], events: [], catalogs: {},
  scanner: { matches: [], hasRun: false, scanning: false, error: null, updatedAt: null, matchNotificationId: null }
};
let codexSnapshot = { updatedAt: null, items: [], affixPools: [], rarities: [] };
let lastGameHeartbeat = 0;
const pendingCombatSnapshots = new Map();
const pendingScannerScans = new Map();
const battleHistoryLimitPerSlot = 50;
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
  CREATE TABLE IF NOT EXISTS battle_timelines (
    battle_id TEXT PRIMARY KEY,
    timeline_gzip BLOB NOT NULL,
    created_at TEXT NOT NULL
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
const readBattleTimelineStatement = database.prepare('SELECT timeline_gzip FROM battle_timelines WHERE battle_id = ?');
const writeBattleTimelineStatement = database.prepare(`
  INSERT OR REPLACE INTO battle_timelines (battle_id, timeline_gzip, created_at) VALUES (?, ?, ?)
`);
const listBattleTimelineIdsStatement = database.prepare('SELECT battle_id FROM battle_timelines');
const deleteBattleTimelineStatement = database.prepare('DELETE FROM battle_timelines WHERE battle_id = ?');
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
    if (count >= battleHistoryLimitPerSlot) return false;
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

function persistBattleHistory(battles, timelineRecord = null) {
  const retained = retainBattleHistory(battles);
  const updatedAt = new Date().toISOString();
  const retainedTimelineIds = new Set(retained
    .map(event => event?.payload?.timelineAvailable ? event.payload.battleId : null)
    .filter(id => typeof id === 'string' && id.length > 0));
  database.exec('BEGIN IMMEDIATE');
  try {
    if (timelineRecord) writeBattleTimelineStatement.run(timelineRecord.battleId, timelineRecord.compressed, updatedAt);
    writeBattleHistoryStatement.run(JSON.stringify(retained), updatedAt);
    for (const row of listBattleTimelineIdsStatement.all())
      if (!retainedTimelineIds.has(row.battle_id)) deleteBattleTimelineStatement.run(row.battle_id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return retained;
}

function detachBattleTimeline(event) {
  const timelines = event?.payload?.combatTimelines;
  if (!Array.isArray(timelines) || timelines.length === 0) return { event, timelineRecord: null };
  const battleId = randomUUID();
  const timeline = {
    battleId,
    battleIndex: battleSlot(event),
    startedAt: event.payload?.startedAt ?? null,
    endedAt: event.payload?.endedAt ?? event.timestamp ?? null,
    heroes: timelines
  };
  const payload = { ...event.payload, battleId, timelineAvailable: true };
  delete payload.combatTimelines;
  return {
    event: { ...event, payload },
    timelineRecord: { battleId, compressed: gzipSync(Buffer.from(JSON.stringify(timeline), 'utf8'), { level: 6 }) }
  };
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
    while (position > 0 && !reachedCutoff && [0, 1, 2].some(slot => (perSlot.get(slot) ?? 0) < battleHistoryLimitPerSlot)) {
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
          if (slot == null || (perSlot.get(slot) ?? 0) >= battleHistoryLimitPerSlot) continue;
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
        if (slot != null && (perSlot.get(slot) ?? 0) < battleHistoryLimitPerSlot) battles.push(event);
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
    // Re-apply the current retention policy on startup as well as insertion so
    // lowering the limit immediately prunes both history and orphan timelines.
    state.battles = persistBattleHistory(stored?.battles ?? []);
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
  return {
    ...value,
    schemaVersion: Math.max(2, Number(value.schemaVersion) || 1),
    autoEnabled: value.autoEnabled === true,
    // Existing installations scanned all storage, so preserve that behavior
    // when upgrading scanner state written before this option existed.
    includeWarehouse: value.includeWarehouse !== false
  };
}

const initialScannerState = readScannerState();
let scannerConfiguration = validateScannerState(initialScannerState?.state ?? { schemaVersion: 2, filters: [], groups: [], autoEnabled: false, includeWarehouse: true });
let scannerFilterIndex = compileScannerFilters(scannerConfiguration);
state.scanner = {
  ...state.scanner,
  autoEnabled: scannerConfiguration.autoEnabled,
  includeWarehouse: scannerConfiguration.includeWarehouse,
  configurationUpdatedAt: initialScannerState?.updatedAt ?? null
};

function scannerCriteriaSignature(configuration) {
  return JSON.stringify({
    includeWarehouse: configuration?.includeWarehouse !== false,
    filters: (configuration?.filters ?? []).map(filter => ({
      id: filter.id,
      enabled: filter.enabled !== false,
      itemKeys: Array.isArray(filter.itemKeys) ? filter.itemKeys.map(String) : [],
      statIds: Array.isArray(filter.statIds) ? filter.statIds.map(Number).filter(Number.isFinite) : [],
      minimumAttributeMatches: Number(filter.minimumAttributeMatches) || 1
    }))
  });
}

function compileScannerFilters(configuration) {
  const byItemKey = new Map();
  for (const filter of configuration?.filters ?? []) {
    if (filter?.enabled === false || !Array.isArray(filter?.itemKeys) || !filter.itemKeys.length) continue;
    const statIds = new Set((Array.isArray(filter.statIds) ? filter.statIds : []).map(Number).filter(Number.isFinite));
    const minimum = statIds.size ? Math.max(1, Math.min(statIds.size, Math.round(Number(filter.minimumAttributeMatches) || statIds.size))) : 0;
    const compiled = { id: String(filter.id), statIds, minimum };
    for (const key of filter.itemKeys.map(String)) {
      const candidates = byItemKey.get(key);
      if (candidates) candidates.push(compiled); else byItemKey.set(key, [compiled]);
    }
  }
  return byItemKey;
}

function scannerItemKey(item) {
  return String(item?.key || `${item?.rarity}:${item?.id}`);
}

function scannerItemIdentity(item, fallback = 'unknown') {
  return `${item?.storageLocation || 'inventory'}:${item?.storagePage ?? item?.storageGroupId ?? 'none'}:${item?.inventoryIndex ?? fallback}:${scannerItemKey(item)}`;
}

function matchingScannerFilterIds(item) {
  const candidates = scannerFilterIndex.get(scannerItemKey(item)) ?? [];
  if (!candidates.length) return [];
  const affixIds = new Set((Array.isArray(item?.affixes) ? item.affixes : []).map(affix => Number(affix?.id)).filter(Number.isFinite));
  return candidates.filter(filter => filter.minimum === 0
    || [...filter.statIds].reduce((count, id) => count + (affixIds.has(id) ? 1 : 0), 0) >= filter.minimum)
    .map(filter => filter.id);
}

function decorateScannerMatch(item, matchedFilterIds, fallback) {
  return { ...item, _matchId: scannerItemIdentity(item, fallback), _matchedFilterIds: matchedFilterIds };
}

function applyAutoScannerItem(event) {
  if (!scannerConfiguration.autoEnabled) return;
  const item = event?.payload?.item;
  if (!item) return;
  const matchedFilterIds = matchingScannerFilterIds(item);
  if (!matchedFilterIds.length) return;
  const match = decorateScannerMatch(item, matchedFilterIds, event.timestamp ?? randomUUID());
  state.scanner = {
    ...state.scanner,
    matches: [match, ...state.scanner.matches.filter(existing => existing?._matchId !== match._matchId)],
    hasRun: true,
    error: null,
    updatedAt: event.timestamp ?? new Date().toISOString(),
    matchNotificationId: randomUUID()
  };
}

async function persistScannerState(value, onlyIfEmpty = false) {
  const normalizedState = validateScannerState(value);
  const existing = readScannerState();
  if (onlyIfEmpty && existing) return { imported: false, state: scannerConfiguration, updatedAt: existing.updatedAt };
  if (!existing) {
    await mkdir(scannerBackupDirectory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(scannerBackupDirectory, `initial-browser-import-${timestamp}.json`), JSON.stringify(normalizedState, null, 2), 'utf8');
  }
  const updatedAt = new Date().toISOString();
  writeScannerStateStatement.run(JSON.stringify(normalizedState), updatedAt);
  const criteriaChanged = scannerCriteriaSignature(scannerConfiguration) !== scannerCriteriaSignature(normalizedState);
  scannerConfiguration = normalizedState;
  scannerFilterIndex = compileScannerFilters(scannerConfiguration);
  state.scanner = {
    ...state.scanner,
    ...(criteriaChanged ? { matches: [], hasRun: false, error: null, updatedAt } : {}),
    autoEnabled: scannerConfiguration.autoEnabled,
    includeWarehouse: scannerConfiguration.includeWarehouse,
    configurationUpdatedAt: updatedAt
  };
  return { imported: !existing, state: normalizedState, updatedAt };
}

function applyEvent(event, timelineRecord = null) {
  const gameWasRunning = state.gameRunning;
  state.connected = true;
  state.updatedAt = event.timestamp;
  if (event.type === 'heartbeat') {
    lastGameHeartbeat = Date.now();
    state.gameRunning = true;
    if (typeof event.payload?.pluginVersion === 'string' && event.payload.pluginVersion.trim()) state.modVersion = event.payload.pluginVersion.trim();
    // Heartbeats only maintain liveness. Broadcasting an unchanged full state
    // every second needlessly wakes Angular and recreates decoded JSON objects.
    if (gameWasRunning) return;
  }
  if (!event.type.startsWith('catalog.') && !event.type.startsWith('snapshot.') && event.type !== 'heartbeat') {
    state.events.unshift(event);
    state.events = state.events.slice(0, 100);
  }
  if (event.type.startsWith('snapshot.') && event.type !== 'snapshot.icon-progress') state.snapshotUpdatedAt = event.timestamp;
  if (event.type === 'snapshot.icon-progress') state.iconProgress = event.payload ?? null;
  if (event.type === 'snapshot.heroes') state.heroes = event.payload?.heroes ?? event.payload ?? [];
  if (event.type === 'snapshot.slots') {
    state.slots = event.payload?.slots ?? [];
    state.slotsUpdatedAt = event.timestamp;
  }
  if (event.type === 'snapshot.resources') {
    state.resources = event.payload?.resources ?? [];
    state.sanctum = event.payload?.sanctum ?? state.sanctum;
  }
  if (event.type === 'inventory.item-added') applyAutoScannerItem(event);
  if (event.type === 'snapshot.scanner') completeScannerScan(event);
  if (event.type === 'snapshot.codex') codexSnapshot = { updatedAt: event.timestamp, ...(event.payload ?? {}) };
  if (event.type.startsWith('catalog.')) state.catalogs[event.type.slice(8)] = event.payload?.entries ?? [];
  if (event.type === 'battle.ended') {
    state.resources = event.payload?.resources ?? state.resources;
    state.sanctum = event.payload?.sanctum ?? state.sanctum;
    state.battles = persistBattleHistory([event, ...state.battles], timelineRecord);
  }
  const message = `data: ${JSON.stringify(publicState(false))}\n\n`;
  for (const client of clients) client.write(message);
}

function publicState() {
  const { catalogs, events, heroes, inventory, inventoryUpdatedAt, inventoryItemAdded, ...live } = state;
  const battles = live.battles.map(publicBattleSummary);
  return { ...live, battles, events: [], heroes: [] };
}

const publicBattleSummaryCache = new WeakMap();
function publicBattleSummary(event) {
  const cached = event && typeof event === 'object' ? publicBattleSummaryCache.get(event) : null;
  if (cached) return cached;
  const payload = event?.payload ?? {};
  const { enemies, resources, sanctum, heroes, loot, ...summary } = payload;
  const result = {
    ...event,
    payload: {
      ...summary,
      heroes: (Array.isArray(heroes) ? heroes : []).map(hero => ({
        uniqueId: hero?.uniqueId,
        id: hero?.id,
        name: hero?.name,
        job: hero?.job,
        englishJob: hero?.englishJob,
        jobId: hero?.jobId,
        classIconUrl: hero?.classIconUrl,
        level: hero?.level,
        damageDone: hero?.damageDone ? {
          battleTimeSeconds: hero.damageDone.battleTimeSeconds,
          totalDamage: hero.damageDone.totalDamage,
          totalDps: hero.damageDone.totalDps
        } : null
      })),
      loot: (Array.isArray(loot) ? loot : []).map(item => ({
        id: item?.id,
        name: item?.name,
        englishName: item?.englishName,
        type: item?.type,
        count: item?.count,
        quality: item?.quality,
        qualityName: item?.qualityName,
        rarity: item?.rarity,
        level: item?.level,
        iconKey: item?.iconKey,
        iconUrl: item?.iconUrl
      }))
    }
  };
  if (event && typeof event === 'object') publicBattleSummaryCache.set(event, result);
  return result;
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

function scannerRequestFilters() {
  return [...scannerFilterIndex.entries()].map(([itemKey, filters]) => ({
    itemKey,
    filters: filters.map(filter => ({ id: filter.id, statIds: [...filter.statIds], minimumAttributeMatches: filter.minimum }))
  }));
}

async function requestScannerScan() {
  if (!state.gameRunning) throw Object.assign(new Error('Start the game and enter your save before scanning.'), { statusCode: 409 });
  if (pendingScannerScans.size > 0 || state.scanner.scanning) throw Object.assign(new Error('A storage scan is already in progress.'), { statusCode: 409 });
  if (!scannerFilterIndex.size) throw Object.assign(new Error('Enable at least one configured item filter before scanning.'), { statusCode: 400 });

  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  state.scanner = { ...state.scanner, scanning: true, error: null, updatedAt: requestedAt };
  broadcastState();
  await mkdir(dirname(inventoryRequest), { recursive: true });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingScannerScans.delete(requestId);
      state.scanner = { ...state.scanner, scanning: false, error: 'The game did not return the storage scan in time.', updatedAt: new Date().toISOString() };
      broadcastState();
      reject(Object.assign(new Error(state.scanner.error), { statusCode: 504 }));
    }, 15000);
    pendingScannerScans.set(requestId, { resolve, reject, timeout });
    writeFile(inventoryRequest, JSON.stringify({
      requestId,
      includeWarehouse: scannerConfiguration.includeWarehouse,
      itemFilters: scannerRequestFilters()
    }), 'utf8').catch(error => {
      clearTimeout(timeout);
      pendingScannerScans.delete(requestId);
      state.scanner = { ...state.scanner, scanning: false, error: error.message, updatedAt: new Date().toISOString() };
      broadcastState();
      reject(error);
    });
  });
}

function completeScannerScan(event) {
  const requestId = event?.payload?.requestId;
  const pending = typeof requestId === 'string' ? pendingScannerScans.get(requestId) : null;
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pendingScannerScans.delete(requestId);

  const uniqueMatches = new Map();
  for (const [index, item] of (Array.isArray(event?.payload?.items) ? event.payload.items : []).entries()) {
    const matchedFilterIds = matchingScannerFilterIds(item);
    if (!matchedFilterIds.length) continue;
    const match = decorateScannerMatch(item, matchedFilterIds, index);
    uniqueMatches.set(match._matchId, match);
  }
  const matches = [...uniqueMatches.values()];
  const completedAt = event.timestamp ?? new Date().toISOString();
  state.scanner = {
    ...state.scanner,
    matches,
    hasRun: true,
    scanning: false,
    error: event?.payload?.error ? String(event.payload.error) : null,
    updatedAt: completedAt,
    matchNotificationId: matches.length ? randomUUID() : state.scanner.matchNotificationId,
    inspectedCount: Number(event?.payload?.inspectedCount) || 0,
    durationMilliseconds: Number(event?.payload?.durationMilliseconds) || 0,
    includedWarehouse: event?.payload?.includeWarehouse === true
  };
  pending.resolve(state.scanner);
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
      return json(response, 200, stored ? { exists: true, state: scannerConfiguration, updatedAt: stored.updatedAt } : { exists: false, state: null, updatedAt: null });
    }
    if (request.method === 'POST' && url.pathname === '/api/scanner/state/import') {
      const result = await persistScannerState(JSON.parse(await readBody(request)), true);
      return json(response, result.imported ? 201 : 200, result);
    }
    if (request.method === 'PUT' && url.pathname === '/api/scanner/state') {
      const result = await persistScannerState(JSON.parse(await readBody(request)));
      broadcastState();
      return json(response, 200, result);
    }
    if (request.method === 'POST' && url.pathname === '/api/scanner/scan') {
      try { return json(response, 200, await requestScannerScan()); }
      catch (error) { return json(response, error?.statusCode ?? 500, { error: error?.message ?? 'Storage scan failed.' }); }
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
    const battleTimelineMatch = url.pathname.match(/^\/api\/battle-timelines\/([a-f0-9-]+)\/heroes\/(\d+)$/);
    if (request.method === 'GET' && battleTimelineMatch) {
      const [, battleId, heroIdText] = battleTimelineMatch;
      const row = readBattleTimelineStatement.get(battleId);
      if (!row) return json(response, 404, { error: 'Battle timeline was not found.' });
      const timeline = JSON.parse(gunzipSync(row.timeline_gzip).toString('utf8'));
      const heroUniqueId = Number(heroIdText);
      const hero = Array.isArray(timeline?.heroes)
        ? timeline.heroes.find(entry => Number(entry?.heroUniqueId) === heroUniqueId) : null;
      if (!hero) return json(response, 404, { error: 'Hero timeline was not found for this battle.' });
      const retainedBattle = state.battles.find(entry => entry?.payload?.battleId === battleId);
      const heroData = Array.isArray(retainedBattle?.payload?.heroes)
        ? retainedBattle.payload.heroes.find(entry => Number(entry?.uniqueId) === heroUniqueId) ?? null
        : null;
      return json(response, 200, { battleId, startedAt: timeline.startedAt, endedAt: timeline.endedAt, hero, heroData });
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
      } else if (event.type !== 'heartbeat' && event.type !== 'battle.ended' && event.type !== 'inventory.item-added' && !event.type.startsWith('snapshot.')) {
        await appendFile(eventLog, JSON.stringify(event) + '\n', 'utf8');
      }
      if (event.type === 'battle.ended') {
        const detached = detachBattleTimeline(event);
        applyEvent(detached.event, detached.timelineRecord);
      } else applyEvent(event);
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
