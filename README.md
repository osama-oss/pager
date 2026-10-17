# Pager

A digital pager (like Bajri): the customer's phone replaces the plastic pager. No app, no account.
Staff adds an order number, the customer opens the order link or QR in the phone browser and taps **Enable alerts**, and when the order is ready a **Web Push** notification is sent to that phone.

This repo contains only the pager part plus a test dashboard. There is no POS; the same HTTP API the dashboard uses is what a POS will call later.

## Run it

```bash
npm install
npm start                 # http://localhost:3000
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `API_KEY` | `dev-key` | Key required by the dashboard and the POS API (`x-api-key` header). **Change it.** |
| `PUBLIC_URL` | request host | Public HTTPS base URL put inside the QR codes |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact for the push service, use your real email |

VAPID keys are generated on first start and stored in `data/vapid.json`. Do not delete this file after customers subscribe, or their subscriptions stop working.

## Test it (dashboard)

1. Open `http://localhost:3000`, type an order number, press **Add order**. A QR / link dialog appears.
2. Press **Open as customer** (or scan the QR on a phone). Tap **Enable alerts** and allow notifications.
3. Back on the dashboard press **Ready + Push**. The notification arrives, the customer page turns green, vibrates and beeps.

## Test on your phone (laptop on your Wi-Fi, e.g. 192.168.1.72)

The server listens on your whole network and puts your laptop's LAN address in the QR codes (auto-detected; force it with `HOST_IP=192.168.1.72`). Phone and laptop must be on the same Wi-Fi.

**Important:** browsers only allow service workers and push on **HTTPS** pages (or `localhost`). `http://192.168.1.72:3000` opens fine but the phone will refuse "Enable alerts". Pick one:

**Option A: HTTPS with mkcert (recommended, works offline on your LAN)**

```bash
# install mkcert once: https://github.com/FiloSottile/mkcert  (Windows: choco install mkcert / scoop install mkcert; Mac: brew install mkcert)
mkcert -install
mkdir certs
mkcert -key-file certs/key.pem -cert-file certs/cert.pem 192.168.1.72 localhost
npm start          # now serves https://192.168.1.72:3000 automatically
```

Then make the phone trust the mkcert certificate authority: run `mkcert -CAROOT`, send `rootCA.pem` from that folder to the phone, and install it
- Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate.
- iPhone: open the file, install the profile, then Settings > General > About > Certificate Trust Settings > enable it.

**Option B: public HTTPS tunnel (no certificate setup)**

```bash
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
PUBLIC_URL=https://<the-url-it-prints> npm start
```

**Option C (Android Chrome only, quick hack):** on the phone open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.1.72:3000`, enable it, relaunch Chrome.

If the phone cannot even open the page, allow the port in the laptop firewall (Windows: Defender Firewall > allow Node.js on Private networks, or `netsh advfirewall firewall add rule name=pager dir=in action=allow protocol=TCP localport=3000`).

Push messages are delivered through Google/Apple/Mozilla push servers, so the **laptop also needs internet access** when you press Ready + Push.

Platform notes:
- **Android (Chrome/Edge/Samsung):** works straight from the browser tab.
- **iPhone (iOS 16.4+):** push only works for a site added to the Home Screen (Share, then "Add to Home Screen"), opened from there. The customer page shows this hint automatically. The page also updates by polling while it is open.
- If the customer denies notifications, the page still flips to "READY" by itself while it is open.

## POS integration API

All calls need the header `x-api-key: <API_KEY>`.

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| `POST` | `/api/orders` | `{"orderNumber":"42"}` | Create the order. Returns `url` (customer link, put it in a QR or a receipt) |
| `GET` | `/api/orders/:id/qr.svg` | | QR code image for the order |
| `POST` | `/api/orders/:ref/ready` | | Mark ready and push. `:ref` is the order id **or the order number** |
| `POST` | `/api/orders/:ref/renotify` | | Send the push again |
| `POST` | `/api/orders/:ref/collected` | | Close the order |
| `GET` | `/api/orders` | | List orders |
| `DELETE` | `/api/orders/:id` | | Remove an order |

Example from any POS or script:

```bash
curl -X POST http://localhost:3000/api/orders -H "x-api-key: dev-key" -H "content-type: application/json" -d '{"orderNumber":"42"}'
curl -X POST http://localhost:3000/api/orders/42/ready -H "x-api-key: dev-key"
```

## Structure

```
server.js            Express API, VAPID keys, JSON storage, push sending
public/index.html    Test dashboard (add order, QR, Ready + Push)
public/pager.html    Customer page at /p/<token> (AR/EN, enable alerts, ready screen)
public/sw.js         Service worker that shows the notification
data/                db.json + vapid.json (created at runtime)
```

## Before production

- Replace the JSON file with a real database (Postgres/SQLite) and the shared `API_KEY` with per-venue keys.
- Add multi-tenant support (venue id on orders), rate limiting and an HTTPS reverse proxy.
- Orders older than 12 hours are cleaned up automatically.
