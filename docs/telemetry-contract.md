# Telemetry contract (draft)

The plugin will POST newline-safe JSON events to `http://127.0.0.1:43127/api/events`.
If the server is unavailable, events are appended to a local JSONL file under
`BepInEx/PathOfIdleStats/`. No network interface other than loopback is used.

Planned event types:

- `snapshot.heroes`: heroes, levels, classes, calculated stats, equipped items.
- `snapshot.inventory`: item identity, rarity, affixes, sockets/runes, quantities.
- `battle.started`: mode/stage and participating heroes.
- `battle.ended`: duration, result, enemy count, enemies, rewards, and loot.
- `heartbeat`: plugin/game version and connection health.

Exact game fields will be mapped after the first IL2CPP interop/discovery launch.

