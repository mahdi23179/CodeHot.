/* CodeHot V12 Agent: real-model escalation bridge.
 * Routing contract:
 *   - Explicit @@COMMAND scripts      -> Command Protocol (deterministic).
 *   - Fully understood single-goal local plans -> original pipeline (tools+verify).
 *   - Complex / multi-step / relative / behavior / unknown -> REAL model
 *     via global.CodeHotAgentBridge.callModel (observable, countable).
 * Safety contract:
 *   - An explicitly named target that does not exist NEVER falls back to the
 *     selection or another object: the action stops with an honest NOT-FOUND.
 *   - No fake fallback: model/network failure surfaces as a real error
 *     message, never as canned text.
 */
(function (global) {
  'use strict';
  if (!global || !global.CodeHotAgent) return;

  var agent = global.CodeHotAgent;
  if (agent.__v12Escalation) return; // idempotent
  agent.__v12Escalation = true;

  var WORKER_URL = global.CodeHotAIEndpoint || 'https://nokhbe.m46680279.workers.dev/';
  // Free-model workers occasionally take >45s. A timeout abort must not kill
  // a multi-step request: give the model real time, then retry transient
  // transport failures (abort / network / 5xx / 429) a bounded number of
  // times. Validation errors (HTTP 4xx other than 429) are not retried.
  var TIMEOUT_MS = 90000;
  var ATTEMPTS = 3;
  var RETRY_DELAYS_MS = [1500, 4000];
  var MSG_MAX = 6000;

  function fa() {
    try {
      var s = JSON.parse(global.localStorage.getItem('codehot-settings') || '{}');
      return s && s.language === 'fa';
    } catch (e) { return false; }
  }

  var STR = {
    fail: function (m) { return fa() ? '⚠️ اتصال به مدل هوش مصنوعی برقرار نشد: ' + m : '⚠️ Could not reach the AI model: ' + m; },
    noModel: function () { return fa() ? '⚠️ پاسخی از مدل هوش مصنوعی دریافت نشد.' : '⚠️ The AI model returned no content.'; },
    notFound: function (n) {
      return (fa()
        ? '⚠️ آبجکتی به نام «' + n + '» در صحنه وجود ندارد؛ هیچ آبجکتی حذف یا تغییر نکردم. اسم دقیق آبجکت را بگو یا اول آن را انتخاب کن.'
        : '⚠️ No object named "' + n + '" exists in the scene. Nothing was changed. Say the exact object name or select it first.') + ' | ENTITY_SAFETY (deterministic, not AI):';
    },
    typeMissing: function (t) {
      return (fa()
        ? '⚠️ هیچ آبجکتی از نوع «' + t + '» در صحنه نیست؛ عملیاتی انجام نشد.'
        : '⚠️ No object of type "' + t + '" exists in the scene. Nothing was changed.') + ' | ENTITY_SAFETY (deterministic, not AI):';
    },
    noAction: function () {
      return fa()
        ? '⚠️ درخواست عملیاتی اجرا نشد: مدل بدون هیچ دستوری پاسخ داد. دوباره تلاش کنید.'
        : '⚠️ The action request was not executed: the model replied without any commands. Please try again.';
    }
  };

  /* ── Live state summary injected into the model prompt ───────── */
  function ctxSummary() {
    try {
      if (global.CodeHotQuerySystem && typeof global.CodeHotQuerySystem.run === 'function') {
        var scene = global.CodeHotQuerySystem.run('QUERY_SCENE');
        if (scene && scene.ok) {
          var d = scene.data || {};
          return {
            objects: (d.objects || []).map(function (o) {
              return { id: o.id, name: o.name, type: o.type, position: o.position, rotation: o.rotation, visible: o.visible, hasScript: o.hasScript, animations: (o.animations || []).map(function (a) { return a.name; }) };
            }),
            selectedId: d.selectedId || null,
            objectCount: d.objectCount || (d.objects || []).length
          };
        }
      }
    } catch (e) {}
    try {
      var st = global.SCENE_STATE;
      if (st && Array.isArray(st.objects)) {
        return { objects: st.objects.map(function (o) { return { id: o.id, name: o.name, type: o.type, position: o.position, visible: o.visible !== false }; }), selectedId: st.selectedId || null, objectCount: st.objects.length };
      }
    } catch (e) {}
    return { objects: [], selectedId: null, objectCount: 0 };
  }

  function buildSystemPrompt(ctx) {
    var caps = (global.CodeHotCommandProtocol && global.CodeHotCommandProtocol.capabilities) ? global.CodeHotCommandProtocol.capabilities() : { commands: [], queries: [] };
    var cmds = (caps.commands || []).join(', ');
    return [
      'You are the CodeHot editor AI agent operating INSIDE the CodeHot 3D editor.',
      'Every assistant reply MUST come from you (the model). Never fabricate results; if you cannot act, say so honestly.',
      'SCENE STATE below is the REAL current state, read from the running editor.',
      'Never invent objects, ids, names, or animation clips.',
      'If the user asks about an object/clip that is not in SCENE STATE, say clearly that it does not exist. NEVER pick a different object instead.',
      '',
      'SCENE STATE (real):',
      JSON.stringify(ctx),
      '',
      'AVAILABLE COMMANDS: ' + cmds,
      '',
      'You can either ANSWER or ACT:',
      '- For questions, status requests, greetings, or explanations: reply with a short natural answer in the user\'s language (Persian if the user writes Persian, else English). Do NOT output commands.',
      '- For actions: reply ONLY with command block(s) in this exact syntax:',
      '@@COMMAND_NAME',
      'PARAM:"value"',
      'NUMBER:1.5',
      '@@END',
      'Multiple blocks are allowed and execute in order.',
      '',
      'Command syntax rules:',
      '- Strings: PARAM:"value". Numbers plain: X:5, Y:-2. Booleans: true/false.',
      '- Targeting: OBJECT:"Name" by name, ID:"<real id>" by id, SELECTED:true, TYPE:"cube" only when exactly one object of that type exists.',
      '- NEVER invent or reuse an ID. Only use ID values that appear verbatim in SCENE STATE; when unsure, target by OBJECT:"Name".',
      '- If a step targets a name that is not in SCENE STATE and you did not create it in an earlier block, STOP and answer in words that the object does not exist.',
      '',
      'Multi-step requests: emit the blocks in order. If step 1 creates an object referenced by later steps, give it NAME:"X" in CREATE_OBJECT and target OBJECT:"X" afterwards.',
      'To rename an object: @@RENAME_OBJECT with OBJECT:"OldName" (or ID) and NEW_NAME:"NewName". NEW_NAME is required and must be quoted.',
      'For "put A next to B": read B\'s position from SCENE STATE and MOVE A to a spot about 2 units away from B using absolute X/Y/Z in MOVE_OBJECT.',
      'Movement is @@MOVE_OBJECT with OBJECT/ID plus absolute X/Y/Z (or DELTA:true for offsets). Rotation is @@ROTATE_OBJECT with X/Y/Z in DEGREES (absolute; add DELTA:true to rotate by). There is no TRANSFORM_OBJECT command.',
      '',
      'Script format for "rotate/move when Play":',
      '@@CREATE_SCRIPT',
      'OBJECT:"Name"',
      'CODE:"start(ctx, self) {}\\nupdate(ctx, self) {\\n  self.rotation.y += THREE.MathUtils.degToRad(90) * (ctx.delta || 0.016);\\n}\\nstop(ctx, self) {}"',
      '@@END',
      'CODE must use exactly this method-style lifecycle: start(ctx, self) / update(ctx, self) / stop(ctx, self). Use \\n for newlines inside CODE (never raw line breaks).',
      'Inside scripts you may use: self.rotation, self.position, self.scale, ctx.delta, THREE, CodeHot, document.',
      'Always write time steps as (ctx.delta || 0.016) so behaviors still advance when the host cannot measure frame time.',
      '',
      'To save the project: @@SAVE_PROJECT followed by @@END.',
      'You may run @@QUERY_SCENE / @@QUERY_SCRIPTS blocks to read real state before answering.',
      '',
      'Physics (V13): attach real gameplay behavior with @@GRAVITY, @@JUMP_KEY (KEY:"Space"), @@MOVE_ON_KEYS (SPEED:4), or @@PHYSICS_SETUP (gravity + jump + arrow/WASD movement + SPEED) — each targets an object with OBJECT/ID/SELECTED like other commands. Use them when the user asks for gravity, jumping, ground, or keyboard/arrow-key movement.',
      '',
      'Examples:',
      '@@CREATE_OBJECT',
      'TYPE:"cylinder"',
      'NAME:"Enemy"',
      '@@END',
      '',
      '@@MOVE_OBJECT',
      'OBJECT:"Enemy"',
      'X:4',
      'Z:-1',
      '@@END'
    ].join('\n');
  }

  // Normalize one command body into KEY:value lines the Protocol parser accepts.
  function normalizeBody(body) {
    return String(body || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (line) {
      var pm = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!pm) return line;
      var key = pm[1].toUpperCase();
      var val = pm[2].trim().replace(/,$/, '');
      if (!/^["']/.test(val) && !/^(true|false|null|-?\d+(?:\.\d+)?)$/i.test(val)) {
        val = '"' + val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      }
      return key + ':' + val;
    });
  }

  function extractBlocks(text) {
    var raw = String(text || '');
    var blocks = [];
    var m;
    // Preferred: @@COMMAND\nKEY: value\n@@END (multi-line).
    var re = /@@\s*([A-Za-z_][A-Za-z0-9_]*)[\t ]*\r?\n([\s\S]*?)(?:@@END|(?=@@\s*[A-Za-z_][A-Za-z0-9_]*[\t ]*\r?\n)|$)/g;
    while ((m = re.exec(raw)) !== null) blocks.push(m[0]);
    if (blocks.length) return blocks;
    // Tolerance: single-line "@@COMMAND KEY:"v" NAME:"x" @@END".
    var reLine = /@@\s*([A-Za-z_][A-Za-z0-9_]*)\s+([^@\n]*?)\s*@@END/g;
    while ((m = reLine.exec(raw)) !== null) {
      var inline = m[2].split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*:)/).map(function (p) { return p.trim(); }).filter(Boolean);
      blocks.push('@@' + m[1].toUpperCase() + '\n' + normalizeBody(inline.join('\n')).join('\n') + '\n@@END');
    }
    if (blocks.length) return blocks;
    // Tolerance: function-call syntax "COMMAND(...)" possibly wrapped in
    // [ ] or <|tool_call|> markers — some free models emit this shape.
    if (!blocks.length) {
      var reFn = /\[?\b([A-Z][A-Z0-9_]{2,})\s*\(\s*([^\)\n]{0,600}?)\s*\)\s*\]?/g;
      while ((m = reFn.exec(raw)) !== null) {
        var fnName = m[1].toUpperCase();
        if (fnName === 'END') continue;
        var args = m[2].split(/,(?![^\"]*\")/).map(function (p) { return p.trim(); }).filter(Boolean);
        var body = args.map(function (p) {
          var pm = p.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
          if (!pm) return null;
          var v = pm[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
          return /^[\-0-9.]+$/.test(v) ? (pm[1].toUpperCase() + ': ' + v) : (pm[1].toUpperCase() + ': "' + v + '"');
        }).filter(Boolean);
        blocks.push('@@' + fnName + '\n' + body.join('\n') + '\n@@END');
      }
    }
    // Tolerance: <tool_call>COMMAND\nKEY: value</tool_call>.
    var reTool = /<tool_call>\s*([A-Za-z_][A-Za-z0-9_]*)\s*\r?\n?([\s\S]*?)<\/tool_call>/g;
    while ((m = reTool.exec(raw)) !== null) {
      blocks.push('@@' + m[1].toUpperCase() + '\n' + normalizeBody(m[2]).join('\n') + '\n@@END');
    }
    return blocks;
  }

  // Models sometimes emit CODE:"..." with REAL line breaks, which the line-
  // oriented Protocol parser cannot accept. Escape real newlines/quotes that
  // appear inside any CODE value so the script survives parsing, then the
  // executor unescapes it back to real JavaScript source.
  function hardenBlocks(blocks) {
    return (blocks || []).map(function (b) {
      var s = String(b)
        .replace(/^\s*\[\s*<\|tool_call\|>\s*/i, '')
        .replace(/\s*<\|tool_call\|>\s*\]\s*$/i, '')
        .replace(/^\s*<\|tool_call\|>\s*/i, '')
        .replace(/\s*<\|tool_call\|>\s*$/i, '')
        .replace(/^\s*\[\s*/, '')
        .replace(/\s*\]\s*$/, '');
      // Models often write RENAME_OBJECT(NAME:"Old", NEW_NAME:"New") — the
      // protocol requires the target selector (OBJECT/ID/TYPE), not NAME.
      var rn = s.match(/^@@RENAME_OBJECT\n([\s\S]*?)@@END$/);
      if (rn && /(^|\n)NAME\s*:/i.test(rn[1]) && !/(^|\n)(OBJECT|ID|TYPE|SELECTED)\s*:/i.test(rn[1])) {
        var nm = rn[1].match(/(?:^|\n)NAME\s*:\s*"?([^"\n]+)"?/);
        if (nm) s = s.replace(/NAME\s*:\s*"?[^"\n]+"?/i, 'OBJECT: "' + nm[1].trim() + '"');
      }
      // RENAME_OBJECT uses NEW_NAME; the model sometimes writes NAME:"X".
      // On a rename there is no other meaning for NAME, so alias it.
      if (/@@\s*RENAME_OBJECT\b/.test(s)) {
        s = s.replace(/^(\s*)NAME(\s*:)/gim, '$1NEW_NAME$2');
      }
      return s.replace(/^(CODE\s*:\s*")((?:[^"\\]|\\.)*)"/gim, function (whole, key, val) {
        var fixed = val
          .replace(/\\r\\n|\\r/g, '\\n')   // normalize escaped CR
          .replace(/\r?\n/g, '\\n')        // real newlines -> \n escapes
          .replace(/\t/g, '\\t')
          // Time-based behaviors must not silently freeze when the host cannot
          // measure frame time (headless runners, throttled tabs).
          .replace(/ctx\.delta\b(?!\s*(\|\||\?))/g, '(ctx.delta || 0.016)');
        return key + fixed + '"';
      });
    });
  }

  function stripBlocks(text) {
    return String(text || '')
      .replace(/@@\s*[A-Za-z_][A-Za-z0-9_]*[\t ]*\r?\n[\s\S]*?(?:@@END|(?=@@\s*[A-Za-z_][A-Za-z0-9_]*[\t ]*\r?\n)|$)/g, '')
      .replace(/@@\s*[A-Za-z_][A-Za-z0-9_]*\s+[^@\n]*?@@END/g, '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/\[?\b[A-Z][A-Z0-9_]{2,}\s*\(\s*[^\)\n]{0,600}?\s*\)\s*\]?/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Transport: prefer the instrumented global (tests wrap it to count calls).
  function transport(messages) {
    if (global.CodeHotAgentBridge && typeof global.CodeHotAgentBridge.callModel === 'function') {
      return global.CodeHotAgentBridge.callModel(messages);
    }
    return rawFetch(messages);
  }

  function rawFetch(messages) {
    return fetchWithTimeout(messages).catch(function (err) {
      var transient = /abort|timeout|network|failed to fetch|HTTP (429|5\d\d)/i.test(String(err && err.message || err));
      if (!transient || ATTEMPTS <= 1) throw err;
      return retryFetch(messages, err, 0);
    });
  }
  function retryFetch(messages, lastErr, attempt) {
    if (attempt >= ATTEMPTS - 1) throw lastErr;
    return new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]); })
      .then(function () { return fetchWithTimeout(messages); })
      .catch(function (err) {
        var transient = /abort|timeout|network|failed to fetch|HTTP (429|5\d\d)/i.test(String(err && err.message || err));
        if (!transient) throw err;
        return retryFetch(messages, err, attempt + 1);
      });
  }
  function fetchWithTimeout(messages) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
    var opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: messages }), signal: ctrl.signal };
    return fetch(WORKER_URL, opts)
      .then(function (res) {
        return res.text().then(function (rawText) {
          if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + String(rawText || '').slice(0, 160));
          var data;
          try { data = JSON.parse(rawText); } catch (e) { throw new Error('Bad JSON from AI endpoint: ' + String(rawText || '').slice(0, 120)); }
          if (!data || !data.choices || !data.choices[0] || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
            throw new Error('Unexpected AI response shape: ' + JSON.stringify(data).slice(0, 120));
          }
          if (!String(data.choices[0].message.content).trim()) {
            throw new Error('HTTP 502: model returned empty content');
          }
          return data.choices[0].message.content;
        });
      })
      .finally(function () { clearTimeout(timer); });
  }

  // Default callModel — the real Worker call. Tests may replace this function
  // on CodeHotAgentBridge to observe/count calls; the agent always routes
  // through it, so modelCalls evidence is real.
  global.CodeHotAgentBridge = {
    url: WORKER_URL,
    version: '12.2',
    buildSystemPrompt: buildSystemPrompt,
    ctxSummary: ctxSummary,
    extractBlocks: extractBlocks,
    hardenBlocks: hardenBlocks,
    stripBlocks: stripBlocks,
    callModel: rawFetch,
    _rawFetch: rawFetch
  };

  /* ── Conversation memory (persisted, feeds the model) ────────── */
  var HIST_KEY = 'codehot-agent-bridge-history';
  function bridgeHistory() {
    try { return JSON.parse(global.localStorage.getItem(HIST_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function pushHistory(role, text) {
    try {
      var all = bridgeHistory().concat([{ role: role, content: String(text || '') }]);
      global.localStorage.setItem(HIST_KEY, JSON.stringify(all.slice(-8)));
    } catch (e) {}
  }
  function historyMessages() {
    return bridgeHistory()
      .filter(function (m) { return m && typeof m.content === 'string' && m.content.trim(); })
      .slice(-6)
      .map(function (m) { return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0, MSG_MAX) }; });
  }
  global.CodeHotAgentBridge.clearHistory = function () {
    try { global.localStorage.removeItem(HIST_KEY); } catch (e) {}
  };

  /* ── Classification (removed) ─────────────────────────────────── */
  // V12: routing is model-first for every user message. There is no local
  // planner answer path anymore, so complexity classification is not used.

  /* ── Entity safety: explicit missing names never fall back ───── */
  var SHAPE_WORDS = ['cube', 'box', 'مکعب', 'مربع', 'sphere', 'کره', 'گوی', 'توپ', 'cylinder', 'استوانه', 'cone', 'مخروط', 'plane', 'صفحه', 'سطح', 'model', 'مدل', 'گروه', 'group', 'glb'];
  var META_WORDS = ['اسم', 'اسمش', 'اسمشو', 'نام', 'نامش', 'انیمیشن', 'انیمیشنش', 'اسکریپت', 'دوربین', 'camera', 'scene', 'صحنه', 'state', 'project', 'پروژه', 'name', 'animation', 'script', 'it', 'this', 'that', 'them', 'him', 'her', 'object', 'objects', 'آبجکت', 'آبجکتش'];
  var VERB_WORDS = ['ببر', 'ببرش', 'بذار', 'بذارش', 'بزار', 'بزارش', 'بکن', 'بکنش', 'کن', 'برو', 'بیار', 'بگیر', 'حذف', 'پاک', 'بساز', 'بچرخ', 'بده', 'بدهش', 'delete', 'remove', 'move', 'rotate', 'create', 'make', 'play', 'stop', 'select', 'rename', 'hide', 'show'];


  function eqName(a, b) {
    var x = String(a || '').replace(/[\u200c\u200d]/g, '').trim().toLowerCase();
    var y = String(b || '').replace(/[\u200c\u200d]/g, '').trim().toLowerCase();
    return !!x && x === y;
  }


  // capitalized Latin token). Only real-looking object names are returned.
  function explicitNamesInText(text) {
    var raw = String(text || '');
    var out = [];
    var push = function (n) { if (n && out.map(eqName.bind(null, n)).indexOf(true) === -1 && out.indexOf(n) === -1) out.push(n); };
    var qm = raw.match(/["']([^"']{2,40})["']/g) || [];
    qm.forEach(function (q) { push(q.slice(1, -1).trim()); });
    var faMatches = raw.match(/([\u0600-\u06FF\w][\u0600-\u06FF\w]*?)\s+(?:رو|را)\s+/g) || [];
    faMatches.forEach(function (mch) {
      var tok = mch.replace(/\s+(?:رو|را)\s+$/, '').trim();
      if (tok.length > 1 && META_WORDS.indexOf(tok) === -1 && VERB_WORDS.indexOf(tok) === -1) push(tok);
    });
    var enMatches = raw.match(/\b[A-Z][A-Za-z0-9_.\-]{1,29}\b/g) || [];
    enMatches.forEach(function (tok) {
      if (!/^(Move|Rotate|Scale|Delete|Rename|Create|Make|Play|Stop|When|Camera|Help|Status|This|That|It|Scene|State|Project)$/.test(tok)) push(tok);
    });
    return out;
  }


  function fmtPos(v) {
    return v && typeof v === 'object'
      ? 'X' + Number(v.x || 0).toFixed(2) + ' Y' + Number(v.y || 0).toFixed(2) + ' Z' + Number(v.z || 0).toFixed(2)
      : '-';
  }

  function buildFinalReply(results) {
    var faLang = fa();
    var lines = [];
    var failed = 0;
    (results || []).forEach(function (r) {
      if (!r.ok) failed++;
      lines.push((r.ok ? '✅ ' : '⚠️ ') + (r.command ? r.command + ': ' : '') + (r.message || ''));
    });
    if (failed) {
      lines.push(faLang ? '⚠️ ' + failed + ' دستور اجرا نشد.' : '⚠️ ' + failed + ' command(s) failed.');
    } else if (results && results.length) {
      lines.push(faLang ? 'همه دستورها اجرا شدند و با وضعیت واقعی صحنه تطبیق داده و تأیید شدند.' : 'All commands executed and verified against the real scene state.');
    }
    lines.push('');
    var live = ctxSummary();
    var objects = live.objects || [];
    lines.push(faLang ? 'وضعیت واقعی صحنه (خوانده‌شده بعد از اجرا):' : 'Real scene state (read after execution):');
    lines.push('• ' + (faLang ? 'آبجکت‌ها' : 'Objects') + ' (' + objects.length + '): ' + (objects.length ? objects.map(function (o) { return o.name; }).join(', ') : (faLang ? 'خالی' : 'none')));
    objects.forEach(function (o) {
      lines.push('  • ' + o.name + ' (' + o.type + ') ' + fmtPos(o.position) + (o.hasScript ? (faLang ? ' · اسکریپت دارد' : ' · script') : ''));
    });
    return lines.join('\n');
  }

  /* ── Model escalation path ───────────────────────────────────── */
  var escalatedProcess = async function (text) {
    var rawText = String(text || '').trim();
    if (!rawText) return '';

    // 1) Explicit @@COMMAND script: always the deterministic protocol path.
    if (rawText.startsWith('@@') && global.CodeHotCommandProtocol && typeof global.CodeHotCommandProtocol.runScript === 'function') {
      var own = global.CodeHotCommandProtocol.runScript(rawText, 'chat');
      return own.map(function (p) { return (p.ok ? '✅ ' : '⚠️ ') + (p.command ? p.command + ': ' : '') + (p.message || ''); }).join('\n\n');
    }

    // 2) V12: NO local answers. plan() is used for entity-safety only; its
    //    result is never shown to the user as an AI reply.
    var plan = null;
    try { plan = agent.plan(rawText, global.AIContext && global.AIContext.getSnapshot ? global.AIContext.getSnapshot() : null); } catch (e) { plan = null; }

    // Existence checks ("do X, Y, Z still exist?") also go to the model — the
    // model sees the same live SCENE STATE in its prompt. No canned report.
    // (isExistenceQuestion/existenceReport removed with the canned paths.)

    // V12: no bridge-level target gating. The REAL model decides from the
    // live SCENE STATE (system prompt forbids substitute targets), and every
    // model-issued command is then executed and verified by the Command
    // Protocol, which fails honestly on unresolved targets.

    // 3) Escalate EVERYTHING to the REAL model through the Worker.
    //    V12 removal: the local planner may no longer ANSWER the user —
    //    it is not the AI, and its canned template replies impersonated one.
    //    plan() results are used only by the model via the scene context.
    pushHistory('user', rawText);
    var ctx = ctxSummary();
    var messages = [{ role: 'system', content: buildSystemPrompt(ctx) }]
      .concat(historyMessages())
      .concat([{ role: 'user', content: rawText }]);

    var content;
    try {
      content = await transport(messages);
    } catch (err) {
      var failMsg = STR.fail((err && err.message) ? err.message : String(err)) + ' | SYSTEM_ERROR (no canned reply): model call attempted and failed.';
      try { global.AIContext.addConversation('assistant', failMsg); } catch (e) {}
      return failMsg; // REAL error surfaced; nothing faked.
    }
    if (!content || !String(content).trim()) {
      var none = STR.noModel() + ' | SYSTEM_ERROR (no canned reply): model call attempted, empty response.';
      try { global.AIContext.addConversation('assistant', none); } catch (e) {}
      return none;
    }
    pushHistory('assistant', content);

    // 4) Execute command blocks produced by the model through the official
    //    Command Protocol (Parser -> Validator -> Executor -> verification).
    var blocks = hardenBlocks(extractBlocks(content));
    if (blocks.length && global.CodeHotCommandProtocol && typeof global.CodeHotCommandProtocol.runScript === 'function') {
      var results = global.CodeHotCommandProtocol.runScript(blocks.join('\n'), 'ai');
      var narration = stripBlocks(content);
      var reply = buildFinalReply(results);
      if (narration && narration.length > 2) reply = narration + '\n\n' + reply;
      try { global.AIContext.addConversation('assistant', reply); } catch (e) {}
      return reply;
    }

    // 5) Pure natural answer from the model (question/greeting/status).
    try { global.AIContext.addConversation('assistant', content); } catch (e) {}
    return content;
  };

  agent.processRequest = escalatedProcess;
})(typeof window !== 'undefined' ? window : null);
