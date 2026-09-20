# V14.0 — Project Export + Canvas Size + Follow-Cam + Emoji Removal

Initial V14 release, built on top of V13.

## What's new

- Export Project button in Settings, with a popover offering HTML and ZIP options.
- Standalone HTML export: ships a self-contained .html file with Three.js r128 embedded verbatim, scene state inlined as JSON, no CodeHot editor UI. Opens directly in Chrome and runs the user's scripts on load.
- ZIP export: bundles index.html + assets/ + scene.json via a tiny in-memory STORE writer (no external JSZip dependency).
- Import Project button (previously disabled in V13 "Open Project - coming soon") now accepts .html / .zip / .json.
- 7 canvas size presets: Free, 3:4, 9:16, 16:9, 19:6 horizontal, 6:19 vertical, 1:1 - with live editor viewport frame preview.
- Follow-cam toggle: when armed via Focus Selected, the editor camera trails the target object from behind at a fixed offset.
- All emojis removed.

## File

- کدهات V14.html - the complete single-file editor (1,384,135 bytes, 17,545 lines).

## Commit

8c47af2 on 2026-09-18.
