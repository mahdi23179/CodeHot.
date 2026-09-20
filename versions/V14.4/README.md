# V14.4 — Revert orange chrome; Export button matches others

## User feedback

V14.3 over-applied orange. User only asked for the Export Project button to match the other project buttons (i.e. be dark grey, not orange). V14.3 incorrectly made every tab bar icon and every scene header button orange too.

## Reverted

- .sh-tab-btn color back to #8b949e (grey), removed orange tint and hover
- .sh-tab-btn.sh-active still orange (unchanged from before V14.3)
- .sc-header-button background back to #2a2a2a, border #444, text #e0e0e0
- .sc-header-button.sc-active still #ff6b35 (unchanged from before V14.3)
- Export Project button: removed .st-primary class so it renders with the default .st-settings-button style (dark grey, white text) - matches New Project and Import Project File buttons

## Kept from V14.3

- Blue sky (#87ceeb) + white ground in exported HTML
- HemisphereLight + Fog in exported scene

## File

- کدهات V14.html (1,393,048 bytes)

## Commit

bbca22f on 2026-09-18.
