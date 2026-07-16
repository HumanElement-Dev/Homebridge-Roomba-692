# CLAUDE.md — homebridge-roomba692

Homebridge platform plugin for the iRobot Roomba 692 (600-series). Exposes the robot as a HomeKit Switch + Battery service. The entire plugin is a single file: `index.js`.

## Critical constraints

**The TLS patch must remain the very first code in `index.js`, before any `require()`.** It monkey-patches `tls.createSecureContext` globally to work around three separate OpenSSL 3 / Node 18+ incompatibilities with the Roomba's self-signed certificate:

1. **SECLEVEL=1** — drops from OpenSSL 3's default SECLEVEL=2, which rejects SHA-1 certs.
2. **sigalgs override** — OpenSSL 3 also blocks RSA+SHA1 signatures separately from SECLEVEL; must be listed explicitly.
3. **Legacy renegotiation flags** — the Roomba uses older TLS handshake patterns rejected by Node 18+.

If `dorita980` is `require()`d before the patch runs, the MQTT client will negotiate TLS with the original `createSecureContext` and every connection will silently fail ("No Response" in HomeKit).

**Firmware version must be `2` for 600-series.** `new dorita980.Local(blid, pwd, ip, 2)` — version 3 (the library default) waits for pose data the 692 never sends, causing `getBasicMission()` to hang indefinitely until the connect timeout fires.

**`await setTimeout()` is broken on Node 18** — it returns `void`, not a Promise. Use `new Promise(res => setTimeout(res, ms))` for all async sleeps.

## Architecture

### State flow
All HomeKit `onGet` handlers read from `this._cache` — they never open a robot connection. The background poller (`_poll`) keeps the cache fresh and self-schedules the next poll via `_scheduleNextPoll`.

```
didFinishLaunching
  └─ _sync()           — register/restore accessory, wire characteristics, start polling
       └─ _startPolling()
            └─ _poll() ──► withRobot() ──► robot.getBasicMission()
                 └─ _scheduleNextPoll() — adaptive: 30s active, 5min idle
```

### Adaptive polling
`isActivePhase(state)` checks `cleanMissionStatus.phase` for `run`, `hmUsrDock`, `hmPostMsn`, `stuck`. When active, polls every 30s; when idle/charging, polls every 5min. Configurable via `pollInterval` / `activePollInterval` (seconds) in the Homebridge config.

### `withRobot(cfg, log, timeoutMs, operation)`
Connect-on-demand wrapper used for every robot command and poll. Creates a fresh `dorita980.Local` connection, runs `operation(robot)`, disconnects, and enforces a hard timeout. The Switch `onSet` handler for dock uses `CONNECT_TIMEOUT_MS + PAUSE_BEFORE_DOCK_MS` as its timeout because it deliberately delays between `pause()` and `dock()`.

### Switch `onSet` (dock path)
Errors on `pause()`/`dock()` are caught and logged as warnings but **not rethrown**. Rethrowing would cause HomeKit to flip the switch back to ON. The robot may already be heading to dock when the error fires.

## Key constants (index.js:47–57)

| Constant | Value | Purpose |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 7000ms | Per-operation robot connection timeout |
| `PAUSE_BEFORE_DOCK_MS` | 1500ms | Delay between `pause()` and `dock()` |
| `IDLE_POLL_MS` | 300000ms | Background poll interval when docked/idle |
| `ACTIVE_POLL_MS` | 30000ms | Background poll interval when cleaning |

## Homebridge config schema

```json
{
  "platforms": [{
    "platform": "Roomba692Platform",
    "name": "Roomba",
    "blid": "<robot-blid>",
    "robotpwd": "<robot-password>",
    "ipaddress": "<robot-ip>",
    "model": "Roomba 692",
    "pollInterval": 300,
    "activePollInterval": 30
  }]
}
```

`blid` and `robotpwd` are obtained via the `dorita980` discovery tool or the iRobot app credentials. `ipaddress` should be a static DHCP reservation.

## Running / testing

No build step. Homebridge loads `index.js` directly via `main` in `package.json`.

Install dependencies:
```
npm install
```

Install into a local Homebridge instance:
```
npm link
# then in homebridge config dir:
npm link homebridge-roomba692
```

View live logs:
```
homebridge -D   # debug flag shows [Roomba692] debug lines
```

## Publishing

Bump `version` in `package.json`, add an entry to `CHANGELOG.md`, commit, then:
```
npm publish
```

## Project identity

- Package: `homebridge-roomba692`
- Platform name: `Roomba692Platform` (must match `"platform"` key in Homebridge config)
- GitHub: `HumanElement-Dev/Homebridge-Roomba-692`
- Author: HumanElement-Dev / richard@humanelement.agency

---

*A [HumanElement](https://HumanElement.agency) idea*
*Made with love by HumanElement & Claude <3*
