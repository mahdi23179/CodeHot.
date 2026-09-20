# V14.5 — Real runtime engine in export + follow-cam in Play mode + blue editor sky

## Critical fix: scripts now actually execute in exported HTML

In V14.0-V14.4 the exported HTML player called behavior.update.call({}, ctx, self) which lost the per-behavior 'this' state that scripts rely on. The user reported: "خروجی که من گرفتم اجرا نمی‌شه، توپ تکان نمی‌خوره".

### Root cause

The exported build's player script had three bugs compared to the real CodeHot RuntimeEngine:

1. **Lost `this` state**: `behavior.update.call({}, ctx, self)` passed an empty object as `this`, so any state a script stashed on `this` during start() was gone by update(). The editor runtime uses `behaviorStates.get(id)` as `this` for every lifecycle phase.
2. **Unstable `self` wrapper**: `makeObjectApi(id)` returned a fresh wrapper on every call, so `self.__baseY = self.position.y` set in start() was lost by the time update() ran. The editor runtime caches one stable wrapper per behavior id in `behaviorSelfSelf`.
3. **No real timestamp-based delta**: the player used `CLOCK.getDelta()` (Three.js clock) which is fine for render loops but doesn't match the editor's `RUNTIME.lastTimestamp` semantics; behavior deltas were slightly off.

### Fix

The exported player now mirrors the editor's RuntimeEngine exactly:

- `BEHAVIORS` is a `Map<id, {start, update, stop}>` (not an array)
- `BEHAVIOR_STATES` is a `Map<id, {}>` - the per-behavior `this`
- `BEHAVIOR_SELF` is a `Map<id, live-backed wrapper>` - cached so scripts can stash fields
- `normalizeScriptSource()` is ported verbatim from RuntimeEngine
- `createScriptFactory()` and `normalizeBehavior()` mirror the editor
- `runLifecycle(phase)` calls `handler.call(state, context, object)` - state from BEHAVIOR_STATES
- `update(timestamp)` computes delta from rAF timestamp, clamps to 0.05s, advances RUNTIME.time/frame
- `makeObjectApi()` uses `Object.defineProperty` for live-backed position/rotation/scale getters
- `makeCameraApi()` for `__codehot_camera__` scripts
- Full `CodeHot` runtime API exposed: `getObject`, `getObjectByName`, `getObjects`, `registerBehavior`, etc.

### Verified

Tested with a bounce+rotate script on Cube: position.y oscillates -1.68 to +1.86 (sin wave), rotation.y increments by 1.5*delta every frame. Visual frame comparison confirms the cube is bouncing and rotating while the other 3 primitives stay static.

## Follow-cam now active during Play mode

The editor's `updateFollowCam()` previously returned early when `RUNTIME_STATE.isPlaying` was true, so the camera snapped back to (10,8,10) the moment Play started. User explicitly asked: "وقتی play می‌کنیم، باز هم باید دوربینمون دنبال object باشه، نه دوربین برگرده به بالا و به جای اصلیش".

Fix: removed the `if (RUNTIME_STATE.isPlaying) return;` early return. Follow-cam now trails the target during Play too.

Verified: during Play, camera position lerps to (cube.pos + offset) every frame, offset (0, 4, 7) preserved.

## Editor scene now has blue sky

User: "تو حالت عادی کدهات یک پس‌زمینه‌ی آسمون باید داشته باشه. چون الان پس‌زمینه‌اش سیاهه بک‌گراند و اصلاً دیده نمیشه".

- Editor `setupScene()` background changed from `0x0f0f0f` (near-black) to `0x87ceeb` (daytime blue)
- Added `THREE.Fog(0x87ceeb, 40, 140)` so distant objects fade into the sky
- Added `HemisphereLight(0x87ceeb, 0x0a0a0a, 0.35)` so the sky/ground tint feels grounded
- Grid + ground plane stay dark so the checkerboard pattern remains visible

## File

- کدهات V14.html (1,402,187 bytes)

## Commit

This V14.5 commit.
