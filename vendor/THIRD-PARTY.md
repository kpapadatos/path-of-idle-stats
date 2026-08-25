# Bundled third-party runtimes

Path of Idle Stats includes the following pinned runtime payloads so players can use `start.bat` without installing developer tools. The BepInEx binaries are unmodified; this project adds `BepInEx/config/BepInEx.cfg` only to hide its terminal while retaining disk logs.

## BepInEx

- Package: `BepInEx-Unity.IL2CPP-win-x64-6.0.0-be.760+a1afbfb.zip`
- Source: <https://builds.bepinex.dev/projects/bepinex_be>
- Archive SHA-256: `9753B825578A3C3A31CC10067CD45A44A7BF56D3C34C4679E24D6ADFD0FBA8EA`
- License: `vendor/bepinex-LICENSE.txt`

## Node.js

- Package: `node-v22.22.2-win-x64.zip`
- Source: <https://nodejs.org/dist/v22.22.2/>
- Archive SHA-256: `7C93E9D92BF68C07182B471AA187E35EE6CD08EF0F24AB060DFFF605FCC1C57C`
- Bundled executable SHA-256: `AE1A50511BE58E987483FDBC12125407443926D2D394669ADE2352776E920DD3`
- License: `vendor/node/LICENSE.txt`

The Angular dashboard is prebuilt in `dist/dashboard/browser`. Its build-only `node_modules` directory is intentionally excluded because it is not used by the bundled server or one-click startup flow.
