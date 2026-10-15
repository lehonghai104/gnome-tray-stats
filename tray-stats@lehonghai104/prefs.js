import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PANEL_BOXES = ['left', 'center', 'right'];

export default class TrayStatsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        window.add(page);

        const showGroup = new Adw.PreferencesGroup({
            title: _('Show in Top Bar'),
            description: _('Everything is always listed in the menu; these control the top bar.'),
        });
        page.add(showGroup);
        for (const [key, title] of [
            ['show-cpu', _('CPU usage')],
            ['show-memory', _('Memory usage')],
            ['show-devices', _('Device batteries')],
        ]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            showGroup.add(row);
        }

        const behaviourGroup = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviourGroup);
        behaviourGroup.add(this._spinRow(settings, 'refresh-interval',
            _('Refresh interval'), _('Seconds between CPU and memory updates'), 1, 60));
        behaviourGroup.add(this._spinRow(settings, 'low-battery-threshold',
            _('Low battery warning'), _('Highlight devices at or below this percentage'), 0, 100));

        const positionGroup = new Adw.PreferencesGroup({title: _('Position')});
        page.add(positionGroup);

        const boxRow = new Adw.ComboRow({
            title: _('Top bar section'),
            model: Gtk.StringList.new([_('Left'), _('Center'), _('Right')]),
            selected: PANEL_BOXES.indexOf(settings.get_string('panel-box')),
        });
        boxRow.connect('notify::selected', () =>
            settings.set_string('panel-box', PANEL_BOXES[boxRow.selected]));
        positionGroup.add(boxRow);

        positionGroup.add(this._spinRow(settings, 'panel-index',
            _('Index within section'), _('0 places it first'), 0, 50));
    }

    _spinRow(settings, key, title, subtitle, min, max) {
        const row = Adw.SpinRow.new_with_range(min, max, 1);
        row.set({title, subtitle});
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
