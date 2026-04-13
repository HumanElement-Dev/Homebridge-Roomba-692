# Changelog
All notable changes to `homebridge-roomba692` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] — 2026-04-13

### Fixed
- **Error handling on `clean()`** — missing try/catch on the clean command path meant a failed robot connection would silently flip the HomeKit switch back to OFF with no log output. Now mirrors the dock path's error handling and logs a warning.
- **Platform config documentation** — README incorrectly documented the plugin as an `"accessory"` type. It must be configured under `"platforms"` with `"platform": "Roomba692Platform"`. The old instructions would silently fail to load the plugin.

### Added
- **HumanElement branding** — social preview banner (`.github/social-preview.svg`), square plugin icon (`assets/icon.svg`), and `"A HumanElement idea"` attribution.
- **README badges** — Homebridge ≥1.3, Node ≥18, MIT license badges.
- **`package.json` metadata** — added `author`, `repository`, `homepage`, and `bugs` fields.

---

## [1.0.0] — 2026-02-26

### Added
- **Adaptive polling** — idle robots poll every 5 minutes; active robots (cleaning, returning to dock, stuck) poll every 30 seconds. Reduces unnecessary connections while keeping HomeKit responsive during a clean cycle.
- Configurable poll intervals via `pollInterval` and `activePollInterval` config keys.

### Fixed
- **TLS — legacy renegotiation** (`SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION`, `SSL_OP_LEGACY_SERVER_CONNECT`). The Roomba's older TLS handshake was being rejected by Node 18+ even after the SECLEVEL patch.
- **TLS — RSA+SHA1 sigalgs** explicitly added to the allowed signature algorithm list. OpenSSL 3 blocks SHA-1 signatures separately from SECLEVEL, requiring an explicit `sigalgs` override.
- **State caching** — `onGet` handlers now read from an in-memory cache populated by the background poller. Previously, every HomeKit read attempted a live connection, causing "No Response" under load.
- **TLS cipher SECLEVEL** — first patch: dropped OpenSSL 3 default from `SECLEVEL=2` to `SECLEVEL=1` to allow the Roomba's SHA-1 self-signed certificate.

### Architecture
- Platform plugin structure (`registerPlatform`) replacing the legacy accessory pattern — required for Homebridge child bridge support.
- `withRobot()` wrapper providing connect-on-demand, hard timeout, and automatic disconnect for every robot operation.
- Firmware version hardcoded to `2` for 600-series; version 3 hangs waiting for pose data the 692 never sends.
- Async patterns use `new Promise(resolve => setTimeout(resolve, ms))` throughout — `await setTimeout()` silently breaks on Node 18 (returns void, not a Promise).

## [0.0.1] - 2026-02-25

## [Unreleased]

---

*A [HumanElement](https://HumanElement.agency) idea*
*Made with love by HumanElement & Claude <3*
