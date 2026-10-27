export const BUTTONS = [
    {id: 'wifi', label: 'Wi-Fi', icon: 'network-wireless-symbolic'},
    {id: 'bluetooth', label: 'Bluetooth', icon: 'bluetooth-active-symbolic'},
    {id: 'sound', label: 'Sound', icon: 'audio-volume-high-symbolic'},
    {id: 'power', label: 'Power profiles', icon: 'power-profile-balanced-symbolic'},
    {id: 'night-light', label: 'Night Light', icon: 'weather-clear-night-symbolic'},
    {id: 'dark-mode', label: 'Dark Mode', icon: 'display-brightness-symbolic'},
    {id: 'airplane', label: 'Airplane Mode', icon: 'airplane-mode-symbolic'},
    {id: 'brightness', label: 'Brightness', icon: 'display-brightness-symbolic'},
    {id: 'camera', label: 'Camera', icon: 'camera-photo-symbolic'},
    {id: 'location', label: 'Location Services', icon: 'find-location-symbolic'},
    {id: 'auto-rotate', label: 'Auto Rotate', icon: 'rotation-allowed-symbolic'},
];

export const SYSTEM_TILES = [
    {id: 'settings', label: 'Settings', icon: 'emblem-system-symbolic',
        description: 'Replaces the small Settings gear'},
    {id: 'power', label: 'Power options', icon: 'system-shutdown-symbolic',
        description: 'Replaces the small shutdown button; keeps GNOME confirmations'},
    {id: 'battery', label: 'Battery & Power', icon: 'battery-good-symbolic',
        description: 'Replaces the compact battery pill; shows battery and power profiles'},
    {id: 'screenshot', label: 'Screenshot', icon: 'screenshooter-symbolic',
        description: 'Opens the standard screenshot and screen-recording tool'},
    {id: 'lock', label: 'Lock screen', icon: 'system-lock-screen-symbolic',
        description: 'Locks your session using GNOME’s standard lock action'},
];

export const ORIGINAL_ITEMS = [
    {id: 'wifi', label: 'Wi-Fi', path: '_network._wirelessToggle'},
    {id: 'wired', label: 'Ethernet', path: '_network._wiredToggle'},
    {id: 'vpn', label: 'VPN', path: '_network._vpnToggle'},
    {id: 'mobile', label: 'Mobile broadband', path: '_network._modemToggle'},
    {id: 'bluetooth-tethering', label: 'Bluetooth tethering', path: '_network._btToggle'},
    {id: 'bluetooth', label: 'Bluetooth', path: '_bluetooth.quickSettingsItems.0'},
    {id: 'output', label: 'Output volume', path: '_volumeOutput.quickSettingsItems.0'},
    {id: 'input', label: 'Microphone', path: '_volumeInput.quickSettingsItems.0'},
    {id: 'brightness', label: 'Brightness', path: '_brightness.quickSettingsItems.0'},
    {id: 'power', label: 'Power profiles', path: '_powerProfiles.quickSettingsItems.0'},
    {id: 'night-light', label: 'Night Light', path: '_nightLight.quickSettingsItems.0'},
    {id: 'dark-mode', label: 'Dark Mode', path: '_darkMode.quickSettingsItems.0'},
    {id: 'backlight', label: 'Keyboard backlight', path: '_backlight.quickSettingsItems.0'},
    {id: 'airplane', label: 'Airplane Mode', path: '_rfkill.quickSettingsItems.0'},
    {id: 'auto-rotate', label: 'Auto Rotate', path: '_autoRotate.quickSettingsItems.0'},
    {id: 'camera', label: 'Camera controls', path: '_camera.quickSettingsItems.0'},
    {id: 'location', label: 'Location controls', path: '_location.quickSettingsItems.0'},
    {id: 'remote-access', label: 'Remote access controls', path: '_remoteAccess.quickSettingsItems.0'},
    {id: 'thunderbolt', label: 'Thunderbolt', path: '_thunderbolt.quickSettingsItems.0'},
    {id: 'unsafe-mode', label: 'Unsafe mode', path: '_unsafeMode.quickSettingsItems.0'},
    {id: 'background-apps', label: 'Background apps', path: '_backgroundApps.quickSettingsItems.0'},
];

export const ORIGINAL_ICONS = [
    {id: 'network', label: 'Network (Wi-Fi, Ethernet and VPN)', path: '_network'},
    {id: 'bluetooth', label: 'Bluetooth', path: '_bluetooth'},
    {id: 'sound', label: 'Output volume', path: '_volumeOutput'},
    {id: 'battery', label: 'Battery and power', path: '_system'},
    {id: 'brightness', label: 'Brightness', path: '_brightness'},
    {id: 'power', label: 'Power profiles', path: '_powerProfiles'},
    {id: 'night-light', label: 'Night Light', path: '_nightLight'},
    {id: 'dark-mode', label: 'Dark Mode', path: '_darkMode'},
    {id: 'backlight', label: 'Keyboard backlight', path: '_backlight'},
    {id: 'airplane', label: 'Airplane Mode', path: '_rfkill'},
    {id: 'auto-rotate', label: 'Auto Rotate', path: '_autoRotate'},
];

export function resolvePath(object, path) {
    return path.split('.').reduce((value, part) => value?.[part], object);
}

export function buttonSources(quickSettings, id) {
    const ids = id === 'sound' ? ['output', 'input']
        : id === 'brightness' ? ['brightness', 'backlight'] : [id];
    return ids.map(sourceId => {
        const spec = ORIGINAL_ITEMS.find(item => item.id === sourceId);
        return spec ? resolvePath(quickSettings, spec.path) : null;
    });
}

export function parseCustomItem(encoded, parseCommand) {
    const item = JSON.parse(encoded);
    if (!item || typeof item.id !== 'string' || !/^custom-[\w-]+$/.test(item.id) ||
        typeof item.label !== 'string' || !item.label.trim() ||
        typeof item.command !== 'string' || !item.command.trim())
        throw new Error('Custom commands need a custom ID, label and command.');

    const argv = parseCommand(item.command);
    if (!argv.length)
        throw new Error('The command is empty.');

    return {...item, label: item.label.trim(), argv};
}

export const PANEL_SECTIONS = ['left', 'center', 'right'];

export function normalizePanelLayout(value) {
    const layout = {left: [], center: [], right: []};
    const seen = new Set();
    for (const [section, ids] of Object.entries(value)) {
        if (!PANEL_SECTIONS.includes(section) || !Array.isArray(ids))
            throw new Error('Panel layout must contain Left, Center or Right lists.');
        for (const id of ids) {
            if (typeof id !== 'string' || seen.has(id))
                throw new Error('Each top-bar item must have a unique string identifier.');
            seen.add(id);
            layout[section].push(id);
        }
    }
    return layout;
}

export function stablePanelId(role, applicationId = '') {
    const match = /^appindicator-:\d+\.\d+@(\/.*)$/.exec(role);
    if (!match)
        return role;
    const path = match[1];
    if (path === '/StatusNotifierItem' || path === '/org/kde/StatusNotifierItem') {
        return applicationId
            ? `appindicator-app:${encodeURIComponent(applicationId)}@${path}` : role;
    }
    return `appindicator-path:${path}`;
}

export function migratePanelLayout(value, aliases = {}) {
    const layout = normalizePanelLayout(value);
    const seen = new Set();
    for (const section of PANEL_SECTIONS) {
        layout[section] = layout[section].map(id => aliases[id] || stablePanelId(id))
            .filter(id => {
                if (seen.has(id))
                    return false;
                seen.add(id);
                return true;
            });
    }
    return layout;
}

export function editPanelLayout(saved, snapshot, id, targetSection, offset = 0) {
    const layout = normalizePanelLayout(saved);
    const liveIds = new Set(snapshot.map(item => item.id));
    const current = Object.fromEntries(PANEL_SECTIONS.map(section => [
        section, snapshot.filter(item => item.section === section).map(item => item.id),
    ]));
    const section = PANEL_SECTIONS.find(box => current[box].includes(id));
    if (!section || !PANEL_SECTIONS.includes(targetSection))
        throw new Error('The selected panel item or section is unavailable.');
    const index = current[section].indexOf(id);
    current[section].splice(index, 1);
    const position = section === targetSection
        ? Math.max(0, Math.min(index + offset, current[section].length))
        : current[targetSection].length;
    current[targetSection].splice(position, 0, id);
    for (const box of PANEL_SECTIONS)
        current[box].push(...layout[box].filter(item => !liveIds.has(item)));
    return current;
}
