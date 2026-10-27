import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    BUTTONS, ORIGINAL_ICONS, ORIGINAL_ITEMS, buttonSources, parseCustomItem, resolvePath,
} from './config.js';
import {PanelLayout} from './panelLayout.js';
import {ControlButton} from './controlUi.js';
import {SystemTiles} from './systemTiles.js';
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const reportedErrors = new Map();

function reportError(error, context) {
    const now = GLib.get_monotonic_time() / 1000;
    const key = context;
    const previous = reportedErrors.get(key) ?? 0;
    if (now - previous < 30000)
        return;
    for (const [reportedKey, timestamp] of reportedErrors) {
        if (now - timestamp >= 30000)
            reportedErrors.delete(reportedKey);
    }
    if (reportedErrors.size >= 64)
        reportedErrors.delete(reportedErrors.keys().next().value);
    reportedErrors.set(key, now);
    console.error(`[Quick Settings Customizer] ${context}: ${error.message}\n${error.stack ?? ''}`);
    Main.notifyError('Quick Settings Customizer', `${context}: ${error.message}`);
}

export default class QuickSettingsCustomizerExtension extends Extension {
    enable() {
        if (this._settings)
            return;
        this._disposed = false;
        this._generation = (this._generation ?? 0) + 1;
        this._settings = this.getSettings();
        this._buttons = new Map();
        this._hiddenItems = new Map();
        this._hiddenIcons = new Map();
        this._gridOrder = [];
        this._errors = new Set();
        this._retryId = 0;
        this._retryCount = 0;
        this._ownPositionId = 0;
        this._originalContainerVisibility = null;
        try {
            this._panelLayout = new PanelLayout(
                this._settings, this.uuid, this._reportOnce.bind(this),
            );
            this._systemTiles = new SystemTiles(this._settings, this._reportOnce.bind(this));
            this._settingsSignals = [
                this._settings.connect('changed::items', () => {
                    this._syncButtons();
                    this._positionButtons();
                }),
                this._settings.connect('changed::custom-items', () => {
                    this._syncButtons();
                    this._positionButtons();
                }),
                this._settings.connect('changed::panel-box', () => this._positionButtons()),
                this._settings.connect('changed::manage-global-panel-layout',
                    () => this._positionButtons()),
                this._settings.connect('changed::hidden-original-items', () => this._syncOriginals()),
                this._settings.connect('changed::hidden-original-icons', () => this._syncOriginals()),
                this._settings.connect('changed::replace-quick-settings', () => this._syncContainer()),
            ];
            this._syncButtons();
            this._positionButtons();
            this._syncOriginals();
            this._syncContainer();
            this._waitForNativeControls();
        } catch (error) {
            this._reportOnce('enable', error, 'Could not initialize Quick Settings Customizer');
            this.disable();
        }
    }

    disable() {
        if (!this._settings)
            return;
        this._disposed = true;
        this._generation++;
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
        if (this._ownPositionId)
            GLib.source_remove(this._ownPositionId);
        this._ownPositionId = 0;
        for (const id of this._settingsSignals ?? [])
            this._settings.disconnect(id);
        this._settingsSignals = [];
        this._panelLayout?.destroy();
        this._panelLayout = null;
        this._systemTiles?.destroy();
        this._systemTiles = null;
        this._clearButtons();
        for (const record of this._hiddenItems.values())
            this._restoreItem(record);
        this._hiddenItems.clear();
        for (const record of this._hiddenIcons.values())
            this._restoreIcon(record);
        this._hiddenIcons.clear();
        this._restoreContainer();
        this._settings = null;
    }

    _clearButtons() {
        for (const button of this._buttons.values())
            button.destroy();
        this._buttons.clear();
    }

    _specifications() {
        const specs = new Map(BUTTONS.map(spec => [spec.id, spec]));
        // Preserve the identifier used by the first version.
        specs.set('power-profiles', {...specs.get('power'), id: 'power-profiles'});
        for (const encoded of this._settings.get_strv('custom-items')) {
            try {
                const item = parseCustomItem(encoded, command => GLib.shell_parse_argv(command)[1]);
                specs.set(item.id, item);
            } catch (error) {
                this._reportOnce(encoded, error, 'Invalid custom command');
            }
        }
        return specs;
    }

    _syncButtons() {
        if (this._disposed || !this._settings)
            return;
        const ids = [...new Set(this._settings.get_strv('items'))];
        const specs = this._specifications();
        let changed = false;
        for (const [id, button] of this._buttons) {
            const spec = specs.get(id);
            const sourceId = id === 'power-profiles' ? 'power' : id;
            const candidate = spec ? {...spec, id: sourceId} : null;
            const unchanged = candidate &&
                JSON.stringify(button._spec) === JSON.stringify(candidate);
            if (!ids.includes(id) || !unchanged) {
                button.destroy();
                this._buttons.delete(id);
                changed = true;
            }
        }
        const quickSettings = Main.panel.statusArea.quickSettings;
        for (const id of ids) {
            if (this._buttons.has(id))
                continue;
            const spec = specs.get(id);
            if (!spec)
                continue;
            const sourceId = id === 'power-profiles' ? 'power' : id;
            const originals = spec.argv ? [] : buttonSources(quickSettings, sourceId);
            if (!spec.argv && ((id === 'brightness' ? !originals[0] : originals.some(source => !source)) ||
                (id === 'wifi' && !originals[0]._client)))
                continue;
            try {
                const button = new ControlButton(
                    {...spec, id: sourceId},
                    originals,
                    (error, context) => this._reportOnce(`${id}:${context}`, error, context),
                );
                button._requestedId = id;
                this._buttons.set(id, button);
                changed = true;
                Main.panel.addToStatusArea(
                    `${this.uuid}-${id}`, button, -1, this._settings.get_string('panel-box'),
                );
            } catch (error) {
                this._buttons.get(id)?.destroy();
                this._buttons.delete(id);
                this._reportOnce(id, error, `Could not create ${spec.label}`);
            }
        }
        if (changed)
            this._positionButtons();
    }

    _positionButtons() {
        if (this._disposed || this._ownPositionId)
            return;
        this._ownPositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._ownPositionId = 0;
            if (this._disposed || !this._settings)
                return GLib.SOURCE_REMOVE;
            if (this._settings.get_boolean('manage-global-panel-layout')) {
                this._panelLayout?.schedule();
                return GLib.SOURCE_REMOVE;
            }
            this._placeOwnButtons();
            return GLib.SOURCE_REMOVE;
        });
    }

    _placeOwnButtons() {
        const section = this._settings.get_string('panel-box');
        const box = Main.panel[`_${section}Box`];
        if (!box)
            return;
        const buttons = this._settings.get_strv('items')
            .map(id => this._buttons.get(id))
            .filter(Boolean);
        const own = new Set([...this._buttons.values()].map(button => button.container));
        const children = box.get_children();
        const currentOwn = children.filter(child => own.has(child));
        const targetIndex = section === 'right' &&
            Main.panel.statusArea.quickSettings?.container.get_parent() === box
            ? children.indexOf(Main.panel.statusArea.quickSettings.container)
            : children.length;
        const expected = buttons.map(button => button.container);
        const adjacent = currentOwn.length === expected.length &&
            currentOwn.every((actor, index) => actor === expected[index]) &&
            (expected.length === 0 || children.indexOf(expected.at(-1)) === targetIndex - 1);
        const allTargeted = expected.every(actor => actor.get_parent() === box);
        if (adjacent && allTargeted)
            return;

        for (const actor of own) {
            const parent = actor.get_parent();
            if (parent)
                parent.remove_child(actor);
        }
        for (const actor of expected) {
            const anchor = section === 'right' &&
                Main.panel.statusArea.quickSettings?.container.get_parent() === box
                ? box.get_children().indexOf(Main.panel.statusArea.quickSettings.container)
                : box.get_n_children();
            box.insert_child_at_index(actor, Math.max(0, anchor));
        }
    }

    _syncOriginals() {
        const quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings?.menu?._grid)
            return;
        const currentOrder = quickSettings.menu._grid.get_children();
        for (let index = 0; index < currentOrder.length; index++) {
            const item = currentOrder[index];
            if (item._qscSystemTile || this._gridOrder.includes(item))
                continue;
            const next = currentOrder.slice(index + 1)
                .find(sibling => this._gridOrder.includes(sibling));
            const position = next ? this._gridOrder.indexOf(next) : this._gridOrder.length;
            this._gridOrder.splice(position, 0, item);
        }
        const hidden = new Set(this._settings.get_strv('hidden-original-items'));
        for (const spec of ORIGINAL_ITEMS) {
            const item = resolvePath(quickSettings, spec.path);
            if (!item)
                continue;
            if (hidden.has(spec.id) && !this._hiddenItems.has(spec.id)) {
                const parent = item.get_parent();
                if (parent !== quickSettings.menu._grid)
                    continue;
                item.menu?.close();
                const columnSpan = parent.layout_manager.get_child_meta(parent, item).column_span;
                this._hiddenItems.set(spec.id, {
                    item, parent,
                    following: this._gridOrder.slice(this._gridOrder.indexOf(item) + 1),
                    columnSpan,
                });
                parent.remove_child(item);
            } else if (!hidden.has(spec.id) && this._hiddenItems.has(spec.id)) {
                this._restoreItem(this._hiddenItems.get(spec.id));
                this._hiddenItems.delete(spec.id);
            }
        }

        const hiddenIcons = new Set(this._settings.get_strv('hidden-original-icons'));
        for (const spec of ORIGINAL_ICONS) {
            const actor = resolvePath(quickSettings, spec.path);
            if (!actor)
                continue;
            if (hiddenIcons.has(spec.id) && !this._hiddenIcons.has(spec.id)) {
                const record = {actor, visible: actor.visible, signal: 0};
                record.signal = actor.connect('notify::visible', () => {
                    if (actor.visible)
                        actor.hide();
                });
                this._hiddenIcons.set(spec.id, record);
                actor.hide();
            } else if (!hiddenIcons.has(spec.id) && this._hiddenIcons.has(spec.id)) {
                this._restoreIcon(this._hiddenIcons.get(spec.id));
                this._hiddenIcons.delete(spec.id);
            }
        }
    }

    _restoreItem({item, parent, following, columnSpan}) {
        if (item.get_parent())
            return;
        const next = following.find(sibling => sibling.get_parent() === parent) ?? null;
        if (next)
            parent.insert_child_below(item, next);
        else
            parent.add_child(item);
        parent.layout_manager.child_set_property(parent, item, 'column-span', columnSpan);
    }

    _restoreIcon({actor, visible, signal}) {
        actor.disconnect(signal);
        if (actor._syncIndicatorsVisible)
            actor._syncIndicatorsVisible();
        else
            actor.visible = visible;
    }

    _syncContainer() {
        if (this._settings.get_boolean('replace-quick-settings')) {
            if (this._originalContainerVisibility)
                return;
            const actor = Main.panel.statusArea.quickSettings?.container;
            if (!actor)
                return;
            this._originalContainerVisibility = {actor, visible: actor.visible};
            actor.hide();
        } else {
            this._restoreContainer();
        }
    }

    _restoreContainer() {
        if (this._originalContainerVisibility) {
            const {actor, visible} = this._originalContainerVisibility;
            actor.visible = visible;
            this._originalContainerVisibility = null;
        }
    }

    _waitForNativeControls() {
        const generation = this._generation;
        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (this._disposed || generation !== this._generation) {
                this._retryId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._syncButtons();
            this._syncOriginals();
            const quickSettings = Main.panel.statusArea.quickSettings;
            this._syncContainer();
            if (quickSettings?._system)
                this._systemTiles?.schedule();
            if (quickSettings?._system && quickSettings?._network?._client) {
                this._retryId = 0;
                this._positionButtons();
                return GLib.SOURCE_REMOVE;
            }
            if (++this._retryCount >= 20) {
                this._reportOnce('startup', new Error(
                    'Some GNOME controls are unavailable. Their buttons could not be added.',
                ), 'Native controls did not finish loading');
                this._retryId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _reportOnce(key, error, context) {
        if (!this._errors.has(key)) {
            this._errors.add(key);
            reportError(error, context);
        }
    }
}
