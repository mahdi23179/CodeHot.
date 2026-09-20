# V14.1 — Canvas-size button grid + spread starter objects

## Bugs fixed (reported by user)

1. Canvas-size buttons row was misaligned: 7 buttons in 2 columns left the 7th button alone in a row. Switched to 3 columns and made the lone 7th button (1:1) span the full row via .st-size-full class.
2. Exported HTML showed only one overlapping blob in the center because all starter objects were placed at (0,0,0) and stacked. Fixed in two places:
   - createStarterObjects() now places the 4 primitives at distinct positions (-2.5, 0, +2.5 on X/Z) so new projects spread immediately.
   - addObject() now accepts an optional initial position argument.
   - Player buildObjects() applies a default circular spread when it detects multiple objects sharing (0,0,0), so old V13/V14 projects also render correctly in exports without any user action.

## Verified in browser

- 4 starter objects now spawn at distinct positions
- Exported HTML shows 3-4 visible objects (sphere, cylinder, cone + cube bouncing)
- Canvas-size buttons row is now a balanced 3+3+1 grid with 1:1 spanning full width

## File

- کدهات V14.html (1,387,155 bytes)

## Commit

bf54918 on 2026-09-18.
