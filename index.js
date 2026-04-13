'use strict';

// ============================================================
// TLS COMPATIBILITY PATCH
// Must be the very first code — before any require() that
// touches TLS (including dorita980 → mqtt → tls).
//
// WHY: Raspberry Pi OS Bookworm uses OpenSSL 3, which sets
// SECLEVEL=2 by default. At SECLEVEL=2, certificates signed
// with SHA-1 are rejected. The Roomba 692 uses a SHA-1
// self-signed TLS certificate, so every connection attempt
// fails silently → HomeKit never gets a response → "No Response".
//
// FIX: Intercept every TLS context creation and drop to
// SECLEVEL=1, which permits SHA-1 signed certs. Also allow
// TLSv1 in case the robot negotiates an older protocol version.
// ============================================================
const tls = require('tls');
const _origCreateSecureContext = tls.createSecureContext.bind(tls);
tls.createSecureContext = function patchedCreateSecureContext(options) {
  const opts = Object.assign({}, options);

  // Drop OpenSSL 3 security level to 1 — allows SHA-1 signed certificates
  opts.ciphers = ((opts.ciphers || 'DEFAULT').replace(/@SECLEVEL=\d/g, '')) + '@SECLEVEL=1';

  // Explicitly allow RSA+SHA1 signature algorithm used by the Roomba's cert.
  // OpenSSL 3 blocks this separately from SECLEVEL, requiring an explicit sigalgs list.
  opts.sigalgs = 'RSA+SHA1:RSA+SHA256:RSA+SHA384:RSA+SHA512:ECDSA+SHA1:ECDSA+SHA256:ECDSA+SHA384';

  // SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION (0x00040000) — Roomba uses legacy TLS renegotiation
  // SSL_OP_LEGACY_SERVER_CONNECT          (0x00000004) — allow connecting to legacy servers
  opts.secureOptions = (opts.secureOptions || 0) | 0x00040000 | 0x00000004;

  if (!opts.minVersion) opts.minVersion = 'TLSv1';
  opts.rejectUnauthorized = false;
  return _origCreateSecureContext(opts);
};

// ============================================================
// Now safe to load dorita980 (pulls in mqtt → tls internally)
// ============================================================
const dorita980 = require('dorita980');

const PLUGIN_NAME   = 'homebridge-roomba692';
const PLATFORM_NAME = 'Roomba692Platform';

// Timeout for each robot connection attempt.
// Keep well under Homebridge's ~9s read-handler deadline.
const CONNECT_TIMEOUT_MS = 7000;

// After pause(), wait before sending dock().
// The robot must enter 'stop' phase before it will accept dock().
const PAUSE_BEFORE_DOCK_MS = 1500;

// Background poll intervals — adapt based on robot activity.
const IDLE_POLL_MS   = 300000;  // 5 min when docked/idle (default)
const ACTIVE_POLL_MS = 30000;   // 30s when cleaning or returning to dock

// ============================================================
// Plugin entry point — modern API export format.
// Required for child bridge support in Homebridge UI.
// ============================================================
module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, Roomba692Platform);
};

// ============================================================
// withRobot — wraps a single Roomba operation with:
//   • a fresh connect-on-demand connection
//   • a hard timeout so we always resolve or reject
//   • automatic disconnect after the operation
// ============================================================
function withRobot(cfg, log, timeoutMs, operation) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let robot   = null;
    let timer   = null;

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    }

    function safeEnd() {
      if (robot) {
        try { robot.end(); } catch (_) {}
        robot = null;
      }
    }

    timer = setTimeout(() => {
      log.warn('[Roomba692] Connection timed out after %dms — is the Roomba on WiFi and reachable at %s?', timeoutMs, cfg.ipaddress);
      safeEnd();
      settle(reject, new Error('Roomba connection timed out'));
    }, timeoutMs);

    try {
      // firmwareVersion 2 is required for the 600-series.
      // Using 3 (the dorita980 default) causes getBasicMission() to wait
      // for pose data the 692 never sends, hanging indefinitely.
      robot = new dorita980.Local(cfg.blid, cfg.robotpwd, cfg.ipaddress, 2);
    } catch (e) {
      clearTimeout(timer);
      return reject(e);
    }

    robot.on('error', (err) => {
      log.error('[Roomba692] MQTT error: %s', err.message || err);
      safeEnd();
      settle(reject, err);
    });

    robot.on('connect', () => {
      log.info('[Roomba692] Connected to %s', cfg.ipaddress);
      operation(robot)
        .then(result => { safeEnd(); settle(resolve, result); })
        .catch(err   => { safeEnd(); settle(reject, err);    });
    });
  });
}

// ============================================================
// State helpers
// ============================================================
function isCleaning(state) {
  try   { return state.cleanMissionStatus.phase === 'run'; }
  catch { return false; }
}

function isCharging(state) {
  try   { return state.cleanMissionStatus.phase === 'charge'; }
  catch { return false; }
}

function getBattery(state) {
  return (state && typeof state.batPct === 'number') ? state.batPct : 50;
}

// Returns true when the robot is actively doing something —
// cleaning, returning to dock, or stuck. Used to decide poll speed.
function isActivePhase(state) {
  try {
    const p = state.cleanMissionStatus.phase;
    return p === 'run' || p === 'hmUsrDock' || p === 'hmPostMsn' || p === 'stuck';
  } catch { return false; }
}

// ============================================================
// Platform
// ============================================================
class Roomba692Platform {
  constructor(log, config, api) {
    this.log    = log;
    this.config = config;
    this.api    = api;

    this.cachedAccessories = new Map();

    // State cache — onGet handlers read from here instantly, never
    // blocking on a live robot connection. The background poller
    // keeps this fresh every POLL_INTERVAL_MS.
    this._cache = {
      state:     null,   // last successful robot state object
      updatedAt: 0,      // Date.now() timestamp of last successful poll
    };

    this._pollTimer = null;

    if (!config || !config.blid) {
      log.warn('[Roomba692] Plugin not configured — skipping');
      return;
    }

    api.on('didFinishLaunching', () => this._sync());
  }

  configureAccessory(accessory) {
    this.log.debug('[Roomba692] Restoring cached accessory: %s', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // ----------------------------------------------------------
  // Background state polling
  // ----------------------------------------------------------
  async _poll() {
    const { config, log } = this;
    const cfg = { blid: config.blid, robotpwd: config.robotpwd, ipaddress: config.ipaddress };

    try {
      const state = await withRobot(cfg, log, CONNECT_TIMEOUT_MS, r => r.getBasicMission());
      this._cache.state     = state;
      this._cache.updatedAt = Date.now();
      log.info('[Roomba692] State cache updated — phase: %s  battery: %s%%',
        state.cleanMissionStatus && state.cleanMissionStatus.phase,
        state.batPct);
    } catch (err) {
      // Keep stale cache — a failed poll doesn't wipe the last known state.
      log.error('[Roomba692] State poll failed: %s', err.message);
    }
    // Schedule next poll at a rate appropriate for the current state
    this._scheduleNextPoll();
  }

  _scheduleNextPoll() {
    clearTimeout(this._pollTimer);
    const active   = isActivePhase(this._cache.state);
    const interval = active ? this._activePollMs : this._idlePollMs;
    this._pollTimer = setTimeout(() => this._poll(), interval);
    this.log.info('[Roomba692] Next poll in %ds (%s)',
      Math.round(interval / 1000), active ? 'active' : 'idle');
  }

  _startPolling() {
    // Immediate first poll so cache is warm by the time HomeKit asks.
    // _poll() will self-schedule subsequent polls via _scheduleNextPoll().
    this._poll();
  }

  // ----------------------------------------------------------
  // Register or restore the accessory and wire up its services
  // ----------------------------------------------------------
  _sync() {
    const { log, config, api } = this;
    const { Service, Characteristic } = api.hap;

    if (!config.blid || !config.robotpwd || !config.ipaddress) {
      log.error('[Roomba692] Missing required config: blid, robotpwd, ipaddress');
      return;
    }

    const cfg = { blid: config.blid, robotpwd: config.robotpwd, ipaddress: config.ipaddress };

    // Configurable poll intervals (seconds in config, ms internally)
    this._idlePollMs   = (config.pollInterval       || 300) * 1000;
    this._activePollMs = (config.activePollInterval  || 30)  * 1000;

    const uuid = api.hap.uuid.generate(config.blid);
    let accessory = this.cachedAccessories.get(uuid);

    if (accessory) {
      log.info('[Roomba692] Restoring: %s', accessory.displayName);
    } else {
      const name = config.name || 'Roomba';
      log.info('[Roomba692] Registering new accessory: %s', name);
      accessory = new api.platformAccessory(name, uuid);
      api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    // ── Accessory Information ───────────────────────────────
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'iRobot')
      .setCharacteristic(Characteristic.Model,        config.model || 'Roomba 692')
      .setCharacteristic(Characteristic.SerialNumber, config.blid);

    // ── Switch ──────────────────────────────────────────────
    // onGet reads from cache — responds instantly, no robot connection.
    // onSet connects to the robot to send the command, then reschedules
    // a poll so the cache reflects the new state quickly.
    const switchService =
      accessory.getService(Service.Switch) ||
      accessory.addService(Service.Switch, config.name || 'Roomba');

    switchService.getCharacteristic(Characteristic.On)
      .onGet(() => {
        const cleaning = isCleaning(this._cache.state);
        log.debug('[Roomba692] getOn (cached) → %s', cleaning);
        return cleaning;
      })
      .onSet(async (value) => {
        log.info('[Roomba692] setOn → %s', value ? 'CLEAN' : 'DOCK');

        if (value) {
          try {
            await withRobot(cfg, log, CONNECT_TIMEOUT_MS, async (r) => {
              await r.clean();
            });
          } catch (err) {
            log.warn('[Roomba692] clean error: %s', err.message);
          }
        } else {
          try {
            await withRobot(cfg, log, CONNECT_TIMEOUT_MS + PAUSE_BEFORE_DOCK_MS, async (r) => {
              await r.pause();
              await new Promise(res => setTimeout(res, PAUSE_BEFORE_DOCK_MS));
              await r.dock();
            });
          } catch (err) {
            // Don't rethrow — robot is likely already heading to dock.
            // Rethrowing flips the switch back to ON in the Home app.
            log.warn('[Roomba692] pause/dock error (robot may already be docking): %s', err.message);
          }
        }

        // Reschedule a fresh poll so cache reflects the new state soon.
        // Delay slightly to give the robot time to update its status.
        setTimeout(() => this._poll(), 3000);
      });

    // ── Battery Service ─────────────────────────────────────
    const batteryService =
      accessory.getService(Service.BatteryService) ||
      accessory.addService(Service.BatteryService, (config.name || 'Roomba') + ' Battery');

    batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .onGet(() => getBattery(this._cache.state));

    batteryService.getCharacteristic(Characteristic.ChargingState)
      .onGet(() => {
        return isCharging(this._cache.state)
          ? Characteristic.ChargingState.CHARGING
          : Characteristic.ChargingState.NOT_CHARGING;
      });

    batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(() => {
        return getBattery(this._cache.state) < 20
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });

    log.info('[Roomba692] Ready — "%s" at %s. Starting background polling.', config.name || 'Roomba', cfg.ipaddress);
    this._startPolling();
  }
}
