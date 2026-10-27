import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    BUTTONS, ORIGINAL_ICONS, ORIGINAL_ITEMS, PANEL_SECTIONS, SYSTEM_TILES,
    editPanelLayout, parseCustomItem,
} from './config.js';

function button(label, callback) {
    const widget = new Gtk.Button({label, valign: Gtk.Align.CENTER});
    widget.connect('clicked', callback);
    return widget;
}

export default class QuickSettingsCustomizerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signals = [];
        const debounces = new Map();
        const watch = (key, callback) => {
            signals.push(settings.connect(`changed::${key}`, callback));
        };
        const debounceInt = (key, value) => {
            const previous = debounces.get(key);
            if (previous)
                GLib.source_remove(previous.id);
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                debounces.delete(key);
                if (settings.get_int(key) !== value)
                    settings.set_int(key, value);
                return GLib.SOURCE_REMOVE;
            });
            debounces.set(key, {id, value});
        };
        window.connect('close-request', () => {
            for (const [key, pending] of debounces) {
                GLib.source_remove(pending.id);
                if (settings.get_int(key) !== pending.value)
                    settings.set_int(key, pending.value);
            }
            debounces.clear();
            for (const signal of signals)
                settings.disconnect(signal);
            signals.length = 0;
            return false;
        });
        window.set_default_size(740, 760);

        const topBarPage = new Adw.PreferencesPage({
            title: 'Separate buttons', icon_name: 'view-more-symbolic',
        });
        window.add(topBarPage);

        const buttonsGroup = new Adw.PreferencesGroup({
            title: 'Separate top-bar buttons',
            description: 'Enable buttons here; position and reorder them on the Top bar layout page. These switches never hide original menu entries or icons.',
        });
        topBarPage.add(buttonsGroup);
        let buttonRows = [];
        const rebuild = () => {
            for (const row of buttonRows)
                buttonsGroup.remove(row);
            buttonRows = [];

            const enabled = settings.get_strv('items');
            const specs = new Map(BUTTONS.map(spec => [spec.id, spec]));
            const powerAlias = enabled.includes('power-profiles');
            if (powerAlias) {
                specs.delete('power');
                specs.set('power-profiles', {
                    ...BUTTONS.find(spec => spec.id === 'power'), id: 'power-profiles',
                });
            }
            for (const encoded of settings.get_strv('custom-items')) {
                try {
                    const spec = parseCustomItem(encoded, command => GLib.shell_parse_argv(command)[1]);
                    specs.set(spec.id, {...spec, encoded});
                } catch (error) {
                    const row = new Adw.ActionRow({
                        title: 'Invalid custom command', subtitle: error.message,
                    });
                    row.add_suffix(button('Remove', () => settings.set_strv(
                        'custom-items', settings.get_strv('custom-items').filter(value => value !== encoded),
                    )));
                    buttonsGroup.add(row);
                    buttonRows.push(row);
                }
            }
            const ordered = [
                ...enabled.filter(id => specs.has(id)),
                ...[...specs.keys()].filter(id => !enabled.includes(id)),
            ];
            for (const id of [...new Set(ordered)]) {
                const spec = specs.get(id);
                const row = new Adw.ActionRow({
                    title: spec.label,
                    subtitle: id === 'sound'
                        ? 'Output and microphone sliders; top-bar scrolling changes output only'
                        : id === 'brightness'
                            ? 'Display and keyboard backlight sliders; top-bar scrolling changes display brightness only'
                            : spec.command || '',
                    use_markup: false,
                });
                if (spec.encoded) {
                    row.add_suffix(button('Edit', () => this._editCommand(window, settings, spec)));
                    row.add_suffix(button('Delete', () => {
                        settings.set_strv('items', settings.get_strv('items').filter(value => value !== id));
                        settings.set_strv('custom-items', settings.get_strv('custom-items')
                            .filter(value => value !== spec.encoded));
                    }));
                }
                const toggle = new Gtk.Switch({
                    active: enabled.includes(id), valign: Gtk.Align.CENTER,
                });
                toggle.connect('notify::active', () => {
                    const items = settings.get_strv('items');
                    if (items.includes(id) === toggle.active)
                        return;
                    settings.set_strv('items', toggle.active
                        ? [...items, id] : items.filter(value => value !== id));
                });
                row.add_suffix(toggle);
                row.activatable_widget = toggle;
                buttonsGroup.add(row);
                buttonRows.push(row);
            }
        };
        watch('items', rebuild);
        watch('custom-items', rebuild);
        rebuild();
        const commands = new Adw.PreferencesGroup({
            title: 'Custom commands',
            description: 'Commands run as your user, without a shell unless explicitly requested.',
        });
        topBarPage.add(commands);
        const add = new Adw.ActionRow({title: 'Add an application or script'});
        add.add_suffix(button('Add', () => this._editCommand(window, settings)));
        commands.add(add);
        this._addPanelLayoutPage(window, settings, watch, debounceInt);

        const originalPage = new Adw.PreferencesPage({
            title: 'Original menu', icon_name: 'preferences-system-symbolic',
        });
        window.add(originalPage);
        const originalBehavior = new Adw.PreferencesGroup({
            title: 'Standard Quick Settings',
            description: 'Replace entries one by one. Settings and power actions remain available as large tiles or compact controls.',
        });
        originalPage.add(originalBehavior);
        const hideOriginal = new Adw.SwitchRow({
            title: 'Hide the entire original system button',
            subtitle: 'Leave this OFF to keep a reduced standard menu',
        });
        settings.bind('replace-quick-settings', hideOriginal, 'active', Gio.SettingsBindFlags.DEFAULT);
        originalBehavior.add(hideOriginal);
        const preset = new Adw.ActionRow({
            title: 'Keep only power and Settings',
            subtitle: 'Hide all entries below without changing your separate buttons or status icons',
        });
        preset.add_suffix(button('Apply', () => {
            settings.set_boolean('replace-quick-settings', false);
            settings.set_strv('hidden-original-items', ORIGINAL_ITEMS.map(spec => spec.id));
        }));
        originalBehavior.add(preset);
        const restore = new Adw.ActionRow({title: 'Restore all original menu entries'});
        restore.add_suffix(button('Restore', () => {
            settings.set_boolean('replace-quick-settings', false);
            settings.set_strv('hidden-original-items', []);
        }));
        originalBehavior.add(restore);
        this._addSystemTilesGroup(window, originalPage, settings, watch);
        this._addVisibilityGroup(
            originalPage, settings, watch, 'hidden-original-items', ORIGINAL_ITEMS,
            'Show in the original menu',
            'ON keeps an entry in GNOME’s menu. OFF hides it there only. Hardware-dependent entries appear only when available.',
        );

        const iconsPage = new Adw.PreferencesPage({
            title: 'Original icons', icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(iconsPage);
        this._addVisibilityGroup(
            iconsPage, settings, watch, 'hidden-original-icons', ORIGINAL_ICONS,
            'Show original status icons',
            'Hide duplicate network or speaker icons inside GNOME’s system button. Separate buttons and menu entries are unaffected. Recording and other privacy indicators are not hidden.',
        );
        const iconActions = new Adw.PreferencesGroup();
        iconsPage.add(iconActions);
        const resetIcons = new Adw.ActionRow({title: 'Restore all original status icons'});
        resetIcons.add_suffix(button('Restore', () => settings.set_strv('hidden-original-icons', [])));
        iconActions.add(resetIcons);
    }

    _addVisibilityGroup(page, settings, watch, key, specs, title, description) {
        const group = new Adw.PreferencesGroup({title, description});
        page.add(group);
        for (const spec of specs) {
            const row = new Adw.SwitchRow({title: spec.label});
            const sync = () => {
                row.active = !settings.get_strv(key).includes(spec.id);
            };
            sync();
            watch(key, sync);
            row.connect('notify::active', () => {
                const hidden = settings.get_strv(key);
                if (hidden.includes(spec.id) === !row.active)
                    return;
                settings.set_strv(key, row.active
                    ? hidden.filter(id => id !== spec.id) : [...hidden, spec.id]);
            });
            group.add(row);
        }
    }

    _addSystemTilesGroup(window, page, settings, watch) {
        const group = new Adw.PreferencesGroup({
            title: 'System controls',
            description: 'Choose Hidden, Compact icon or Large tile for every header control, including Screenshot and Lock. Rename and reorder the large tiles independently.',
        });
        page.add(group);
        const presentation = new Adw.ComboRow({
            title: 'Menu presentation',
            subtitle: 'Compact icons show names on hover and keyboard focus; labeled tiles show names and details directly',
            model: Gtk.StringList.new(['Compact icon grid', 'Labeled tiles']),
        });
        const syncPresentation = () => {
            presentation.selected = settings.get_boolean('compact-system-tiles') ? 0 : 1;
        };
        syncPresentation();
        watch('compact-system-tiles', syncPresentation);
        presentation.connect('notify::selected', () => {
            const compact = presentation.selected === 0;
            if (compact !== settings.get_boolean('compact-system-tiles'))
                settings.set_boolean('compact-system-tiles', compact);
        });
        group.add(presentation);
        const batteryPercentage = new Adw.SwitchRow({
            title: 'Show battery percentage below icon',
            subtitle: 'Live battery level in compact icon-grid mode',
        });
        settings.bind('compact-battery-percentage', batteryPercentage, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('compact-system-tiles', batteryPercentage, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(batteryPercentage);
        let rows = [];
        const refresh = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];
            const enabled = settings.get_strv('system-tiles');
            const hidden = settings.get_strv('hidden-system-controls');
            const labels = settings.get_value('system-tile-labels').deep_unpack();
            const ordered = [
                ...enabled,
                ...SYSTEM_TILES.map(spec => spec.id).filter(id => !enabled.includes(id)),
            ];
            for (const id of ordered) {
                const spec = SYSTEM_TILES.find(item => item.id === id);
                if (!spec)
                    continue;
                const row = new Adw.ActionRow({
                    title: labels[id] || spec.label,
                    subtitle: spec.description,
                    use_markup: false,
                });
                const move = offset => {
                    const items = settings.get_strv('system-tiles');
                    const index = items.indexOf(id);
                    const target = index + offset;
                    if (index < 0 || target < 0 || target >= items.length)
                        return;
                    [items[index], items[target]] = [items[target], items[index]];
                    settings.set_strv('system-tiles', items);
                };
                const index = enabled.indexOf(id);
                const earlier = button('Earlier', () => move(-1));
                earlier.sensitive = index > 0;
                const later = button('Later', () => move(1));
                later.sensitive = index >= 0 && index < enabled.length - 1;
                row.add_suffix(earlier);
                row.add_suffix(later);
                row.add_suffix(button('Rename', () => {
                    const dialog = new Gtk.Dialog({
                        title: `Rename ${spec.label}`, transient_for: window,
                        modal: true, default_width: 380,
                    });
                    dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
                    dialog.add_button('Save', Gtk.ResponseType.OK);
                    const entry = new Gtk.Entry({
                        text: labels[id] || '', placeholder_text: spec.label,
                        max_length: 60, margin_top: 16, margin_bottom: 16,
                        margin_start: 16, margin_end: 16,
                    });
                    dialog.get_content_area().append(entry);
                    dialog.connect('response', (_dialog, response) => {
                        if (response === Gtk.ResponseType.OK) {
                            const current = settings.get_value('system-tile-labels').deep_unpack();
                            if (entry.text.trim())
                                current[id] = entry.text.trim();
                            else
                                delete current[id];
                            settings.set_value('system-tile-labels', new GLib.Variant('a{ss}', current));
                        }
                        dialog.destroy();
                    });
                    dialog.present();
                }));
                const mode = Gtk.DropDown.new_from_strings(['Hidden', 'Compact icon', 'Large tile']);
                mode.valign = Gtk.Align.CENTER;
                mode.selected = enabled.includes(id) ? 2 : hidden.includes(id) ? 0 : 1;
                mode.connect('notify::selected', () => {
                    const selected = mode.selected;
                    const tiles = settings.get_strv('system-tiles');
                    const hiddenControls = settings.get_strv('hidden-system-controls')
                        .filter(item => item !== id);
                    if (selected === 0)
                        hiddenControls.push(id);
                    settings.set_strv('hidden-system-controls', hiddenControls);
                    settings.set_strv('system-tiles', selected === 2
                        ? tiles.includes(id) ? tiles : [...tiles, id]
                        : tiles.filter(item => item !== id));
                });
                row.add_suffix(mode);
                group.add(row);
                rows.push(row);
            }
        };
        watch('system-tiles', refresh);
        watch('system-tile-labels', refresh);
        watch('hidden-system-controls', refresh);
        refresh();
        const resetGroup = new Adw.PreferencesGroup();
        page.add(resetGroup);
        const reset = new Adw.ActionRow({
            title: 'Restore default system tiles',
            subtitle: 'Restore Settings, Power, Battery and Lock tiles; hide Screenshot',
            use_markup: false,
        });
        reset.add_suffix(button('Reset tiles', () => {
            settings.reset('system-tiles');
            settings.reset('system-tile-labels');
            settings.reset('hidden-system-controls');
        }));
        resetGroup.add(reset);
    }

    _addPanelLayoutPage(window, settings, watch, debounceInt) {
        const page = new Adw.PreferencesPage({
            title: 'Top bar layout', icon_name: 'view-grid-symbolic',
        });
        window.add(page);
        const behavior = new Adw.PreferencesGroup({
            title: 'Panel organization',
            description: 'Global ordering is experimental and disabled for stability. It observes and moves third-party panel items; do not use it with another panel organizer.',
        });
        page.add(behavior);
        const manage = new Adw.SwitchRow({
            title: 'Enable experimental global panel ordering',
            subtitle: 'Off by default. The legacy manage-panel-layout setting is ignored; saved placements remain stored.',
        });
        settings.bind('manage-global-panel-layout', manage, 'active', Gio.SettingsBindFlags.DEFAULT);
        behavior.add(manage);
        const position = new Adw.ComboRow({
            title: 'Default section for separate buttons',
            subtitle: 'Uncustomized controls go immediately before original Quick Settings when on the same side',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
        });
        const syncPosition = () => {
            position.selected = PANEL_SECTIONS.indexOf(settings.get_string('panel-box'));
        };
        syncPosition();
        watch('panel-box', syncPosition);
        position.connect('notify::selected', () => {
            const value = PANEL_SECTIONS[position.selected];
            if (value !== settings.get_string('panel-box'))
                settings.set_string('panel-box', value);
        });
        behavior.add(position);
        const reset = new Adw.ActionRow({
            title: 'Reset all item positions',
            subtitle: 'Restore native positions, with separate controls just left of original Quick Settings',
        });
        reset.add_suffix(button('Reset layout', () => {
            settings.set_value('panel-layout', new GLib.Variant('a{sas}', {}));
            settings.set_string('panel-box', 'right');
        }));
        behavior.add(reset);

        const spacing = new Adw.PreferencesGroup({
            title: 'Horizontal spacing',
            description: 'Values are logical pixels and scale with your display. Extra theme padding and margins around status icons are removed while custom spacing is on.',
        });
        page.add(spacing);
        const customSpacing = new Adw.SwitchRow({
            title: 'Use custom spacing',
            subtitle: 'Turn off to restore the current theme exactly',
        });
        settings.bind('custom-panel-spacing', customSpacing, 'active', Gio.SettingsBindFlags.DEFAULT);
        spacing.add(customSpacing);
        for (const [key, title, subtitle] of [
            ['panel-button-padding', 'Button padding per side', 'Main control for reducing large gaps around each panel icon'],
            ['panel-button-spacing', 'Extra gap between buttons', 'Additional space between neighboring panel items'],
            ['panel-indicator-spacing', 'Gap inside grouped indicators', 'Spacing between icons within the original system menu and other groups'],
        ]) {
            const row = new Adw.ActionRow({title, subtitle});
            const spin = Gtk.SpinButton.new_with_range(0, 24, 1);
            spin.valign = Gtk.Align.CENTER;
            spin.width_chars = 3;
            const sync = () => spin.set_value(settings.get_int(key));
            sync();
            watch(key, sync);
            spin.connect('value-changed', () => {
                const value = spin.get_value_as_int();
                if (value !== settings.get_int(key))
                    debounceInt(key, value);
            });
            settings.bind('custom-panel-spacing', row, 'sensitive', Gio.SettingsBindFlags.GET);
            row.add_suffix(spin);
            spacing.add(row);
        }
        const spacingReset = new Adw.ActionRow({title: 'Restore compact spacing defaults'});
        spacingReset.add_suffix(button('Reset spacing', () => {
            for (const key of ['custom-panel-spacing', 'panel-button-padding',
                'panel-button-spacing', 'panel-indicator-spacing'])
                settings.reset(key);
        }));
        spacing.add(spacingReset);

        const inventory = new Adw.PreferencesGroup({
            title: 'Individual panel items',
            description: 'When global ordering is deliberately enabled, each section is listed left to right. Stored placements remain saved while live third-party management is off.',
        });
        page.add(inventory);
        const disabledNote = new Adw.ActionRow({
            title: 'Global ordering is disabled',
            subtitle: 'Third-party panel items are not observed or moved. Saved placements will apply only after explicit opt-in.',
        });
        const syncDisabledNote = () => {
            disabledNote.visible = !settings.get_boolean('manage-global-panel-layout');
        };
        syncDisabledNote();
        watch('manage-global-panel-layout', syncDisabledNote);
        inventory.add(disabledNote);
        const rows = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        inventory.add(rows);
        let snapshot = [];
        const change = (id, section, offset = 0) => {
            if (!settings.get_boolean('manage-global-panel-layout'))
                return;
            const layout = editPanelLayout(
                settings.get_value('panel-layout').deep_unpack(), snapshot, id, section, offset,
            );
            settings.set_value('panel-layout', new GLib.Variant('a{sas}', layout));
        };
        const refresh = () => {
            while (rows.get_first_child())
                rows.remove(rows.get_first_child());
            snapshot = JSON.parse(settings.get_string('panel-items'));
            if (!snapshot.length) {
                rows.append(new Adw.ActionRow({
                    title: 'No live panel items yet',
                    subtitle: 'Enable Quick Settings Customizer, then reopen this page after GNOME has loaded it.',
                }));
                return;
            }
            for (const section of PANEL_SECTIONS) {
                const members = snapshot.filter(item => item.section === section);
                const heading = new Gtk.Label({
                    label: `${section[0].toUpperCase()}${section.slice(1)}`, xalign: 0,
                    margin_top: 12, margin_bottom: 4,
                });
                heading.add_css_class('heading');
                rows.append(heading);
                members.forEach((item, index) => {
                    const row = new Adw.ActionRow({
                        title: item.label, use_markup: false,
                        subtitle: `${item.id}${item.visible ? '' : ' (currently hidden)'}${item.movable ? '' : ' (no stable panel identifier)'}`,
                    });
                    const earlier = button('Move left', () => change(item.id, section, -1));
                    earlier.sensitive = index > 0 && item.movable;
                    const later = button('Move right', () => change(item.id, section, 1));
                    later.sensitive = index < members.length - 1 && item.movable;
                    row.add_suffix(earlier);
                    row.add_suffix(later);
                    const select = Gtk.DropDown.new_from_strings(['Left', 'Center', 'Right']);
                    select.valign = Gtk.Align.CENTER;
                    select.selected = PANEL_SECTIONS.indexOf(section);
                    select.sensitive = item.movable;
                    select.connect('notify::selected', () => {
                        const target = PANEL_SECTIONS[select.selected];
                        if (target !== section && settings.get_boolean('manage-global-panel-layout'))
                            change(item.id, target);
                    });
                    row.add_suffix(select);
                    rows.append(row);
                });
            }
        };
        watch('panel-items', refresh);
        settings.bind('manage-global-panel-layout', inventory, 'sensitive', Gio.SettingsBindFlags.GET);
        refresh();
    }

    _editCommand(window, settings, existing = null) {
        const dialog = new Gtk.Dialog({
            title: existing ? 'Edit command' : 'Add command',
            transient_for: window, modal: true, default_width: 480,
        });
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Save', Gtk.ResponseType.OK);
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 10,
            margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16,
        });
        const label = new Gtk.Entry({placeholder_text: 'Label', text: existing?.label || ''});
        const command = new Gtk.Entry({
            placeholder_text: 'Command (for example: gnome-calculator)', text: existing?.command || '',
        });
        const icon = new Gtk.Entry({
            placeholder_text: 'Icon name (optional)', text: existing?.icon || '',
        });
        const errorLabel = new Gtk.Label({wrap: true, xalign: 0, visible: false});
        errorLabel.add_css_class('error');
        for (const child of [label, command, icon, errorLabel])
            box.append(child);
        dialog.get_content_area().append(box);
        dialog.connect('response', (_dialog, response) => {
            if (response !== Gtk.ResponseType.OK) {
                dialog.destroy();
                return;
            }
            const spec = {
                id: existing?.id || `custom-${GLib.uuid_string_random()}`,
                label: label.text.trim(), command: command.text.trim(),
                icon: icon.text.trim() || 'applications-system-symbolic',
            };
            const encoded = JSON.stringify(spec);
            try {
                parseCustomItem(encoded, value => GLib.shell_parse_argv(value)[1]);
            } catch (error) {
                errorLabel.label = error.message;
                errorLabel.visible = true;
                return;
            }
            const customs = settings.get_strv('custom-items');
            settings.set_strv('custom-items', existing
                ? customs.map(value => value === existing.encoded ? encoded : value)
                : [...customs, encoded]);
            if (!existing)
                settings.set_strv('items', [...settings.get_strv('items'), spec.id]);
            dialog.destroy();
        });
        dialog.present();
    }
}
