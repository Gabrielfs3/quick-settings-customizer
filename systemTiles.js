import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {SYSTEM_TILES} from './config.js';

export class SystemTiles {
    constructor(settings, reportError) {
        this._settings = settings;
        this._reportError = reportError;
        this._tiles = new Map();
        this._originals = null;
        this._detached = new Set();
        this._syncIdle = 0;
        this._batteryIdle = 0;
        this._destroyed = false;
        this._stats = {reconciliations: 0, created: 0, destroyed: 0, moves: 0};
        this._signals = ['system-tiles', 'system-tile-labels', 'hidden-system-controls',
            'compact-system-tiles', 'compact-battery-percentage'].map(key =>
            settings.connect(`changed::${key}`, () => this.schedule()));
        this.schedule();
    }

    schedule() {
        if (this._destroyed || this._syncIdle)
            return;
        this._syncIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncIdle = 0;
            if (!this._destroyed)
                this.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    sync() {
        if (this._destroyed)
            return;
        try {
            this._sync();
        } catch (error) {
            this._reportError('system-tiles', error, 'Could not update system tiles');
        }
    }

    _initialize() {
        if (this._originals)
            return true;
        const qs = Main.panel.statusArea.quickSettings;
        const system = qs?._system?._systemItem;
        if (!system)
            return false;
        const children = system.child.get_children();
        const originals = {
            settings: children.find(actor => '_settingsApp' in actor),
            power: children.find(actor => actor.menu === system.menu),
            battery: system.powerToggle,
            screenshot: children.find(actor => actor.icon_name === 'screenshooter-symbolic'),
            lock: children.find(actor => actor.icon_name === 'system-lock-screen-symbolic'),
        };
        if (Object.values(originals).some(actor => !actor))
            throw new Error('The GNOME system header does not match the GNOME 46 layout.');
        this._qs = qs;
        this._system = system;
        this._header = system.child;
        this._headerOrder = children;
        this._originals = originals;
        this._headerVisible = system.visible;
        for (const actor of Object.values(originals)) {
            actor.connectObject('notify::visible', () => this._syncHeader(), system);
        }
        this._actions = originals.power._systemActions;
        this._profile = qs._powerProfiles?.quickSettingsItems[0] ?? null;
        return true;
    }

    _sync() {
        this._stats.reconciliations++;
        if (!this._initialize())
            return;
        const ids = [...new Set(this._settings.get_strv('system-tiles'))];
        const hidden = new Set(this._settings.get_strv('hidden-system-controls'));
        const compact = this._settings.get_boolean('compact-system-tiles');
        if (compact) {
            this._qs.menu.box.add_style_class_name('qsc-compact-system-menu');
            this._qs.menu._boxPointer.add_style_class_name('qsc-compact-system-shell');
        } else {
            this._qs.menu.box.remove_style_class_name('qsc-compact-system-menu');
            this._qs.menu._boxPointer.remove_style_class_name('qsc-compact-system-shell');
        }
        const labels = this._settings.get_value('system-tile-labels').deep_unpack();
        for (const id of ids) {
            if (!SYSTEM_TILES.some(spec => spec.id === id))
                throw new Error(`Unknown system tile: ${id}`);
        }
        for (const [id, tile] of this._tiles) {
            if (!ids.includes(id)) {
                this._destroyTile(tile);
                this._tiles.delete(id);
            }
        }

        const grid = this._qs.menu._grid;
        const headerIndex = grid.get_children().indexOf(this._system);
        const sibling = grid.get_children().slice(headerIndex + 1)
            .find(actor => !actor._qscSystemTile) ?? null;
        for (const id of ids) {
            let tile = this._tiles.get(id);
            if (!tile) {
                const spec = SYSTEM_TILES.find(item => item.id === id);
                tile = this._create(spec);
                this._tiles.set(id, tile);
                this._qs.menu.insertItemBefore(tile, sibling);
                this._stats.created++;
            }
            const title = labels[id]?.trim() || SYSTEM_TILES.find(spec => spec.id === id).label;
            if (tile.title !== title)
                tile.title = title;
            if (tile.accessible_name !== title)
                tile.accessible_name = title;
            if (tile._title.get_parent().visible === compact)
                tile._title.get_parent().visible = !compact;
            const xAlign = compact ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
            if (tile._box.x_align !== xAlign)
                tile._box.x_align = xAlign;
            if (tile.menu)
                this._setTileHeader(tile, tile.iconName || 'battery-good-symbolic', tile.title);
        }
        let position = grid.get_children().indexOf(this._system) + 1;
        for (const id of ids) {
            const tile = this._tiles.get(id);
            if (grid.get_child_at_index(position) !== tile) {
                grid.set_child_at_index(tile, position);
                this._stats.moves++;
            }
            position++;
        }
        for (const id of Object.keys(this._originals)) {
            if (ids.includes(id) || hidden.has(id)) {
                // Do not change visibility: battery/privacy bindings need the live state.
                this._originals[id].menu?.close();
                this._originals[id].get_parent()?.remove_child(this._originals[id]);
                this._detached.add(id);
            } else {
                this._restoreCompact(id);
            }
        }
        this._syncHeader();
        this._scheduleBatterySync();
    }

    _create(spec) {
        const tile = new QuickToggle({
            title: spec.label, iconName: spec.icon, hasMenu: ['power', 'battery'].includes(spec.id),
            accessible_role: Atk.Role.PUSH_BUTTON,
        });
        tile._qscSystemTile = spec.id;
        tile.add_style_class_name('qsc-system-tile');
        tile.track_hover = true;
        this._installTooltip(tile);
        if (['settings', 'screenshot', 'lock'].includes(spec.id)) {
            tile.connect('clicked', () => this._originals[spec.id].emit('clicked', Clutter.BUTTON_PRIMARY));
        } else if (spec.id === 'power') {
            this._populatePower(tile);
        } else {
            this._populateBattery(tile);
        }
        if (spec.id !== 'battery') {
            const source = this._originals[spec.id];
            const sync = () => {
                tile.visible = source.visible;
                tile.reactive = source.reactive;
            };
            source.connectObject(
                'notify::visible', sync, 'notify::reactive', sync, tile,
            );
            sync();
        }
        if (tile.menu) {
            tile.connect('clicked', () => tile.menu.open());
            tile._qscMenuSignal = tile.menu.connect('open-state-changed', () => {
                const anyOpen = [...this._tiles.values()].some(item => item.menu?.isOpen);
                if (anyOpen)
                    this._qs.menu.box.add_style_class_name('qsc-compact-submenu-open');
                else
                    this._qs.menu.box.remove_style_class_name('qsc-compact-submenu-open');
            });
        }
        tile.connect('clicked', () => this._hideTooltip(tile));
        return tile;
    }

    _setTileHeader(tile, icon, title, subtitle = tile.subtitle) {
        const current = tile._qscHeader;
        const sameIcon = current?.icon === icon ||
            (current?.icon instanceof Gio.Icon && icon instanceof Gio.Icon &&
                current.icon.equal(icon));
        if (sameIcon && current.title === title && current.subtitle === (subtitle ?? ''))
            return;
        tile.menu.setHeader(icon, title, subtitle);
        tile._qscHeader = {icon, title, subtitle: subtitle ?? ''};
    }

    _installTooltip(tile) {
        tile._qscTooltip = new St.Label({
            style_class: 'dash-label qsc-system-tooltip', reactive: false, visible: false,
        });
        Main.uiGroup.add_child(tile._qscTooltip);
        tile._qscTooltipTimer = 0;
        const show = () => {
            this._hideTooltip(tile);
            if (!tile.mapped || !this._settings.get_boolean('compact-system-tiles'))
                return;
            tile._qscTooltipTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                tile._qscTooltipTimer = 0;
                tile._qscTooltip.text = [tile.title, tile.subtitle].filter(Boolean).join(' - ');
                const [x, y] = tile.get_transformed_position();
                const [, width] = tile._qscTooltip.get_preferred_width(-1);
                const [, height] = tile._qscTooltip.get_preferred_height(width);
                const monitor = Main.layoutManager.findMonitorForActor(tile);
                const left = monitor?.x ?? 0;
                const right = left + (monitor?.width ?? global.stage.width);
                tile._qscTooltip.set_position(
                    Math.max(left, Math.min(x + (tile.width - width) / 2, right - width)),
                    Math.max(monitor?.y ?? 0, y - height - 6),
                );
                Main.uiGroup.set_child_above_sibling(tile._qscTooltip, null);
                tile._qscTooltip.show();
                return GLib.SOURCE_REMOVE;
            });
        };
        tile.connect('notify::hover', () => tile.hover ? show() : this._hideTooltip(tile));
        tile.connect('key-focus-in', show);
        tile.connect('key-focus-out', () => this._hideTooltip(tile));
        tile.connect('notify::mapped', () => {
            if (!tile.mapped)
                this._hideTooltip(tile);
        });
    }

    _hideTooltip(tile) {
        if (tile._qscTooltipTimer)
            GLib.source_remove(tile._qscTooltipTimer);
        tile._qscTooltipTimer = 0;
        tile._qscTooltip?.hide();
    }

    _populatePower(tile) {
        tile._actionItems = new Map();
        for (const [label, permission, action] of [
            ['Suspend', 'can-suspend', 'activateSuspend'],
            ['Restart...', 'can-restart', 'activateRestart'],
            ['Power Off...', 'can-power-off', 'activatePowerOff'],
            ['Log Out...', 'can-logout', 'activateLogout'],
            ['Switch User...', 'can-switch-user', 'activateSwitchUser'],
        ]) {
            if (action === 'activateLogout')
                tile.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const item = tile.menu.addAction(label, () => {
                this._actions[action]();
                this._qs.menu.close();
            });
            const binding = this._actions.bind_property(
                permission, item, 'visible', GObject.BindingFlags.SYNC_CREATE,
            );
            tile._qscBindings ??= [];
            tile._qscBindings.push(binding);
            tile._actionItems.set(action, item);
        }
        tile.connect('notify::mapped', () => {
            if (tile.mapped)
                this._actions.forceUpdate();
        });
    }

    _populateBattery(tile) {
        tile._percentage = new St.Label({
            style_class: 'qsc-battery-percentage',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        tile._box.add_child(tile._percentage);
        tile._batteryInfo = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        tile.menu.addMenuItem(tile._batteryInfo);
        tile._profiles = new PopupMenu.PopupMenuSection();
        tile.menu.addMenuItem(tile._profiles);
        tile._profileItems = new Map();
        tile.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        tile.menu.addSettingsAction('Power Settings', 'gnome-power-panel.desktop');
        const sync = () => this._scheduleBatterySync();
        const battery = this._originals.battery;
        battery.connectObject(
            'notify::title', sync, 'notify::gicon', sync, 'notify::visible', sync, tile,
        );
        if (this._profile) {
            this._profile.connectObject(
                'notify::subtitle', sync, 'notify::visible', sync, tile,
            );
            this._profile._proxy.connectObject(
                'g-properties-changed', sync, 'notify::g-name-owner', sync, tile,
            );
        }
        Main.sessionMode.connectObject('updated', sync, tile);
    }

    _scheduleBatterySync() {
        if (this._destroyed || this._batteryIdle)
            return;
        this._batteryIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._batteryIdle = 0;
            if (!this._destroyed)
                this._syncBattery();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncBattery() {
        const tile = this._tiles.get('battery');
        if (!tile)
            return;
        const battery = this._originals.battery;
        const hasBattery = battery.visible;
        const showPercentage = hasBattery &&
            this._settings.get_boolean('compact-system-tiles') &&
            this._settings.get_boolean('compact-battery-percentage');
        const percentageText = hasBattery ? battery.title : '';
        if (tile._percentage.text !== percentageText)
            tile._percentage.text = percentageText;
        if (tile._percentage.visible !== showPercentage)
            tile._percentage.visible = showPercentage;
        if (tile._box.vertical !== showPercentage)
            tile._box.vertical = showPercentage;
        const yAlign = showPercentage ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
        if (tile._box.y_align !== yAlign)
            tile._box.y_align = yAlign;
        if (showPercentage && !tile.has_style_class_name('qsc-battery-with-percentage'))
            tile.add_style_class_name('qsc-battery-with-percentage');
        else if (!showPercentage && tile.has_style_class_name('qsc-battery-with-percentage'))
            tile.remove_style_class_name('qsc-battery-with-percentage');
        const accessibleName = hasBattery ? `${tile.title}, ${battery.title}` : tile.title;
        if (tile.accessible_name !== accessibleName)
            tile.accessible_name = accessibleName;
        const profile = this._profile;
        const active = profile?._proxy.ActiveProfile;
        const details = [
            hasBattery ? battery.title : 'No battery',
            profile?.visible ? profile.subtitle : null,
        ].filter(Boolean);
        const subtitle = details.join(' - ');
        if (tile.subtitle !== subtitle)
            tile.subtitle = subtitle;
        this._setTileHeader(
            tile, profile?.iconName || 'battery-good-symbolic', tile.title, tile.subtitle,
        );
        const batteryInfo = hasBattery ? `Battery: ${battery.title}` : 'No battery detected';
        if (tile._batteryInfo.label.text !== batteryInfo)
            tile._batteryInfo.label.text = batteryInfo;
        if (hasBattery && battery.gicon) {
            if (tile.gicon !== battery.gicon)
                tile.gicon = battery.gicon;
        } else {
            const iconName = profile?.iconName || 'battery-good-symbolic';
            if (tile.iconName !== iconName)
                tile.iconName = iconName;
        }

        const profiles = profile?.visible ? [...profile._profileItems] : [];
        const available = new Set(profiles.map(([id]) => id));
        for (const [id, item] of tile._profileItems) {
            if (!available.has(id)) {
                item.destroy();
                tile._profileItems.delete(id);
            }
        }
        for (const [id, original] of profiles) {
            let item = tile._profileItems.get(id);
            if (!item) {
                item = new PopupMenu.PopupImageMenuItem(original.label.text, `power-profile-${id}-symbolic`);
                item.connect('activate', () => {
                    this._profile._proxy.ActiveProfile = id;
                });
                tile._profiles.addMenuItem(item);
                tile._profileItems.set(id, item);
            }
            if (item.label.text !== original.label.text)
                item.label.text = original.label.text;
            const iconName = `power-profile-${id}-symbolic`;
            if (item._icon.icon_name !== iconName)
                item.setIcon(iconName);
            item.setOrnament(id === active ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        if (!tile._profileUnavailable) {
            tile._profileUnavailable = new PopupMenu.PopupMenuItem('Power profiles unavailable', {
                reactive: false, can_focus: false,
            });
            tile._profiles.addMenuItem(tile._profileUnavailable);
        }
        const unavailable = profiles.length === 0;
        if (tile._profileUnavailable.visible !== unavailable)
            tile._profileUnavailable.visible = unavailable;
        if (tile.visible !== Main.sessionMode.allowSettings)
            tile.visible = Main.sessionMode.allowSettings;
    }

    _restoreCompact(id) {
        if (!this._detached.has(id))
            return;
        const actor = this._originals[id];
        const next = this._headerOrder.slice(this._headerOrder.indexOf(actor) + 1)
            .find(child => child.get_parent() === this._header);
        if (next)
            this._header.insert_child_below(actor, next);
        else
            this._header.add_child(actor);
        this._detached.delete(id);
    }

    _syncHeader() {
        if (this._originals) {
            const visible = Object.values(this._originals)
                .some(actor => actor.get_parent() === this._header && actor.visible);
            if (this._system.visible !== visible)
                this._system.visible = visible;
        }
    }

    _destroyTile(tile) {
        this._hideTooltip(tile);
        for (const original of Object.values(this._originals ?? {}))
            original.disconnectObject(tile);
        this._profile?.disconnectObject(tile);
        this._profile?._proxy?.disconnectObject(tile);
        Main.sessionMode.disconnectObject(tile);
        for (const binding of tile._qscBindings ?? [])
            binding.unbind();
        tile._qscBindings = [];
        if (tile._qscMenuSignal)
            tile.menu.disconnect(tile._qscMenuSignal);
        tile._qscTooltip.destroy();
        tile.menu?.close();
        tile.menu?.destroy();
        tile.get_parent()?.remove_child(tile);
        tile.destroy();
        this._stats.destroyed++;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._syncIdle)
            GLib.source_remove(this._syncIdle);
        this._syncIdle = 0;
        if (this._batteryIdle)
            GLib.source_remove(this._batteryIdle);
        this._batteryIdle = 0;
        for (const id of this._signals)
            this._settings.disconnect(id);
        for (const [id, tile] of this._tiles) {
            this._destroyTile(tile);
        }
        this._tiles.clear();
        this._qs?.menu.box.remove_style_class_name('qsc-compact-system-menu');
        this._qs?.menu.box.remove_style_class_name('qsc-compact-submenu-open');
        this._qs?.menu._boxPointer.remove_style_class_name('qsc-compact-system-shell');
        for (const id of [...this._detached])
            this._restoreCompact(id);
        if (this._originals) {
            for (const actor of Object.values(this._originals))
                actor.disconnectObject(this._system);
            this._system.visible = this._headerVisible;
        }
    }
}
