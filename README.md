# Tray Stats

A GNOME Shell extension that adds a top-bar indicator showing:

- **CPU** usage (from `/proc/stat`)
- **RAM** usage (`MemTotal - MemAvailable`, from `/proc/meminfo`)
- **Battery level of wireless devices**: Bluetooth headsets, mice and keyboards, plus
  vendor receivers such as Logitech Lightspeed/Unifying. These come from UPower, which
  already collects BlueZ and HID++ batteries.

```
[cpu] 8%   [ram] 37%   [mouse] Full   [keyboard] 50%
```

Click the indicator to open a menu with usage bars, load average, used/total memory and
swap, each device's charge and charging state, and shortcuts to System Monitor, Bluetooth
Settings and the extension's preferences.

Tested on Ubuntu 24.04 / GNOME Shell 46 (Wayland). The metadata also declares 45, 47 and 48.

## Install

```sh
./install.sh            # copies to ~/.local/share/gnome-shell/extensions/
./install.sh --link     # symlink instead, handy while editing the code
./install.sh --uninstall
```

On Wayland, GNOME only picks up newly installed extensions at login, so **log out and
back in** after the first install. After that you can toggle it in the Extensions app.

## Settings

Open them from the menu (**Preferences**) or with `gnome-extensions prefs tray-stats@lehonghai104`:

- Choose which of CPU, memory and devices appear in the top bar. The menu always lists all of them.
- Refresh interval for CPU/RAM (default 2 s). Battery updates are event-driven and don't poll.
- Low-battery threshold (default 20%). Devices at or below it are shown in red, as is CPU/RAM at 90% or more.
- Top bar section (left/center/right) and position within it.

## Notes

- **A Bluetooth headset is connected but doesn't appear.** Many headphones, such as
  Sony WH-1000XM4, report battery through BlueZ's battery-provider API. That API is still
  marked experimental, so enable it, then reconnect the headset:

  ```sh
  sudo sed -i 's/^#\?\s*Experimental\s*=.*/Experimental = true/' /etc/bluetooth/main.conf
  sudo systemctl restart bluetooth
  ```

  You can check what UPower sees with `upower -d`. Anything listed there with a
  battery will show up in the widget.
- Some devices only report a coarse level instead of a percentage, such as the AA-powered
  mouse. For these, UPower invents a 100% value (marked "should be ignored") and
  a "fully charged" state, even though the kernel reports the battery as discharging. The
  widget ignores both. It shows only the level the mouse itself reports (`Full`, `High`,
  `Normal`, `Low` or `Critical`), with no bar, and turns red at `Low`/`Critical`.
- Logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep tray-stats`

## Layout

```
tray-stats@lehonghai104/
  extension.js   panel button, popup menu, refresh timer
  sources.js     CPU/RAM sampler and UPower device monitor (GLib/Gio only, runnable in plain gjs)
  prefs.js       Adwaita preferences window
  stylesheet.css
  icons/         CPU and RAM symbolic icons
  schemas/       GSettings schema
```
