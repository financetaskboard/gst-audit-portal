# GST Audit Portal

A local audit portal for GST reconciliation with Odoo integration.

Syncs GSTR-1, GSTR-2B, GSTR-3B, RCM, ISD (GSTR-6), and ITC books.
Data is stored server-side in `gst-portal-state.json` — survives browser cache clears and works across all browsers on the same machine.

---

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (LTS version)

### 2. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/gst-audit-portal.git
cd gst-audit-portal
```

### 3. Install dependencies
```bash
npm install
```

### 4. Start the server
```bash
npm start
```

### 5. Open the portal
Go to → **http://localhost:3002/gst-audit-portal.html**

---

## Files

| File | Purpose |
|---|---|
| `gst-server.js` | Express proxy server (port 3002) — Odoo sync + state persistence |
| `gst-audit-portal.html` | The full portal UI (single-file) |
| `storage-bridge.js` | Syncs all portal state to the server instead of browser localStorage |
| `gst-portal-state.json` | **Auto-created at runtime** — your saved GST data (gitignored) |
| `gst-odoo-settings.json` | **Auto-created at runtime** — your Odoo credentials (gitignored) |

---

## How Storage Works

```
SAVE:  App → localStorage (instant) + POST /api/state/:key (async, server file)
LOAD:  GET /api/state (server) → seed localStorage → App reads localStorage
```

- **localStorage** — instant cache, used as the working copy
- **gst-portal-state.json** — durable file on your machine (server-backed)
- If the server is unreachable (e.g. opened as a raw HTML file), the app silently falls back to localStorage-only

---

## Odoo Setup

Configure your Odoo connection from the portal's **Settings** tab (⚙️ icon in the top bar).  
Credentials are stored in `gst-odoo-settings.json` and are excluded from git.

---

## API Endpoints

| Method | URL | Description |
|---|---|---|
| `GET` | `/api/state` | Load all saved portal state |
| `POST` | `/api/state/:key` | Save a single state key |
| `DELETE` | `/api/state` | Wipe all saved state |
| `POST` | `/api/test` | Test Odoo connection |
| `POST` | `/api/sync/sales` | Sync sales invoices from Odoo |
| `POST` | `/api/sync/credit` | Sync credit notes from Odoo |
| `POST` | `/api/sync/rcm` | Sync RCM accounts |
| `POST` | `/api/sync/itc` | Sync ITC books |
| `GET` | `/health` | Server health check |
