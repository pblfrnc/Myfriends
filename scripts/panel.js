#!/usr/bin/env node
'use strict';
// Painel do MyFriends no navegador: quem está online, conversa das salas, tarefas e reservas.
//   myfriends painel [--port 4800] [--no-open]
// Só escuta em 127.0.0.1, com um token aleatório no endereço; nada sai da sua máquina.
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const H = require('./hub');
const { parse } = require('./myfriends');

const PAGE = fs.readFileSync(require('path').join(__dirname, 'panel.html'), 'utf8');

function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch {}
}

function createServer({ hub = new H.Hub().init(), token = crypto.randomBytes(16).toString('hex') } = {}) {
  const me = new Map(); // sala → sessão do painel (para enviar como "Você")
  const panelSession = (room) => {
    const cur = me.get(room);
    if (cur && hub.alive(hub.getSession(cur))) return cur;
    const s = hub.join({ tool: 'outro', name: 'Você (painel)', folder: process.cwd(), room, pid: process.pid });
    me.set(room, s.id);
    return s.id;
  };
  const state = (room) => {
    const sessions = hub.sessions().filter((s) => !me.has(s.room) || me.get(s.room) !== s.id);
    const rooms = hub.rooms().map((r) => ({ ...r, online: sessions.filter((s) => s.room === r.name).length }));
    const cur = room && rooms.some((r) => r.name === room) ? room : (rooms.find((r) => r.online) || rooms[0])?.name || null;
    const messages = cur ? hub.messages(cur, { limit: 200 }) : [];
    const board = cur ? hub.board(cur) : { tasks: [], claims: [] };
    return { version: H.VERSION, config: hub.config(), sessions, rooms, room: cur, messages, board, hub: hub.dir };
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const clients = new Set();
  let lastSig = '';
  const sig = () => {
    try {
      const parts = [];
      for (const d of ['sessions', 'rooms']) {
        for (const f of fs.readdirSync(hub.p(d))) {
          const p = d === 'rooms' ? hub.roomFile(f) : hub.p(d, f);
          try { const st = fs.statSync(p); parts.push(`${f}:${st.size}:${st.mtimeMs}`); } catch {}
        }
      }
      return parts.sort().join('|');
    } catch { return ''; }
  };
  const timer = setInterval(() => {
    const s = sig();
    if (s !== lastSig) { lastSig = s; for (const c of clients) c.write('event: change\ndata: {}\n\n'); }
  }, 700);
  timer.unref();

  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'host' });
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== token) return send(res, 404, 'Não encontrado. Abra o endereço completo que o comando "myfriends painel" mostrou.', 'text/plain; charset=utf-8');
    const route = `/${parts.slice(1).join('/')}`;
    try {
      if (req.method === 'GET' && route === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && route === '/api/state') return send(res, 200, state(url.searchParams.get('room')));
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && (route === '/api/send' || route === '/api/config')) {
        if (req.headers['x-myfriends'] !== '1') return send(res, 403, { error: 'csrf' });
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
        req.on('end', () => {
          try {
            const b = JSON.parse(body || '{}');
            if (route === '/api/config') return send(res, 200, hub.setConfig({ wake: b.wake, notify: b.notify }));
            const room = H.normRoom(String(b.room || ''));
            const text = String(b.text || '').trim();
            if (!text) return send(res, 400, { error: 'Escreva a mensagem.' });
            const type = ['chat', 'task'].includes(b.type) ? b.type : 'chat';
            const m = hub.post(room, panelSession(room), { text, type, to: b.to || undefined });
            return send(res, 200, { message: m });
          } catch (e) { return send(res, 400, { error: e.message }); }
        });
        return;
      }
      return send(res, 404, { error: 'rota' });
    } catch (e) { return send(res, 500, { error: e.message }); }
  });
  server.on('close', () => { clearInterval(timer); for (const id of me.values()) { try { hub.leave(id); } catch {} } });
  return { server, token };
}

async function main(argv = process.argv.slice(2)) {
  const o = parse(argv);
  const { server, token } = createServer();
  const port = Number(o.port) || 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/${token}/`;
  console.log(`MyFriends ${H.VERSION} — painel aberto em:\n  ${url}\n(Ctrl+C para fechar. O endereço só funciona neste computador.)`);
  if (!o['no-open']) openBrowser(url);
  return new Promise((resolve) => {
    const stop = () => { server.close(); resolve(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

if (require.main === module) main().then((c) => { process.exitCode = c; });

module.exports = { main, createServer };
