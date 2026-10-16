import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    BatteryDeviceMonitor, DeviceKind, DeviceLevel, DeviceState, ResourceSampler,
} from './sources.js';

const HIGH_USAGE = 0.9;

const KIND_ICONS = {
    [DeviceKind.MOUSE]: 'input-mouse-symbolic',
    [DeviceKind.KEYBOARD]: 'input-keyboard-symbolic',
    [DeviceKind.PHONE]: 'phone-symbolic',
    [DeviceKind.MEDIA_PLAYER]: 'multimedia-player-symbolic',
    [DeviceKind.TABLET]: 'input-tablet-symbolic',
    [DeviceKind.PEN]: 'input-tablet-symbolic',
    [DeviceKind.COMPUTER]: 'computer-symbolic',
    [DeviceKind.GAMING_INPUT]: 'input-gaming-symbolic',
    [DeviceKind.TOUCHPAD]: 'input-touchpad-symbolic',
    [DeviceKind.HEADSET]: 'audio-headset-symbolic',
    [DeviceKind.HEADPHONES]: 'audio-headphones-symbolic',
    [DeviceKind.SPEAKERS]: 'audio-speakers-symbolic',
    [DeviceKind.OTHER_AUDIO]: 'audio-speakers-symbolic',
};

// Labels for devices that only report coarse levels (e.g. AA-powered mice).
// Translated at use time; gettext isn't usable while the module loads.
const LEVELS = {
    [DeviceLevel.CRITICAL]: 'Critical',
    [DeviceLevel.LOW]: 'Low',
    [DeviceLevel.NORMAL]: 'Normal',
    [DeviceLevel.HIGH]: 'High',
    [DeviceLevel.FULL]: 'Full',
};

const STATE_LABELS = {
    [DeviceState.CHARGING]: 'Charging',
    [DeviceState.FULLY_CHARGED]: 'Fully charged',
    [DeviceState.PENDING_CHARGE]: 'Not charging',
    [DeviceState.EMPTY]: 'Empty',
};

function formatPercent(fraction) {
    return fraction === null ? '…' : `${Math.round(fraction * 100)}%`;
}

function formatBytes(bytes) {
    return GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
}

function setStyleClass(actor, className, enabled) {
    if (enabled)
        actor.add_style_class_name(className);
    else
        actor.remove_style_class_name(className);
}

/**
 * Returns {text, fraction, low, charging, detail} describing a device's charge.
 * fraction is null for coarse-level devices, whose percentage is meaningless.
 * A charging device is never flagged low, since it's already being dealt with.
 */
function describeBattery(device, lowThreshold) {
    const charging = device.state === DeviceState.CHARGING;
    const label = LEVELS[device.level];
    if (label) {
        // UPower fakes a 100% percentage and a "fully charged" state from a
        // "Full" level even while the kernel reports discharging, which is
        // nonsense for a device running on AA cells. Only trust real charging.
        return {
            text: _(label),
            fraction: null,
            low: !charging &&
                (device.level === DeviceLevel.LOW || device.level === DeviceLevel.CRITICAL),
            charging,
            detail: charging ? _(STATE_LABELS[device.state]) : '',
        };
    }
    return {
        text: `${Math.round(device.percentage)}%`,
        fraction: device.percentage / 100,
        low: !charging && device.percentage <= lowThreshold,
        charging,
        detail: device.state in STATE_LABELS ? _(STATE_LABELS[device.state]) : '',
    };
}

/** A non-interactive menu row: icon, title + detail, usage bar and value. */
const StatRow = GObject.registerClass(
class StatRow extends PopupMenu.PopupBaseMenuItem {
    _init(gicon, title) {
        super._init({reactive: false, can_focus: false, style_class: 'tray-stats-row'});

        this.add_child(new St.Icon({gicon, style_class: 'popup-menu-icon'}));

        const textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({text: title, style_class: 'tray-stats-row-title'});
        this._detail = new St.Label({style_class: 'tray-stats-row-detail', opacity: 170, visible: false});
        textBox.add_child(this._title);
        textBox.add_child(this._detail);
        this.add_child(textBox);

        this._bar = new St.Widget({
            style_class: 'tray-stats-bar',
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({
            style_class: 'tray-stats-bar-fill',
            x_expand: true,
            y_expand: true,
            pivot_point: new Graphene.Point({x: 0, y: 0.5}),
            scale_x: 0,
        });
        this._bar.add_child(this._fill);
        this.add_child(this._bar);

        this._value = new St.Label({
            style_class: 'tray-stats-row-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    /** A null fraction hides the bar (nothing measurable to show). */
    update({fraction, value, detail = '', warning = false, charging = false}) {
        this._bar.visible = fraction !== null;
        this._fill.scale_x = Math.min(Math.max(fraction ?? 0, 0), 1);
        this._value.text = value;
        this._detail.text = detail;
        this._detail.visible = detail !== '';
        setStyleClass(this._fill, 'tray-stats-warning', warning);
        setStyleClass(this._value, 'tray-stats-warning', warning);
        setStyleClass(this._fill, 'tray-stats-charging', charging);
    }
});

/** Icon + label shown in the top bar, followed by a bolt while charging. */
const PanelStat = GObject.registerClass(
class PanelStat extends St.BoxLayout {
    _init(gicon, chargingGicon = null) {
        super._init({style_class: 'tray-stats-item'});
        this.add_child(new St.Icon({gicon, style_class: 'system-status-icon tray-stats-icon'}));
        this._label = new St.Label({
            style_class: 'tray-stats-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        this._chargingIcon = null;
        if (chargingGicon) {
            this._chargingIcon = new St.Icon({
                gicon: chargingGicon,
                style_class: 'system-status-icon tray-stats-icon tray-stats-charging',
                visible: false,
            });
            this.add_child(this._chargingIcon);
        }
    }

    update(text, warning = false, charging = false) {
        this._label.text = text;
        setStyleClass(this._label, 'tray-stats-warning', warning);
        if (this._chargingIcon)
            this._chargingIcon.visible = charging;
    }
});

const TrayStatsIndicator = GObject.registerClass(
class TrayStatsIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, extension.metadata.name);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._sampler = new ResourceSampler();
        this._monitor = new BatteryDeviceMonitor(() => this._queueDevicesUpdate());
        this._lastSample = null;
        this._refreshing = false;
        this._timeoutId = 0;
        this._devicesIdleId = 0;

        const cpuIcon = Gio.icon_new_for_string(`${extension.path}/icons/tray-stats-cpu-symbolic.svg`);
        const memIcon = Gio.icon_new_for_string(`${extension.path}/icons/tray-stats-memory-symbolic.svg`);
        this._chargingIcon = Gio.icon_new_for_string(`${extension.path}/icons/tray-stats-charging-symbolic.svg`);

        // Top bar
        const box = new St.BoxLayout({style_class: 'tray-stats-box'});
        this._cpuStat = new PanelStat(cpuIcon);
        this._memStat = new PanelStat(memIcon);
        this._devicesBox = new St.BoxLayout({style_class: 'tray-stats-box'});
        box.add_child(this._cpuStat);
        box.add_child(this._memStat);
        box.add_child(this._devicesBox);
        this.add_child(box);

        // Popup menu
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('System')));
        this._cpuRow = new StatRow(cpuIcon, _('CPU'));
        this._memRow = new StatRow(memIcon, _('Memory'));
        this._swapRow = new StatRow(memIcon, _('Swap'));
        this.menu.addMenuItem(this._cpuRow);
        this.menu.addMenuItem(this._memRow);
        this.menu.addMenuItem(this._swapRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Devices')));
        this._devicesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._devicesSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._addLauncher(_('System Monitor'), 'org.gnome.SystemMonitor.desktop');
        this._addLauncher(_('Bluetooth Settings'), 'gnome-bluetooth-panel.desktop');
        this.menu.addAction(_('Preferences'), () => extension.openPreferences());

        this._settings.connectObject(
            'changed::refresh-interval', () => this._restartTimer(),
            'changed::show-cpu', () => this._syncVisibility(),
            'changed::show-memory', () => this._syncVisibility(),
            'changed::show-devices', () => this._syncVisibility(),
            'changed::low-battery-threshold', () => this._updateDevices(),
            this);

        this._syncVisibility();
        this._updateDevices();
        this._refresh();
        this._restartTimer();
        this._monitor.start();
    }

    _addLauncher(label, desktopId) {
        const app = Gio.DesktopAppInfo.new(desktopId);
        if (!app)
            return;
        this.menu.addAction(label, () => {
            try {
                app.launch([], global.create_app_launch_context(0, -1));
            } catch (e) {
                console.error(`tray-stats: cannot launch ${desktopId}: ${e.message}`);
            }
        });
    }

    _syncVisibility() {
        this._cpuStat.visible = this._settings.get_boolean('show-cpu');
        this._memStat.visible = this._settings.get_boolean('show-memory');
        this._devicesBox.visible = this._settings.get_boolean('show-devices');
        // Keep the button clickable even if everything is hidden in the panel
        const anyVisible = this._cpuStat.visible || this._memStat.visible ||
            (this._devicesBox.visible && this._devicesBox.get_n_children() > 0);
        this._cpuStat.visible ||= !anyVisible;
    }

    _restartTimer() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;
        try {
            const sample = await this._sampler.sample(this._cancellable);
            if (this._cancellable.is_cancelled())
                return;
            this._lastSample = sample;
            this._updateResources();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`tray-stats: cannot read system usage: ${e.message}`);
        } finally {
            this._refreshing = false;
        }
    }

    _updateResources() {
        const {cpu, loadAvg, memUsed, memTotal, swapUsed, swapTotal} = this._lastSample;
        const memFraction = memUsed / memTotal;
        const cpuHigh = cpu !== null && cpu >= HIGH_USAGE;
        const memHigh = memFraction >= HIGH_USAGE;

        this._cpuStat.update(formatPercent(cpu), cpuHigh);
        this._memStat.update(formatPercent(memFraction), memHigh);

        this._cpuRow.update({
            fraction: cpu ?? 0,
            value: formatPercent(cpu),
            detail: `${_('Load')} ${loadAvg.map(n => n.toFixed(2)).join('  ')}`,
            warning: cpuHigh,
        });
        this._memRow.update({
            fraction: memFraction,
            value: formatPercent(memFraction),
            detail: `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`,
            warning: memHigh,
        });
        this._swapRow.visible = swapTotal > 0;
        if (swapTotal > 0) {
            this._swapRow.update({
                fraction: swapUsed / swapTotal,
                value: formatPercent(swapUsed / swapTotal),
                detail: `${formatBytes(swapUsed)} / ${formatBytes(swapTotal)}`,
            });
        }
    }

    // UPower emits bursts of property changes; coalesce them into one redraw.
    _queueDevicesUpdate() {
        if (this._devicesIdleId)
            return;
        this._devicesIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._devicesIdleId = 0;
            this._updateDevices();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateDevices() {
        const lowThreshold = this._settings.get_int('low-battery-threshold');
        const devices = this._monitor.devices;

        this._devicesBox.destroy_all_children();
        this._devicesSection.removeAll();

        for (const device of devices) {
            const battery = describeBattery(device, lowThreshold);
            const gicon = new Gio.ThemedIcon({
                name: KIND_ICONS[device.kind] ?? 'bluetooth-active-symbolic',
            });

            const stat = new PanelStat(gicon, this._chargingIcon);
            stat.update(battery.text, battery.low, battery.charging);
            this._devicesBox.add_child(stat);

            const row = new StatRow(gicon, device.name || _('Unknown device'));
            row.update({
                fraction: battery.fraction,
                value: battery.text,
                detail: battery.detail,
                warning: battery.low,
                charging: battery.charging,
            });
            this._devicesSection.addMenuItem(row);
        }

        if (devices.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(_('No devices reporting battery'), {reactive: false});
            this._devicesSection.addMenuItem(empty);
        }
        this._syncVisibility();
    }

    _onDestroy() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._devicesIdleId)
            GLib.source_remove(this._devicesIdleId);
        this._devicesIdleId = 0;
        this._cancellable.cancel();
        this._monitor.stop();
        this._settings.disconnectObject(this);
        this._settings = null;
        super._onDestroy();
    }
});

export default class TrayStatsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settings.connectObject(
            'changed::panel-box', () => this._recreateIndicator(),
            'changed::panel-index', () => this._recreateIndicator(),
            this);
        this._recreateIndicator();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    _recreateIndicator() {
        this._indicator?.destroy();
        this._indicator = new TrayStatsIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-box'));
    }
}
