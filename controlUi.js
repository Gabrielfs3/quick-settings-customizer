import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickSlider} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {LatestValueWriter} from './bounded.js';
import {KeyboardBacklight} from './keyboardBacklight.js';

function callProperties(proxy, method, parameters, cancellable) {
    return new Promise((resolve, reject) => {
        proxy.g_connection.call(
            proxy.g_name,
            proxy.g_object_path,
            'org.freedesktop.DBus.Properties',
            method,
            parameters,
            null,
            Gio.DBusCallFlags.NONE,
            5000,
            cancellable,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

function idleScheduler(callback) {
    return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

function makePopupRow(label, icon = null) {
    return icon
        ? new PopupMenu.PopupImageMenuItem(label, icon)
        : new PopupMenu.PopupMenuItem(label);
}

function setRowIcon(row, icon) {
    const unchanged = row._qscIcon === icon ||
        (row._qscIcon instanceof Gio.Icon && icon instanceof Gio.Icon &&
            row._qscIcon.equal(icon));
    if (!icon || unchanged)
        return;
    row._qscIcon = icon;
    row.setIcon(icon);
}

export const ControlButton = GObject.registerClass(
class ControlButton extends PanelMenu.Button {
    _init(spec, originals, reportError) {
        super._init(0.0, spec.label, false);
        this._spec = spec;
        this._originals = originals;
        this._reportError = reportError;
        this._signals = [];
        this._popupSignals = new Map();
        this._queued = new Map();
        this._disposed = false;
        this._generation = 1;
        this._scanTimeout = 0;
        this._scanCancellable = null;
        this._commandCancellable = new Gio.Cancellable();
        this._wifiRows = new Map();
        this._bluetoothRows = new Map();
        this._audioEntries = [];

        this._icon = new St.Icon({
            icon_name: spec.icon || 'applications-system-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
        this.menu.box.add_style_class_name('qsc-popup');

        try {
            if (spec.argv) {
                this.menu.addAction(spec.label, () => this._runCommand());
            } else if (spec.id === 'wifi') {
                this._buildWifi(originals[0]);
            } else if (spec.id === 'bluetooth') {
                this._buildBluetooth(originals[0]);
            } else if (spec.id === 'sound') {
                this._buildSound(originals);
            } else if (spec.id === 'brightness') {
                this._buildBrightness(originals);
            } else {
                this._buildSimpleToggle(originals[0]);
            }

            this._watch(this.menu, 'open-state-changed', (_menu, open) => {
                if (open)
                    this._onPopupOpened();
                else
                    this._onPopupClosed();
            });
        } catch (error) {
            this._cleanup();
            this.destroy();
            throw error;
        }
    }

    get resourceCounts() {
        return {
            signals: this._signals.length,
            popupSignals: [...this._popupSignals.values()]
                .reduce((count, signals) => count + signals.size, 0),
            queued: this._queued.size,
            wifiRows: this._wifiRows.size,
            bluetoothRows: this._bluetoothRows.size,
            audioRows: this._audioEntries.reduce(
                (count, entry) => count + entry.deviceRows.size, 0),
            scanTimer: Number(Boolean(this._scanTimeout)),
            scanInFlight: Number(Boolean(this._scanCancellable)),
        };
    }

    _watch(object, signal, callback) {
        if (!object?.connect)
            return 0;
        const id = object.connect(signal, callback);
        this._signals.push([object, id]);
        return id;
    }

    _watchPopup(object, signal, callback) {
        if (!object?.connect)
            return;
        let signals = this._popupSignals.get(object);
        if (!signals) {
            signals = new Map();
            this._popupSignals.set(object, signals);
        }
        if (!signals.has(signal))
            signals.set(signal, object.connect(signal, callback));
    }

    _disconnectPopupSignals() {
        for (const [object, signals] of this._popupSignals) {
            for (const id of signals.values())
                object.disconnect(id);
        }
        this._popupSignals.clear();
    }

    _queue(category, callback) {
        if (this._disposed || this._queued.has(category))
            return;
        const id = idleScheduler(() => {
            this._queued.delete(category);
            if (!this._disposed)
                callback();
        });
        this._queued.set(category, id);
    }

    _setIcon(iconName) {
        const name = iconName || this._spec.icon || 'applications-system-symbolic';
        if (this._icon.icon_name !== name)
            this._icon.icon_name = name;
    }

    _buildSimpleToggle(source) {
        if (!source || typeof source.checked !== 'boolean')
            throw new Error(`GNOME does not expose a toggle for ${this._spec.label}.`);
        this._toggleSource = source;
        this._toggleRow = new PopupMenu.PopupSwitchMenuItem(this._spec.label, source.checked);
        this.menu.addMenuItem(this._toggleRow);
        const sync = () => {
            if (this._toggleRow.state !== source.checked)
                this._toggleRow.setToggleState(source.checked);
            if (this._toggleRow.sensitive !== source.reactive)
                this._toggleRow.setSensitive(source.reactive);
            this._setIcon(source.iconName);
        };
        this._watch(source, 'notify::checked', sync);
        this._watch(source, 'notify::reactive', sync);
        this._watch(source, 'notify::icon-name', sync);
        this._watch(this._toggleRow, 'toggled', (_row, enabled) => {
            if (enabled === source.checked)
                return;
            if (source.toggle_mode)
                source.checked = enabled;
            source.emit('clicked', Clutter.BUTTON_PRIMARY);
        });
        sync();
    }

    _buildWifi(source) {
        this._wifiControl = source;
        this._wifiClient = source._client;
        this._wifiRow = new PopupMenu.PopupSwitchMenuItem(
            this._spec.label, Boolean(this._wifiClient.wireless_enabled),
        );
        this._wifiPlaceholder = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._wifiSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._wifiRow);
        this.menu.addMenuItem(this._wifiPlaceholder);
        this.menu.addMenuItem(this._wifiSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction('Wi-Fi Settings', 'gnome-wifi-panel.desktop');

        const sync = () => {
            const enabled = Boolean(this._wifiClient.wireless_enabled);
            if (this._wifiRow.state !== enabled)
                this._wifiRow.setToggleState(enabled);
            this._wifiRow.setSensitive(Boolean(this._wifiClient.networking_enabled));
            const placeholder = !enabled
                ? 'Turn on Wi-Fi to see available networks'
                : this._wifiDevices().length === 0
                    ? 'No Wi-Fi adapter available'
                    : this._wifiRows.size === 0
                        ? 'No networks found yet'
                        : '';
            if (this._wifiPlaceholder.label.text !== placeholder)
                this._wifiPlaceholder.label.text = placeholder;
            this._wifiPlaceholder.visible = !enabled || this._wifiRows.size === 0;
            this._setIcon(source.iconName);
        };
        this._watch(source, 'notify::icon-name', sync);
        this._watch(source, 'notify::checked', () => {
            sync();
            if (this.menu.isOpen)
                this._queue('wifi-rows', () => this._refreshWifiRows());
        });
        this._watch(this._wifiClient, 'notify::wireless-enabled', sync);
        this._watch(this._wifiClient, 'notify::networking-enabled', sync);
        this._watch(this._wifiRow, 'toggled', (_row, enabled) => {
            if (enabled !== Boolean(this._wifiClient.wireless_enabled))
                this._wifiClient.wireless_enabled = enabled;
        });
        this._wifiSync = sync;
        sync();
    }

    _wifiDevices() {
        return [...(this._wifiControl?._nmDevices ?? [])];
    }

    _wifiNetworks() {
        const result = new Set();
        for (const item of this._wifiControl?._items?.values?.() ?? []) {
            for (const network of item._networkItems?.keys?.() ?? [])
                result.add(network);
        }
        return [...result];
    }

    _refreshWifiRows() {
        if (!this.menu.isOpen || this._disposed)
            return;
        const networks = this._wifiNetworks();
        for (const network of networks) {
            let row = this._wifiRows.get(network);
            if (!row) {
                row = makePopupRow(
                    network.name,
                    network.icon_name || 'network-wireless-signal-none-symbolic',
                );
                row.connect('activate', () => {
                    if (!this._disposed)
                        network.activate();
                });
                this._wifiSection.addMenuItem(row);
                this._wifiRows.set(network, row);
            }
            if (row.label.text !== network.name)
                row.label.text = network.name;
            row.setOrnament(network.is_active ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            setRowIcon(row, network.icon_name || 'network-wireless-signal-none-symbolic');
        }

        const current = new Set(networks);
        for (const [network, row] of this._wifiRows) {
            if (!current.has(network)) {
                row.destroy();
                this._wifiRows.delete(network);
            }
        }
        this._wifiSync();
    }

    _buildBluetooth(source) {
        this._bluetoothControl = source;
        this._bluetoothClient = source._client;
        this._bluetoothRow = new PopupMenu.PopupSwitchMenuItem(
            this._spec.label, Boolean(this._bluetoothClient.active),
        );
        this._bluetoothSection = new PopupMenu.PopupMenuSection();
        this._bluetoothPlaceholder = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this.menu.addMenuItem(this._bluetoothRow);
        this.menu.addMenuItem(this._bluetoothSection);
        this.menu.addMenuItem(this._bluetoothPlaceholder);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction('Bluetooth Settings', 'gnome-bluetooth-panel.desktop');

        const sync = () => {
            const active = Boolean(this._bluetoothClient.active);
            if (this._bluetoothRow.state !== active)
                this._bluetoothRow.setToggleState(active);
            this._bluetoothRow.setSensitive(Boolean(this._bluetoothClient.available));
            const placeholder = active
                ? 'No paired devices available'
                : 'Turn on Bluetooth to connect to paired devices';
            if (this._bluetoothPlaceholder.label.text !== placeholder)
                this._bluetoothPlaceholder.label.text = placeholder;
            this._bluetoothPlaceholder.visible = !active || this._bluetoothRows.size === 0;
            this._setIcon(source.iconName);
        };
        this._watch(this._bluetoothClient, 'notify::active', sync);
        this._watch(this._bluetoothClient, 'notify::available', sync);
        this._watch(this._bluetoothClient, 'notify::adapter-state', sync);
        this._watch(source, 'notify::icon-name', sync);
        this._watch(this._bluetoothRow, 'toggled', (_row, enabled) => {
            if (enabled !== Boolean(this._bluetoothClient.active) &&
                this._bluetoothClient.available)
                this._bluetoothClient.toggleActive();
        });
        this._bluetoothSync = sync;
        sync();
    }

    _bluetoothDevices() {
        return [...this._bluetoothClient.getDevices()]
            .filter(device => device.paired)
            .sort((a, b) => Number(b.connected) - Number(a.connected) ||
                a.alias.localeCompare(b.alias));
    }

    _refreshBluetoothRows() {
        if (!this.menu.isOpen || this._disposed)
            return;
        const devices = this._bluetoothDevices();
        for (const device of devices) {
            const path = device.get_object_path();
            let entry = this._bluetoothRows.get(path);
            if (!entry) {
                const row = makePopupRow('', device.icon || 'bluetooth-active-symbolic');
                entry = {device, row};
                row.connect('activate', () => this._toggleBluetoothDevice(path));
                this._bluetoothSection.addMenuItem(row);
                this._bluetoothRows.set(path, entry);
            }
            entry.device = device;
            const label = `${device.alias} — ${device.connected ? 'Disconnect' : 'Connect'}`;
            if (entry.row.label.text !== label)
                entry.row.label.text = label;
            entry.row.setSensitive(Boolean(device.connectable));
            setRowIcon(entry.row, device.icon || 'bluetooth-active-symbolic');
        }

        const current = new Set(devices.map(device => device.get_object_path()));
        for (const [path, entry] of this._bluetoothRows) {
            if (!current.has(path)) {
                entry.row.destroy();
                this._bluetoothRows.delete(path);
            }
        }
        this._bluetoothSync();
    }

    async _toggleBluetoothDevice(path) {
        const entry = this._bluetoothRows.get(path);
        if (!entry || this._disposed)
            return;
        const generation = this._generation;
        try {
            await this._bluetoothClient.toggleDevice(entry.device);
            if (this._disposed || generation !== this._generation)
                return;
            this._queue('bluetooth-rows', () => this._refreshBluetoothRows());
        } catch (error) {
            if (!this._disposed && generation === this._generation)
                this._reportError(error, `Could not toggle ${entry.device.alias}`);
        }
    }

    _buildSound(originals) {
        this._outputAudio = this._addAudioSlider(originals[0], 'Output volume', false);
        this._inputAudio = this._addAudioSlider(originals[1], 'Microphone', true);
        this.menu.addSettingsAction('Sound Settings', 'gnome-sound-panel.desktop');
        this._watch(this, 'scroll-event', (_actor, event) => this._scrollOutput(event));
        this._syncAudioIcon();
    }

    _addAudioSlider(original, title, microphone) {
        const control = new QuickSlider({
            iconName: microphone ? 'audio-input-microphone-symbolic' : 'audio-volume-high-symbolic',
            x_expand: true,
        });
        control.menuEnabled = false;
        control.slider.accessible_name = title;
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        row.add_child(control);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
        this.menu.addMenuItem(row);
        const unavailable = new PopupMenu.PopupMenuItem(
            microphone ? 'No microphone available' : 'No output device available',
            {reactive: false, can_focus: false},
        );
        this.menu.addMenuItem(unavailable);
        const deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(deviceSection);
        const entry = {
            original,
            control,
            row,
            unavailable,
            deviceSection,
            deviceRows: new Map(),
            stream: null,
            microphone,
            valueSignal: 0,
        };
        entry.valueSignal = this._watch(control.slider, 'notify::value', () =>
            this._writeAudioLevel(entry));
        this._audioEntries.push(entry);
        this._watch(original, 'stream-updated', () => {
            this._syncAudio(entry);
            if (!microphone)
                this._syncAudioIcon();
        });
        this._watch(original, 'notify::icon-name', () => {
            if (!microphone)
                this._syncAudioIcon();
        });
        this._syncAudio(entry);
        return entry;
    }

    _syncAudioIcon() {
        const original = this._outputAudio?.original;
        this._setIcon(original?.iconName || original?._indicator?.icon_name);
    }

    _syncAudio(entry) {
        if (this._disposed)
            return;
        const stream = entry.original.stream;
        if (entry.stream !== stream) {
            entry.stream = stream;
        }
        const control = entry.original._control;
        const maximum = Math.max(1, control.get_vol_max_norm());
        const available = Boolean(stream);
        if (entry.row.visible !== available)
            entry.row.visible = available;
        if (entry.unavailable.visible === available)
            entry.unavailable.visible = !available;
        if (entry.control.slider.maximum_value !== entry.original.slider.maximum_value)
            entry.control.slider.maximum_value = entry.original.slider.maximum_value;
        if (!available)
            return;

        const value = stream.is_muted ? 0 : stream.volume / maximum;
        if (Math.abs(entry.control.slider.value - value) > 0.0001) {
            entry.control.slider.block_signal_handler(entry.valueSignal);
            entry.control.slider.value = value;
            entry.control.slider.unblock_signal_handler(entry.valueSignal);
        }
        const iconName = entry.microphone
            ? 'audio-input-microphone-symbolic'
            : entry.original.iconName || 'audio-volume-high-symbolic';
        if (entry.control.iconName !== iconName)
            entry.control.iconName = iconName;
    }

    _writeAudioLevel(entry) {
        const stream = entry.stream;
        if (!stream || this._disposed)
            return;
        const maximum = entry.original._control.get_vol_max_norm();
        const requested = Math.round(entry.control.slider.value * maximum);
        const muted = requested === 0;
        if (Math.round(stream.volume) === requested && Boolean(stream.is_muted) === muted)
            return;
        stream.volume = requested;
        if (Boolean(stream.is_muted) !== muted)
            stream.change_is_muted(muted);
        stream.push_volume();
    }

    _audioDeviceEntries(entry) {
        const ids = [...(entry.original._deviceItems?.keys?.() ?? [])];
        const lookup = entry.microphone ? 'lookup_input_id' : 'lookup_output_id';
        return ids.map(id => [id, entry.original._control[lookup](id)]).filter(([, device]) => device);
    }

    _refreshAudioDevices(entry) {
        if (!this.menu.isOpen || this._disposed)
            return;
        const devices = this._audioDeviceEntries(entry);
        const activeSignal = entry.microphone ? 'active-input-update' : 'active-output-update';
        this._watchPopup(entry.original._control, activeSignal, (_control, id) => {
            this._queue(`audio-devices-${entry.microphone}`, () =>
                this._refreshAudioDevices(entry));
            entry.activeId = id;
        });
        const addedSignal = entry.microphone ? 'input-added' : 'output-added';
        const removedSignal = entry.microphone ? 'input-removed' : 'output-removed';
        this._watchPopup(entry.original._control, addedSignal, () => this._queue(
            `audio-devices-${entry.microphone}`, () => this._refreshAudioDevices(entry)));
        this._watchPopup(entry.original._control, removedSignal, () => this._queue(
            `audio-devices-${entry.microphone}`, () => this._refreshAudioDevices(entry)));

        for (const [id, device] of devices) {
            const label = device.origin
                ? `${device.description} – ${device.origin}` : device.description;
            let row = entry.deviceRows.get(id);
            if (!row) {
                row = makePopupRow(
                    label,
                    device.get_gicon?.() || 'audio-card-symbolic',
                );
                row.connect('activate', () => {
                    const current = entry.original._control[
                        entry.microphone ? 'lookup_input_id' : 'lookup_output_id'](id);
                    if (current) {
                        if (entry.microphone)
                            entry.original._control.change_input(current);
                        else
                            entry.original._control.change_output(current);
                    }
                });
                entry.deviceSection.addMenuItem(row);
                entry.deviceRows.set(id, row);
            } else if (row.label.text !== label) {
                row.label.text = label;
            }
            const nativeRow = entry.original._deviceItems.get(id);
            const selected = entry.activeId === id ||
                nativeRow?._ornament === PopupMenu.Ornament.CHECK;
            row.setOrnament(selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        const present = new Set(devices.map(([id]) => id));
        for (const [id, row] of entry.deviceRows) {
            if (!present.has(id)) {
                row.destroy();
                entry.deviceRows.delete(id);
            }
        }
    }

    _buildBrightness(originals) {
        this._displayEntry = this._addBrightnessSlider(
            'Display brightness',
            'display-brightness-symbolic',
            'Brightness control is unavailable for this display',
            value => this._displayWriter?.request(value),
        );
        this._keyboardEntry = this._addBrightnessSlider(
            'Keyboard backlight',
            'keyboard-brightness-symbolic',
            'Keyboard backlight is not available on this device',
            value => this._keyboardModel?.setPercentage(value),
        );
        const proxy = originals[0]?._proxy;
        if (proxy)
            this._bindDisplayBrightness(proxy);
        this._bindKeyboardBacklight(new KeyboardBacklight());
        this._watch(this, 'scroll-event', (_actor, event) => this._scrollBrightness(event));
    }

    _addBrightnessSlider(title, icon, unavailableText, onValue) {
        const control = new QuickSlider({iconName: icon, x_expand: true});
        control.menuEnabled = false;
        control.slider.accessible_name = title;
        const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        row.add_child(control);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
        this.menu.addMenuItem(row);
        const unavailable = new PopupMenu.PopupMenuItem(unavailableText, {
            reactive: false, can_focus: false,
        });
        this.menu.addMenuItem(unavailable);
        const entry = {control, row, unavailable, available: false, percent: null, valueSignal: 0};
        entry.valueSignal = this._watch(control.slider, 'notify::value', () => {
            if (entry.available)
                onValue(Math.round(control.slider.value * 100));
        });
        this._syncBrightnessSlider(entry, false, 0);
        return entry;
    }

    _syncBrightnessSlider(entry, available, percent) {
        if (this._disposed)
            return;
        entry.available = Boolean(available);
        if (entry.row.visible !== entry.available)
            entry.row.visible = entry.available;
        if (entry.unavailable.visible === entry.available)
            entry.unavailable.visible = !entry.available;
        if (!entry.available)
            return;
        const value = Math.max(0, Math.min(100, percent)) / 100;
        if (Math.abs(entry.control.slider.value - value) > 0.0001) {
            entry.control.slider.block_signal_handler(entry.valueSignal);
            entry.control.slider.value = value;
            entry.control.slider.unblock_signal_handler(entry.valueSignal);
        }
        entry.percent = Math.round(value * 100);
    }

    _bindDisplayBrightness(proxy) {
        this._displayProxy = proxy;
        this._displayCancellable = new Gio.Cancellable();
        this._displayWriter = new LatestValueWriter({
            intervalMs: 50,
            now: () => GLib.get_monotonic_time() / 1000,
            schedule: (delay, callback) => GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, Math.max(0, Math.ceil(delay)), () => {
                    callback();
                    return GLib.SOURCE_REMOVE;
                }),
            cancel: id => GLib.source_remove(id),
            write: value => callProperties(proxy, 'Set', new GLib.Variant('(ssv)', [
                proxy.g_interface_name,
                'Brightness',
                new GLib.Variant('i', [value]),
            ]), this._displayCancellable),
            read: async () => {
                const result = await callProperties(proxy, 'Get', new GLib.Variant('(ss)', [
                    proxy.g_interface_name, 'Brightness',
                ]), this._displayCancellable);
                return result.get_child_value(0).get_variant().get_int32();
            },
            onValue: value => this._syncBrightnessSlider(this._displayEntry, true, value),
            onError: error => this._reportError(error, 'Could not control display brightness'),
        });
        const reload = () => {
            this._displayWriter.cancelPending();
            this._loadDisplayBrightness();
        };
        this._watch(proxy, 'notify::g-name-owner', reload);
        this._watch(proxy, 'g-properties-changed', () => {
            if (proxy.g_name_owner && Number.isInteger(proxy.Brightness))
                this._syncBrightnessSlider(this._displayEntry, true, proxy.Brightness);
        });
        this._loadDisplayBrightness();
    }

    async _loadDisplayBrightness() {
        const proxy = this._displayProxy;
        const generation = this._generation;
        if (!proxy?.g_name_owner) {
            this._displayWriter?.setCurrent(null);
            this._syncBrightnessSlider(this._displayEntry, false, 0);
            return;
        }
        try {
            const result = await callProperties(proxy, 'Get', new GLib.Variant('(ss)', [
                proxy.g_interface_name, 'Brightness',
            ]), this._displayCancellable);
            const value = result.get_child_value(0).get_variant().get_int32();
            if (this._disposed || generation !== this._generation)
                return;
            this._displayWriter.setCurrent(value);
            this._syncBrightnessSlider(this._displayEntry, Number.isInteger(value) && value >= 0, value);
        } catch (error) {
            if (!this._disposed && generation === this._generation)
                this._reportError(error, 'Could not read display brightness');
        }
    }

    _bindKeyboardBacklight(model) {
        this._keyboardModel = model;
        this._watch(model, 'changed', () => this._syncBrightnessSlider(
            this._keyboardEntry, model.available, model.percentage,
        ));
        this._watch(model, 'error', (_model, message) => this._reportError(
            new Error(message), 'Could not control keyboard backlight',
        ));
        this._syncBrightnessSlider(this._keyboardEntry, model.available, model.percentage);
    }

    _scrollOutput(event) {
        if (!this._outputAudio?.stream)
            return Clutter.EVENT_PROPAGATE;
        const slider = this._outputAudio.control.slider;
        const previous = slider.value;
        const result = slider.scroll(event);
        if (result === Clutter.EVENT_STOP && slider.value !== previous) {
            Main.osdWindowManager.show(
                -1,
                new Gio.ThemedIcon({name: this._outputAudio.original.iconName ||
                    'audio-volume-high-symbolic'}),
                null,
                slider.value,
                slider.maximum_value,
            );
        }
        return result;
    }

    _scrollBrightness(event) {
        if (!this._displayEntry?.available)
            return Clutter.EVENT_PROPAGATE;
        const slider = this._displayEntry.control.slider;
        const previous = slider.value;
        const result = slider.scroll(event);
        if (result === Clutter.EVENT_STOP && slider.value !== previous) {
            Main.osdWindowManager.show(
                -1,
                new Gio.ThemedIcon({name: 'display-brightness-symbolic'}),
                null,
                slider.value,
                1,
            );
        }
        return result;
    }

    _onPopupOpened() {
        if (this._wifiControl) {
            this._watchPopup(this._wifiClient, 'device-added', () =>
                this._queue('wifi-rows', () => this._refreshWifiRows()));
            this._watchPopup(this._wifiClient, 'device-removed', () =>
                this._queue('wifi-rows', () => this._refreshWifiRows()));
            this._refreshWifiRows();
            this._startScanning();
        }
        if (this._bluetoothControl) {
            this._watchPopup(this._bluetoothClient, 'devices-changed', () =>
                this._queue('bluetooth-rows', () => this._refreshBluetoothRows()));
            this._refreshBluetoothRows();
        }
        if (this._audioEntries.length) {
            for (const entry of this._audioEntries) {
                this._syncAudio(entry);
                this._refreshAudioDevices(entry);
            }
        }
    }

    _onPopupClosed() {
        this._stopScanning();
        this._disconnectPopupSignals();
        for (const [category, id] of this._queued) {
            GLib.source_remove(id);
            this._queued.delete(category);
        }
    }

    _startScanning() {
        if (this._scanTimeout || this._disposed)
            return;
        this._scanWifi();
        this._scanTimeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
            if (this._disposed || !this.menu.isOpen) {
                this._scanTimeout = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._scanWifi();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _scanWifi() {
        if (this._scanCancellable || !this._wifiClient?.wireless_enabled || this._disposed)
            return;
        const cancellable = new Gio.Cancellable();
        const generation = this._generation;
        this._scanCancellable = cancellable;
        try {
            const devices = this._wifiDevices();
            const results = await Promise.allSettled(devices.map(device =>
                device.request_scan_async(cancellable)));
            const failed = results.find(result => result.status === 'rejected');
            if (failed && !cancellable.is_cancelled() && !this._disposed)
                this._reportError(failed.reason, 'Unable to scan Wi-Fi networks');
            if (!this._disposed && generation === this._generation && this.menu.isOpen)
                this._queue('wifi-rows', () => this._refreshWifiRows());
        } catch (error) {
            if (!cancellable.is_cancelled() && !this._disposed &&
                generation === this._generation)
                this._reportError(error, 'Unable to scan Wi-Fi networks');
        } finally {
            if (this._scanCancellable === cancellable) {
                this._scanCancellable = null;
                if (!this._disposed && this.menu.isOpen && cancellable.is_cancelled())
                    this._queue('wifi-scan', () => this._scanWifi());
            }
        }
    }

    _stopScanning() {
        if (this._scanTimeout)
            GLib.source_remove(this._scanTimeout);
        this._scanTimeout = 0;
        this._scanCancellable?.cancel();
    }

    async _runCommand() {
        const generation = this._generation;
        try {
            const process = Gio.Subprocess.new(this._spec.argv, Gio.SubprocessFlags.STDERR_PIPE);
            const [, stderr] = await process.communicate_utf8_async(
                null, this._commandCancellable,
            );
            if (!process.get_successful())
                throw new Error(stderr.trim() || 'The command exited unsuccessfully.');
        } catch (error) {
            if (!this._disposed && generation === this._generation)
                this._reportError(error, `Could not run ${this._spec.label}`);
        }
    }

    _onDestroy() {
        this._cleanup();
        super._onDestroy();
    }

    _cleanup() {
        if (this._disposed)
            return;
        this._disposed = true;
        this._generation++;
        this._stopScanning();
        this._commandCancellable?.cancel();
        this._displayCancellable?.cancel();
        this._displayWriter?.dispose();
        this._disconnectPopupSignals();
        for (const id of this._queued.values())
            GLib.source_remove(id);
        this._queued.clear();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._keyboardModel?.destroy();
        for (const row of this._wifiRows.values())
            row.destroy();
        this._wifiRows.clear();
        for (const {row} of this._bluetoothRows.values())
            row.destroy();
        this._bluetoothRows.clear();
        for (const entry of this._audioEntries) {
            for (const row of entry.deviceRows.values())
                row.destroy();
            entry.deviceRows.clear();
        }
        this._audioEntries = [];
    }
});
