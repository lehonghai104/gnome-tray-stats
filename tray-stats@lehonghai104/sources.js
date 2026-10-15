// Data sources for the indicator. Only depends on GLib/Gio so it can be
// exercised from plain `gjs` outside of GNOME Shell.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

// Values from UPowerGlib's UpDeviceKind / UpDeviceLevel / UpDeviceState.
export const DeviceKind = {
    LINE_POWER: 1,
    MOUSE: 5,
    KEYBOARD: 6,
    PHONE: 8,
    MEDIA_PLAYER: 9,
    TABLET: 10,
    COMPUTER: 11,
    GAMING_INPUT: 12,
    PEN: 13,
    TOUCHPAD: 14,
    HEADSET: 17,
    SPEAKERS: 18,
    HEADPHONES: 19,
    OTHER_AUDIO: 21,
};

export const DeviceLevel = {
    UNKNOWN: 0,
    NONE: 1,
    LOW: 3,
    CRITICAL: 4,
    NORMAL: 6,
    HIGH: 7,
    FULL: 8,
};

export const DeviceState = {
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
};

const decoder = new TextDecoder();

async function readTextFile(path, cancellable) {
    const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(contents);
}

function parseMemInfo(text) {
    const kb = {};
    for (const line of text.split('\n')) {
        const match = /^(\w+):\s+(\d+)/.exec(line);
        if (match)
            kb[match[1]] = Number(match[2]);
    }
    const available = kb.MemAvailable ?? kb.MemFree;
    const swapTotal = kb.SwapTotal ?? 0;
    return {
        memTotal: kb.MemTotal * 1024,
        memUsed: (kb.MemTotal - available) * 1024,
        swapTotal: swapTotal * 1024,
        swapUsed: (swapTotal - (kb.SwapFree ?? 0)) * 1024,
    };
}

export class ResourceSampler {
    constructor() {
        this._prevTotal = 0;
        this._prevIdle = 0;
    }

    /**
     * @param {Gio.Cancellable} [cancellable]
     * @returns {Promise<object>} cpu is a 0–1 fraction (null on the very first
     *   sample, since usage needs two readings), memory/swap are in bytes.
     */
    async sample(cancellable = null) {
        const [stat, meminfo, loadavg] = await Promise.all([
            readTextFile('/proc/stat', cancellable),
            readTextFile('/proc/meminfo', cancellable),
            readTextFile('/proc/loadavg', cancellable),
        ]);
        return {
            cpu: this._cpuFraction(stat),
            loadAvg: loadavg.split(' ', 3).map(Number),
            ...parseMemInfo(meminfo),
        };
    }

    _cpuFraction(stat) {
        // cpu  user nice system idle iowait irq softirq steal [guest guest_nice]
        // guest time is already counted in user/nice, so only sum the first 8.
        const fields = stat.slice(0, stat.indexOf('\n')).trim().split(/\s+/)
            .slice(1, 9).map(Number);
        const idle = fields[3] + fields[4];
        const total = fields.reduce((a, b) => a + b, 0);

        const isFirst = this._prevTotal === 0;
        const dTotal = total - this._prevTotal;
        const dIdle = idle - this._prevIdle;
        this._prevTotal = total;
        this._prevIdle = idle;

        if (isFirst || dTotal <= 0)
            return null;
        return Math.min(Math.max(1 - dIdle / dTotal, 0), 1);
    }
}

const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = `${UPOWER_PATH}/devices/DisplayDevice`;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg name="devices" direction="out" type="ao"/>
    </method>
    <signal name="DeviceAdded">
      <arg name="device" type="o"/>
    </signal>
    <signal name="DeviceRemoved">
      <arg name="device" type="o"/>
    </signal>
  </interface>
</node>`);

const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Vendor" type="s" access="read"/>
    <property name="Model" type="s" access="read"/>
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="BatteryLevel" type="u" access="read"/>
    <property name="IconName" type="s" access="read"/>
  </interface>
</node>`);

function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Tracks peripheral batteries through UPower. UPower already aggregates
 * BlueZ (org.bluez.Battery1) devices and vendor receivers such as Logitech
 * HID++, so this covers Bluetooth headsets, mice, keyboards, etc.
 */
export class BatteryDeviceMonitor {
    /** @param {() => void} onChanged called whenever the device list or any value changes */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._cancellable = new Gio.Cancellable();
        this._manager = null;
        this._managerSignalIds = [];
        // object path -> {proxy, changedId}, or null while the proxy is loading
        this._devices = new Map();
    }

    async start() {
        try {
            this._manager = await UPowerProxy.newAsync(
                Gio.DBus.system, UPOWER_BUS_NAME, UPOWER_PATH, this._cancellable);
            if (this._cancellable.is_cancelled())
                return;

            this._managerSignalIds.push(
                this._manager.connectSignal('DeviceAdded',
                    (_proxy, _sender, [path]) => this._addDevice(path)),
                this._manager.connectSignal('DeviceRemoved',
                    (_proxy, _sender, [path]) => this._removeDevice(path)));

            const [paths] = await this._manager.EnumerateDevicesAsync();
            if (this._cancellable.is_cancelled())
                return;
            await Promise.all(paths.map(path => this._addDevice(path)));
        } catch (e) {
            if (!isCancelled(e))
                console.error(`tray-stats: cannot read UPower devices: ${e.message}`);
        }
    }

    stop() {
        this._cancellable.cancel();
        for (const id of this._managerSignalIds)
            this._manager.disconnectSignal(id);
        this._managerSignalIds = [];
        this._manager = null;
        for (const entry of this._devices.values())
            entry?.proxy.disconnect(entry.changedId);
        this._devices.clear();
    }

    async _addDevice(path) {
        if (path === DISPLAY_DEVICE_PATH || this._devices.has(path))
            return;
        this._devices.set(path, null);

        try {
            const proxy = await UPowerDeviceProxy.newAsync(
                Gio.DBus.system, UPOWER_BUS_NAME, path, this._cancellable);
            // Removed (or monitor stopped) while the proxy was loading
            if (this._devices.get(path) !== null)
                return;
            const changedId = proxy.connect('g-properties-changed', () => this._onChanged());
            this._devices.set(path, {proxy, changedId});
            this._onChanged();
        } catch (e) {
            this._devices.delete(path);
            if (!isCancelled(e))
                console.error(`tray-stats: cannot read UPower device ${path}: ${e.message}`);
        }
    }

    _removeDevice(path) {
        const entry = this._devices.get(path);
        this._devices.delete(path);
        if (entry) {
            entry.proxy.disconnect(entry.changedId);
            this._onChanged();
        }
    }

    /**
     * Peripheral devices that currently report a battery, sorted by name.
     * The machine's own battery and AC adapter (PowerSupply=true) are skipped
     * since GNOME already shows those.
     */
    get devices() {
        const devices = [];
        for (const [path, entry] of this._devices) {
            if (!entry)
                continue;
            const {proxy} = entry;
            if (proxy.PowerSupply || !proxy.IsPresent || proxy.Type === DeviceKind.LINE_POWER)
                continue;
            devices.push({
                path,
                kind: proxy.Type,
                name: proxy.Model || proxy.Vendor || '',
                percentage: proxy.Percentage,
                // When set to something other than NONE/UNKNOWN the device only
                // reports coarse levels and `percentage` should be ignored.
                level: proxy.BatteryLevel,
                state: proxy.State,
                iconName: proxy.IconName,
            });
        }
        return devices.sort((a, b) => a.name.localeCompare(b.name));
    }
}
