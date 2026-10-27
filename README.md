# Quick Settings Customizer

A GNOME Shell extension for customizing Quick Settings and related top-bar controls.

> **Status:** experimental
> **Supported desktop:** GNOME Shell 46
> **Tested target:** Ubuntu 24.04

## Features

- Separate top-bar controls for:
- Wi-Fi
- Bluetooth
- Sound
- Display brightness
- Keyboard backlight
- Wi-Fi networks shown directly in the Wi-Fi popup.
- Paired Bluetooth devices shown directly in the Bluetooth popup.
- Output and microphone sliders in the Sound popup.
- Display and keyboard-backlight sliders in the Brightness popup.
- Native GNOME volume and brightness on-screen indicators.
- Large or compact system controls for:
- Settings
- Power
- Battery
- Screenshot
- Lock screen
- Live battery percentage below the compact Battery icon.
- Independent visibility controls for original Quick Settings entries.
- Independent visibility controls for original top-bar status icons.
- Custom command buttons for launching applications or scripts.
- Configurable panel spacing.
- Optional per-item panel placement and ordering.

## Stability mode

Global reordering of third-party panel extensions is **disabled by default**.

This is intentional. The extension normally manages only its own controls and does not observe or move unrelated panel extensions. An experimental global-layout option is available in Preferences for users who understand the risks of interacting with other panel-organizing extensions.

Do not enable this option together with another extension that also rearranges the top bar.

## Preferences

Open Preferences from Extension Manager, or run:

```bash
gnome-extensions prefs quick-settings-customizer@gabriel-silva_tkv.github.io