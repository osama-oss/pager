'use strict';

/**
 * Digital pager server.
 *
 * Flow:
 *   1. Staff adds an order number (dashboard, or POS via /api/v1).
 *   2. Customer opens the order's link / QR in the phone browser and taps "Enable alerts".
 *   3. Staff presses "Ready" -> a Web Push notification is sent to that customer's phone.
 *
 * Storage is a small JSON file (data/db.json). Swap it for a real DB when you go to production.
 */

const express = require('express');
const webpush = require('web-push');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const path = require('path');

const PORT = process.env.PORT || 3000;

// HTTPS is switched on automatically when certs/key.pem and certs/cert.pem exist (see README, mkcert).
// Phones only allow push notifications on HTTPS pages (or localhost).
const KEY_FILE = path.join(__dirname, 'certs', 'key.pem');
const CERT_FILE = path.join(__dirname, 'certs', 'cert.pem');
const USE_HTTPS = fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE);
const SCHEME = USE_HTTPS ? 'https' : 'http';

// The laptop's address on the Wi-Fi/LAN, put inside the QR codes so phones can reach it.
// Override with HOST_IP=192.168.1.72 if auto-detection picks the wrong network card.
function detectLanIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP;
  const all = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) all.push(n.address);
  }
  return all.find((a) => a.startsWith('192.168.')) || all[0] || 'localhost';
}
const LAN_IP = detectLanIp();
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

// Protects the dashboard + POS API. Set a strong value in production: API_KEY=xxxx npm start
const API_KEY = process.env.API_KEY || 'dev-key';
// Public base URL used inside QR codes (must be reachable from the customer's phone, HTTPS for push).
// Example: PUBLIC_URL=https://abc123.ngrok-free.app
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- VAPID keys
function loadVapid() {
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  return keys;
}
const vapid = loadVapid();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

// ---------------------------------------------------------------- tiny JSON store
let db = { orders: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* start fresh */ }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), (err) => {
      if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {});
    });
  }, 50);
}

// Drop orders older than 12h so the file never grows forever.
function cleanup() {
  const cutoff = Date.now() - 12 * 3600 * 1000;
  const before = db.orders.length;
  db.orders = db.orders.filter((o) => o.createdAt > cutoff);
  if (db.orders.length !== before) save();
}
setInterval(cleanup, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------- helpers
const newToken = () => crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
const publicOrder = (o) => ({
  id: o.id,
  orderNumber: o.orderNumber,
  token: o.token,
  status: o.status,
  createdAt: o.createdAt,
  readyAt: o.readyAt || null,
  subscribed: o.subscriptions.length > 0,
  devices: o.subscriptions.length,
  lastPush: o.lastPush || null,
});
// Links given to customers must work from a phone, so "localhost" is replaced by the LAN address.
const baseUrl = (req) => {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return `${SCHEME}://${LAN_IP}:${PORT}`;
  return `${req.protocol}://${req.get('host')}`;
};
const trackUrl = (req, o) => `${baseUrl(req)}/p/${o.token}`;

function requireKey(req, res, next) {
  const key = req.get('x-api-key') || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

async function pushToOrder(order, payload) {
  const body = JSON.stringify(payload);
  const results = [];
  for (const sub of [...order.subscriptions]) {
    try {
      await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
      results.push({ ok: true });
    } catch (err) {
      results.push({ ok: false, status: err.statusCode, message: err.body || err.message });
      // 404/410 = subscription expired or user revoked permission -> forget it
      if (err.statusCode === 404 || err.statusCode === 410) {
        order.subscriptions = order.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
      }
    }
  }
  const sent = results.filter((r) => r.ok).length;
  order.lastPush = { at: Date.now(), sent, failed: results.length - sent, details: results.filter((r) => !r.ok) };
  save();
  return order.lastPush;
}

// ---------------------------------------------------------------- app
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- customer-facing (no auth, protected by the unguessable token)
app.get('/p/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pager.html')));

// Per-order manifest so "Add to Home Screen" (needed for push on iPhone) reopens the same order.
app.get('/p/:token/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'Order Pager',
    short_name: 'Pager',
    start_url: `/p/${req.params.token}`,
    scope: '/',
    display: 'standalone',
    background_color: '#0f172a',
    theme_color: '#0f172a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
});

app.get('/api/vapid-public-key',(req, res) => res.json({ key: vapid.publicKey }));

app.get('/api/track/:token', (req, res) => {
  const o = db.orders.find((x) => x.token === req.params.token);
  if (!o) return res.status(404).json({ error: 'not_found' });
  res.json({ orderNumber: o.orderNumber, status: o.status, readyAt: o.readyAt || null });
});

app.post('/api/track/:token/subscribe', (req, res) => {
  const o = db.orders.find((x) => x.token === req.params.token);
  if (!o) return res.status(404).json({ error: 'not_found' });
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'bad_subscription' });
  o.subscriptions = o.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
  o.subscriptions.push(sub);
  save();
  res.json({ ok: true });
});

app.post('/api/track/:token/unsubscribe', (req, res) => {
  const o = db.orders.find((x) => x.token === req.params.token);
  if (!o) return res.status(404).json({ error: 'not_found' });
  const endpoint = req.body && req.body.endpoint;
  o.subscriptions = o.subscriptions.filter((s) => s.endpoint !== endpoint);
  save();
  res.json({ ok: true });
});

// ---------- staff / POS API (x-api-key header). Same endpoints serve the dashboard and a POS integration.
const api = express.Router();
api.use(requireKey);

// List active orders
api.get('/orders', (req, res) => {
  const list = [...db.orders].sort((a, b) => b.createdAt - a.createdAt).map((o) => ({ ...publicOrder(o), url: trackUrl(req, o) }));
  res.json({ orders: list });
});

// Create an order: { orderNumber: "42" }  (re-using an active number returns the existing order)
api.post('/orders', (req, res) => {
  const orderNumber = String((req.body && req.body.orderNumber) || '').trim().slice(0, 20);
  if (!orderNumber) return res.status(400).json({ error: 'orderNumber_required' });
  let o = db.orders.find((x) => x.orderNumber === orderNumber && x.status !== 'collected');
  if (!o) {
    o = {
      id: crypto.randomUUID(),
      orderNumber,
      token: newToken(),
      status: 'waiting',
      createdAt: Date.now(),
      readyAt: null,
      subscriptions: [],
    };
    db.orders.push(o);
    save();
  }
  res.status(201).json({ ...publicOrder(o), url: trackUrl(req, o) });
});

// QR code (SVG) pointing to the customer's pager page
api.get('/orders/:id/qr.svg', async (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).end();
  const svg = await QRCode.toString(trackUrl(req, o), { type: 'svg', margin: 1, width: 240 });
  res.type('image/svg+xml').send(svg);
});

// Mark ready + push notification. Accepts the internal id OR the order number (handy for a POS).
api.post('/orders/:ref/ready', async (req, res) => {
  const ref = req.params.ref;
  const o = db.orders.find((x) => x.id === ref) || db.orders.find((x) => x.orderNumber === ref && x.status !== 'collected');
  if (!o) return res.status(404).json({ error: 'not_found' });
  o.status = 'ready';
  o.readyAt = Date.now();
  const push = await pushToOrder(o, {
    title: `Order #${o.orderNumber} is ready`,
    body: 'Your order is ready for pickup.',
    orderNumber: o.orderNumber,
    url: `/p/${o.token}`,
  });
  res.json({ ...publicOrder(o), push });
});

// Send the notification again (customer missed it)
api.post('/orders/:ref/renotify', async (req, res) => {
  const ref = req.params.ref;
  const o = db.orders.find((x) => x.id === ref) || db.orders.find((x) => x.orderNumber === ref && x.status !== 'collected');
  if (!o) return res.status(404).json({ error: 'not_found' });
  const push = await pushToOrder(o, {
    title: `Order #${o.orderNumber} is ready`,
    body: 'Reminder: your order is waiting for you.',
    orderNumber: o.orderNumber,
    url: `/p/${o.token}`,
  });
  res.json({ ...publicOrder(o), push });
});

api.post('/orders/:ref/collected', (req, res) => {
  const ref = req.params.ref;
  const o = db.orders.find((x) => x.id === ref) || db.orders.find((x) => x.orderNumber === ref && x.status !== 'collected');
  if (!o) return res.status(404).json({ error: 'not_found' });
  o.status = 'collected';
  o.subscriptions = [];
  save();
  res.json(publicOrder(o));
});

api.delete('/orders/:id', (req, res) => {
  db.orders = db.orders.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.use('/api', api);

const server = USE_HTTPS
  ? https.createServer({ key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) }, app)
  : http.createServer(app);

// 0.0.0.0 = reachable from other devices on the network, not only this laptop.
server.listen(PORT, '0.0.0.0', () => {
  console.log('Pager is running.');
  console.log(`  Dashboard (laptop):  ${SCHEME}://localhost:${PORT}/`);
  console.log(`  Phone / LAN:         ${PUBLIC_URL || `${SCHEME}://${LAN_IP}:${PORT}`}/`);
  console.log(`  API key:             ${API_KEY === 'dev-key' ? 'dev-key  (change with API_KEY=...)' : '(from API_KEY env)'}`);
  if (!USE_HTTPS && !PUBLIC_URL) {
    console.log('\n  NOTE: plain http on a LAN address works for the dashboard, but phones will NOT allow');
    console.log('  push notifications on it. Use HTTPS (README: "Test on your phone") or an https tunnel.');
  }
});
