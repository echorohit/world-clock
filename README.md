# Weltzeituhr — World Clock (Chrome extension)

A world clock modeled on the Weltzeituhr at Alexanderplatz, Berlin: a 24-sided column whose
hour ring shows the current hour in every time zone, topped by the atom-model sculpture.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension and click its icon

## Use

- **Add a city:** type in the search box (≈130 curated cities plus every IANA time zone), then pick with ↑/↓ + Enter or click.
- **The column:** faces holding your cities glow orange; faint names are the column's own reference plaques.
  Drag or scroll to turn it; click a city in the list to turn its face to the front.
- **List:** local time, day/night, Today/Tomorrow/Yesterday, UTC offset and the difference from your time.
  Drag rows to reorder, × to remove.
- **Swiss clocks:** two SBB-style railway clocks; pick each one's city from the dropdown under it (any city in your list).
  The red second hand sweeps in 58.5 s, rests at 12, then the minute hand jumps — like the real thing.
- **12h / 24h:** toggle next to the UTC readout.
- **New tab:** every new tab shows the clock at full size. Chrome asks once whether to keep the change; choose **Keep it**.
  To go back to Chrome's default new tab, remove the `chrome_url_overrides` block from `manifest.json` and reload the extension.

Cities and settings sync through `chrome.storage.sync`.
