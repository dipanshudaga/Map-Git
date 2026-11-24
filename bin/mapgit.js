#!/usr/bin/env node
'use strict';
// Map Git: a small local server. It serves the page and passes GitHub API
// requests on, with your own GitHub sign-in added. The sign-in never reaches the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = (process.env.MAPGIT_API || 'https://api.github.com').replace(/\/$/, '');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/favicon.png': ['favicon.png', 'image/png'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };

const HELP = `Map Git ${VERSION}
Map Git shows a GitHub repository as a map of branches and commits.

Usage:
  mapgit [owner/repo | github-url] [options]
  mapgit update         Update Map Git to the newest version

If you give no repository, Map Git opens the GitHub remote of the
current folder. If the folder has no GitHub remote, Map Git opens an
empty canvas.

Options:
  -p, --port <number>   Use this port (default: 4747)
      --no-open         Do not open the browser
  -v, --version         Show the version
  -h, --help            Show this help

Login:
  Map Git uses your GitHub CLI login. To log in, run "gh auth login".
  Map Git also reads the GITHUB_TOKEN variable.
  A login opens private repositories. It also raises the GitHub limit
  from 60 to 5,000 requests each hour.
`;

// ---- terminal look: one accent color, dim labels, thin rules ----
const tty = !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '');
const paint = (code, text) => tty ? `\x1b[${code}m${text}\x1b[0m` : String(text);
const ui = {
  accent: t => paint(truecolor ? '38;2;139;92;246' : '38;5;99', t),
  bold: t => paint('1', t), dim: t => paint('2', t), green: t => paint('32', t), yellow: t => paint('33', t), red: t => paint('31', t),
};
const unicode = process.platform === 'win32' ? !!(process.env.WT_SESSION || process.env.TERM_PROGRAM) : /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const plain = t => unicode ? t : t.replace(/─/g, '-').replace(/[◆●]/g, '*').replace(/○/g, 'o').replace(/✓/g, '+').replace(/✗/g, 'x').replace(/›/g, '>').replace(/·/g, '.');
const out = t => process.stdout.write(plain(t));
const PAD = '  ', RULE = ui.dim('─'.repeat(44));
const row = (label, value, note) => PAD + ui.dim(label.padEnd(12)) + value + '\n' + (note ? PAD + ' '.repeat(12) + ui.dim(note) + '\n' : '');
const heading = text => `${PAD}${ui.accent('◆')} ${ui.bold('Map Git')}${text ? ui.dim('  ' + text) : ''}\n${PAD}${RULE}\n`;

// A new user needs to know three things: Map Git runs, where to go, and what to do next. A returning user needs only the first two.
// So the notes appear only when they help: no repository, no login, a busy port, or a tip for npx users.
function banner({ address, name, fromFolder, token, ghMissing, update, opening, portMoved, wantedPort, tip }) {
  let out = '\n';
  if (update) out += PAD + ui.green(`Update ${update} available. Run: ${updateCommand()}`) + '\n\n';
  out += heading('v' + VERSION);
  out += row('Status', ui.green('●') + ' Running', '');
  out += row('Address', address, portMoved ? `Port ${wantedPort} is busy. Map Git uses this port.` : opening ? 'Opening in your browser' : 'Open this address in your browser');
  out += row('Repository', name ? ui.bold(name) + (fromFolder ? ui.dim('  (this folder)') : '') : ui.dim('none yet'), name ? '' : 'Paste a GitHub link in the browser');
  out += row('GitHub', token ? ui.green('●') + ' Logged in' : ui.yellow('○') + ' Not logged in', token ? '' : 'Public repos work. 60 requests each hour.');
  if (!token) {
    out += PAD + RULE + '\n';
    out += ghMissing
      ? row('Optional', ui.accent('https://cli.github.com'), 'Install the GitHub CLI, then run: gh auth login') + row('', ui.dim('This opens private repos and 5,000 requests each hour.'))
      : row('Optional', ui.accent('gh auth login'), 'Opens private repos and 5,000 requests each hour.') + row('', ui.dim('Then start Map Git again.'));
  }
  if (tip) out += (token ? PAD + RULE + '\n' : '') + row('Tip', ui.accent('npm install --global mapgit'), 'Then type mapgit, and update with mapgit update.');
  out += PAD + RULE + '\n' + PAD + ui.dim('Press Ctrl+C to stop') + '\n';
  return out;
}

// ---- how Map Git runs decides which update command is right ----
const runMode = () => ROOT.includes('_npx') ? 'npx' : fs.existsSync(path.join(ROOT, '.git')) ? 'source' : 'installed';
const updateCommand = () => ({ npx: 'npx mapgit@latest', source: 'git pull', installed: 'mapgit update' })[runMode()];

// ---- update check and the "mapgit update" command ----
const REGISTRY = process.env.MAPGIT_REGISTRY || 'https://registry.npmjs.org/mapgit/latest';
const CACHE = path.join(os.tmpdir(), 'mapgit-update-check.json');
const saveCache = patch => { let c = {}; try { c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* no cache yet */ } try { fs.writeFileSync(CACHE, JSON.stringify({ ...c, ...patch })); } catch { /* ignore */ } };
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function latestVersion(ms = 4000) {
  try { const r = await fetch(REGISTRY, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } }); return r.ok ? String((await r.json()).version || '') : ''; }
  catch { return ''; }
}
// The notice never slows the start: it reads the last answer from a small cache and refreshes the cache in the background.
// The install tip is for npx users who come back: it shows on runs 2, 3 and 4, never on the first run, so a new user sees only what they need.
function npxTip() {
  if (runMode() !== 'npx' || process.env.MAPGIT_NO_UPDATE_CHECK) return false;
  let c = {}; try { c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* no cache yet */ }
  const run = (c.runs || 0) + 1; saveCache({ runs: run });
  return run >= 2 && run <= 4;
}
function updateNotice() {
  if (process.env.MAPGIT_NO_UPDATE_CHECK) return '';
  let c = {}; try { c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* no cache yet */ }
  if (!c.t || Date.now() - c.t > 12 * 3600e3) latestVersion(3000).then(v => { if (v) saveCache({ t: Date.now(), latest: v }); });
  return c.latest && newer(c.latest, VERSION) ? c.latest : '';
}
async function update() {
  out('\n' + heading('update'));
  const latest = await latestVersion();
  if (!latest) { console.error(PAD + ui.red('✗') + ' Map Git cannot reach the npm registry.\n' + PAD + ui.dim('Check your internet connection and try again.\n')); process.exit(1); }
  out(row('Installed', 'v' + VERSION) + row('Latest', 'v' + latest));
  saveCache({ t: Date.now(), latest });
  const done = (mark, text, note) => { out(PAD + RULE + '\n' + PAD + mark + ' ' + text + '\n' + (note ? PAD + '  ' + ui.dim(note) + '\n' : '') + '\n'); };
  if (!newer(latest, VERSION)) return done(ui.green('✓'), 'Map Git is up to date.');
  if (ROOT.includes('_npx')) { out(PAD + RULE + '\n' + PAD + ui.yellow('●') + ' You run Map Git with npx.\n' + PAD + '  ' + ui.dim('npx can keep an old copy.') + '\n\n' + row('Run now', ui.accent('npx mapgit@latest')) + row('Or install', ui.accent('npm install --global mapgit'), 'Then update any time with: mapgit update') + '\n'); return; }
  if (fs.existsSync(path.join(ROOT, '.git'))) return done(ui.yellow('●'), 'You run Map Git from a source folder.', 'To update, run: git pull');
  const args = ['install', '--global', 'mapgit@latest'];
  if (process.env.MAPGIT_DRY_RUN) return done(ui.dim('·'), 'Dry run. Map Git would run:', 'npm ' + args.join(' '));
  out(PAD + RULE + '\n' + PAD + ui.accent('›') + ` Updating to v${latest}...\n\n`);
  const code = await new Promise(res => { const c = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit' }); c.on('error', () => res(1)); c.on('close', res); });
  if (code === 0) return done(ui.green('✓'), `Updated to v${latest}.`, 'Run mapgit again to use it.');
  console.error('\n' + PAD + ui.red('✗') + ' The update failed.\n' + PAD + ui.dim('If npm shows a permission error, run: sudo npm install --global mapgit@latest') + '\n');
  process.exit(1);
}

function parse(argv) {
  const o = { port: 4747, open: true, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '-p' || a === '--port') o.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a.startsWith('-')) { o.bad = a; }
    else o.repo = a;
  }
  return o;
}

function repoName(v) {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/.exec(String(v || '').trim());
  return m ? m[1] + '/' + m[2] : '';
}

// Parse a GitHub remote address: https, ssh://, or git@github.com:owner/repo(.git)
function remoteRepo(url) {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^@\/]+@)?|[^@\/\s]+@)github\.com[:\/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? m[1] + '/' + m[2] : '';
}

// The GitHub repository of the current folder, if it has one (prefers the "origin" remote).
function folderRepo() {
  return new Promise(resolve => {
    execFile('git', ['remote', '-v'], { timeout: 3000, windowsHide: true }, (err, out) => {
      if (err) return resolve('');
      const remotes = {};
      for (const line of String(out).split('\n')) { const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line); if (m) remotes[m[1]] = m[2]; }
      const order = ['origin', ...Object.keys(remotes).filter(k => k !== 'origin')];
      for (const k of order) { const r = remoteRepo(remotes[k]); if (r) return resolve(r); }
      resolve('');
    });
  });
}

function findToken() {
  return new Promise(resolve => {
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env) return resolve({ token: env.trim(), ghMissing: false });
    execFile('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true }, (err, out) => resolve({ token: err ? '' : String(out).trim(), ghMissing: !!(err && err.code === 'ENOENT') }));
  });
}

function createServer(token, port) {
  const own = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return http.createServer(async (req, res) => {
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(body); };
    try {
      // Only this computer's own page may use the server (blocks other sites and DNS tricks).
      if (!own.has(req.headers.host || '')) return send(403, 'text/plain', 'Forbidden');
      if (req.headers.origin && ![...own].some(h => req.headers.origin === 'http://' + h)) return send(403, 'text/plain', 'Forbidden');
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (p === '/api/auth' && req.method === 'GET') return send(200, 'application/json', JSON.stringify({ authed: !!token }));
      if (p === '/gh/graphql' && req.method === 'POST' || p.startsWith('/gh/') && req.method === 'GET') {
        const body = req.method === 'POST' ? await new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > 1e6) { no(new Error('too big')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); }) : undefined;
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'mapgit/' + VERSION };
        if (token) headers.Authorization = 'Bearer ' + token;
        if (body) headers['Content-Type'] = 'application/json';
        let up;
        try { up = await fetch(API + p.slice(3) + url.search, { method: req.method, headers, body }); }
        catch { return send(502, 'application/json', JSON.stringify({ message: 'Cannot reach GitHub' })); }
        const keep = {};
        const type = up.headers.get('content-type') || 'application/json'; for (const h of ['x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset']) { const v = up.headers.get(h); if (v) keep[h] = v; }
        return send(up.status, type, Buffer.from(await up.arrayBuffer()), { ...keep, 'Cache-Control': 'no-store' });
      }
      const a = req.method === 'GET' && ASSETS[p];
      if (a) return send(200, a[1], fs.readFileSync(path.join(ROOT, a[0])));
      return send(404, 'text/plain', 'Not found');
    } catch (e) { send(500, 'text/plain', 'Error'); }
  });
}

function listen(server, port, tries = 10) {
  return new Promise((ok, no) => {
    const tryPort = (n, left) => {
      const onErr = e => { server.removeListener('listening', onOk); if (e.code === 'EADDRINUSE' && left > 0) tryPort(n + 1, left - 1); else no(e); };
      const onOk = () => { server.removeListener('error', onErr); ok(n); };
      server.once('error', onErr); server.once('listening', onOk); server.listen(n, '127.0.0.1');
    };
    tryPort(port, tries);
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }); c.on('error', () => {}); c.unref(); } catch { /* the address is printed anyway */ }
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) return void out(HELP);
  if (o.repo === 'update') return update();
  if (o.version) return void console.log(VERSION);
  if (o.bad) { console.error(`Unknown option: ${o.bad}\n\n${HELP}`); process.exit(2); }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) { console.error('The port must be a number from 1 to 65535.'); process.exit(2); }
  let name = o.repo ? repoName(o.repo) : '', fromFolder = false;
  if (!o.repo) { name = await folderRepo(); fromFolder = !!name; }
  if (o.repo && !name) { console.error(`"${o.repo}" is not a GitHub repository. Use owner/repo or a github.com link.`); process.exit(2); }
  if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Map Git needs Node.js 18 or later.'); process.exit(1); }

  const { token, ghMissing } = await findToken();
  // The port may move up if it is busy, so the server learns its final port after it starts.
  let server, port = o.port;
  for (let i = 0; i < 10; i++) {
    server = createServer(token, port);
    try { await listen(server, port, 0); break; }
    catch (e) { if (e.code === 'EADDRINUSE' && i < 9) { port++; continue; } console.error(`Map Git cannot start the server: ${e.message}`); process.exit(1); }
  }
  const address = `http://127.0.0.1:${port}`, url = address + '/' + (name ? `?repo=${name}` : '');
  out(banner({ address, name, fromFolder, token, ghMissing, update: updateNotice(), opening: o.open, portMoved: port !== o.port, wantedPort: o.port, tip: npxTip() }));
  if (o.open) openBrowser(url);
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (require.main === module) main(); else module.exports = { parse, repoName, remoteRepo, folderRepo, createServer, newer };
