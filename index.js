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
// fails silently → HomeKit callback never fires → "No Response".
//
// FIX: Intercept every TLS context creation and drop to
// SECLEVEL=1, which permits SHA-1 signed certs. Also allow
// TLSv1 in case the robot negotiates an older protocol version.
// ============================================================
const tls = require('tls');
const _origCreateSecureContext = tls.createSecureContext.bind(tls);
tls.createSecureContext = function patchedCreateSecureContext(options) {
  const opts = Object.assign({}, options);
  opts.ciphers = ((opts.ciphers || 'DEFAULT').replace(/@SECLEVEL=\d/g, '')) + '@SECLEVEL=1';
  if (!opts.minVersion) opts.minVersion = 'TLSv1';
  opts.rejectUnauthorized = false;
  return _origCreateSecureContext(opts);
};

// ============================================================
// Now safe to load dorita980 (pulls in mqtt → tls internally)
// ============================================================
const dorita980 = require('dorita980');

const PLUGIN_NAME   = 'homebridge-roomba692';
const ACCESSORY_NAME = 'Roomba692';

// How long to wait for a Roomba operation before giving up.
// HomeKit's own timeout is ~25s, so 12s gives us a comfortable margin.
const DEFAULT_TIMEOUT_MS = 12000;

// After pause(), how long to wait before sending dock().
// The robot needs to enter 'stop' phase before it will accept dock().
const PAUSE_BEFORE_DOCK_MS = 1500;

// ============================================================
// withRobot — wraps every Roomba operation with:
//   • a fresh connect-on-demand connection
//   • a hard timeout so HomeKit callbacks always fire
//   • proper error forwarding
//
// Usage:
//   withRobot(cfg, log, timeoutMs, async (robot) => {
//     return await robot.someMethod();
//   })
//   .then(result => callback(null, result))
//   .catch(err  => callback(null, fallbackValue));
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

    // Hard deadline — guarantees the callback fires even if the
    // MQTT connection hangs silently (common on Node 18 + OpenSSL 3).
    timer = setTimeout(() => {
      log.warn('[Roomba692] Operation timed out after %dms', timeoutMs);
      safeEnd();
      settle(reject, new Error('Roomba connection timed out'));
    }, timeoutMs);

    try {
      // firmwareVersion 2 is correct for the 600-series (including 692).
      // Passing 3 (the dorita980 default) causes getRobotState to wait
      // for 'pose' data that the 692 never sends, hanging indefinitely.
      robot = new dorita980.Local(
        cfg.blid,
        cfg.robotpwd,
        cfg.ipaddress,
        2
      );
    } catch (e) {
      clearTimeout(timer);
      return reject(e);
    }

    robot.on('error', (err) => {
      log.error('[Roomba692] Connection error: %s', err.message || err);
      safeEnd();
      settle(reject, err);
    });

    robot.on('connect', () => {
      log.debug('[Roomba692] Connected to %s', cfg.ipaddress);
      operation(robot)
        .then(result => { safeEnd(); settle(resolve, result); })
        .catch(err   => { safeEnd(); settle(reject, err);    });
    });
  });
}

// ============================================================
// Helpers for interpreting cleanMissionStatus
// ============================================================
function isCleaning(state) {
  try   { return state.cleanMissionStatus.phase === 'run'; }
  catch { return false; }
}

function isCharging(state) {
  try   { return state.cleanMissionStatus.phase === 'charge'; }
  catch { return false; }
}

function batteryLevel(state) {
  return (state && typeof state.batPct === 'number') ? state.batPct : 50;
}

// ============================================================
// Homebridge plugin registration
// ============================================================
module.exports = function(homebridge) {
  const { Service, Characteristic } = homebridge.hap;

  homebridge.registerAccessory(PLUGIN_NAME, ACCESSORY_NAME, RoombaAccessory);

  // ----------------------------------------------------------
  // Accessory constructor
  // ----------------------------------------------------------
  function RoombaAccessory(log, config) {
    this.log  = log;
    this.name = config.name || 'Roomba';

    this.cfg = {
      blid:      config.blid,
      robotpwd:  config.robotpwd,
      ipaddress: config.ipaddress,
    };

    this.timeoutMs = (config.timeout || DEFAULT_TIMEOUT_MS / 1000) * 1000;

    if (!this.cfg.blid || !this.cfg.robotpwd || !this.cfg.ipaddress) {
      throw new Error('[Roomba692] Config must include blid, robotpwd, and ipaddress');
    }

    // Switch service: On = cleaning, Off = docked
    this.switchService = new Service.Switch(this.name);
    this.switchService.getCharacteristic(Characteristic.On)
      .on('get', this.getOn.bind(this))
      .on('set', this.setOn.bind(this));

    // Battery service
    this.batteryService = new Service.BatteryService(this.name + ' Battery');
    this.batteryService.getCharacteristic(Characteristic.BatteryLevel)
      .on('get', this.getBatteryLevel.bind(this));
    this.batteryService.getCharacteristic(Characteristic.ChargingState)
      .on('get', this.getChargingState.bind(this));
    this.batteryService.getCharacteristic(Characteristic.StatusLowBattery)
      .on('get', this.getLowBattery.bind(this));

    // Accessory information
    this.infoService = new Service.AccessoryInformation();
    this.infoService
      .setCharacteristic(Characteristic.Manufacturer, 'iRobot')
      .setCharacteristic(Characteristic.Model, config.model || 'Roomba 692')
      .setCharacteristic(Characteristic.SerialNumber, 'See iRobot App');

    log.info('[Roomba692] Initialised "%s" at %s', this.name, this.cfg.ipaddress);
  }

  // ----------------------------------------------------------
  // Switch: get (is the Roomba currently cleaning?)
  // ----------------------------------------------------------
  RoombaAccessory.prototype.getOn = function(callback) {
    const { log, cfg, timeoutMs } = this;
    log.debug('[Roomba692] getOn');

    withRobot(cfg, log, timeoutMs, async (robot) => {
      const state = await robot.getBasicMission();
      return isCleaning(state);
    })
    .then(isOn => callback(null, isOn))
    .catch(err  => {
      // Return false (not cleaning) rather than an error.
      // An error here causes HomeKit to display "No Response".
      log.warn('[Roomba692] getOn failed, defaulting to false: %s', err.message);
      callback(null, false);
    });
  };

  // ----------------------------------------------------------
  // Switch: set (start cleaning, or pause then dock)
  // ----------------------------------------------------------
  RoombaAccessory.prototype.setOn = function(value, callback) {
    const { log, cfg, timeoutMs } = this;
    log.info('[Roomba692] setOn → %s', value ? 'CLEAN' : 'DOCK');

    if (value) {
      withRobot(cfg, log, timeoutMs, async (robot) => {
        await robot.clean();
      })
      .then(()  => callback(null))
      .catch(err => {
        log.error('[Roomba692] clean() failed: %s', err.message);
        callback(err);
      });

    } else {
      // pause() then dock() — the 692 ignores dock() during 'run' phase,
      // so we must pause first and wait for the robot to settle.
      withRobot(cfg, log, timeoutMs + PAUSE_BEFORE_DOCK_MS, async (robot) => {
        await robot.pause();
        // Correct async delay — await setTimeout() is a common broken pattern
        // (setTimeout returns void, not a Promise). Use this form instead:
        await new Promise(resolve => setTimeout(resolve, PAUSE_BEFORE_DOCK_MS));
        await robot.dock();
      })
      .then(()  => callback(null))
      .catch(err => {
        // Still call callback(null) — the robot may have already started
        // returning to the dock, so this isn't a user-visible failure.
        log.warn('[Roomba692] pause/dock error (robot may already be docking): %s', err.message);
        callback(null);
      });
    }
  };

  // ----------------------------------------------------------
  // Battery: level (%)
  // ----------------------------------------------------------
  RoombaAccessory.prototype.getBatteryLevel = function(callback) {
    const { log, cfg, timeoutMs } = this;
    log.debug('[Roomba692] getBatteryLevel');

    withRobot(cfg, log, timeoutMs, async (robot) => {
      return robot.getBasicMission();
    })
    .then(state => callback(null, batteryLevel(state)))
    .catch(err  => {
      log.warn('[Roomba692] getBatteryLevel failed, defaulting to 50: %s', err.message);
      callback(null, 50);
    });
  };

  // ----------------------------------------------------------
  // Battery: charging state
  // ----------------------------------------------------------
  RoombaAccessory.prototype.getChargingState = function(callback) {
    const { log, cfg, timeoutMs } = this;
    log.debug('[Roomba692] getChargingState');

    withRobot(cfg, log, timeoutMs, async (robot) => {
      return robot.getBasicMission();
    })
    .then(state => {
      const cs = isCharging(state)
        ? Characteristic.ChargingState.CHARGING
        : Characteristic.ChargingState.NOT_CHARGING;
      callback(null, cs);
    })
    .catch(err => {
      log.warn('[Roomba692] getChargingState failed: %s', err.message);
      callback(null, Characteristic.ChargingState.NOT_CHARGING);
    });
  };

  // ----------------------------------------------------------
  // Battery: low battery warning (< 20%)
  // ----------------------------------------------------------
  RoombaAccessory.prototype.getLowBattery = function(callback) {
    const { log, cfg, timeoutMs } = this;

    withRobot(cfg, log, timeoutMs, async (robot) => {
      return robot.getBasicMission();
    })
    .then(state => {
      const low = batteryLevel(state) < 20
        ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      callback(null, low);
    })
    .catch(() => callback(null, Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
  };

  // ----------------------------------------------------------
  // Required: return all services to Homebridge
  // ----------------------------------------------------------
  RoombaAccessory.prototype.getServices = function() {
    return [this.infoService, this.switchService, this.batteryService];
  };
};
