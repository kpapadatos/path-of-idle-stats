# Path of Idle Stats

Local-only telemetry, data-mining, and dashboard tooling for **Path of Idle: Old Gods Rising**. This is the project handoff and source of truth for continuing from a clean checkout.

## Goal and current result

A BepInEx 6 IL2CPP plugin observes the running Unity game and POSTs JSON telemetry to a local Node.js service. An Angular/Tailwind dashboard at `http://127.0.0.1:43127/` displays the three concurrent battle slots, ordered heroes, battle history, loot, classes, levels, talent trees, skills, English names, icons, and the selected basic skill.

Telemetry extraction is read-only with respect to game state. The optional guarded restart script uses the game's real Continue button and visible Auto checkboxes to resume the three battle slots; it never locates, reads, edits, or replaces save files.

## Safety boundaries

- Never modify, delete, move, or inspect game save files.
- Close `PathOfIdle.exe` before installing, updating, or uninstalling the plugin.
- Only install BepInEx files and `BepInEx\plugins\PathOfIdleStats.dll` into the game directory.
- Stage downloads and builds under this project before installation.
- `scripts/install.ps1` validates the executable, refuses to run while the game is open, backs up collisions, and records every installed file in `install-manifest.json`.
- `scripts/update-plugin.ps1` only replaces the manifest-recorded plugin and backs up the previous DLL by SHA-256.
- `scripts/uninstall.ps1` removes only manifest-recorded files and restores backed-up collisions.
- The plugin and server communicate only over `http://127.0.0.1:43127`.
- Never commit `data/`, `work/`, `install-manifest.json`, logs, or extracted game assets. The pinned player runtime under `vendor/`, compiled plugin under `release/`, and production dashboard under `dist/dashboard/browser/` are intentionally committed for one-step installation.

## Repository layout

- `plugin/Plugin.cs` — BepInEx plugin and reflection-based extraction.
- `plugin/PathOfIdleStats.csproj` — .NET 6 metadata.
- `server/server.mjs` — dependency-free Node ingestion/API/static server.
- `web/src/main.ts` — standalone Angular dashboard and UI.
- `scripts/build-plugin.ps1` — Roslyn compilation against BepInEx and game interop.
- `scripts/install.ps1` — guarded first installation.
- `scripts/find-game.ps1` — detects Steam and its custom libraries, then verifies app `4243990` and the game layout.
- `scripts/start.ps1` / `start.bat` — idempotent install/update, bundled server startup, readiness check, and browser opening.
- `scripts/update-plugin.ps1` — guarded plugin-only replacement.
- `scripts/configure-bepinex.ps1` — disables only BepInEx console output while preserving disk logs.
- `scripts/restart-game-and-update.ps1` — normal-close/update/reopen workflow with verified window placement, Continue, and three-slot Auto UI clicks.
- `scripts/uninstall.ps1` — manifest-limited removal/restoration.
- `scripts/extract-icons.py` — optional developer-only bulk game sprite extraction to content-addressed PNGs.
- `data/` — runtime JSONL, catalogs, and icons; ignored.
- `work/` — downloads, staging, builds, caches, and backups; ignored.

## Known working environment

- Windows x64.
- Steam game path: `C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle`.
- BepInEx archive: `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.760+a1afbfb.zip`.
- Archive SHA-256: `9753B825578A3C3A31CC10067CD45A44A7BF56D3C34C4679E24D6ADFD0FBA8EA`.
- Plugin target: .NET 6.
- The custom compiler script discovers Roslyn from the newest installed .NET SDK.
- Node build dependencies are locked by `pnpm-lock.yaml`. They are not needed at runtime: the server uses Node built-ins and the Angular production build is committed.
- Bundled Node runtime: Windows x64 `22.22.2`; archive SHA-256 `7C93E9D92BF68C07182B471AA187E35EE6CD08EF0F24AB060DFFF605FCC1C57C`.

Use only the official BepInEx build server or official BepInEx GitHub organization. Verify the archive hash before extraction; never use an unrelated repack.

## Clean-environment setup

### 1. Prerequisites and checkout

Players need only Windows, Steam, and Path of Idle. Contributors need Git, Node.js with Corepack/pnpm, a .NET SDK with Roslyn, and Python 3 if regenerating icons.

```powershell
git clone https://github.com/kpapadatos/path-of-idle-stats.git C:\r\path-of-idle-stats
Set-Location C:\r\path-of-idle-stats
corepack enable
pnpm install --frozen-lockfile
```

### 2. Stage BepInEx (maintainer/source builds only)

Download the pinned official IL2CPP x64 archive and extract it so this file exists:

`C:\r\path-of-idle-stats\work\bepinex\BepInEx\core\BepInEx.Unity.IL2CPP.dll`

Verify the download:

```powershell
$archive = 'C:\r\path-of-idle-stats\work\downloads\BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.760+a1afbfb.zip'
(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
```

Expected: `9753B825578A3C3A31CC10067CD45A44A7BF56D3C34C4679E24D6ADFD0FBA8EA`.

### 3. Generate game interop assemblies

The plugin build needs BepInEx-generated IL2CPP assemblies. On a clean machine:

1. Keep the game closed and copy the staged BepInEx distribution into the game directory.
2. Start the game once and let BepInEx generate `BepInEx\interop`.
3. Close the game normally before compiling or copying the telemetry plugin.

Required references include:

- `BepInEx\interop\Il2Cppmscorlib.dll`
- `BepInEx\interop\UnityEngine.CoreModule.dll`
- `BepInEx\interop\UnityEngine.ImageConversionModule.dll`

Earlier broad Unity assembly scans caused noisy `TypeLoadException` messages such as invalid `LightProbesQueryDisposeJob` formats. The current plugin patches named methods directly and avoids broad assembly scanning.

### 4. Build and install the plugin (maintainer/source builds only)

The compiler still assumes the default Steam game directory; adjust that path if the game is installed elsewhere. Player installation does not: `start.bat` discovers all configured Steam library folders.

```powershell
.\scripts\build-plugin.ps1
.\scripts\install.ps1 -GameDirectory 'C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle'
```

The build, install, and update scripts use `plugin\bin\Release\net6.0\PathOfIdleStats.dll`.

For later plugin-only updates, close the game and run:

```powershell
.\scripts\update-plugin.ps1
```

Installed destination: `<game>\BepInEx\plugins\PathOfIdleStats.dll`.

Replacing the plugin requires a game restart. Starting or stopping the dashboard does not. After installation, start through Steam and enter the save so runtime hero/adventure objects exist.

### 5. Build and run the dashboard

```powershell
pnpm build
pnpm start
```

Open `http://127.0.0.1:43127/`. Useful checks:

```powershell
Invoke-RestMethod http://127.0.0.1:43127/api/health
Invoke-RestMethod http://127.0.0.1:43127/api/state
Get-Content -Tail 100 '<game>\BepInEx\LogOutput.log'
```

The server binds to loopback, not the LAN.

### 6. Icons and catalogs

Catalogs are emitted after `TableData.init`. The plugin exports referenced sprites on demand into `<game>/BepInEx/PathOfIdleStats/icons`, and the server serves that directory as the authoritative player source. Export uses a temporary GPU render target so it also works for Unity textures that are not CPU-readable; failed jobs remain queued for a later retry. The plugin drains this queue at most one icon every 0.2 seconds to avoid a frame spike, while the dashboard retries initially missing `/assets/icons/` images outside Angular change detection. `scripts/extract-icons.py` is an optional developer-only bulk extractor into `data/icons.json` and `data/icons/<sha256>.png`, which the server uses only as a fallback.

Icons are derived from the locally installed game, can be large, may be copyrighted, and are not committed. A player install generates only referenced icons automatically at runtime.

## Runtime architecture

```text
Path of Idle
  -> BepInEx + Harmony postfix patches
  -> PathOfIdleStats.dll
  -> POST /api/events on 127.0.0.1:43127
  -> Node in-memory state + data/events.jsonl
  -> Server-Sent Events /api/stream
  -> Angular dashboard
```

If the server is unavailable, the plugin queues events and falls back to JSONL under `<game>\BepInEx\PathOfIdleStats\` rather than blocking the game.

## Reverse-engineering knowledge

Harmony postfixes are installed on:

- `AdvBattleData.Create` — battle start and slot identity.
- `CombatData.CreateEnemy` — enemy counting.
- `AdvFieldData.BattleEnd` — the single completed-battle emission point after the adventure field finalizes rewards and global modifiers.
- Do not capture loot from `DropSys.GetDropItemList` or `AdvFieldData.AddDropItem`; both occur before the late Gold/Blood reward adjustment.
- `TableData.init` — one-time catalogs.
- `Root.Update` — checks for an on-demand snapshot marker four times per second.

Important paths and fields:

- Live slots: `Game.dataMgr.nowSeasonData.advData.advFieldList`.
- Slot heroes: each adventure field's `heroFieldList`, then `heroData`.
- Selected basic skill: `SaveHeroData.baseSkillId`; changed by `HeroTalentData.ChangeBaseSkill(int attackId)`.
- Talent position: `TTalentPos.row`, `.col`, `.type`, and `.index`.
- Battle place: `battleMapData.mapSiteData`, `chapSiteData`/chapter row, and site row index.
- English strings: explicitly query table translation data; never assume the active game language is English.
- Verified exact English title: `Rift-Star Expanse-15`.

## Telemetry and HTTP API

Current events include `heartbeat`, `battle.started`, `battle.ended`, `snapshot.slots`, `snapshot.heroes`, `snapshot.resources`, `snapshot.inventory`, and catalogs for talents, skills, abilities, materials, runes, tools, curios, and equipment. The plugin sends a lightweight heartbeat every two seconds. The backend does not persist heartbeats or add them to the event list; it broadcasts `gameRunning` only when presence changes and marks the game stopped after five seconds without a heartbeat.

- `GET /api/health` — health and last update.
- `GET /api/state` — live state excluding large catalogs.
- `GET /api/catalogs` — catalogs.
- `GET /api/stream` — server-sent live state.
- `POST /api/events` — ingestion, limited to 1 MB.
- `POST /api/snapshot` — creates `<game>\BepInEx\PathOfIdleStats\snapshot.request`.
- `DELETE /api/battles/0`, `/1`, or `/2` — clears one slot's history.
- `GET /assets/icons/<sha256>.png` — local extracted icons.

`Root.Update` consumes and deletes the snapshot marker, then emits `snapshot.slots` and `snapshot.heroes`. This avoids waiting for battle completion. A marker may be queued while the game is closed and consumed after the game starts and a save is entered.

State is currently in memory. Server restart does not replay `data/events.jsonl`. Non-catalog events append to that file; catalogs overwrite individual files in `data/catalogs/`.

## Dashboard product decisions

The dashboard intentionally contains only the header/status controls, three battle-slot panels, and hero modal. Do not restore removed summary, inventory, raw-event, catalog, or debug sections unless explicitly requested.

### Battle slots

- Exactly three vertical panels: slots 0, 1, and 2.
- Up to three heroes per panel in one row.
- Runtime hero order is reversed for display to match visible in-game assignment order.
- Tiles show name, English class, class icon, and level and are clickable.
- Runtime hero avatar extraction was unreliable. All avatar hooks, routes, placeholders, and UI were removed. Do not restore placeholders without a reliable source.
- Class icons map job IDs 1–6 to extracted content-addressed files.
- **Refresh heroes** calls the on-demand snapshot endpoint.

### Battle history

- Retain the newest 50 completed battles per slot; drop the oldest on insertion.
- History expands, but individual battles start collapsed.
- **Reset history** appears inside expanded history and clears only that slot.
- Show exact English place, outcome, duration, timestamp, enemy count, wave, mode, and loot.
- Aggregate stackable finalized loot by item type/ID and sum counts; keep equipment entries separate because their affixes and other rolled properties may differ.
- Gold and Blood receive a late global Sanctum multiplier that is not represented by `AdvBattleData.teamGoldDropUp` (observed as zero). Read the finalized `AdvFieldData.dropItemList` in the `AdvFieldData.BattleEnd` postfix and emit exactly one authoritative `battle.ended` event. Never emit a provisional battle followed by a correction event.
- Header format: `Battle history (50) - Rift-Star Expanse-15 Avg. Time: 31.211s`.
- Average all retained entries in that slot (up to 50) whose resolved title exactly equals `Rift-Star Expanse-15`.
- Format to three decimals plus `s`; show `n/a` when no exact matches exist.

### Hero talent modal

- Main tree is a fixed 6-row by 5-column grid; cells may be empty.
- Use `positionRow`/`positionColumn`, with legacy fallback only for old telemetry.
- Inspired talents appear in a centered row above the grid.
- **Basic skills** and **Mutated skills** are separate, side-by-side sections with centered titles/content.
- Talents are circles; skills are squares.
- Basic skills are fixed, position-0 skills, normally three.
- Exactly one basic skill is selected by `baseSkillId`; show an emerald ring and **Selected** badge.
- Mutated skills are unpositioned, non-inspired skills that are not basic.
- Tooltips show English name, rank, optional description, skill ID, and tags.
- Talents legitimately have no description; never show “No description available.”
- The Angular root component uses `ChangeDetectionStrategy.OnPush`; live SSE updates flow through signals, and battle rows use stable tracking keys to avoid unnecessary DOM replacement.
- Tooltip behavior is document-level: `pointermove`, `elementFromPoint`, nearest `[data-talent-id]`, fixed positioning, viewport-edge flipping, `pointer-events: none`, and immediate clearing off-tile, on document leave, window blur, or modal close. Ordinary SSE/battle updates must not clear an active tooltip.
- Keep tooltip DOM outside overflow-clipped grid regions.

### Hero stats tab

- The hero dialog is a tab group with **Talents** first and **Stats** second.
- Stats contains two side-by-side lists: `HeroData.attrData` for current/base values and the matching `CombatData.attrData` for live combat values.
- The **Refresh stats now** button uses the same on-demand snapshot marker and updates the open hero without waiting for battle completion.
- Match each hero to combat state through `AdvFieldData.advBattleData.comPlayerList` and the combat object's `heroData` pointer.
- Enumerate every nonzero `EAttrType`, including normally hidden/internal modifiers. Use `TAttr` for English names/descriptions and retain the enum key plus numeric ID for transparency.
- Use `AttrInfoData.Create`, `SetOwnHeroData`, `GetDesc`, `GetSpecialDesc`, and `GetExplain` for the game's resolved derived explanations. Pass the hero's level for both base and combat attributes.
- Crit explanations are verified to resolve values such as `Crit Value: 9629` into 54% crit chance and 154% additional damage.

## English localization

Prefer extracted English values regardless of active language. Payloads carry pairs such as `name`/`englishName`, `description`/`englishDescription`, and `placeTitle`/`englishPlaceTitle`; the UI prefers English and falls back to current-language values.

Catalogs cover talents, skills, abilities, materials, runes, tools, curios, and equipment. Hero talent payloads include ranks, fixed grid position metadata, tags, icon URL, skill ID, and selection state.

## Data retention and privacy

- Backend keeps 50 battles per slot in memory.
- Rift-Star average uses all retained exact matches (up to 50).
- `data/events.jsonl` may contain hero names, equipment, and gameplay history; it is ignored.
- Catalogs and icons are ignored.
- No telemetry is intentionally sent off-machine.
- Public GitHub repository: [https://github.com/kpapadatos/path-of-idle-stats](https://github.com/kpapadatos/path-of-idle-stats).

## Portability notes

- Player startup is portable across Steam library drives: `scripts/find-game.ps1` discovers Steam from registry data, parses `libraryfolders.vdf`, validates app manifest `4243990`, and verifies the executable/data layout.
- `start.bat` installs from checked-in `vendor/bepinex` and `release/PathOfIdleStats.dll`, starts `vendor/node/node.exe`, passes the discovered game directory to the server, waits for `/api/health`, and opens the browser.
- The server uses `PATH_OF_IDLE_GAME_DIR` for request-file IPC instead of a hard-coded game location.
- `node_modules` remains intentionally ignored because it is build-only and adds about 208 MB without helping players.
- Maintainer-only `build-plugin.ps1` still assumes the default Steam interop directory; parameterizing that build path and pinning icon-extraction dependencies remain future cleanup.

## Troubleshooting

- Angular blank screen with `NG0908`: retain `import 'zone.js';` at the top of `web/src/main.ts`, then rebuild.
- Dashboard unavailable: confirm `dist/dashboard/browser/index.html`, Node port 43127, and `/api/health`.
- No telemetry: confirm the plugin DLL, inspect `BepInEx\LogOutput.log`, enter a save, start the server, and request a snapshot.
- Missing icons: confirm the game is running with plugin 0.7.8 or newer and check `<game>/BepInEx/PathOfIdleStats/icons`; the dashboard's ignored `data/icons` cache is only a developer fallback.
- Place says only `chapter`: build it from English chapter row plus site index, e.g. `Rift-Star Expanse-15`.
- No selected marker: request a fresh snapshot and verify a basic skill has `selected: true` from `SaveHeroData.baseSkillId`.

## Development and Git workflow

Before committing dashboard work:

```powershell
pnpm build
Invoke-WebRequest http://127.0.0.1:43127/ | Select-Object StatusCode
git diff --check
git status --short
```

For plugin changes: close the game, build, update, verify DLL hashes, restart, enter the save, inspect the BepInEx log, request a snapshot, and confirm three slots plus hero/talent selection data.

The public repository is [https://github.com/kpapadatos/path-of-idle-stats](https://github.com/kpapadatos/path-of-idle-stats); the default branch is `main`. Preserve reproducibility with pinned runtime versions, published archive hashes, bundled licenses, scripts, and verification checks. Never commit runtime telemetry or game-derived assets.
