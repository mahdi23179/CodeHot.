import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';

const PORT = 8099;
let server;

function startServer() {
  return new Promise((resolve) => {
    const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const protocol = fs.readFileSync(new URL('./codehot-agent-protocol.js', import.meta.url), 'utf8');
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
      if (pathname === '/codehot-agent-protocol.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(protocol);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server on port ${PORT}`);
      resolve();
    });
  });
}

async function test() {
  await startServer();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-web-security']
  });
  
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(err.message));

  try {
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Test 1: App loads
    const appVisible = await page.evaluate(() => {
      const app = document.getElementById('app');
      return app && app.classList.contains('sh-visible');
    });
    console.log('TEST 1 - App loads:', appVisible ? 'PASS' : 'FAIL');

    // Test 2: AI classes exist
    const classesExist = await page.evaluate(() => {
      return typeof AIIntentParser !== 'undefined' && typeof AIStateExecutor !== 'undefined';
    });
    console.log('TEST 2 - AI classes exist:', classesExist ? 'PASS' : 'FAIL');

    // Test 3: Scene objects exist (starter objects)
    const sceneObjects = await page.evaluate(() => {
      if (typeof window === 'undefined' || typeof window.SCENE_STATE === 'undefined') return [];
      return window.SCENE_STATE.objects.map(o => ({ name: o.name, type: o.type, id: o.id }));
    });
    console.log('TEST 3 - Scene objects:', sceneObjects.length >= 4 ? `PASS (${sceneObjects.length} objects)` : 'FAIL');
    console.log('  Objects:', sceneObjects.map(o => o.name).join(', '));

    // Test 4: AIIntentParser recognizes MOVE
    const moveIntent = await page.evaluate(() => {
      return AIIntentParser.recognize('Cube رو بالا ببر');
    });
    console.log('TEST 4 - MOVE intent:', moveIntent.intent === 'move' ? 'PASS' : `FAIL (got: ${moveIntent.intent})`);
    console.log('  Target:', moveIntent.target?.name, 'Params:', JSON.stringify(moveIntent.params));

    // Test 5: AIIntentParser recognizes RENAME
    const renameIntent = await page.evaluate(() => {
      return AIIntentParser.recognize('اسم Cube رو Player کن');
    });
    console.log('TEST 5 - RENAME intent:', renameIntent.intent === 'rename' ? `PASS` : `FAIL (got: ${renameIntent.intent})`);
    console.log('  Target:', renameIntent.target?.name, 'NewName:', renameIntent.params.newName);

    // Test 6: AIIntentParser recognizes CREATE
    const createIntent = await page.evaluate(() => {
      return AIIntentParser.recognize('یک sphere بساز');
    });
    console.log('TEST 6 - CREATE intent:', createIntent.intent === 'create' ? 'PASS' : `FAIL (got: ${createIntent.intent})`);
    console.log('  Type:', createIntent.params.type);

    // Test 7: AIIntentParser recognizes DELETE
    const deleteIntent = await page.evaluate(() => {
      return AIIntentParser.recognize('Cube رو حذف کن');
    });
    console.log('TEST 7 - DELETE intent:', deleteIntent.intent === 'delete' ? 'PASS' : `FAIL (got: ${deleteIntent.intent})`);
    console.log('  Target:', deleteIntent.target?.name);

    // Test 8: AIIntentParser recognizes SCALE
    const scaleIntent = await page.evaluate(() => {
      return AIIntentParser.recognize('Cube رو بزرگ تر کن');
    });
    console.log('TEST 8 - SCALE intent:', scaleIntent.intent === 'scale' ? 'PASS' : `FAIL (got: ${scaleIntent.intent})`);
    console.log('  Factor:', scaleIntent.params.factor);

    // Test 9: AIIntentParser recognizes INSPECT
    const inspectIntent = await page.evaluate(() => {
      return AIIntentParser.recognize('وضعیت Cube چیه');
    });
    console.log('TEST 9 - INSPECT intent:', inspectIntent.intent === 'inspect' ? `PASS` : `FAIL (got: ${inspectIntent.intent})`);

    // Test 10: MOVE with Y=5
    const moveY5 = await page.evaluate(() => {
      return AIIntentParser.recognize('Cube رو Y=5 بذار');
    });
    console.log('TEST 10 - MOVE Y=5:', moveY5.intent === 'move' && moveY5.params.y === 5 ? 'PASS' : `FAIL`);

    // Test 11: EXECUTE MOVE
    const moveResult = await page.evaluate(() => {
      const parsed = AIIntentParser.recognize('Cube رو Y=5 بذار');
      const result = AIStateExecutor.execute(parsed);
      const cube = SCENE_STATE.objects.find(o => o.name === 'Cube');
      return { result, cubeY: cube?.position?.y };
    });
    console.log('TEST 11 - EXECUTE MOVE:', moveResult.result?.ok && moveResult.cubeY === 5 ? 'PASS' : `FAIL (y=${moveResult.cubeY})`);

    // Test 12: EXECUTE RENAME
    const renameResult = await page.evaluate(() => {
      const parsed = AIIntentParser.recognize('اسم Cube رو Player کن');
      const result = AIStateExecutor.execute(parsed);
      const obj = SCENE_STATE.objects.find(o => o.name === 'Player');
      return { result, found: !!obj };
    });
    console.log('TEST 12 - EXECUTE RENAME:', renameResult.result?.ok && renameResult.found ? 'PASS' : 'FAIL');

    // Test 13: EXECUTE SCALE
    const scaleResult = await page.evaluate(() => {
      const parsed = AIIntentParser.recognize('Player رو بزرگ تر کن');
      const result = AIStateExecutor.execute(parsed);
      const obj = SCENE_STATE.objects.find(o => o.name === 'Player');
      return { result, scaleX: obj?.scale?.x };
    });
    console.log('TEST 13 - EXECUTE SCALE:', scaleResult.result?.ok && scaleResult.scaleX === 2 ? `PASS (scaleX=${scaleResult.scaleX})` : `FAIL`);

    // Test 14: EXECUTE CREATE
    const createResult = await page.evaluate(() => {
      const before = window.SCENE_STATE.objects.length;
      const parsed = AIIntentParser.recognize('یک cone بساز');
      const result = AIStateExecutor.execute(parsed);
      const after = window.SCENE_STATE.objects.length;
      return { result, before, after, diff: after - before };
    });
    console.log('TEST 14 - EXECUTE CREATE:', createResult.result?.ok && createResult.diff === 1 ? 'PASS' : `FAIL (before=${createResult.before}, after=${createResult.after})`);

    // Test 15: EXECUTE INSPECT
    const inspectResult = await page.evaluate(() => {
      const parsed = AIIntentParser.recognize('وضعیت Player چیه');
      const result = AIStateExecutor.execute(parsed);
      return { result };
    });
    console.log('TEST 15 - EXECUTE INSPECT:', inspectResult.result?.ok ? 'PASS' : 'FAIL');
    if (inspectResult.result?.message) {
      console.log('  Message:', inspectResult.result.message.substring(0, 100));
    }

    // Test 16: handleUserSubmit exists and is async
    const husExists = await page.evaluate(() => {
      return typeof handleUserSubmit === 'function';
    });
    console.log('TEST 16 - handleUserSubmit exists:', husExists ? 'PASS' : 'FAIL');

    // Test 17: No V11-specific JS errors (filter known V10 errors)
    const v11Errors = errors.filter(e => !e.includes('WebGL') && !e.includes('getRuntimeEngine'));
    console.log('TEST 17 - No V11 JS errors:', v11Errors.length === 0 ? 'PASS' : `FAIL (${v11Errors.length} errors)`);
    if (v11Errors.length > 0) console.log('  Errors:', v11Errors.slice(0, 3));

    // Test 18: Move with direction "بالا"
    const moveUp = await page.evaluate(() => {
      const parsed = AIIntentParser.recognize('Player رو بالا ببر');
      return { intent: parsed.intent, y: parsed.params.y, target: parsed.target?.name };
    });
    console.log('TEST 18 - MOVE DIR بالا:', moveUp.intent === 'move' && moveUp.y !== null ? `PASS (y=${moveUp.y})` : 'FAIL');

    // Test 19: EXECUTE DELETE
    const coneExists = await page.evaluate(() => {
      const cone = SCENE_STATE.objects.find(o => o.type === 'cone');
      return !!cone;
    });
    if (coneExists) {
      const deleteResult = await page.evaluate(() => {
        const cone = SCENE_STATE.objects.find(o => o.type === 'cone');
        const parsed = AIIntentParser.recognize(cone.name + ' رو حذف کن');
        const result = AIStateExecutor.execute(parsed);
        const stillExists = SCENE_STATE.objects.find(o => o.type === 'cone');
        return { result, stillExists: !!stillExists };
      });
      console.log('TEST 19 - EXECUTE DELETE:', deleteResult.result?.ok && !deleteResult.stillExists ? 'PASS' : 'FAIL');
    } else {
      console.log('TEST 19 - EXECUTE DELETE: SKIP (no cone to delete)');
    }

    // Test 20: English commands
    const engMove = await page.evaluate(() => {
      return AIIntentParser.recognize('move cube to Y=10');
    });
    console.log('TEST 20 - English MOVE:', engMove.intent === 'move' && engMove.params.y === 10 ? 'PASS' : `FAIL (intent=${engMove.intent}, y=${engMove.params.y})`);

    // Summary
    console.log('\n=== All tests completed ===');
    
  } catch (e) {
    console.error('Test error:', e.message);
  } finally {
    await browser.close();
    server.close();
  }
}

test();
