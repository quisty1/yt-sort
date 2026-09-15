# yt-sort

`yt-sort` is a small Chrome extension for organizing YouTube playlists by video
duration. It works with playlists you can edit, including **Watch Later**, and
runs entirely in the active YouTube tab.

## What it does

- sorts the complete playlist from shortest to longest or longest to shortest;
- optionally keeps videos outside a selected duration range at the end;
- shows the number of videos, total watch time, and average duration;
- detects private, deleted, and otherwise unavailable videos;
- removes unavailable entries only after a separate confirmation;
- exports the current playlist order to CSV;
- verifies that YouTube accepted the new order before reporting success;
- supports YouTube's light and dark themes.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or another Chromium-based browser.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension` directory from this repository.

## Use

1. Sign in to YouTube.
2. Open a playlist you own or open **Watch Later**.
3. Set YouTube's built-in playlist order to **Manual**.
4. Choose **Shortest first** or **Longest first** in the extension panel.
5. Click **Sort playlist**.

The extension reads the full playlist, calculates the desired order, applies
the changes, and checks the saved order. By default, the page then reloads so
the result is immediately visible.

Keep the playlist in **Manual** mode after sorting. Selecting one of YouTube's
automatic ordering modes can replace the custom order.

## Additional tools

Open **More** in the panel to:

- export the playlist as a CSV file;
- copy the operation log;
- change sorting and diagnostic settings.

When unavailable videos are detected, use **Remove unavailable** to review the
entries first. Removal is permanent for that playlist and starts only after
confirmation.

## Settings

- **Refresh the page after sorting** — displays the server-side order after a
  successful run.
- **Only sort videos within a duration range** — sorts matching videos and
  places the rest at the end.
- **Delay between actions** — controls fallback drag-and-drop pacing.
- **Actions per request** — controls the YouTube request batch size.
- **Missing-video tolerance** — allows a run to continue when YouTube reports
  more entries than it returns or renders.

Settings are stored in the current browser profile. The operation log is kept
only for the current tab and survives the automatic post-sort reload.

## How it works

The content script runs in the YouTube page context. It prefers YouTube's own
playlist endpoint for fast server-side reordering and falls back to verified
drag-and-drop when that endpoint is unavailable. Both paths re-read the current
order and stop on navigation, cancellation, or failed verification.

## Limitations

- Only playlists editable by the signed-in account can be reordered.
- Sorting depends on YouTube's current page structure and internal playlist
  requests, which YouTube may change without notice.
- Live streams and entries without a readable duration are placed at the end.
- Very large playlists or temporary YouTube throttling may require another run.

## Privacy

The extension has no external service or analytics. It reads and updates the
open playlist through YouTube and stores preferences locally in the browser.

## Project files

- `extension/manifest.json` — Chrome Manifest V3 configuration.
- `extension/yt-sort.js` — playlist loading, sorting, verification, cleanup,
  export, and user interface logic.
- `extension/icons/` — extension icons.
