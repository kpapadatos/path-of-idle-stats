# Path of Idle Stats — maintainer memory

This is the durable handoff for continuing the project from a clean checkout. It captures the project-relevant knowledge, decisions, mistakes, safety constraints, and user preferences accumulated during development. It intentionally does not reproduce private platform/system prompts verbatim.

Current baseline at the time of this update:

- Public repository: [https://github.com/kpapadatos/path-of-idle-stats](https://github.com/kpapadatos/path-of-idle-stats)
- Branch: `main`
- Released version: `v0.10.2`
- Release commit: `34ae4b6`
- Local project path used during development: `C:\r\path-of-idle-stats`
- Default Steam game path on the original machine: `C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle`
- Dashboard: [http://127.0.0.1:43127](http://127.0.0.1:43127)

## Product and goal

Path of Idle Stats is a local companion for **Path of Idle: Old Gods Rising**. A BepInEx 6 IL2CPP plugin reads live Unity runtime objects, sends telemetry to a loopback-only Node server, and an Angular/Tailwind dashboard presents:

- the three concurrent battle slots and ordered heroes;
- retained battle history, finalized loot, per-hero final DPS, and loot/hour;
- Gold, Blood, Bone, Sanctum floor, and Sanctum resource bonus;
- hero talents, skills, live/base stats, buffs/debuffs, and damage meters;
- one-second live and historical combat timelines;
- a searchable, rank-scaled talent compendium;
- the game Codex with awareness and possible/excluded rank-9 affixes;
- an inventory/warehouse/vault item scanner with persistent filters and groups.

Everything is local. The plugin is observational except for the explicitly guarded restart automation, which invokes real game UI handlers for Continue and Auto. It must never edit save files or directly mutate gameplay/save state.

## Working relationship and user expectations

The user does not want to learn or operate BepInEx internals; handle the workflow end to end. They are technically discerning about architecture and UX and expect evidence, not guesses.

- Protect the game, save, filters, history, and the rest of the computer above all else.
- Never inspect, edit, copy, move, or delete save files on disk. Runtime objects named `Save*` may be read in memory; that is not permission to touch save files.
- Be autonomous. If a safe script already closes/updates/reopens the game, use it instead of repeatedly asking the user to do manual restarts.
- Give short progress updates during tool work; do not leave the user waiting without explanation. Trivial filesystem checks should finish in seconds.
- Verify runtime fields against values visible in the game before shipping a mapping. A field with a plausible name is not sufficient.
- Do not claim something is fixed merely because it compiles. Build, install when appropriate, inspect logs/API state, and let the user test behavior that needs real gameplay.
- Preserve existing user data before migrations. The loss of a carefully built scanner filter is unacceptable.
- Avoid regressions in unrelated features. When changing shared state, SSE reconciliation, tooltips, or hero payloads, explicitly test adjacent behavior.
- The user prefers clean, robust architecture and notices flicker, delayed updates, stale data, random identity swaps, and unnecessary polling immediately.
- Do not commit or push unless the user explicitly asks.
- Standing release rule: when the user says **commit and push**, increment the patch version and create/push an annotated `v<version>` tag unless they explicitly say otherwise. Never move or reuse a tag.
- Updates must overwrite the existing project folder rather than use a new folder; otherwise ignored local data such as scanner filters/history is lost.

## Non-negotiable engineering rules

### Runtime identity and IL2CPP pointers

Unity/IL2CPP native pointers are transient and may be reused after an object is removed. Earlier long-lived pointer caches caused effect titles/icons/descriptions to become apparently random over time, and incorrect joins caused swapped talent identities.

- Never persist a native pointer, expose it as durable identity, or use it across battles/object lifetimes.
- Never use a pointer-address cache as a catalog or provenance database.
- If a pointer is unavoidable inside one active runtime lifecycle, scope it to that exact instance, clear it on the matching removal/battle reset, and immediately resolve durable IDs and provenance.
- Durable identities use game definition IDs, hero unique IDs, battle IDs, item rarity+definition ID, affix IDs, and explicit source fields.
- Resolve an entity's title, description, icon, rank, and ID from the same definition/runtime object. Do not zip unrelated lists or assume reflection/dictionary enumeration order.
- Never join collections by array index unless the game type explicitly guarantees that structure.

### Angular and live updates

- Every Angular component uses `ChangeDetectionStrategy.OnPush`.
- Use signals/computed state, immutable updates, stable `trackBy` keys, and reference reuse for unchanged battles/heroes.
- Do not rebuild the 50×3 retained history on every heartbeat or snapshot. Hovered rows and tooltips must not flicker when unrelated telemetry arrives.
- Heartbeats update liveness without broadcasting a full state when presence did not change.
- Expensive/high-frequency work must live outside Angular's zone when possible.
- Never attach a tooltip inside an overflow-clipped container. Tooltips are fixed, document-level, `pointer-events: none`, viewport-aware, and cleared on true pointer leave, document leave, blur, modal close, or anchor removal.
- Changing a timeline point must update or close the tooltip deterministically; never leave a tooltip bound to stale effect DOM/data.
- Browser tabs must consume backend-owned state. Multiple open tabs must not cause multiple game scans, polling loops, or timeline collectors.

### Persistence and file growth

- Never use an ever-growing append-only file as primary state.
- Battle history is capped at 50 entries per slot. Its timeline is deleted when the owning battle is reset or evicted.
- Historical timelines are compressed before SQLite storage.
- Scanner filters/groups live in a single SQLite row containing the complete JSON state.
- SQLite writes and pruning must be transactional.
- Do not persist heartbeats, full snapshots, repeated catalogs, or high-volume inventory events.
- Known debt: the server and plugin still have low-volume `events.jsonl` fallback/diagnostic paths. Never add high-volume event types to them; if this area is touched, add explicit size retention/rotation or remove the fallback. Completed battles, snapshots, heartbeats, and automatic scanner item events must not be appended there.

### Game safety and installation

- The game must be closed before replacing BepInEx/plugin DLLs.
- Close it normally with `CloseMainWindow()`; never force-kill it during an update.
- Validate the exact game executable and Steam manifest before touching the game directory.
- Only install the pinned BepInEx distribution and `BepInEx\plugins\PathOfIdleStats.dll`.
- Installation/removal is manifest-limited and hash-verified. Preserve backups of collisions/replaced plugin DLLs.
- Never recursively delete or overwrite broad game/project directories.
- BepInEx console output is disabled through its configuration; disk logging remains available in `BepInEx\LogOutput.log`.
- Plugin hooks must fail safely and must not block Unity's main thread on network I/O.

## Repository layout

- `plugin/Plugin.cs` — BepInEx plugin, Harmony hooks, reflection extraction, localization, icon export, timelines, scanner, restart UI handshake.
- `plugin/PathOfIdleStats.csproj` — .NET 6 metadata.
- `server/server.mjs` — dependency-free Node HTTP/SSE server, request correlation, scanner orchestration, SQLite persistence, static files.
- `web/src/main.ts` — standalone Angular dashboard. It currently contains the root component and isolated OnPush historical-DPS child.
- `dist/dashboard/browser/` — committed production Angular build used by players.
- `release/PathOfIdleStats.dll` — committed release plugin.
- `vendor/bepinex/` — pinned player BepInEx runtime.
- `vendor/node/` — pinned Windows x64 Node runtime.
- `scripts/find-game.ps1` — Steam registry/library discovery and app/layout verification.
- `scripts/start.ps1`, `start.bat` — one-step install/update, server startup, health wait, browser opening.
- `scripts/build-plugin.ps1` — Roslyn build against BepInEx/game interop.
- `scripts/install.ps1` — guarded initial installation.
- `scripts/update-plugin.ps1` — guarded hash-backed plugin replacement.
- `scripts/configure-bepinex.ps1` — hides BepInEx console while retaining logs.
- `scripts/restart-game-and-update.ps1` — normal close, build/update, Steam launch, right-half placement, Continue, Auto.
- `scripts/uninstall.ps1` — manifest-limited uninstall/restoration.
- `scripts/extract-icons.py` — developer-only bulk icon extraction fallback.
- `data/` — ignored SQLite, runtime state, catalogs, backups, optional developer icons.
- `work/` — ignored downloads, decompilation, staging, experiments, and temporary diagnostics.
- `docs/images/` — committed README screenshots.

Ignored/private runtime data includes `data/`, `work/`, `node_modules/`, build caches, `install-manifest.json`, logs, SQLite sidecars, `.env*`, and editor files. Do not commit locally extracted game assets, tokens, usernames, telemetry, or machine-specific installation records.

## Runtime/provenance baseline

- Windows x64; Steam app ID `4243990`.
- BepInEx: `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.760+a1afbfb.zip`.
- BepInEx SHA-256: `9753B825578A3C3A31CC10067CD45A44A7BF56D3C34C4679E24D6ADFD0FBA8EA`.
- Node runtime: Windows x64 `22.22.2`.
- Node archive SHA-256: `7C93E9D92BF68C07182B471AA187E35EE6CD08EF0F24AB060DFFF605FCC1C57C`.
- Plugin target: .NET 6.
- Build dependencies are locked by `pnpm-lock.yaml`.
- Runtime server uses Node built-ins; `node_modules` is build-only and intentionally not bundled.

Only source BepInEx from the official BepInEx build server/GitHub organization and verify the pinned hash. Do not use repacks.

## Player install and update

`start.bat` is the player entry point. Players need Windows, Steam, and the game; they do not need Node, npm, .NET, or a separate BepInEx download.

It:

1. discovers Steam through registry data;
2. parses every configured `libraryfolders.vdf`;
3. locates app `4243990`;
4. validates `PathOfIdle.exe`, `GameAssembly.dll`, and `PathOfIdle_Data`;
5. installs the pinned bundled BepInEx only when safe;
6. installs/updates only the plugin when its hash differs;
7. starts the bundled Node server;
8. waits for `/api/health`;
9. opens `http://127.0.0.1:43127/`.

Daily startup is idempotent. If the healthy server already exists, the launcher opens it. If the installed plugin already matches, it does not rewrite it.

For updates, paste new files into the existing Path of Idle Stats folder and overwrite. Never delete the old folder first and never extract into a different folder, because ignored `data/path-of-idle-stats.sqlite` contains user filters and history.

## Maintainer build and safe restart

Source build:

```powershell
pnpm install --frozen-lockfile
pnpm build
.\scripts\build-plugin.ps1
```

The plugin build references BepInEx-generated IL2CPP interop assemblies under the game. On a clean developer machine, install BepInEx, run the game once to generate `BepInEx\interop`, close normally, then build.

### Reusable close/install/reopen script

For normal plugin development, use:

```powershell
.\scripts\restart-game-and-update.ps1
```

If the plugin is already built:

```powershell
.\scripts\restart-game-and-update.ps1 -SkipBuild
```

The script deliberately performs the following guarded sequence:

1. verifies the exact game executable and Steam manifest;
2. builds before closing the game, so compile failure leaves the running game untouched;
3. finds only the exact `PathOfIdle.exe` process;
4. requests a normal window close and refuses to force-kill on timeout;
5. waits for game-directory helper processes to exit;
6. configures BepInEx console logging;
7. invokes the manifest-aware plugin updater;
8. verifies built and installed DLL SHA-256 hashes match;
9. creates tiny request markers under `BepInEx\PathOfIdleStats`;
10. launches through `steam://rungameid/4243990`;
11. waits for the plugin to locate the exact MainScene Continue handler;
12. finds exactly one visible `UnityWndClass` belonging to the game PID, not the BepInEx terminal;
13. restores and positions that game window on the right half of its monitor work area;
14. acknowledges positioning, then the plugin invokes the real `OnContinueBtnClick`;
15. waits for one active adventure UI with exactly three verified field cells;
16. calls the real pointer-click path on each unchecked visible Auto toggle;
17. confirms all three toggles are on and all three live battles exist.

No screen coordinates, arbitrary mouse input, direct `SetAuto` call, or save mutation are used.

Important gotcha: the current committed script always turns on all three Auto toggles and starts all battles. Do not run it blindly if a configured battle consumes scarce attempt materials or the user wants battles stopped. A temporary diagnostic-only `-SkipAuto` variation was previously used and then reverted; do not leave diagnostic changes in the repository.

After restart, verify:

```powershell
$built = (Get-FileHash .\plugin\bin\Release\net6.0\PathOfIdleStats.dll -Algorithm SHA256).Hash
$installed = (Get-FileHash '<game>\BepInEx\plugins\PathOfIdleStats.dll' -Algorithm SHA256).Hash
$built -eq $installed
Get-Content -Tail 100 '<game>\BepInEx\LogOutput.log'
```

The script does not start the Node dashboard. Use `start.bat` or `pnpm start` separately.

## Architecture

```text
Path of Idle Unity runtime
  -> BepInEx 6 IL2CPP + named Harmony hooks
  -> PathOfIdleStats.dll
  -> POST http://127.0.0.1:43127/api/events
  -> Node state + request correlation + SQLite
  -> SSE /api/stream
  -> OnPush Angular dashboard
```

The plugin sends a two-second heartbeat. The backend marks the game stopped after five seconds without one and broadcasts only a liveness transition. General on-demand requests use atomic marker files in `<game>\BepInEx\PathOfIdleStats`. The selected-hero combat request is checked every 50 ms; general requests are checked four times per second. Telemetry enqueue triggers an immediate asynchronous drain.

The server binds only to `127.0.0.1`. `PATH_OF_IDLE_GAME_DIR` allows portable Steam library paths.

### Main HTTP API

- `GET /api/health` — server health.
- `GET /api/state` — lightweight public live state.
- `GET /api/catalogs` — current catalogs.
- `GET /api/stream` — server-sent state.
- `POST /api/events` — plugin ingestion, 1 MB limit.
- `POST /api/snapshot` — requests slots/heroes/resources.
- `POST /api/combat-snapshot` — correlated one-hero live capture.
- `GET /api/battle-timelines/:battleId/heroes/:heroId` — only one historical hero timeline.
- `DELETE /api/battles/0|1|2` — reset one slot.
- `POST /api/catalogs/refresh` — on-demand catalog regeneration.
- `GET /api/codex`, `POST /api/codex/refresh` — cached/on-demand Codex.
- `GET|PUT /api/scanner/state` — persistent scanner state.
- `POST /api/scanner/state/import` — guarded first migration from browser state.
- `POST /api/scanner/scan` — one correlated backend-owned storage scan.
- `GET /assets/icons/<sha256>.png` — serves local extracted icons.

## Persistence and privacy

`data/path-of-idle-stats.sqlite` contains:

- `scanner_state`: exactly one row with the complete filters/groups/options JSON;
- `battle_history_state`: exactly one row with retained history JSON;
- `battle_timelines`: one gzip blob per retained battle;
- `runtime_migrations`: idempotent migration records.

Battle/timeline insertion, 50-per-slot pruning, and orphan deletion happen transactionally. Server restart restores history and scanner configuration. Reset deletes that slot's history and timelines. Scanner initial browser import creates a JSON backup before replacing server state.

No telemetry is intentionally sent off-machine. Runtime data may include hero names, equipment, battle history, combat effects, and scanner configuration. All of it is ignored by Git.

### Browser-local preferences

Local storage is only for view preferences and migration compatibility:

- talent compendium rank and selected/pinned talents;
- Codex rarity and attribute search;
- globally pinned hero stat keys;
- selected average chapter for each battle slot;
- legacy scanner filters/groups/Auto/warehouse values for one-time server import.

Authoritative scanner state is SQLite, not local storage.

## Plugin hooks and reverse-engineering map

Current named Harmony hooks:

- `AdvBattleData.Create` — create per-slot battle capture and timeline schedule.
- `CombatData.CreateEnemy` — count/describe enemies.
- `ActionData.OnCastSkill` — per-talent cast counts.
- `AdvTallyData.AddData` overload with five parameters — damage aggregation.
- `AbilityCheckData.CreateByBulletCrit` — critical counts.
- `AbilityCheckData.CreateByBulletDodge` — miss counts.
- `AdvFieldData.BattleEnd` — one authoritative completed battle.
- `TableData.init` — catalogs and icon total.
- `Root.Update` — lightweight marker consumption, heartbeat, icon budget, timeline capture.
- `TriggerResultData.DoAbility` + `ComAbilityData.AddAbility` + `AbilityData.Remove` — scoped effect provenance.
- `LordBagData.addItemToBag` — event-driven automatic scanner for only the new equipment item.

Patch known type/method names directly. Broad `Assembly.GetTypes()`/Harmony assembly scans caused noisy IL2CPP `TypeLoadException` failures such as invalid `LightProbesQueryDisposeJob`; do not reintroduce them.

Important runtime paths:

- `Game.dataMgr.nowSeasonData.advData.advFieldList` — three adventure fields.
- field `heroFieldList -> heroData` — assigned slot heroes.
- `AdvBattleData.comPlayerList` and each combat object's `heroData` — live hero matching.
- `SaveHeroData.baseSkillId` — selected basic skill.
- `HeroTalentData.ChangeBaseSkill(int attackId)` — game method that changes it; Stats only reads.
- `TTalentPos.row/col/type/index` — fixed 6×5 talent position.
- `battleMapData.mapSiteData`, `chapSiteData`, chapter row, site index — English place title.
- `HeroData.attrData` — current/off-combat stats.
- `CombatData.attrData` — live combat stats.
- town `resDic` IDs 1/2/3 — Gold/Blood/Bone.
- map save `towerFloor` — Sanctum floor.
- Sanctum primary-resource bonus is directly derived by the game's rule at +2% per floor; payload rate is `floor * 0.02`, displayed as percent.

English text must be explicitly resolved from the translation table regardless of active game language. Payloads generally carry raw/current and `english*` variants; UI prefers English.

## Data correctness gotchas

### Battle completion and loot

- Emit exactly one `battle.ended`; never emit provisional data followed by a correction.
- Read finalized `AdvFieldData.dropItemList` in the `BattleEnd` postfix. Early drop hooks precede global reward adjustments and produced wrong Gold/Blood.
- Gold/Blood Sanctum multiplication is already represented in finalized field loot; do not apply a guessed multiplier in the server/UI.
- Tower mode differs: final boss rewards remain in `AdvBattleData.pendingBossDropList` during `BattleEnd`. Merge that list only for tower, deduplicate by same-live-instance pointer within that synchronous operation, then serialize stable item IDs. This recovers missing Gold/Blood/chests without double-counting other modes.
- Aggregate stackable loot by type+ID; keep equipment separate because rolls differ.
- Curio instances may have a specific English title such as **Echo of the Boss** or **Abyssal Scales**. Prefer instance/definition English names over the generic item-type name.
- Loot speed uses all retained battle loot and durations. Sort descending globally, then split into two contiguous columns so every left-column entry is at least as large as every right-column entry.

### Effects, stats, and damage

- Effect labels/icons are not reliably parallel to the raw ability list. Capture origin during the game call that creates the ability and resolve a stable source skill/item immediately.
- Enhancements such as Mettle may use their native effect identity. Auras/buffs should use a verified originating skill/item only when the relationship is proven.
- If a source icon cannot be proven, use the generic effect fallback (historically the green arrow) instead of assigning a plausible but wrong skill.
- Stacks come from the active runtime effect; never infer them by counting similarly named effects.
- Stats enumerate all nonzero `EAttrType`, including hidden modifiers.
- Build English stat metadata from `TAttr`. Use `AttrInfoData.Create`, `SetOwnHeroData`, `GetDesc`, `GetSpecialDesc`, and `GetExplain` with the hero level.
- Preserve resolved explanation arguments. Crit Value descriptions contain multiple independently computed placeholders; replacing every placeholder with the raw stat value is wrong.
- Main stat lists floor the visible number; tooltips retain precise values.
- Live combat lists show only keys that also exist in current hero stats so both columns align.
- Damage meter includes total damage/DPS and per-skill damage/DPS, casts, hits, criticals, and misses. Use K/M/B/T formatting.

### Talents and icons

- Talent tree is exactly six rows by five columns; empty cells are valid.
- Talents and skills are different entities. Compendium lists talents only.
- Talent rank descriptions are generated for ranks 1–15 from game preview objects and must update with the selected rank.
- Preserve game line breaks: normalize `<br>` and newline data and render descriptions with `white-space: pre-line`.
- Icon export keys are resolved from the same talent/item row as the title and description. Earlier cross-row reuse swapped icons such as Zod/Unyielding.
- Runtime hero avatar extraction was unreliable and was completely removed. Do not add a placeholder or retry unless a stable source is found.

## Icons and first-run loader

Catalog creation queues every referenced sprite. The plugin exports PNGs into `<game>\BepInEx\PathOfIdleStats\icons` using a temporary render target so non-readable Unity textures work.

- Existing cached files are discovered before work is queued.
- Missing icons export at about 50/second, with a maximum three-icon catch-up batch per frame.
- Exact dynamic progress is atomically stored in `icons.progress.json` and emitted as `snapshot.icon-progress`.
- Never hardcode the total icon count. The dashboard waits for the plugin's real total.
- Before completion, show only the centered **Loading...** bar and exact `completed / total`.
- If the game is closed, show **(Start the game to continue)**.
- Missing icon responses are retried outside Angular; do not display a dashboard full of permanent broken images.
- Game-extracted/copyrighted icons are local and ignored. `data/icons` is only a developer fallback.

## Current dashboard contract

The viewport is a fixed-height application. Header, resource row, and top tabs remain visible; each page tab body scrolls independently.

### Header and resources

- Title: **Path of Idle Stats**, followed by live `v<pluginVersion>`.
- Controls: Refresh heroes, Game running/stopped, Backend connected/reconnecting.
- Four equal cards: icon+number for Gold, Blood, Bone; text-only `Sanctum Floor X (+Y%)`.
- Resource values and Sanctum update on battle end and explicit snapshots from runtime state.

### Battles tab

- Exactly three vertical battle panels.
- Each panel has three ordered hero tiles. Runtime order is reversed to match game display order.
- Hero tile: class icon before name and level on the same row. No avatar, class-name text, “Position,” “Team order,” or “Battle Slot” labels.
- Hero tiles open the hero modal in normal live/manual context.
- History retains newest 50 per slot and starts collapsed at both slot-history and individual-battle levels.
- Reset history is always visible at the right end of the history summary, disabled when empty, and visually subtle.
- History header dims the count/chapter portion and centers `Avg. Time: X.XXXs`.
- Average selector defaults to standard **Rift-Star Expanse-15**, is persisted per slot, and lists distinct retained titles for that slot. Treasure variants are separate and display `(Treasure)`.
- Picker has an auto-focused search. Average includes only completed wins whose exact title and treasure flag match the selection.
- The info tooltip explains that the average applies only to the selected chapter.
- Each collapsed battle row shows place/result/duration, timestamp, and a centered three-hero final-DPS strip.
- Missing hero/DPS data leaves that slot empty; never shift another hero into it.
- Clicking a DPS hero opens that hero's read-only retained timeline without preventing the surrounding battle row from expanding.
- Expanded battle shows enemy count, wave, mode, and finalized loot.
- Loot speed appears below the three slots in a compact two-column descending list with icon/title/rate.

### Talents tab

- Full-width search over talent title, class, description, and IDs.
- Rank control is `− [1..15] +`; native number spinners are hidden and the number is centered.
- Three-column cards show talent icon, overlaid class icon, title, class, rank-scaled description, and `rank/15` at 50% opacity.
- Clicking toggles selection and displays a pin after the title.
- Selected talents appear in their own three-column grid above the main grid; a divider exists when at least one is selected.
- Selected talent IDs and rank persist in local storage.

### Codex tab

- Fetches on first entry and on Refresh; it is not continually polled.
- Left rarity views: Rare (default), Legendary, Set, Unique, Mythic. Last rarity persists.
- Right side is a ten-column square icon grid sorted by item part, weapon subtype where applicable, table sort index, then ID.
- Square displays Codex awareness.
- Rarity backgrounds: rare yellow, legendary orange, set green, unique cyan, mythic red. Use these consistently in Codex and Scanner.
- Clicking opens possible affixes produced through the game's Codex eligibility path. Never list generic damage affixes on parts for which the game does not allow them.
- Attribute rows show rank as `9`, not “Rank 9,” and are vertically centered.
- Display game rank-9 ranges such as `Physical Attack +(20–29%)`.
- Affixes excluded/disabled in the player's Codex are retained and shown with a red background and **Excluded**.
- Attribute search sits above the scroll area, persists across items/local refresh, auto-focuses, and selects its contents when the dialog opens.

### Scanner tab

- Button row: Scan all storage, Create item filter, Create filter group, Warehouse switch+info, Auto switch+info.
- Manual scanning is backend-owned and correlated. Warehouse off scans inventory only; on also scans every warehouse tab and vault.
- Auto is event-driven from `LordBagData.addItemToBag`; it compares only the newly added equipment item against the backend's compiled enabled-filter index. It never presses Scan on an interval.
- Backend owns the shared matches array. Every browser tab observes the same result without initiating duplicate work.
- A pleasant short Web Audio notification plays only when a match notification ID changes.
- Match tooltip includes full item data, storage location (`WAREHOUSE STORAGE - TAB N` when known), affixes, every matched filter, and group title.
- Filter cards are a three-column grid, enabled by default, single-click renameable, editable, and deletable.
- Card preview shows first five items and a compact `+N more` tile.
- Groups can be renamed in place, reordered, collapsed, expanded, and accept dragged filters. Ungrouped is a drop target.
- Deleting a nonempty group requires a modal warning that its contained filters will also be deleted.
- Editor changes auto-save; closing is not the save action.
- Item picker contains all Codex items/rarities. Selecting the first item establishes the primary part restriction; removing it promotes another selected item as anchor. Restriction clears only when no items remain.
- Selected items are shown only in the picker, not duplicated above it. Click again or right-click to unselect.
- Item picker uses compact ten-column icons.
- Items and Options share a row. Options currently contains `Must match at least X selected attributes` with bounds 1..selected-stat-count.
- Available/selected attributes are side by side, each with a header search outside its independently scrolling list.
- Click adds a stat. Right-click or X removes a selected stat.
- If an affix is disabled for any selected item, show it red, prevent adding it, and expose a fixed tooltip listing `Item name (Rarity)`.
- Filters/groups/Auto/Warehouse are persisted in the single SQLite state row. Never silently replace them with empty browser defaults.

### Hero modal

- **Stats** is the first/default tab; **Talents** is second.
- Modal header and tabs stay fixed; each tab body scrolls independently.

Talents view:

- Inspired talents centered above the tree.
- Fixed 6×5 grid uses explicit row/column metadata and allows holes.
- Talents are circles; skills are squares.
- Ranked talents and skills use the same highlighted-border style; rank text is centered below.
- **Basic skills** and **Mutated skills** share one row as separate centered sections.
- Exactly one of the three basic skills is selected via `baseSkillId`; show selected ring/badge.
- Hover tooltip contains English title, rank, optional description, skill ID, and tags. Talents with no description show no placeholder sentence.

Stats view:

- Fixed top stack: timeline, full-width horizontally scrolling effect row with background, then controls.
- Timeline has horizontal gutter so first/last circles do not touch the border; points remain relatively spaced from first to last.
- Empty effect row says **Buffs and debuffs will appear here.** with 15 px left padding.
- Effect icons are compact with a two-pixel gap; debuffs follow buffs without “Buffs”/“Debuffs” headings.
- Controls: previous, next, Clear (always present, disabled when empty), Record/Stop, Refresh.
- Refresh adds one snapshot. Record serializes non-overlapping one-second requests and stops on death, manual stop, or selected-slot battle transition. Refresh is disabled while recording.
- The area below controls scrolls independently so timeline/effects/buttons remain visible.
- Left panel switches between **Current hero stats** and **Damage done**; its heading height aligns exactly with **Live combat stats**.
- Current/off-combat values must continue to come from `HeroData.attrData`; live values come from the chosen snapshot's `CombatData.attrData`.
- Clicking any stat pins/unpins it globally for all heroes, adds a pin, hoists pinned keys in stable order, and persists them.
- Damage view shows total DPS/damage/elapsed and per-skill `damage | Casts | Hits (crit, miss)`.
- Historical context is read-only. Clear/Record/Refresh are disabled and cannot mutate retained timeline data.

## Combat timeline architecture

Live manual capture:

- Browser calls one correlated backend endpoint.
- Backend writes a request with `requestId` and `heroUniqueId`.
- Plugin extracts only that hero and returns a matching `snapshot.combat`.
- Backend resolves the waiting request directly instead of replacing all dashboard state.

Historical capture:

- Plugin, not the browser, owns a staggered one-second schedule for every active battle.
- It samples all three heroes in a slot as one batch, supporting up to nine active heroes without nine browser pollers.
- It captures no samples during the seven-second intermission because the battle object is absent.
- A forced final sample is taken at `BattleEnd`.
- Snapshots use compact numeric stat pairs and battle-local interned effect/damage definitions.
- Backend strips `combatTimelines` from the public battle payload, gzip-compresses each retained timeline, and serves one hero lazily.

## Performance lessons

- Never send full hero catalogs/stats/equipment inside every public retained battle row.
- Public state uses lightweight battle summaries; full historical hero/timeline data stays server-side.
- Reuse prior object/array references when IDs and content are unchanged.
- Scanner matching precompiles `itemKey -> enabled filters`; plugin checks rarity/definition ID and affix IDs before expensive item serialization.
- Auto scanner is a hook, not polling.
- Manual scanner traverses storage once and describes only candidate matches.
- Combat requests are correlated and immediately drained, not discovered by slow browser polling.
- Keep Unity work bounded per frame (notably icon export and timeline scheduling).

## Testing and verification

For dashboard/server changes:

```powershell
pnpm build
node --check .\server\server.mjs
Invoke-WebRequest http://127.0.0.1:43127/ | Select-Object StatusCode
Invoke-RestMethod http://127.0.0.1:43127/api/health
git diff --check
git status --short
```

Use the running dashboard to verify the exact interaction, especially:

- hover remains stable while battles finish/SSE arrives;
- tooltips close on mouseout and remain attached to the correct snapshot object;
- history count stays ≤50 per slot after restart;
- reset deletes SQLite timeline ownership;
- scanner filters survive refresh/server restart/update;
- Auto adds only newly acquired matching items;
- manual warehouse scan labels tabs correctly;
- current and live hero stats remain aligned;
- historical timelines are read-only.

For plugin changes:

1. build before closing the game;
2. use the safe restart script when its Auto behavior is acceptable;
3. verify installed and built hashes;
4. inspect `BepInEx\LogOutput.log`;
5. enter the save and request a fresh snapshot;
6. compare extracted values against the visible game;
7. test all three battle modes/slots when shared loot/history code changed.

Do not leave diagnostic hooks, temporary marker files, traces, or experiments installed. Restore source and installed DLL to the released baseline after one-off investigations.

## Release workflow

Only when explicitly asked to commit and push:

1. confirm the user has tested the current behavior when runtime testing is needed;
2. increment `Plugin.PluginVersion` patch component;
3. rebuild plugin and production Angular dashboard;
4. copy the built DLL to `release/PathOfIdleStats.dll`;
5. verify build/install hashes as appropriate;
6. run build, syntax, diff, status, and focused runtime checks;
7. commit a concise release commit;
8. create annotated tag `v<version>`;
9. push `main` and the tag;
10. confirm remote branch/tag point to the expected commit.

Do not include `data/`, extracted icons, SQLite, logs, `work/`, install manifests, tokens, or machine-specific files.

## Troubleshooting

- Angular black screen / `NG0908`: retain `import 'zone.js';` before bootstrap, rebuild.
- Dashboard unavailable: verify `dist/dashboard/browser/index.html`, port 43127, and `/api/health`.
- No game data: game must be running inside a save, not only at main menu; inspect plugin DLL and BepInEx log, then request snapshot.
- Game indicator stale: heartbeat is every two seconds; stopped threshold is five seconds.
- Missing icons: wait for dynamic loader with game running; inspect `icons.progress.json` and local icon directory.
- Place says only “chapter”: resolve English chapter row plus site index, e.g. `Rift-Star Expanse-15`.
- Wrong selected basic skill: refresh and verify `SaveHeroData.baseSkillId`.
- Wrong loot amounts: confirm data comes from finalized BattleEnd field list; for tower also merge pending boss drops.
- Wrong/mutating effect title or icon: audit transient pointer/index caching first.
- UI hover flicker: audit reference reconciliation, `trackBy`, OnPush boundaries, and unnecessary SSE broadcasts.
- Scanner says matches but lists none: inspect correlation response and backend authoritative matches, not browser polling flags.
- Filters disappeared: stop before writing; inspect SQLite scanner row and `data/scanner-state-backups`; never initialize server state from empty local storage over existing SQLite.
- Version still old after dashboard refresh: the version is emitted by the running plugin heartbeat. Rebuild/install/restart the game; rebuilding only the dashboard cannot change it.

## Public repository hygiene

The repository is intended to be safe and public. Before releases, search tracked files and history for secrets, personal paths/usernames, telemetry, and save-related data. Default public Steam paths and the public GitHub URL are acceptable; authentication tokens and machine/user-specific paths are not. Use the authenticated local `gh` CLI without writing credentials into the repository.
