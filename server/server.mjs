import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDirectory = join(root, 'data');
const eventLog = join(dataDirectory, 'events.jsonl');
const webRoot = join(root, 'dist', 'dashboard', 'browser');
const iconRoot = join(root, 'data', 'icons');
const snapshotRequest = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PathOfIdle\\BepInEx\\PathOfIdleStats\\snapshot.request';
const catalogRequest = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PathOfIdle\\BepInEx\\PathOfIdleStats\\catalog.request';
const codexRequest = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PathOfIdle\\BepInEx\\PathOfIdleStats\\codex.request';
const inventoryRequest = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\PathOfIdle\\BepInEx\\PathOfIdleStats\\inventory.request';
const clients = new Set();
const state = { connected: false, gameRunning: false, updatedAt: null, snapshotUpdatedAt: null, inventoryUpdatedAt: null, inventoryItemAdded: null, heroes: [], slots: [], resources: [], sanctum: null, inventory: [], battles: [], events: [], catalogs: {} };
let codexSnapshot = { updatedAt: null, items: [], affixPools: [], rarities: [] };
let lastGameHeartbeat = 0;
await mkdir(dataDirectory, { recursive: true });

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
  if (event.type.startsWith('snapshot.')) state.snapshotUpdatedAt = event.timestamp;
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
    state.battles.unshift(event);
    const perSlot = new Map();
    state.battles = state.battles.filter(battle => {
      const slot = Number(battle.payload?.battleIndex);
      const count = perSlot.get(slot) ?? 0;
      if (count >= 50) return false;
      perSlot.set(slot, count + 1);
      return true;
    });
  }
  const message = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const client of clients) client.write(message);
}

function publicState() {
  const { catalogs, ...live } = state;
  return live;
}

function broadcastState() {
  const message = `data: ${JSON.stringify(publicState())}\n\n`;
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
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, updatedAt: state.updatedAt });
    if (request.method === 'GET' && url.pathname === '/api/state') return json(response, 200, publicState());
    if (request.method === 'GET' && url.pathname === '/api/catalogs') return json(response, 200, state.catalogs);
    if (request.method === 'GET' && url.pathname === '/api/codex') return json(response, 200, codexSnapshot);
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
    if (request.method === 'DELETE' && /^\/api\/battles\/[0-2]$/.test(url.pathname)) {
      const slot = Number(url.pathname.slice(-1));
      state.battles = state.battles.filter(battle => Number(battle.payload?.battleIndex) !== slot);
      broadcastState();
      return json(response, 200, { reset: true, slot });
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify(publicState())}\n\n`);
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/events') {
      const event = JSON.parse(await readBody(request));
      if (!event || typeof event.type !== 'string') return json(response, 400, { error: 'type is required' });
      event.timestamp ??= new Date().toISOString();
      if (event.type.startsWith('catalog.')) {
        const catalogDirectory = join(dataDirectory, 'catalogs');
        await mkdir(catalogDirectory, { recursive: true });
        await import('node:fs/promises').then(({ writeFile }) => writeFile(join(catalogDirectory, event.type.slice(8) + '.json'), JSON.stringify(event.payload), 'utf8'));
      } else if (event.type !== 'heartbeat' && !event.type.startsWith('snapshot.')) {
        await appendFile(eventLog, JSON.stringify(event) + '\n', 'utf8');
      }
      applyEvent(event);
      return json(response, 202, { accepted: true });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/assets/icons/')) {
      const filename = url.pathname.slice('/assets/icons/'.length);
      if (!/^[a-f0-9]{64}\.png$/.test(filename)) return json(response, 400, { error: 'invalid icon path' });
      try {
        const icon = await readFile(join(iconRoot, filename));
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        response.end(icon);
      } catch { return json(response, 404, { error: 'icon not exported yet' }); }
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

server.listen(43127, '127.0.0.1', () => {
  console.log('Path of Idle Stats: http://127.0.0.1:43127');
  console.log(`Event log: ${eventLog}`);
});

const gameHeartbeatTimer = setInterval(() => {
  const running = lastGameHeartbeat > 0 && Date.now() - lastGameHeartbeat < 5000;
  if (state.gameRunning === running) return;
  state.gameRunning = running;
  broadcastState();
}, 1000);
gameHeartbeatTimer.unref();
