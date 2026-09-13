#!/usr/bin/env node
/* Build a fully self-contained CodeHot index.html.
 *
 * Problem: index.html loads its AI engine from three sibling files
 * (codehot-agent-protocol.js, codehot-command-protocol.js,
 * codehot-agent-bridge.js). When the single HTML file is downloaded and
 * opened locally (file:// or content:// on a phone) those siblings do not
 * exist, the bridge never loads, and every chat message ends in an honest
 * SYSTEM_ERROR even though the network is fine.
 *
 * Fix: embed the exact bytes of the three engine files as inline <script>
 * blocks at the END of <body> (defer scripts run after body parsing, so the
 * engine expects window.CodeHotAgent to already exist — end-of-body inline
 * scripts run at the same point in the lifecycle; head-inline would run too
 * early and bail on their guards). The head <script src> tags are removed.
 *
 * Idempotent: an existing embedded block (between markers) is replaced with
 * fresh copies, so re-running after engine edits stays correct.
 */
const fs = require('fs');

const ENGINE_FILES = ['codehot-agent-protocol.js', 'codehot-command-protocol.js', 'codehot-agent-bridge.js'];
const OPEN_MARK = '/*codehot-standalone-engine-v1:embedded-do-not-edit*/';
const CLOSE_MARK = '/*codehot-standalone-engine-v1:end*/';

let html = fs.readFileSync('index.html', 'utf8');

// 1) Strip any previously embedded block (idempotency).
const blockRe = new RegExp('[ \\t]*<script>\\s*' + OPEN_MARK.replace(/[*/]/g, '\\$&') + '[\\s\\S]*?' + CLOSE_MARK.replace(/[*/]/g, '\\$&') + '\\s*</script>\\n?', 'g');
html = html.replace(blockRe, '');

// 2) Remove the external engine <script src> tags from head.
for (const f of ENGINE_FILES) {
  const tagRe = new RegExp('[ \\t]*<script src="' + f.replace(/[.]/g, '\\.') + '" defer></script>\\n?', 'g');
  if (!tagRe.test(html)) {
    console.error('FATAL: expected script tag for ' + f + ' not found (already removed?)');
    process.exit(1);
  }
  html = html.replace(tagRe, '');
}

// 3) Build the embedded block with the exact engine bytes.
const parts = [];
parts.push('    <script>\n    /* ' + OPEN_MARK.slice(2, -2) + ' single-file engine: three engine files embedded verbatim below so the app works standalone (file://, content://, any host) with no sibling JS. */\n');
for (const f of ENGINE_FILES) {
  const code = fs.readFileSync(f, 'utf8');
  if (code.includes('</script')) {
    console.error('FATAL: ' + f + ' contains a literal </script and cannot be inlined safely.');
    process.exit(1);
  }
  parts.push('    /* ==== begin ' + f + ' ==== */\n' + code + '\n    /* ==== end ' + f + ' ==== */\n');
}
parts.push('    ' + CLOSE_MARK + '\n    </script>\n');
const block = parts.join('');

// 4) Insert the block right before </body>.
const closeBodyIdx = html.lastIndexOf('</body>');
if (closeBodyIdx === -1) { console.error('FATAL: </body> not found'); process.exit(1); }
html = html.slice(0, closeBodyIdx) + block + html.slice(closeBodyIdx);

fs.writeFileSync('index.html', html);

// 5) Keep the versioned delivery copy byte-identical.
fs.copyFileSync('index.html', 'codehot-v12-final.html');

console.log('OK: embedded ' + ENGINE_FILES.join(', '));
console.log('index.html bytes:', html.length);
