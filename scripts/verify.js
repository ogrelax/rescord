#!/usr/bin/env node
/*
 * Rescord QA / compile-diagnosis harness.
 * Dependency-free (Node builtins only). Runs on the real filesystem so it always
 * sees current files. Exits non-zero on ANY error so the build and push abort.
 *
 *   node scripts/verify.js
 *
 * Checks:
 *   1. JS syntax of every authored file + the inline <script> in index.html.
 *   2. Required features present in index.html (functions, elements, WS cases).
 *   3. DeepFilterNet3 assets: wasm compiles + exports needed fns; model is a valid
 *      gzip tar containing the 3 ONNX stages; worklet registers its processor.
 *   4. Referenced static assets actually exist on disk.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];
let passed = 0;

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };
const ok   = m => { passed++; console.log(`  ${C.g}✓${C.x} ${m}`); };
const err  = m => { errors.push(m); console.log(`  ${C.r}✗${C.x} ${m}`); };
const warn = m => { warnings.push(m); console.log(`  ${C.y}!${C.x} ${m}`); };
const head = m => console.log(`\n${C.d}== ${m} ==${C.x}`);

const read   = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

function checkSyntax(label, code) {
  try { new vm.Script(code, { filename: label }); ok(`syntax: ${label}`); }
  catch (e) { err(`syntax: ${label} → ${e.message}`); }
}

// ---- 1. JS syntax ----------------------------------------------------------
head('JS syntax');
for (const f of ['electron.js', 'server.js']) {
  if (exists(f)) checkSyntax(f, read(f)); else err(`missing file: ${f}`);
}

let html = '';
if (exists('public/index.html')) {
  html = read('public/index.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!scripts.length) err('index.html: no inline <script> found');
  scripts.forEach((s, i) => checkSyntax(`index.html <script>#${i + 1}`, s));
} else err('missing file: public/index.html');

if (exists('public/dfnet/dfnet3-worklet.js')) {
  const w = read('public/dfnet/dfnet3-worklet.js');
  checkSyntax('dfnet3-worklet.js', w);
  if (!/registerProcessor\(\s*['"]deepfilter-audio-processor['"]/.test(w))
    err('dfnet3-worklet.js: does not registerProcessor("deepfilter-audio-processor")');
  else ok('worklet registers deepfilter-audio-processor');
} else err('missing file: public/dfnet/dfnet3-worklet.js');

// ---- 2. Feature presence checks -------------------------------------------
head('Feature presence');
if (html) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

  // Required functions
  const requiredFns = [
    'sendMessage', 'appendMessage', 'handleMsg', 'joinVoice', 'leaveVoice',
    'toggleScreenShare', 'stopScreenShare', 'toggleAudioShare', 'stopAudioShare',
    'handleMusicState', 'updateMusicPlayer', 'syncYouTube', 'musicCmd',
    'extractYouTubeId', 'handleSlashCommand', 'formatFileSize',
    'toggleMute', 'toggleDeafen', 'updateVoiceView', 'renderMembers',
    'renderChannels', 'renderMessages', 'closePeer', 'makePeer',
    'initiateCall', 'handleOffer', 'handleAnswer', 'handleIce',
    'buildAudioPipeline', 'getProcessedStream', 'reacquireStream',
    'startLocalVAD', 'stopLocalVAD', 'startRemoteVAD', 'cleanupRemoteVAD',
    'updateDenoiseStatus', 'sfx', 'esc', 'avatarInner', 'renderMyAvatar',
    'applyTheme', 'renderThemeGrid', 'showUserCtx', 'hideCtx',
    'openSettings', 'showSection', 'refreshUserVolumeList',
    'submitNickname', 'openModal', 'closeModal',
    'hostMute', 'hostKick', 'toggleUserMute', 'setUserVolume',
    'updateMicGain', 'updateOutputVol', 'updateSuppression',
    'toggleRNNoise', 'toggleNoiseSup', 'toggleEchoCancel', 'toggleAutoGain',
    'toggleMicTest', 'stopMicTest', 'copyEl', 'onAvatarPicked',
    'removeAvatar', 'saveDisplayName', 'toggleSounds', 'applyInputDevice',
    'applyOutputDevice', 'submitNewText', 'submitNewVoice'
  ];
  const missing = requiredFns.filter(fn => !new RegExp('function\\s+' + fn + '\\s*\\(|' + fn + '\\s*=\\s*(?:async\\s*)?(?:function|\\()').test(script));
  if (missing.length) missing.forEach(fn => err('missing function: ' + fn + '()'));
  else ok('all ' + requiredFns.length + ' required functions defined');

  // Required HTML elements
  const requiredIds = [
    'fileInput', 'msgInput', 'messages', 'musicPlayer', 'musicTitle',
    'musicThumb', 'musicSub', 'ytPlayer', 'ytPlayerWrap',
    'audioShareBtn', 'shareBtn', 'voiceView', 'chatView',
    'voiceParticipants', 'screenGrid', 'voiceChannelTitle',
    'nicknameModal', 'nicknameInput', 'settingsModal', 'kickedBanner'
  ];
  requiredIds.forEach(id => {
    if (html.includes('id="' + id + '"')) ok('element present: #' + id);
    else err('missing element: #' + id);
  });

  // WS case handlers
  const requiredCases = ['text-message', 'file-message', 'music-state', 'user-update',
    'user-joined-voice', 'user-left-voice', 'voice-peers', 'server-mute',
    'kicked', 'rtc-offer', 'rtc-answer', 'rtc-ice', 'init'];
  requiredCases.forEach(c => {
    if (script.includes("case '" + c + "'")) ok('WS case handled: ' + c);
    else err('missing WS case: ' + c);
  });

  // Server-side message types
  if (exists('server.js')) {
    const srv = read('server.js');
    ['file-message', 'music-command', 'music-state'].forEach(t => {
      if (srv.includes("'" + t + "'")) ok('server handles: ' + t);
      else err('server missing handler for: ' + t);
    });
  }

  // Inline handler check
  const defined = new Set();
  for (const m of script.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
  const SAFE = new Set([
    'if','for','while','switch','return','typeof','new','delete','void','in','of','do','else',
    'case','catch','try','throw','await','yield','event','this','document','window','console',
    'alert','confirm','prompt','JSON','Math','location','navigator','parseInt','parseFloat',
    'setTimeout','setInterval','Number','String','Boolean','Array','Object','Date','isNaN'
  ]);
  const handlerRe = /\b(?:onclick|oninput|onchange|onkeydown|onkeyup|oncontextmenu|onsubmit)\s*=\s*"([^"]*)"/g;
  let handlerCount = 0, badHandlers = 0;
  for (const m of html.matchAll(handlerRe)) {
    handlerCount++;
    const expr = m[1];
    for (const c of expr.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = c[2];
      if (!defined.has(name) && !SAFE.has(name)) {
        err(`handler calls undefined function: ${name}()  ${C.d}[${expr.slice(0,48)}]${C.x}`);
        badHandlers++;
      }
    }
  }
  if (!badHandlers) ok(`all ${handlerCount} inline handlers resolve`);
}

// ---- 3. Static assets ------------------------------------------------------
head('Static assets');
for (const a of [
  'public/dfnet/df_bg.wasm',
  'public/dfnet/DeepFilterNet3_onnx.tar.gz',
  'public/dfnet/dfnet3-worklet.js',
  'public/icon.ico', 'public/icon-192.png', 'public/icon-512.png',
  'public/rnnoise-sync.js'
]) { exists(a) ? ok(`present: ${a}`) : err(`missing asset: ${a}`); }

// ---- 4. DeepFilterNet3 asset integrity ------------------------------------
(async () => {
  head('DeepFilterNet3 integrity');
  try {
    const buf = fs.readFileSync(path.join(ROOT, 'public/dfnet/df_bg.wasm'));
    const mod = await WebAssembly.compile(buf);
    const ex = WebAssembly.Module.exports(mod).map(e => e.name);
    const need = ['df_create', 'df_process_frame', 'df_get_frame_length', 'df_set_atten_lim', 'memory'];
    const miss = need.filter(n => !ex.includes(n));
    miss.length ? err(`df_bg.wasm missing exports: ${miss.join(', ')}`) : ok('df_bg.wasm compiles + exports df_create/process_frame/frame_length/atten_lim/memory');
  } catch (e) { err(`df_bg.wasm: ${e.message}`); }
  try {
    const buf = fs.readFileSync(path.join(ROOT, 'public/dfnet/DeepFilterNet3_onnx.tar.gz'));
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) err('model tar.gz: bad gzip header');
    else {
      const tar = zlib.gunzipSync(buf).toString('latin1');
      const miss = ['enc.onnx', 'erb_dec.onnx', 'df_dec.onnx'].filter(n => !tar.includes(n));
      miss.length ? err(`model missing ONNX stage(s): ${miss.join(', ')}`) : ok('model is valid gzip tar with enc/erb_dec/df_dec ONNX');
    }
  } catch (e) { err(`model tar.gz: ${e.message}`); }

  // ---- summary ----
  console.log(`\n${C.d}${'-'.repeat(56)}${C.x}`);
  console.log(`  ${C.g}${passed} passed${C.x}   ${warnings.length ? C.y : C.d}${warnings.length} warnings${C.x}   ${errors.length ? C.r : C.d}${errors.length} errors${C.x}`);
  if (errors.length) {
    console.log(`\n${C.r}QA FAILED — build/push blocked. Fix the ✗ items above.${C.x}\n`);
    process.exit(1);
  }
  console.log(`\n${C.g}QA PASSED — 0 errors.${C.x}\n`);
  process.exit(0);
})();
