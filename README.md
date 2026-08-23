# Path of Idle Stats

Local-only telemetry tooling for **Path of Idle: Old Gods Rising**.

## Safety boundaries

- The project does not locate, read, or write game save files.
- BepInEx and the telemetry plugin are staged under `work/` before installation.
- `scripts/install.ps1` refuses to run while the game is open.
- Installation records every introduced file in `install-manifest.json`.
- `scripts/uninstall.ps1` removes only files recorded by that manifest.
- Telemetry is sent only to `http://127.0.0.1:43127` and stored under `data/`.

## Components

- `plugin/`: BepInEx 6 IL2CPP C# telemetry plugin.
- `server/`: local Node.js ingestion service.
- `web/`: Angular/Tailwind dashboard.
- `scripts/`: safe install, verification, and uninstall helpers.
- `work/`: downloaded and generated staging artifacts (not user data).

Setup and run instructions will be completed after the first verified game launch.

