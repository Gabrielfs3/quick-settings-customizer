import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {migratePanelLayout, PANEL_SECTIONS, stablePanelId} from './config.js';

const NATIVE_LABELS = {
    activities: 'Activities and workspaces',
    dateMenu: 'Date and time',
    quickSettings: 'Original Quick Settings',
    keyboard: 'Keyboard layout',
    a11y: 'Accessibility',
    appMenu: 'Application menu',
    dwellClick: 'Dwell click',
};

export class PanelLayout {
    constructor(settings, uuid, reportError) {
        this._settings = settings;
        this._uuid = uuid;
        this._reportError = reportError;
        this._destroyed = false;
        this._signals = [];
        this._layout = null;
        this._spacingTimer = 0;
        this._spacingTheme = null;
        this._spacingFile = null;
        this._spacingDirectory = null;
        this._spacingCss = null;
        this._spacingStats = {writes: 0, reloads: 0};
        this._globalStats = {
            reconciliations: 0,
            moves: 0,
            inventoryWrites: 0,
            aliasWrites: 0,
            conflicts: 0,
        };

        this._signals.push([settings, settings.connect(
            'changed::manage-global-panel-layout', () => this._syncGlobalMode(),
        )]);
        for (const key of ['custom-panel-spacing', 'panel-button-padding',
            'panel-button-spacing', 'panel-indicator-spacing']) {
            this._signals.push([settings, settings.connect(
                `changed::${key}`, () => this._scheduleSpacing(),
            )]);
        }
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._signals.push([themeContext, themeContext.connect(
            'changed', () => this._scheduleSpacing(),
        )]);

        this._syncGlobalMode();
        this._scheduleSpacing();
    }

    get globalStats() {
        return {...this._globalStats, active: Boolean(this._layout), suspended: Boolean(this._layout?._suspended)};
    }

    get spacingStats() {
        return {...this._spacingStats};
    }

    _syncGlobalMode() {
        if (this._destroyed)
            return;
        const enabled = this._settings.get_boolean('manage-global-panel-layout');
        if (enabled && !this._layout)
            this._startGlobalLayout();
        else if (!enabled && this._layout)
            this._stopGlobalLayout();
    }

    _startGlobalLayout() {
        const layout = {
            records: new Map(),
            baseline: Object.fromEntries(PANEL_SECTIONS.map(section => [section, []])),
            signals: [],
            idle: 0,
            retry: 0,
            inventoryIdle: 0,
            applying: false,
            destroyed: false,
            suspended: false,
            anonymousId: 0,
            conflictTimes: [],
            initialPass: true,
            settingsChanged: false,
            stats: this._globalStats,
        };
        this._layout = layout;
        for (const section of PANEL_SECTIONS) {
            const box = this._box(section);
            for (const signal of ['child-added', 'child-removed'])
                layout.signals.push([box, box.connect(signal, () => this._scheduleLayout())]);
        }
        for (const key of ['panel-layout', 'panel-box']) {
            layout.signals.push([this._settings, this._settings.connect(
                `changed::${key}`, () => {
                    if (!this._layout || this._layout !== layout)
                        return;
                    layout.settingsChanged = true;
                    layout.conflictTimes = [];
                    this._scheduleLayout();
                },
            )]);
        }
        layout.signals.push([Main.layoutManager, Main.layoutManager.connect(
            'startup-complete', () => this._scheduleLayout(),
        )]);
        this._discover(layout);
        this._scheduleLayout();
    }

    _stopGlobalLayout() {
        const layout = this._layout;
        if (!layout)
            return;
        this._layout = null;
        layout.destroyed = true;
        if (layout.idle)
            GLib.source_remove(layout.idle);
        if (layout.retry)
            GLib.source_remove(layout.retry);
        if (layout.inventoryIdle)
            GLib.source_remove(layout.inventoryIdle);
        for (const [object, signal] of layout.signals)
            object.disconnect(signal);
        this._restoreBaseline(layout);
        for (const record of [...layout.records.values()])
            this._forget(layout, record);
    }

    _box(section) {
        return Main.panel[`_${section}Box`];
    }

    schedule() {
        this._scheduleLayout();
    }

    _scheduleLayout() {
        const layout = this._layout;
        if (!layout || layout.destroyed || layout.suspended || layout.applying || layout.idle)
            return;
        if (layout.retry) {
            GLib.source_remove(layout.retry);
            layout.retry = 0;
        }
        layout.idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            layout.idle = 0;
            if (this._layout !== layout || layout.destroyed || layout.suspended)
                return GLib.SOURCE_REMOVE;
            try {
                this._syncLayout(layout);
            } catch (error) {
                this._reportError('panel-layout', error, 'Could not update the optional top-bar layout');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleInventory(layout = this._layout) {
        if (!layout || layout.destroyed || layout.suspended || layout.inventoryIdle)
            return;
        layout.inventoryIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            layout.inventoryIdle = 0;
            if (this._layout === layout && !layout.destroyed && !layout.suspended)
                this._publish(layout);
            return GLib.SOURCE_REMOVE;
        });
    }

    _discover(layout) {
        const registered = new Map(Object.entries(Main.panel.statusArea)
            .filter(([, indicator]) => indicator?.container)
            .map(([role, indicator]) => [indicator.container, {role, indicator}]));
        const live = new Set();
        for (const section of PANEL_SECTIONS) {
            const box = this._box(section);
            for (const actor of box.get_children()) {
                live.add(actor);
                const existing = layout.records.get(actor);
                if (existing) {
                    if (existing.role)
                        existing.id = this._stableId(existing.role, existing.indicator);
                    continue;
                }
                const known = registered.get(actor);
                const id = known
                    ? this._stableId(known.role, known.indicator)
                    : `panel-actor:${actor.name || actor.constructor.name}:${++layout.anonymousId}`;
                const record = {
                    actor,
                    id,
                    role: known?.role ?? '',
                    section,
                    indicator: known?.indicator ?? null,
                    signals: [],
                    own: id.startsWith(`${this._uuid}-`),
                };
                layout.records.set(actor, record);
                const baseline = layout.baseline[section];
                const children = box.get_children();
                const next = children.slice(children.indexOf(actor) + 1)
                    .find(child => baseline.includes(child));
                const position = next ? baseline.indexOf(next) : baseline.length;
                baseline.splice(position, 0, actor);
                record.signals.push([actor, actor.connect('notify::visible', () =>
                    this._scheduleInventory(layout))]);
                if (known?.indicator && known.indicator !== actor) {
                    for (const [signal, callback] of [
                        ['notify::visible', () => this._scheduleInventory(layout)],
                        ['notify::accessible-name', () => this._scheduleInventory(layout)],
                    ]) {
                        record.signals.push([known.indicator, known.indicator.connect(signal, callback)]);
                    }
                }
                const application = known?.indicator?._indicator;
                if (known?.role.startsWith('appindicator-') && application?.connect) {
                    for (const signal of ['ready', 'reset', 'name-owner-changed']) {
                        record.signals.push([application, application.connect(signal, () => {
                            const newId = this._stableId(record.role, record.indicator);
                            if (newId !== record.id) {
                                record.id = newId;
                                this._scheduleLayout();
                            } else {
                                this._scheduleInventory(layout);
                            }
                        })]);
                    }
                }
                record.signals.push([actor, actor.connect('destroy', () => {
                    this._forget(layout, record, true);
                    this._scheduleLayout();
                })]);
            }
        }
        for (const [actor, record] of layout.records) {
            if (!live.has(actor))
                this._forget(layout, record);
        }
    }

    _stableId(role, indicator) {
        return stablePanelId(role, indicator?._indicator?.id || '');
    }

    _forget(layout, record, destroying = false) {
        if (!layout.records.has(record.actor))
            return;
        layout.records.delete(record.actor);
        for (const [object, signal] of record.signals)
            object.disconnect(signal);
        record.signals = [];
        for (const section of PANEL_SECTIONS)
            layout.baseline[section] = layout.baseline[section].filter(actor => actor !== record.actor);
        if (!destroying)
            this._scheduleInventory(layout);
    }

    _migrateSavedLayout(layout) {
        const saved = this._settings.get_value('panel-layout').deep_unpack();
        const aliases = this._settings.get_value('panel-item-aliases').deep_unpack();
        const migrationAliases = {...aliases};
        const savedRoles = new Set(Object.values(saved).flat());
        for (const record of layout.records.values()) {
            if (record.role && record.id !== record.role && savedRoles.has(record.role))
                migrationAliases[record.role] = record.id;
        }
        const migrated = migratePanelLayout(saved, migrationAliases);
        if (JSON.stringify(saved) !== JSON.stringify(migrated)) {
            this._settings.set_value('panel-layout', new GLib.Variant('a{sas}', migrated));
            layout.stats.migrations = (layout.stats.migrations ?? 0) + 1;
        }
        if (Object.keys(aliases).length) {
            this._settings.set_value('panel-item-aliases', new GLib.Variant('a{ss}', {}));
            layout.stats.aliasWrites++;
        }
        return migrated;
    }

    _syncLayout(layout) {
        layout.stats.reconciliations++;
        this._discover(layout);
        const configured = this._migrateSavedLayout(layout);
        const pinned = new Set(Object.values(configured).flat());
        const byId = new Map([...layout.records.values()].map(record => [record.id, record]));
        const own = this._settings.get_strv('items')
            .map(id => `${this._uuid}-${id}`)
            .filter(id => byId.has(id));
        const automatic = own.filter(id => !pinned.has(id));
        const desired = {};
        for (const section of PANEL_SECTIONS) {
            desired[section] = this._box(section).get_children()
                .map(actor => layout.records.get(actor)?.id)
                .filter(id => id && !pinned.has(id) && !automatic.includes(id));
            desired[section].push(...configured[section].filter(id => byId.has(id)));
        }

        const target = this._settings.get_string('panel-box');
        if (target === 'right' && !pinned.has('quickSettings') &&
            desired.right.includes('quickSettings')) {
            desired.right = desired.right.filter(id => id !== 'quickSettings');
            desired.right.push('quickSettings');
        }
        const anchor = desired[target].indexOf('quickSettings');
        desired[target].splice(anchor < 0 ? desired[target].length : anchor, 0, ...automatic);

        layout.applying = true;
        const startingMoves = layout.stats.moves;
        try {
            for (const section of PANEL_SECTIONS) {
                const box = this._box(section);
                desired[section].forEach((id, index) => {
                    const actor = byId.get(id)?.actor;
                    if (!actor)
                        return;
                    if (actor.get_parent() !== box) {
                        actor.get_parent()?.remove_child(actor);
                        box.insert_child_at_index(actor, index);
                        layout.stats.moves++;
                    } else if (box.get_child_at_index(index) !== actor) {
                        box.set_child_at_index(actor, index);
                        layout.stats.moves++;
                    }
                });
            }
        } finally {
            layout.applying = false;
        }

        this._publish(layout);
        const satisfied = this._matchesLayout(layout, desired, byId);
        const moved = layout.stats.moves - startingMoves;
        if (layout.initialPass) {
            layout.initialPass = false;
        } else if (!layout.settingsChanged && moved > 0 && !satisfied) {
            const now = GLib.get_monotonic_time() / 1000;
            layout.conflictTimes = layout.conflictTimes.filter(time => now - time < 5000);
            layout.conflictTimes.push(now);
            layout.stats.conflicts++;
            if (layout.conflictTimes.length >= 3) {
                this._suspendConflictingLayout(layout);
                return;
            }
        }
        layout.settingsChanged = false;
        if (!satisfied)
            this._scheduleConflictRetry(layout);
    }

    _matchesLayout(layout, desired, byId) {
        for (const section of PANEL_SECTIONS) {
            const box = this._box(section);
            for (const [index, id] of desired[section].entries()) {
                const actor = byId.get(id)?.actor;
                if (actor && (actor.get_parent() !== box || box.get_child_at_index(index) !== actor))
                    return false;
            }
        }
        return true;
    }

    _scheduleConflictRetry(layout) {
        if (layout.destroyed || layout.suspended || layout.retry || layout.idle)
            return;
        layout.retry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            layout.retry = 0;
            if (this._layout === layout && !layout.destroyed && !layout.suspended)
                this._scheduleLayout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _suspendConflictingLayout(layout) {
        layout.suspended = true;
        if (layout.idle)
            GLib.source_remove(layout.idle);
        if (layout.retry)
            GLib.source_remove(layout.retry);
        if (layout.inventoryIdle)
            GLib.source_remove(layout.inventoryIdle);
        layout.idle = 0;
        layout.retry = 0;
        layout.inventoryIdle = 0;
        console.warn(
            'QSC_EXPECTED_ORGANIZER_CONFLICT: Optional global panel ordering paused after repeated conflicts; disable global ordering or the other organizer.',
        );
    }

    _publish(layout) {
        if (!layout || layout.suspended)
            return;
        const snapshot = [];
        for (const section of PANEL_SECTIONS) {
            for (const actor of this._box(section).get_children()) {
                const record = layout.records.get(actor);
                if (!record)
                    continue;
                const indicator = record.indicator;
                const application = indicator?._indicator;
                const label = indicator?._spec?.label || NATIVE_LABELS[record.id] ||
                    application?.title || application?.id || indicator?.accessible_name ||
                    actor.name || record.id;
                snapshot.push({
                    id: record.id,
                    role: record.role,
                    label,
                    section,
                    own: record.own,
                    visible: actor.visible && (indicator?.visible ?? true),
                    movable: !record.id.startsWith('panel-actor:'),
                });
            }
        }
        const encoded = JSON.stringify(snapshot);
        if (this._settings.get_string('panel-items') !== encoded) {
            this._settings.set_string('panel-items', encoded);
            layout.stats.inventoryWrites++;
        }
    }

    _restoreBaseline(layout) {
        layout.applying = true;
        try {
            for (const section of PANEL_SECTIONS) {
                const box = this._box(section);
                let index = 0;
                for (const actor of layout.baseline[section]) {
                    if (!layout.records.has(actor) || !actor.get_parent())
                        continue;
                    if (actor.get_parent() !== box) {
                        actor.get_parent().remove_child(actor);
                        box.insert_child_at_index(actor, index);
                    } else if (box.get_child_at_index(index) !== actor) {
                        box.set_child_at_index(actor, index);
                    }
                    index++;
                }
            }
        } finally {
            layout.applying = false;
        }
    }

    _scheduleSpacing() {
        if (this._destroyed || this._spacingTimer)
            return;
        this._spacingTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._spacingTimer = 0;
            this._applySpacing();
            return GLib.SOURCE_REMOVE;
        });
    }

    _spacingCssText() {
        const padding = this._settings.get_int('panel-button-padding');
        const gap = this._settings.get_int('panel-button-spacing');
        const indicators = this._settings.get_int('panel-indicator-spacing');
        const prefix = '#panel.qsc-custom-spacing';
        return `${prefix} .panel-button {\n` +
            `    -natural-hpadding: ${padding}px;\n` +
            `    -minimum-hpadding: ${padding}px;\n` +
            '}\n' +
            `${prefix} .panel-button .system-status-icon {\n` +
            '    padding-left: 0px; padding-right: 0px;\n' +
            '    margin-left: 0px; margin-right: 0px;\n' +
            '}\n' +
            `${prefix} #panelLeft, ${prefix} #panelCenter, ${prefix} #panelRight {\n` +
            `    spacing: ${gap}px;\n` +
            '}\n' +
            `${prefix} .panel-button .panel-status-indicators-box,\n` +
            `${prefix} .panel-button .panel-status-menu-box {\n` +
            `    spacing: ${indicators}px;\n` +
            '}\n';
    }

    _ensureSpacingFile() {
        if (this._spacingFile)
            return;
        const directory = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'quick-settings-customizer',
        ]);
        GLib.mkdir_with_parents(directory, 0o700);
        this._spacingDirectory = Gio.File.new_for_path(directory);
        this._spacingFile = this._spacingDirectory.get_child('spacing.css');
    }

    _applySpacing() {
        if (this._destroyed)
            return;
        try {
            if (!this._settings.get_boolean('custom-panel-spacing')) {
                this._clearSpacing();
                return;
            }

            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            const css = this._spacingCssText();
            if (this._spacingTheme === theme && this._spacingCss === css)
                return;
            this._ensureSpacingFile();
            if (this._spacingTheme)
                this._spacingTheme.unload_stylesheet(this._spacingFile);
            if (this._spacingCss !== css) {
                this._spacingFile.replace_contents(
                    css, null, false, Gio.FileCreateFlags.PRIVATE, null,
                );
                this._spacingStats.writes++;
            }
            theme.load_stylesheet(this._spacingFile);
            this._spacingTheme = theme;
            this._spacingCss = css;
            this._spacingStats.reloads++;
            if (!Main.panel.has_style_class_name('qsc-custom-spacing'))
                Main.panel.add_style_class_name('qsc-custom-spacing');
        } catch (error) {
            this._reportError('panel-spacing', error, 'Could not apply top-bar spacing');
        }
    }

    _clearSpacing() {
        Main.panel.remove_style_class_name('qsc-custom-spacing');
        if (this._spacingTheme && this._spacingFile)
            this._spacingTheme.unload_stylesheet(this._spacingFile);
        this._spacingTheme = null;
        this._spacingCss = null;
        if (this._spacingFile?.query_exists(null))
            this._spacingFile.delete(null);
        this._spacingFile = null;
        this._spacingDirectory = null;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._spacingTimer)
            GLib.source_remove(this._spacingTimer);
        this._spacingTimer = 0;
        for (const [object, signal] of this._signals)
            object.disconnect(signal);
        this._signals = [];
        this._stopGlobalLayout();
        this._clearSpacing();
    }
}
