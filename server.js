const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public', {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
  }
}));

// Railway health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Public URL detection (Railway sets RAILWAY_PUBLIC_DOMAIN)
function getPublicUrl(req) {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  return null;
}

const users = new Map();
const textChannels = new Map();
const voiceChannels = new Map();
let hostId = null;

// Music bot state
const musicState = {
  playing: false,
  videoId: null,
  search: null,
  startedAt: null,
  pausedOffset: 0,
  queue: []
};

function broadcastMusicState() {
  broadcastAll({ type: 'music-state', state: Object.assign({}, musicState) });
}

['general', 'random', 'announcements'].forEach(name => textChannels.set(name, []));
['General Voice', 'Gaming', 'Music'].forEach(name => voiceChannels.set(name, new Set()));

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcast(data, exclude) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(msg); });
}

function getState() {
  return {
    users: Array.from(users.values()).map(u => ({
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar || null,
      textChannel: u.textChannel,
      voiceChannel: u.voiceChannel,
      serverMuted: u.serverMuted || false
    })),
    textChannels: Array.from(textChannels.keys()),
    voiceChannels: Array.from(voiceChannels.keys()),
    hostId
  };
}

wss.on('connection', (ws) => {
  const id = Math.random().toString(36).substr(2, 9);
  if (!hostId) hostId = id;

  users.set(ws, { id, nickname: null, avatar: null, textChannel: 'general', voiceChannel: null, serverMuted: false });

  sendTo(ws, {
    type: 'init',
    id,
    state: getState(),
    history: Object.fromEntries(
      Array.from(textChannels.entries()).map(([k, v]) => [k, v.slice(-100)])
    ),
    lanIp: getLanIp(),
    port: process.env.PORT || 3000,
    publicUrl: getPublicUrl()
  });

  ws.on('message', (raw) => {
    const user = users.get(ws);
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'set-nickname') {
      user.nickname = (msg.nickname || '').trim().substring(0, 32) || 'Anonymous';
      broadcastAll({ type: 'user-update', state: getState() });

    } else if (msg.type === 'set-avatar') {
      const a = typeof msg.avatar === 'string' ? msg.avatar : null;
      user.avatar = (a && a.length < 200000) ? a : null;
      broadcastAll({ type: 'user-update', state: getState() });

    } else if (msg.type === 'text-message') {
      const ch = msg.channel;
      if (!textChannels.has(ch)) return;
      const message = {
        id: Math.random().toString(36).substr(2, 9),
        sender: user.nickname || 'Anonymous',
        senderId: user.id,
        content: (msg.content || '').trim().substring(0, 2000),
        channel: ch,
        timestamp: Date.now()
      };
      const hist = textChannels.get(ch);
      hist.push(message);
      if (hist.length > 200) hist.shift();
      broadcastAll({ type: 'text-message', message });

    } else if (msg.type === 'file-message') {
      const ch = msg.channel;
      if (!textChannels.has(ch)) return;
      const MAX_B64 = 8 * 1024 * 1024 * 1.4;
      if (!msg.data || typeof msg.data !== 'string' || msg.data.length > MAX_B64) return;
      const fileMsg = {
        id: Math.random().toString(36).substr(2, 9),
        sender: user.nickname || 'Anonymous',
        senderId: user.id,
        channel: ch,
        timestamp: Date.now(),
        filename: (msg.filename || 'file').substring(0, 255),
        mimetype: (msg.mimetype || 'application/octet-stream').substring(0, 128),
        size: msg.size || 0,
        fileData: msg.data
      };
      broadcastAll({ type: 'file-message', message: fileMsg });

    } else if (msg.type === 'music-command') {
      switch (msg.command) {
        case 'play':
          if (msg.videoId) { musicState.videoId = msg.videoId; musicState.search = null; }
          else if (msg.search) { musicState.search = msg.search; musicState.videoId = null; }
          else break;
          musicState.playing = true;
          musicState.startedAt = Date.now();
          musicState.pausedOffset = 0;
          break;
        case 'pause':
          if (musicState.playing && musicState.startedAt !== null) {
            musicState.pausedOffset += (Date.now() - musicState.startedAt) / 1000;
            musicState.playing = false;
            musicState.startedAt = null;
          }
          break;
        case 'resume':
          if (!musicState.playing && (musicState.videoId || musicState.search)) {
            musicState.playing = true;
            musicState.startedAt = Date.now();
          }
          break;
        case 'stop':
          musicState.playing = false;
          musicState.videoId = null;
          musicState.search = null;
          musicState.startedAt = null;
          musicState.pausedOffset = 0;
          musicState.queue = [];
          break;
        case 'skip':
          if (musicState.queue.length > 0) {
            const nxt = musicState.queue.shift();
            musicState.videoId = nxt.videoId || null;
            musicState.search = nxt.search || null;
            musicState.playing = true;
            musicState.startedAt = Date.now();
            musicState.pausedOffset = 0;
          } else {
            musicState.playing = false;
            musicState.videoId = null;
            musicState.search = null;
            musicState.startedAt = null;
            musicState.pausedOffset = 0;
          }
          break;
        case 'queue':
          if (msg.videoId || msg.search) {
            musicState.queue.push({ videoId: msg.videoId || null, search: msg.search || null });
          }
          break;
      }
      broadcastMusicState();

    } else if (msg.type === 'create-text-channel') {
      const name = (msg.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 32);
      if (name && !textChannels.has(name)) {
        textChannels.set(name, []);
        broadcastAll({ type: 'user-update', state: getState() });
      }

    } else if (msg.type === 'create-voice-channel') {
      const name = (msg.name || '').trim().substring(0, 32);
      if (name && !voiceChannels.has(name)) {
        voiceChannels.set(name, new Set());
        broadcastAll({ type: 'user-update', state: getState() });
      }

    } else if (msg.type === 'join-voice') {
      if (user.voiceChannel) {
        voiceChannels.get(user.voiceChannel) && voiceChannels.get(user.voiceChannel).delete(user.id);
        broadcast({ type: 'user-left-voice', userId: user.id, channel: user.voiceChannel }, ws);
      }
      const ch = msg.channel;
      if (ch && voiceChannels.has(ch)) {
        user.voiceChannel = ch;
        voiceChannels.get(ch).add(user.id);
        const existingPeers = Array.from(users.entries())
          .filter(([s, u]) => s !== ws && u.voiceChannel === ch)
          .map(([s, u]) => u.id);
        sendTo(ws, { type: 'voice-peers', peers: existingPeers, channel: ch });
        broadcast({ type: 'user-joined-voice', userId: user.id, channel: ch }, ws);
      }
      broadcastAll({ type: 'user-update', state: getState() });

    } else if (msg.type === 'leave-voice') {
      if (user.voiceChannel) {
        voiceChannels.get(user.voiceChannel) && voiceChannels.get(user.voiceChannel).delete(user.id);
        broadcastAll({ type: 'user-left-voice', userId: user.id, channel: user.voiceChannel });
        user.voiceChannel = null;
        broadcastAll({ type: 'user-update', state: getState() });
      }

    } else if (msg.type === 'host-mute') {
      if (user.id !== hostId) return;
      const entry = Array.from(users.entries()).find(([s, u]) => u.id === msg.target);
      if (entry) {
        const [tws, tu] = entry;
        tu.serverMuted = !tu.serverMuted;
        sendTo(tws, { type: 'server-mute', muted: tu.serverMuted });
        broadcastAll({ type: 'user-update', state: getState() });
      }

    } else if (msg.type === 'host-kick') {
      if (user.id !== hostId) return;
      const entry = Array.from(users.entries()).find(([s, u]) => u.id === msg.target);
      if (entry) {
        sendTo(entry[0], { type: 'kicked' });
        setTimeout(() => entry[0].close(), 200);
      }

    } else if (msg.type === 'rtc-offer' || msg.type === 'rtc-answer' || msg.type === 'rtc-ice') {
      const entry = Array.from(users.entries()).find(([s, u]) => u.id === msg.target);
      if (entry) sendTo(entry[0], Object.assign({}, msg, { from: user.id }));
    }
  });

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      if (user.voiceChannel) {
        voiceChannels.get(user.voiceChannel) && voiceChannels.get(user.voiceChannel).delete(user.id);
        broadcastAll({ type: 'user-left-voice', userId: user.id, channel: user.voiceChannel });
      }
      const wasHost = user.id === hostId;
      users.delete(ws);
      if (wasHost) {
        const remaining = Array.from(users.values());
        hostId = remaining.length ? remaining[0].id : null;
      }
    }
    broadcastAll({ type: 'user-update', state: getState() });
  });
});

const PORT = process.env.PORT || 3000;
const LAN = getLanIp();
server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  Rescord Running');
  console.log('========================================');
  console.log('\n  Local:    http://localhost:' + PORT);
  console.log('  LAN:      http://' + LAN + ':' + PORT);
  console.log('\n  Internet: npx ngrok http ' + PORT);
  console.log('            Share the https:// URL\n');
});
