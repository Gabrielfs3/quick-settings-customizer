import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {LatestValueWriter} from './bounded.js';

const INTERFACE = 'org.freedesktop.UPower.KbdBacklight';
const PATH = '/org/freedesktop/UPower/KbdBacklight';

function call(proxy, method, parameters, cancellable) {
    return new Promise((resolve, reject) => {
        proxy.call(method, parameters, Gio.DBusCallFlags.NONE, 5000, cancellable, (source, result) => {
            try {
                resolve(source.call_finish(result).deep_unpack());
            } catch (error) {
                reject(error);
            }
        });
    });
}

export const KeyboardBacklight = GObject.registerClass({
    Signals: {
        'changed': {},
        'error': {param_types: [GObject.TYPE_STRING]},
    },
}, class KeyboardBacklight extends GObject.Object {
    _init(connection = Gio.DBus.system) {
        super._init();
        this.available = false;
        this.level = 0;
        this.maximum = 0;
        this._destroyed = false;
        this._generation = 0;
        this._lastErrorAt = 0;
        this._cancellable = new Gio.Cancellable();
        this._proxy = new Gio.DBusProxy({
            g_connection: connection,
            g_name: 'org.freedesktop.UPower',
            g_object_path: PATH,
            g_interface_name: INTERFACE,
            g_flags: Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
        });
        this._signals = [
            this._proxy.connect('notify::g-name-owner', () => {
                this._writer?.cancelPending();
                this._load();
            }),
            this._proxy.connect('g-signal', (_proxy, _sender, signal, parameters) => {
                if (['BrightnessChanged', 'BrightnessChangedWithSource'].includes(signal)) {
                    const [level] = parameters.deep_unpack();
                    if (this.level !== level) {
                        this.level = level;
                        this._writer.setCurrent(level);
                        this.emit('changed');
                    }
                }
            }),
        ];
        this._writer = new LatestValueWriter({
            intervalMs: 50,
            now: () => GLib.get_monotonic_time() / 1000,
            schedule: (delay, callback) => GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, Math.max(0, Math.ceil(delay)), () => {
                    callback();
                    return GLib.SOURCE_REMOVE;
                }),
            cancel: id => GLib.source_remove(id),
            write: level => call(
                this._proxy, 'SetBrightness', new GLib.Variant('(i)', [level]),
                this._cancellable,
            ),
            read: async () => {
                const [[level]] = [await call(this._proxy, 'GetBrightness', null, this._cancellable)];
                return level;
            },
            onValue: level => {
                if (this._destroyed)
                    return;
                this.level = level;
                this.emit('changed');
            },
            onError: error => this._error(error),
        });
        this._start();
    }

    get percentage() {
        return this.maximum > 0 ? 100 * this.level / this.maximum : 0;
    }

    async _start() {
        try {
            await new Promise((resolve, reject) =>
                this._proxy.init_async(0, this._cancellable, (source, result) => {
                    try {
                        source.init_finish(result);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                }));
            await this._load();
        } catch (error) {
            this._error(error);
        }
    }

    async _load() {
        if (this._destroyed)
            return;
        const generation = ++this._generation;
        if (this.available) {
            this.available = false;
            this.emit('changed');
        }
        if (!this._proxy.g_name_owner) {
            this.emit('changed');
            return;
        }
        try {
            const [[maximum], [level]] = await Promise.all([
                call(this._proxy, 'GetMaxBrightness', null, this._cancellable),
                call(this._proxy, 'GetBrightness', null, this._cancellable),
            ]);
            if (this._destroyed || generation !== this._generation)
                return;
            this.maximum = maximum;
            this.level = level;
            this.available = Number.isInteger(maximum) && maximum > 0 &&
                Number.isInteger(level) && level >= 0 && level <= maximum;
            this._writer.setCurrent(level);
            this.emit('changed');
        } catch (error) {
            if (!this._destroyed && generation === this._generation) {
                this.available = false;
                this.emit('changed');
                this._error(error);
            }
        }
    }

    setPercentage(value) {
        if (!this.available)
            return;
        this._writer.request(Math.round(Math.max(0, Math.min(100, value)) *
            this.maximum / 100));
    }

    _error(error) {
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._destroyed && !this._cancellable.is_cancelled() &&
            now - this._lastErrorAt >= 30000) {
            this._lastErrorAt = now;
            this.emit('error', error.message);
        }
    }

    destroy() {
        this._destroyed = true;
        this._generation++;
        this._writer.dispose();
        this._cancellable.cancel();
        for (const signal of this._signals)
            this._proxy.disconnect(signal);
        this._signals = [];
    }
});
