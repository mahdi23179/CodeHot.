import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';

const PORT = 8098;
const htmlPath = new URL('./index.html', import.meta.url).pathname;
let server;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
      if (pathname === '/codehot-agent-protocol.js') {
        const protocolPath = new URL('./codehot-agent-protocol.js', import.meta.url).pathname;
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(fs.readFileSync(protocolPath, 'utf8'));
        return;
      }
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(PORT, '0.0.0.0', () => resolve());
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await startServer();
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-web-security', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--use-angle=swiftshader', '--use-cmd-decoder=passthrough', '--enable-webgl', '--ignore-gpu-blocklist']
});
const page = await browser.newPage();
const consoleMsgs = [];
page.on('console', msg => consoleMsgs.push(`[${msg.type()}] ${msg.text().slice(0, 250)}`));
page.on('pageerror', err => consoleMsgs.push(`[pageerror] ${err.message.slice(0, 400)}`));

await page.goto(`http://localhost:${PORT}`, { waitUntil: 'load', timeout: 45000 });
await sleep(5000);

function log(name, pass, detail) {
  console.log((pass ? 'PASS' : 'FAIL') + ' - ' + name + (detail !== undefined ? ' :: ' + detail : ''));
}

// ── Boot state ───────────────────────────────────────────────
const boot = await page.evaluate(() => {
  const out = { hasCanvas: !!document.querySelector('#sc-viewport canvas') };
  out.manager = !!window._sceneEditorManager;
  out.managerInit = window._sceneEditorManager ? !!window._sceneEditorManager.initialized : null;
  out.objects = window.SCENE_STATE ? window.SCENE_STATE.objects.map(o => o.name + ':' + o.type) : [];
  out.agent = !!(window.CodeHotAgent && window.CodeHotLocalAgent && window.CodeHotTools && window.AIContext && window.handleUserSubmit);
  out.runtimeApi = !!window.CodeHotRuntime;
  out.animStore = !!window.CodeHotAnimationStore;
  out.sceneApi = !!window.CodeHotScene;
  return out;
});
log('boot: WebGL canvas', boot.hasCanvas);
log('boot: scene manager initialized', boot.manager && boot.managerInit, JSON.stringify({ manager: boot.manager, init: boot.managerInit }));
log('boot: starter objects', boot.objects.length >= 4, boot.objects.join(', '));
log('boot: agent globals', boot.agent);

// ── Context snapshot ─────────────────────────────────────────
const ctx = await page.evaluate(() => {
  const c = window.CodeHotLocalAgent.getContext();
  return { total: c.totalObjects, names: c.objects.map(o => o.name).slice(0, 8), selected: c.selected ? c.selected.name : null, lang: c.language, runtimePlaying: c.runtime.isPlaying, camera: !!c.camera, assets: c.totalAssets };
});
log('context: snapshot shape', ctx.total >= 4 && typeof ctx.lang === 'string', JSON.stringify(ctx).slice(0, 220));

// ── Resolution: explicit name + pronoun/selection ───────────
const resolve = await page.evaluate(() => {
  const c = window.CodeHotLocalAgent.getContext();
  const byName = window.AIContext.resolveTarget('Cube رو ببر بالا', c);
  // select Cube first, then resolve pronoun
  window.SCENE_STATE.selectedId = byName && byName.id ? byName.id : null;
  const c2 = window.CodeHotLocalAgent.getContext();
  const pronoun = window.AIContext.resolveTarget('این رو بزرگ‌تر کن', c2);
  return { byName: byName ? byName.name : null, pronoun: pronoun ? pronoun.name : null };
});
log('resolve: explicit name', resolve.byName === 'Cube', resolve.byName);
log('resolve: pronoun -> selection', resolve.pronoun === 'Cube', resolve.pronoun);

// ── Plan classification: edit-time vs runtime ───────────────
const plans = await page.evaluate(() => {
  const t = (msg) => {
    const p = window.CodeHotLocalAgent.plan(msg);
    return { intent: p.intent, tool: p.tool, params: p.params || null };
  };
  return {
    editAbs: t('Cube رو روی Y=5 بذار'),
    editUp: t('Cube رو ببر بالا'),
    editRotate: t('Cube رو 90 درجه بچرخون'),
    editScale: t('Cube رو بزرگ‌تر کن'),
    runtimeMove: t('وقتی Play شد Cube حرکت کنه'),
    runtimeRotateEvery: t('Cube هر 3 ثانیه بچرخه'),
    jump: t('وقتی Space زده شد Cube بپره'),
    rename: t('اسم Cube رو Player کن'),
    create: t('یه کره به اسم Ball بساز'),
    del: t('Cube رو حذف کن'),
    cameraFollow: t('دوربین موقع Play دنبال Cube باشه'),
    unknown: t('صبح بخیر!')
  };
});
log('plan: edit abs Y=5', plans.editAbs.intent === 'transform' && plans.editAbs.tool === 'SET_TRANSFORM' && plans.editAbs.params && plans.editAbs.params.change && plans.editAbs.params.change.position && plans.editAbs.params.change.position.y === 5, JSON.stringify(plans.editAbs));
log('plan: edit move up', plans.editUp.intent === 'transform', JSON.stringify(plans.editUp));
log('plan: edit rotate deg', plans.editRotate.intent === 'transform', JSON.stringify(plans.editRotate));
log('plan: edit scale', plans.editScale.intent === 'transform', JSON.stringify(plans.editScale));
log('plan: runtime move on play', plans.runtimeMove.intent === 'behavior', JSON.stringify(plans.runtimeMove));
log('plan: rotate every 3s', plans.runtimeRotateEvery.intent === 'behavior' && /__chTimer/.test((plans.runtimeRotateEvery.params || {}).code || ''), JSON.stringify(plans.runtimeRotateEvery));
log('plan: jump on space', plans.jump.intent === 'behavior' && /Space/.test((plans.jump.params || {}).code || ''), JSON.stringify(plans.jump));
log('plan: rename', plans.rename.intent === 'rename' && plans.rename.params && plans.rename.params.newName === 'Player', JSON.stringify(plans.rename));
log('plan: create sphere Ball', plans.create.intent === 'create' && plans.create.params && plans.create.params.type === 'sphere' && plans.create.params.name === 'Ball', JSON.stringify(plans.create));
log('plan: delete', plans.del.intent === 'delete', JSON.stringify(plans.del));
log('plan: camera follow', plans.cameraFollow.intent === 'camera_follow', JSON.stringify(plans.cameraFollow));
log('plan: unknown -> help', plans.unknown.intent === 'unknown' || plans.unknown.intent === 'help', plans.unknown.intent);

// ── Execution through the agent ──────────────────────────────
const exec = await page.evaluate(async () => {
  const out = {};
  const objCount = () => window.SCENE_STATE.objects.length;
  const before = objCount();
  out.move = await window.CodeHotAgent.processRequest('Cube رو روی Y=5 بذار');
  const cube = window.SCENE_STATE.objects.find(o => o.type === 'cube');
  out.cubeY = cube ? cube.position.y : null;
  out.moveOk = cube && cube.position.y === 5;
  out.create = await window.CodeHotAgent.processRequest('یه کره به اسم Ball بساز');
  const ball = window.SCENE_STATE.objects.find(o => o.name === 'Ball');
  out.ballCreated = !!ball;
  out.ren = await window.CodeHotAgent.processRequest('اسم Cube رو Player کن');
  out.renamed = window.SCENE_STATE.objects.some(o => o.name === 'Player');
  out.anim = await window.CodeHotAgent.processRequest('انیمیشن Run رو روی Cube پخش کن');
  out.beh = await window.CodeHotAgent.processRequest('وقتی Play شد Ball حرکت کنه');
  const scripts = JSON.parse(localStorage.getItem('codehot-script-bindings') || '{}');
  out.ballHasScript = ball ? !!(scripts[ball.id] && scripts[ball.id].code) : false;
  out.validated = (() => {
    if (!ball || !scripts[ball.id]) return null;
    const rt = window.CodeHotRuntime;
    return rt && typeof rt.validateScript === 'function' ? rt.validateScript(scripts[ball.id].code) : null;
  })();
  // Direct tool attach + real runtime run (edit->play->behave->stop)
  out.direct = ball ? window.CodeHotTools.ATTACH_SCRIPT({ id: ball.id, code: 'start(ctx, self) {}\nupdate(ctx, self) { self.position.y += 1 * (ctx.delta || 0.016); }\nstop(ctx, self) {}' }) : null;
  const rt = window.CodeHotRuntime;
  out.runStart = ball && rt ? rt.start({ onlyId: ball.id }) : null;
  out.runtimePlaying = rt ? rt.isPlaying() : null;
  const meshBefore = ball ? window._sceneEditorManager.scene.children.find(c => c.userData && c.userData.id === ball.id) : null;
  out.yBeforeRun = meshBefore ? meshBefore.position.y : null;
  await new Promise(r => setTimeout(r, 700));
  const meshAfter = ball ? window._sceneEditorManager.scene.children.find(c => c.userData && c.userData.id === ball.id) : null;
  out.yAfterRun = meshAfter ? meshAfter.position.y : null;
  if (rt && rt.isPlaying()) rt.stop();
  out.runtimeAfterStop = rt ? rt.isPlaying() : null;
  const meshRestored = ball ? window._sceneEditorManager.scene.children.find(c => c.userData && c.userData.id === ball.id) : null;
  out.yRestored = meshRestored ? meshRestored.position.y : null;
  out.del = await window.CodeHotAgent.processRequest('Player رو حذف کن');
  out.deleted = !window.SCENE_STATE.objects.some(o => o.name === 'Player');
  out.finalCount = objCount();
  return out;
});
log('exec: move Cube to Y=5', exec.moveOk, 'Y=' + exec.cubeY + ' | ' + exec.move.slice(0, 90));
log('exec: create Ball', exec.ballCreated, exec.create.slice(0, 120));
log('exec: rename to Player', exec.renamed, exec.ren.slice(0, 100));
log('exec: animation on non-model object -> graceful', typeof exec.anim === 'string' && exec.anim.length > 0, exec.anim.slice(0, 150));
log('exec: runtime move behavior attached+validated', exec.ballHasScript && exec.validated && exec.validated.ok, 'beh=' + (exec.beh || '').slice(0, 130) + ' validated=' + JSON.stringify(exec.validated));
log('exec: direct script attach', !!exec.direct && !!exec.direct.ok, JSON.stringify(exec.direct));
log('exec: runtime starts + moves object then stops+restores', exec.runStart === true && exec.runtimePlaying === true && exec.yAfterRun > exec.yBeforeRun && exec.runtimeAfterStop === false && exec.yRestored === exec.yBeforeRun, 'y=' + exec.yBeforeRun + '->' + exec.yAfterRun + ' restored=' + exec.yRestored);
log('exec: delete Player', exec.deleted, exec.del.slice(0, 90));
log('exec: net object count sane', exec.finalCount >= 4 && exec.ballCreated, 'after=' + exec.finalCount);

// ── Single chat path (no double execution) ───────────────────
const chat = await page.evaluate(async () => {
  // switch to the AI tab and inspect current message count
  const tabs = document.querySelectorAll('.sh-tab-btn');
  for (const b of tabs) { if ((b.dataset.tab || '').toLowerCase().includes('ai')) b.click(); }
  await new Promise(r => setTimeout(r, 300));
  const container = document.getElementById('ai-aiMessages');
  const beforeCount = container ? container.children.length : -1;
  const input = document.getElementById('ai-aiUserInput');
  input.value = 'یه استوانه بساز';
  const btn = document.getElementById('ai-aiSendBtn');
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  const afterCount = container ? container.children.length : -1;
  const cylinders = window.SCENE_STATE.objects.filter(o => o.type === 'cylinder').length;
  const msgs = [];
  for (const c of container.children) msgs.push(c.className.includes('ai-ai-message-user') ? 'U' : c.className.includes('ai-ai-message-assistant') ? 'A' : '.');
  return { beforeCount, afterCount, msgs: msgs.join(''), cylinders };
});
log('chat: exactly one user bubble per submit', chat.msgs.split('U').length - 1 === 1, chat.msgs);
log('chat: one assistant reply', chat.msgs.split('A').length - 1 >= 1, chat.msgs);
log('chat: send created exactly one cylinder', chat.cylinders === 2, 'cylinders (starter 1 + created 1)=' + chat.cylinders);

// ── English request path ─────────────────────────────────────
const eng = await page.evaluate(async () => {
  const before = window.SCENE_STATE.objects.length;
  const r = await window.CodeHotAgent.processRequest('create a cone named Rocket');
  const cone = window.SCENE_STATE.objects.find(o => o.name === 'Rocket');
  return { r: r.slice(0, 110), ok: !!cone, type: cone ? cone.type : null, before, after: window.SCENE_STATE.objects.length };
});
log('exec(EN): create cone Rocket', eng.ok && eng.type === 'cone' && eng.after === eng.before + 1, JSON.stringify(eng));

console.log('\n-- console errors (first 20) --');
const errs = consoleMsgs.filter(m => m.startsWith('[error]') || m.startsWith('[pageerror]'));
errs.slice(0, 20).forEach(m => console.log(' ', m));
console.log('total console errors/pageerrors:', errs.length);

await browser.close();
server.close();
