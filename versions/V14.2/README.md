# V14.2 — Fix Export Project button (bottom action sheet)

## Bug reported by user

The Export Project popover was broken. It used position:absolute with bottom:100% inside a wrapper that wasn't position:relative, so it anchored to the viewport and landed in the top-left corner of the screen, partially overlapping the page header. The two option buttons inside (HTML and ZIP) had inconsistent internal spacing and tiny 10px descriptions that wrapped awkwardly on mobile.

## Fix

- Moved the popover out of the Settings scroll container and placed it at the body root, so position:fixed anchors cleanly to the viewport.
- Switched from a tiny inline popover to a proper bottom action sheet that slides up from the bottom of the screen with a dark backdrop.
- Sheet uses left:0, right:0, margin:auto for centering (no transform tricks that could fight with the slide-in animation).
- Added an explicit Cancel button and Escape-key + tap-outside dismiss.
- Each option button now has a 22px SVG icon, a 13px bold label, and a 11px description with proper word-break for long Persian text.
- Body overflow is hidden while the sheet is open so the background doesn't scroll.
- Localized labels are refreshed at every render() pass.

## File

- کدهات V14.html (1,392,608 bytes)

## Commit

367a328 on 2026-09-18.
