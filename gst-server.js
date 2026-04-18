/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║   GST AUDIT PORTAL — Odoo Proxy + Firebase Server  v2.1     ║
 * ║   Runs on http://localhost:3002  (or Render.com online)      ║
 * ║   Data stored in Firebase Firestore (free, permanent)        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  LOCAL SETUP:
 *    1. npm install
 *    2. Rename your Firebase service-account JSON → serviceAccountKey.json
 *       (or set FIREBASE_SERVICE_ACCOUNT env variable — see README)
 *    3. node gst-server.js
 *    4. Open http://localhost:3002/gst-audit-portal-v5.html
 *
 *  RENDER SETUP:
 *    Environment variable:  FIREBASE_SERVICE_ACCOUNT = <full JSON content>
 *    (copy-paste the entire serviceAccountKey.json content as the value)
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const admin    = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ── Serve portal HTML + bridge script ─────────────────────────
app.use(express.static(__dirname));

// ══════════════════════════════════════════════════════════════
//  FIREBASE INITIALISATION
//  Priority 1: FIREBASE_SERVICE_ACCOUNT env variable (Render)
//  Priority 2: serviceAccountKey.json file (local dev)
// ══════════════════════════════════════════════════════════════
let db = null;
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // ── Render / production ───────────────────────────────────
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('🔥 Firebase: credentials from FIREBASE_SERVICE_ACCOUNT env var');
  } else {
    // ── Local dev — look for serviceAccountKey.json ───────────
    const keyPath = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(keyPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      console.log(`🔥 Firebase: credentials from serviceAccountKey.json (project: ${serviceAccount.project_id})`);
    }
  }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('✅ Firebase Firestore connected');
  } else {
    console.warn('⚠️  No Firebase credentials — data will NOT be saved to Firestore.');
    console.warn('   Locally:  place serviceAccountKey.json next to this file.');
    console.warn('   Render:   set FIREBASE_SERVICE_ACCOUNT env variable.');
  }
} catch (e) {
  console.error('❌ Firebase init error:', e.message);
}

// ══════════════════════════════════════════════════════════════
//  CHUNKED FIRESTORE HELPERS
//
//  Firestore hard limit = 1 MB per document.
//  gst_sales can be 2+ MB with a full year of invoices.
//  Solution: split large arrays into 400-record chunks stored as
//  separate docs, reassemble on read.
//
//  Small values  → gst_state/{key}            { value, updatedAt }
//  Large arrays  → gst_state/{key}            { chunked:true, chunkCount:N, updatedAt }
//                  gst_state/{key}_chunk_0    { items: [...400 records] }
//                  gst_state/{key}_chunk_1    { items: [...400 records] }
//                  …
// ══════════════════════════════════════════════════════════════
const CHUNK_SIZE    = 400;    // records per chunk
const CHUNK_LIMIT   = 900000; // ~900 KB — chunk if JSON string exceeds this

async function fbSave(key, value) {
  if (!db) return;
  const col       = db.collection('gst_state');
  const jsonStr   = JSON.stringify(value);
  const byteSize  = Buffer.byteLength(jsonStr, 'utf8');
  const sizeKB    = Math.round(byteSize / 1024);
  const needChunk = Array.isArray(value) && byteSize > CHUNK_LIMIT;

  if (!needChunk) {
    // ── Small value: single document ────────────────────────────
    await col.doc(key).set({ value, updatedAt: new Date().toISOString() });
    console.log(`  💾 Firebase saved [${key}] — ${sizeKB} KB (single doc)`);
    return;
  }

  // ── Large array: write in chunks ─────────────────────────────
  const chunks     = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }

  // Firestore allows max 500 ops per batch; our chunks are small enough
  // that we can write them in one batch (max ~400 records × 1 batch = fine).
  const batch = db.batch();

  // Metadata doc
  batch.set(col.doc(key), {
    chunked:    true,
    chunkCount: chunks.length,
    totalCount: value.length,
    updatedAt:  new Date().toISOString()
  });

  // Chunk docs
  chunks.forEach((chunk, i) => {
    batch.set(col.doc(`${key}_chunk_${i}`), { items: chunk });
  });

  await batch.commit();
  console.log(`  💾 Firebase saved [${key}] — ${sizeKB} KB across ${chunks.length} chunks (${value.length} records)`);
}

async function fbLoad(key) {
  if (!db) return undefined;
  const col  = db.collection('gst_state');
  const meta = await col.doc(key).get();
  if (!meta.exists) return undefined;
  const data = meta.data();

  if (!data.chunked) {
    // ── Single doc ───────────────────────────────────────────────
    return data.value;
  }

  // ── Chunked: reassemble ──────────────────────────────────────
  const chunkDocs = await Promise.all(
    Array.from({ length: data.chunkCount }, (_, i) =>
      col.doc(`${key}_chunk_${i}`).get()
    )
  );
  const full = [];
  chunkDocs.forEach(d => { if (d.exists) full.push(...(d.data().items || [])); });
  console.log(`  📂 Firebase loaded [${key}] — ${full.length} records from ${data.chunkCount} chunks`);
  return full;
}

async function fbDelete(key) {
  if (!db) return;
  const col  = db.collection('gst_state');
  const meta = await col.doc(key).get();
  if (!meta.exists) return;
  const data = meta.data();

  const batch = db.batch();
  batch.delete(col.doc(key));
  if (data.chunked) {
    for (let i = 0; i < data.chunkCount; i++) {
      batch.delete(col.doc(`${key}_chunk_${i}`));
    }
  }
  await batch.commit();
}

// ── Settings — stored in Firestore ────────────────────────────
async function loadSettings() {
  if (db) {
    try {
      const doc = await db.collection('gst_config').doc('odoo_settings').get();
      if (doc.exists) return doc.data();
    } catch (e) { console.warn('Firestore settings load failed:', e.message); }
  }
  // Fallback to local file (for cold-start before any settings are saved)
  try {
    const localFile = path.join(__dirname, 'gst-odoo-settings.json');
    if (fs.existsSync(localFile)) return JSON.parse(fs.readFileSync(localFile, 'utf8'));
  } catch (e) {}
  return {
    url:      'https://ginesys.odoo.com',
    db:       'ginesys',
    username: 'kunal.g@gsl.in',
    apiKey:   ''
  };
}

async function saveSettings(data) {
  if (db) {
    try {
      await db.collection('gst_config').doc('odoo_settings').set(data);
      return;
    } catch (e) { console.warn('Firestore settings save failed:', e.message); }
  }
  // Fallback: write local file
  fs.writeFileSync(path.join(__dirname, 'gst-odoo-settings.json'), JSON.stringify(data, null, 2));
}

// ── Branch / Company lookup from invoice prefix ────────────────
const BRANCH_MAP = {
  // ── Ginni Systems — Sales & Credit journals ──────────────────
  'SWB':'West Bengal',  'SKN':'Karnataka',  'SEM':'Haryana',
  'SMH':'Maharashtra',  'SHR':'Haryana',    'CMH':'Maharashtra',
  'CHR':'Haryana',      'STN':'Telangana',
  'CWB':'West Bengal',  'CKN':'Karnataka',  'CEM':'Haryana',
  // ── Ginni Systems — Purchase Bill journals (B-prefix) ────────
  'BWB':'West Bengal',  'BHR':'Haryana',    'BTL':'Telangana',
  'BMH':'Maharashtra',  'BKN':'Karnataka',
  // ── Ginni Systems — Debit Note / other journals (D-prefix) ───
  'DHR':'Haryana',      'DKN':'Karnataka',  'DWB':'West Bengal',
  'DMH':'Maharashtra',  'DTL':'Telangana',
  // ── Ginni Systems — BILL journal (Haryana HO) ─────────────────
  'BILL':'Haryana',
  // ── Ginni Systems — GOA branch ───────────────────────────────
  'BGO':'Goa',
  // ── Browntape — Sales, Credit & Purchase journals ─────────────
  'SBTM':'Goa',         'CMS':'Goa',        'SBTE':'Goa',
  'SBT':'Goa',          'CENT':'Goa',       'CDIY':'Goa',
  'BTBIL':'Goa',        'MISBT':'Goa',      'RBTBIL':'Goa',
  'RBTBIL':'Goa',
  // ── Easemy Business ───────────────────────────────────────────
  'BILLE':'Haryana',
  // ── Roxfortech ───────────────────────────────────────────────
  'BILRO':'Haryana',    'CNRX':'Haryana',   'SRX':'Haryana',
  'RBHR':'Haryana',
};
const COMPANY_MAP = {
  // ── Ginni Systems — Sales & Credit ──────────────────────────
  'SWB':'Ginni Systems Ltd',                'SKN':'Ginni Systems Ltd',
  'SEM':'Easemy Business Pvt Ltd',          'SMH':'Ginni Systems Ltd',
  'SHR':'Ginni Systems Ltd',                'CMH':'Ginni Systems Ltd',
  'CHR':'Ginni Systems Ltd',                'STN':'Ginni Systems Ltd',
  'CWB':'Ginni Systems Ltd',                'CKN':'Ginni Systems Ltd',
  'CEM':'Easemy Business Pvt Ltd',
  // ── Ginni Systems — Purchase Bill journals (B-prefix) ────────
  'BWB':'Ginni Systems Ltd',                'BHR':'Ginni Systems Ltd',
  'BTL':'Ginni Systems Ltd',                'BMH':'Ginni Systems Ltd',
  'BKN':'Ginni Systems Ltd',
  // ── Ginni Systems — Debit Note / other journals (D-prefix) ───
  'DHR':'Ginni Systems Ltd',                'DKN':'Ginni Systems Ltd',
  'DWB':'Ginni Systems Ltd',                'DMH':'Ginni Systems Ltd',
  'DTL':'Ginni Systems Ltd',
  // ── Ginni Systems — BILL journal (Haryana HO) ─────────────────
  'BILL':'Ginni Systems Ltd',
  // ── Ginni Systems — GOA branch ───────────────────────────────
  'BGO':'Ginni Systems Ltd',
  // ── Browntape ────────────────────────────────────────────────
  'SBTM':'Browntape Infrosolution Pvt Ltd', 'CMS':'Browntape Infrosolution Pvt Ltd',
  'SBTE':'Browntape Infrosolution Pvt Ltd', 'SBT':'Browntape Infrosolution Pvt Ltd',
  'CENT':'Browntape Infrosolution Pvt Ltd', 'CDIY':'Browntape Infrosolution Pvt Ltd',
  'BTBIL':'Browntape Infrosolution Pvt Ltd','MISBT':'Browntape Infrosolution Pvt Ltd',
  'RBTBIL':'Browntape Infrosolution Pvt Ltd',
  'RBTBIL':'Browntape Infrosolution Pvt Ltd',
  // ── Easemy Business ───────────────────────────────────────────
  'BILLE':'Easemy Business Pvt Ltd',
  // ── Roxfortech ───────────────────────────────────────────────
  'BILRO':'Roxfortech Infosolutions Private Limited',
  'CNRX': 'Roxfortech Infosolutions Private Limited',
  'SRX':  'Roxfortech Infosolutions Private Limited',
  'RBHR': 'Roxfortech Infosolutions Private Limited',
};
const COKEY_MAP = {
  // ── Ginni ────────────────────────────────────────────────────
  'SWB':'gsl', 'SKN':'gsl',  'SEM':'em',    'SMH':'gsl',  'SHR':'gsl',
  'CMH':'gsl', 'CHR':'gsl',  'STN':'gsl',   'CWB':'gsl',  'CKN':'gsl',
  'CEM':'em',
  // ── Ginni purchase bill ──────────────────────────────────────
  'BWB':'gsl', 'BHR':'gsl',  'BTL':'gsl',   'BMH':'gsl',  'BKN':'gsl',
  // ── Ginni debit notes & BILL ─────────────────────────────────
  'DHR':'gsl', 'DKN':'gsl',  'DWB':'gsl',   'DMH':'gsl',  'DTL':'gsl',
  'BILL':'gsl', 'BGO':'gsl',
  // ── Browntape ────────────────────────────────────────────────
  'SBTM':'bt', 'CMS':'bt',   'SBTE':'bt',   'SBT':'bt',
  'CENT':'bt', 'CDIY':'bt',  'BTBIL':'bt',  'MISBT':'bt',  'RBTBIL':'bt',  'RBTBIL':'bt',
  // ── Easemy ────────────────────────────────────────────────────
  'BILLE':'em',
  // ── Roxfortech ───────────────────────────────────────────────
  'BILRO':'roxfo', 'CNRX':'roxfo', 'SRX':'roxfo', 'RBHR':'roxfo'
};

function getBranch(invoiceName) {
  const prefix = (invoiceName || '').match(/^([A-Z]+)/)?.[1] || '';
  return {
    branch:  BRANCH_MAP[prefix]  || prefix || 'Unknown',
    company: COMPANY_MAP[prefix] || 'Unknown',
    coKey:   COKEY_MAP[prefix]   || 'other'
  };
}

// ── Odoo Authenticate ──────────────────────────────────────────
async function odooAuthenticate(url, db, username, password) {
  const baseUrl = url.replace(/\/$/, '');
  const resp = await fetch(`${baseUrl}/web/session/authenticate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db, login: username, password }
    })
  });
  const data = await resp.json();
  if (!data.result || !data.result.uid || data.result.uid === false) {
    const msg = data.result?.message || data.error?.data?.message || 'Invalid credentials';
    throw new Error(`Authentication failed: ${msg}`);
  }
  const uid    = data.result.uid;
  const cookie = resp.headers.get('set-cookie') || '';
  const session = { uid, cookie, baseUrl, companyIds: [] };

  // Fetch ALL company IDs this user can access
  try {
    const userRec = await odooCall(session, 'res.users', 'read', [[uid]], {
      fields: ['company_ids', 'company_id']
    });
    const allCoIds = userRec?.[0]?.company_ids || [];
    if (allCoIds.length) {
      session.companyIds = allCoIds;
      console.log(`   ✅ Multi-company: ${allCoIds.length} companies → [${allCoIds.join(', ')}]`);
    } else {
      const defCo = userRec?.[0]?.company_id?.[0];
      if (defCo) session.companyIds = [defCo];
      console.log(`   ⚠ Single company only: [${session.companyIds}]`);
    }
  } catch (e) {
    console.warn('   ⚠ company fetch failed:', e.message, '— using default company');
  }

  return session;
}

// ── Odoo call_kw ───────────────────────────────────────────────
async function odooCall(session, model, method, args = [], kwargs = {}) {
  const resp = await fetch(`${session.baseUrl}/web/dataset/call_kw`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session.cookie ? { Cookie: session.cookie } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 99999),
      params: {
        model, method, args,
        kwargs: {
          context: {
            lang: 'en_IN',
            ...(session.companyIds?.length
              ? { allowed_company_ids: session.companyIds }
              : {})
          },
          ...kwargs
        }
      }
    })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.data?.message || data.error.message);
  return data.result;
}

// ── Fetch invoices or credit notes (paginated) ────────────────
async function fetchMoves(session, moveType, fromDate, toDate) {
  const BATCH = 500;
  const domain = [
    ['move_type',    '=',  moveType],
    ['invoice_date', '>=', fromDate],
    ['invoice_date', '<=', toDate],
    ['state',        '=',  'posted']
  ];
  const fields = [
    'name', 'invoice_date', 'partner_id', 'ref',
    'amount_untaxed', 'amount_tax', 'amount_total',
    'amount_untaxed_signed', 'amount_tax_signed', 'currency_id',
    'tax_totals', 'invoice_line_ids', 'journal_id'
  ];

  const all = [];
  let offset = 0;
  while (true) {
    const batch = await odooCall(session, 'account.move', 'search_read',
      [domain],
      { fields, limit: BATCH, offset, order: 'invoice_date asc, id asc' }
    );
    all.push(...batch);
    console.log(`   page offset=${offset} → ${batch.length} records (total so far: ${all.length})`);
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return all;
}

// ── Fetch tax lines for CGST/SGST/IGST breakdown ──────────────
async function fetchTaxLines(session, moveIds) {
  if (!moveIds.length) return [];
  const result = [];
  for (let i = 0; i < moveIds.length; i += 500) {
    try {
      const batch = await odooCall(session, 'account.move.line', 'search_read', [[
        ['move_id',     'in', moveIds.slice(i, i + 500)],
        ['tax_line_id', '!=', false]
      ]], {
        fields: ['move_id', 'name', 'tax_line_id', 'debit', 'credit', 'balance'],
        limit:  10000
      });
      result.push(...batch);
    } catch (e) { console.warn('  Tax line batch error:', e.message); }
  }
  return result;
}

// ── Map raw Odoo records → GST portal schema ──────────────────
function mapRecords(raw, taxLineMap, type) {
  return raw.map(m => {
    const d  = m.invoice_date || '';
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mo = d ? (MONTH_SHORT[parseInt(d.slice(5, 7), 10) - 1] + ' ' + d.slice(0, 4)) : '';
    const { branch, company, coKey } = getBranch(m.name);

    const invoiceCurrency   = m.currency_id?.[1] || 'INR';
    const isForeignCurrency = invoiceCurrency !== 'INR';

    const taxableINR = Math.abs(
      (m.amount_untaxed_signed !== undefined && m.amount_untaxed_signed !== false)
        ? m.amount_untaxed_signed
        : m.amount_untaxed
    );

    let cgst = 0, sgst = 0, igst = 0;
    (taxLineMap[m.id] || []).forEach(l => {
      const n   = (l.name || l.tax_line_id?.[1] || '').toUpperCase();
      const amt = Math.abs(l.balance !== undefined ? l.balance : (l.credit || 0) - (l.debit || 0));
      if      (n.includes('CGST'))                        cgst += amt;
      else if (n.includes('SGST') || n.includes('UTGST')) sgst += amt;
      else if (n.includes('IGST'))                        igst += amt;
    });

    if (cgst === 0 && sgst === 0 && igst === 0) {
      const tt = m.tax_totals || {};
      if (tt.groups_by_subtotal) {
        Object.values(tt.groups_by_subtotal).flat().forEach(g => {
          const n   = (g.tax_group_name || '').toUpperCase();
          const amt = g.tax_group_amount || 0;
          if      (n.includes('CGST'))                        cgst += amt;
          else if (n.includes('SGST') || n.includes('UTGST')) sgst += amt;
          else if (n.includes('IGST'))                        igst += amt;
        });
      }
    }

    if (cgst === 0 && sgst === 0 && igst === 0) {
      const totalTaxINR = Math.abs(
        (m.amount_tax_signed !== undefined && m.amount_tax_signed !== false)
          ? m.amount_tax_signed
          : m.amount_tax
      );
      if (totalTaxINR) { cgst = totalTaxINR / 2; sgst = cgst; }
    }

    const round = v => Math.round(v * 100) / 100;
    const gstin = '';

    if (type === 'sales') {
      return {
        invoice_no:          m.name,
        date:                d,
        party:               m.partner_id?.[1] || '—',
        gstin,
        branch,
        company,
        coKey,
        month:               mo,
        currency:            invoiceCurrency,
        is_foreign_currency: isForeignCurrency,
        taxable:             round(taxableINR),
        cgst:                round(cgst),
        sgst:                round(sgst),
        igst:                round(igst),
        recon_status:        'Pending'
      };
    } else {
      return {
        cn_no:               m.name,
        against_invoice:     m.ref || '—',
        party:               m.partner_id?.[1] || '—',
        gstin,
        branch,
        company,
        coKey,
        month:               mo,
        currency:            invoiceCurrency,
        is_foreign_currency: isForeignCurrency,
        amount:              round(taxableINR),
        cgst:                round(cgst),
        sgst:                round(sgst),
        igst:                round(igst),
        gstr1_status:        'Pending'
      };
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    server:   'GST Audit Proxy v2.1 — chunked Firebase storage',
    firebase: db ? 'connected' : 'not connected',
    port:     PORT,
    time:     new Date().toISOString()
  });
});

app.get('/api/settings', async (req, res) => {
  const s = await loadSettings();
  res.json({ ...s, apiKey: s.apiKey ? '••••••••' : '' });
});

app.post('/api/settings', async (req, res) => {
  try {
    const s        = await loadSettings();
    const incoming = req.body;
    if (incoming.apiKey === '••••••••') delete incoming.apiKey;
    await saveSettings({ ...s, ...incoming });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test', async (req, res) => {
  const s = { ...await loadSettings(), ...req.body };
  if (req.body.apiKey === '••••••••') s.apiKey = (await loadSettings()).apiKey;
  try {
    const session = await odooAuthenticate(s.url, s.db, s.username, s.apiKey);
    const count   = await odooCall(session, 'account.move', 'search_count', [[
      ['move_type', '=', 'out_invoice'], ['state', '=', 'posted']
    ]]);
    res.json({ ok: true, uid: session.uid, message: `Connected! UID ${session.uid} — ${count} posted sales invoices found.` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sync/sales', async (req, res) => {
  const s   = await loadSettings();
  const cfg = {
    url:      req.body.url      || s.url,
    db:       req.body.db       || s.db,
    username: req.body.username || s.username,
    apiKey:   req.body.apiKey === '••••••••' ? s.apiKey : (req.body.apiKey || s.apiKey)
  };
  const { fromDate, toDate } = req.body;
  try {
    console.log(`\n📦 Sales sync: ${fromDate} → ${toDate}`);
    const session    = await odooAuthenticate(cfg.url, cfg.db, cfg.username, cfg.apiKey);
    const raw        = await fetchMoves(session, 'out_invoice', fromDate, toDate);
    console.log(`   ${raw.length} invoices — fetching tax lines...`);
    const taxLines   = await fetchTaxLines(session, raw.map(m => m.id));
    const taxLineMap = {};
    taxLines.forEach(l => {
      const mid = l.move_id[0];
      if (!taxLineMap[mid]) taxLineMap[mid] = [];
      taxLineMap[mid].push(l);
    });
    const data = mapRecords(raw, taxLineMap, 'sales');
    console.log(`✅ Sales: ${data.length} records`);
    res.json({ ok: true, count: data.length, data });
  } catch (e) {
    console.error('❌ Sales error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sync/credit', async (req, res) => {
  const s   = await loadSettings();
  const cfg = {
    url:      req.body.url      || s.url,
    db:       req.body.db       || s.db,
    username: req.body.username || s.username,
    apiKey:   req.body.apiKey === '••••••••' ? s.apiKey : (req.body.apiKey || s.apiKey)
  };
  const { fromDate, toDate } = req.body;
  try {
    console.log(`\n📦 Credit notes sync: ${fromDate} → ${toDate}`);
    const session    = await odooAuthenticate(cfg.url, cfg.db, cfg.username, cfg.apiKey);
    const raw        = await fetchMoves(session, 'out_refund', fromDate, toDate);
    console.log(`   ${raw.length} credit notes — fetching tax lines...`);
    const taxLines   = await fetchTaxLines(session, raw.map(m => m.id));
    const taxLineMap = {};
    taxLines.forEach(l => {
      const mid = l.move_id[0];
      if (!taxLineMap[mid]) taxLineMap[mid] = [];
      taxLineMap[mid].push(l);
    });
    const data = mapRecords(raw, taxLineMap, 'credit');
    console.log(`✅ Credit: ${data.length} records`);
    res.json({ ok: true, count: data.length, data });
  } catch (e) {
    console.error('❌ Credit error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── RCM Sync (transaction-wise) ───────────────────────────────
const RCM_ACCOUNT_TYPE = {
  '234005':  'igst',
  '2341013': 'igst',
  '234006':  'cgst',
  '2341015': 'cgst',
  '234007':  'sgst',
  '2341017': 'sgst',
};
const RCM_ACCOUNT_CODES = Object.keys(RCM_ACCOUNT_TYPE);
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const RCM_JOURNAL_MAP = {
  'BHR':   { branch: 'Haryana',       company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'BMH':   { branch: 'Maharashtra',   company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'BWB':   { branch: 'West Bengal',   company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'BKN':   { branch: 'Karnataka',     company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'BTL':   { branch: 'Telangana',     company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'DHR':   { branch: 'Haryana',       company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'DWB':   { branch: 'West Bengal',   company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'DKN':   { branch: 'Karnataka',     company: 'Ginni Systems Limited',                    coKey: 'gsl'   },
  'BTBIL': { branch: 'Goa',           company: 'Browntape Technologies Private Limited',   coKey: 'bt'    },
  'RBTBIL':{ branch: 'Goa',           company: 'Browntape Infrosolution Pvt Ltd',           coKey: 'bt'    },
  'BGO':   { branch: 'Goa',           company: 'Ginni Systems Ltd',                         coKey: 'gsl'   },
  'BILLE': { branch: 'Haryana',       company: 'Easemy Business Private Limited',           coKey: 'em'    },
  'RBHR':  { branch: 'Haryana',       company: 'Roxfortech Infosolutions Private Limited', coKey: 'roxfo' },
  'BILRO': { branch: 'Haryana',       company: 'Roxfortech Infosolutions Private Limited', coKey: 'roxfo' },
};

function getRCMJournalInfo(moveName) {
  const prefix = (moveName || '').split('/')[0].toUpperCase().trim();
  return RCM_JOURNAL_MAP[prefix] || { branch: prefix || 'Unknown', company: 'Unknown', coKey: 'other' };
}

app.post('/api/sync/rcm', async (req, res) => {
  const s   = await loadSettings();
  const cfg = {
    url:      req.body.url      || s.url,
    db:       req.body.db       || s.db,
    username: req.body.username || s.username,
    apiKey:   req.body.apiKey === '••••••••' ? s.apiKey : (req.body.apiKey || s.apiKey)
  };
  const { fromDate, toDate } = req.body;
  try {
    console.log(`\n📦 RCM sync (transaction-wise): ${fromDate} → ${toDate}`);
    const session = await odooAuthenticate(cfg.url, cfg.db, cfg.username, cfg.apiKey);

    const accounts = await odooCall(session, 'account.account', 'search_read',
      [[['code', 'in', RCM_ACCOUNT_CODES]]],
      { fields: ['id', 'code', 'name'], limit: 50 }
    );
    console.log(`   Found ${accounts.length} RCM accounts`);
    if (!accounts.length) {
      return res.json({ ok: true, count: 0, data: [],
        message: 'No RCM accounts found with codes: ' + RCM_ACCOUNT_CODES.join(', ') });
    }

    const acIdToCode = {};
    accounts.forEach(a => { acIdToCode[a.id] = a.code; });
    const acIds = accounts.map(a => a.id);

    const BATCH = 500;
    const domain = [
      ['account_id',   'in', acIds],
      ['date',         '>=', fromDate],
      ['date',         '<=', toDate],
      ['parent_state', '=',  'posted']
    ];
    const lineFields = ['move_id', 'account_id', 'date', 'debit', 'credit', 'balance', 'name'];

    const allLines = [];
    let offset = 0;
    while (true) {
      const batch = await odooCall(session, 'account.move.line', 'search_read',
        [domain], { fields: lineFields, limit: BATCH, offset, order: 'date asc' }
      );
      allLines.push(...batch);
      console.log(`   RCM lines page offset=${offset} → ${batch.length} lines (total: ${allLines.length})`);
      if (batch.length < BATCH) break;
      offset += BATCH;
    }
    console.log(`   ${allLines.length} RCM journal lines`);

    const moveIdSet = new Set(allLines.map(l => l.move_id[0]));
    const moveIds   = Array.from(moveIdSet);

    const movesMap = {};
    for (let i = 0; i < moveIds.length; i += 200) {
      const batch = await odooCall(session, 'account.move', 'read',
        [moveIds.slice(i, i + 200)],
        { fields: ['id', 'name', 'invoice_date', 'date', 'partner_id',
                   'amount_untaxed_signed', 'amount_untaxed', 'ref', 'move_type'] }
      );
      batch.forEach(m => { movesMap[m.id] = m; });
    }

    const moveTax = {};
    allLines.forEach(line => {
      const mid  = line.move_id[0];
      const code = acIdToCode[line.account_id[0]];
      const type = RCM_ACCOUNT_TYPE[code];
      // FIX: Use signed balance (debit - credit) so credit notes produce negative amounts.
      // Previously used Math.abs(debit) which gave 0 for credit-note lines (debit=0, credit>0),
      // causing all credit notes to be silently dropped by the > 0 filter below.
      const amt = (line.balance !== undefined && line.balance !== false)
        ? line.balance
        : ((line.debit || 0) - (line.credit || 0));
      if (!moveTax[mid]) moveTax[mid] = { igst: 0, cgst: 0, sgst: 0 };
      if      (type === 'igst') moveTax[mid].igst += amt;
      else if (type === 'cgst') moveTax[mid].cgst += amt;
      else if (type === 'sgst') moveTax[mid].sgst += amt;
    });

    const round = v => Math.round(v * 100) / 100;
    const data = moveIds
      .map(mid => {
        const move  = movesMap[mid];
        const tax   = moveTax[mid] || { igst: 0, cgst: 0, sgst: 0 };
        const info  = getRCMJournalInfo(move ? move.name : '');
        const d     = (move && (move.date || move.invoice_date)) || '';
        const month = d
          ? MONTH_LABELS[parseInt(d.slice(5, 7), 10) - 1] + ' ' + d.slice(0, 4)
          : '';
        const isRefund = move ? (move.move_type === 'in_refund') : false;
        // FIX: normalise taxable sign — bills = +positive, credit notes = -negative.
        // Do NOT use amount_untaxed_signed (Odoo sign is inverted for purchase moves).
        const taxable = move
          ? (isRefund
              ? -Math.abs(move.amount_untaxed || 0)
              :  Math.abs(move.amount_untaxed || 0))
          : 0;
        return {
          moveId:   mid,
          entryNo:  move ? move.name : String(mid),
          isRefund,
          date:     d,
          month,
          vendor:   move?.partner_id?.[1] || '—',
          ref:      move?.ref || '',
          branch:   info.branch,
          company:  info.company,
          coKey:    info.coKey,
          taxable:  round(taxable),
          igst:     round(tax.igst),
          cgst:     round(tax.cgst),
          sgst:     round(tax.sgst),
        };
      })
      .filter(r => {
        const prefix = (r.entryNo || '').split('/')[0].toUpperCase();
        if (prefix === 'BILL') {
          console.log(`   ⛔ Skipping BILL entry: ${r.entryNo}`);
          return false;
        }
        // FIX: use !== 0 (not > 0) so credit notes with negative GST are kept.
        return r.igst !== 0 || r.cgst !== 0 || r.sgst !== 0;
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const cnCount = data.filter(r => r.isRefund).length;
    console.log(`✅ RCM: ${data.length} transactions (${data.length - cnCount} bills, ${cnCount} credit notes) from ${allLines.length} journal lines`);
    res.json({ ok: true, count: allLines.length, txCount: data.length, data });
  } catch (e) {
    console.error('❌ RCM error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── ITC Books Sync ────────────────────────────────────────────
const ITC_ACCOUNT_MAP = {
  // ── Ginni Systems Limited (GSL) ──────────────────────────────
  '234001':  { taxType: 'cgst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234002':  { taxType: 'sgst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234003':  { taxType: 'igst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234004':  { taxType: 'igst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234008':  { taxType: 'cgst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234009':  { taxType: 'sgst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },

  // ── Browntape Technologies Private Limited ───────────────────
  '2341002': { taxType: 'cgst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341006': { taxType: 'sgst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341010': { taxType: 'igst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },

  // ── Easemy Business Private Limited ─────────────────────────
  '2341003': { taxType: 'cgst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  '2341007': { taxType: 'sgst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  '2341011': { taxType: 'igst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },

  // ── Roxfortech Infosolutions Private Limited ─────────────────
  '2341001': { taxType: 'cgst', itcType: 'Normal', coKey: 'roxfo', company: 'Roxfortech Infosolutions Private Limited' },
  '2341005': { taxType: 'sgst', itcType: 'Normal', coKey: 'roxfo', company: 'Roxfortech Infosolutions Private Limited' },
  '2341009': { taxType: 'igst', itcType: 'Normal', coKey: 'roxfo', company: 'Roxfortech Infosolutions Private Limited' },
};
const ITC_ACCOUNT_CODES = Object.keys(ITC_ACCOUNT_MAP);

// ── Diagnostic: check what accounts a specific bill uses ─────
// POST /api/debug/bill  { moveName: "BHR/2024/2836" }
// Returns all journal lines with their account codes so you can
// identify missing codes and add them to ITC_ACCOUNT_MAP above.
app.post('/api/debug/bill', async (req, res) => {
  const s   = await loadSettings();
  const cfg = {
    url:      req.body.url      || s.url,
    db:       req.body.db       || s.db,
    username: req.body.username || s.username,
    apiKey:   req.body.apiKey === '••••••••' ? s.apiKey : (req.body.apiKey || s.apiKey)
  };
  const { moveName } = req.body;
  if (!moveName) return res.status(400).json({ ok: false, error: 'moveName required' });

  try {
    const session = await odooAuthenticate(cfg.url, cfg.db, cfg.username, cfg.apiKey);
    const moves = await odooCall(session, 'account.move', 'search_read',
      [[['name', '=', moveName]]],
      { fields: ['id','name','move_type','date','ref','partner_id','amount_untaxed'], limit: 5 }
    );
    if (!moves.length) return res.json({ ok: false, error: `No move found: ${moveName}` });

    const moveId = moves[0].id;
    const lines  = await odooCall(session, 'account.move.line', 'search_read',
      [[['move_id', '=', moveId]]],
      { fields: ['account_id','name','debit','credit','balance','tax_line_id'], limit: 100 }
    );

    const result = lines.map(l => ({
      account_id:   l.account_id[0],
      account_code: l.account_id[1]?.split(' ')[0] || '',
      account_name: l.account_id[1] || '',
      label:        l.name || '',
      debit:        l.debit,
      credit:       l.credit,
      balance:      l.balance,
      is_tax_line:  !!l.tax_line_id,
      in_itc_map:   ITC_ACCOUNT_CODES.includes((l.account_id[1]||'').split(' ')[0])
    }));

    const missingTaxAccounts = result
      .filter(l => l.is_tax_line && !l.in_itc_map)
      .map(l => ({ code: l.account_code, name: l.account_name }));

    console.log(`🔍 Debug bill ${moveName}: ${lines.length} lines, ${missingTaxAccounts.length} missing tax accounts`);
    res.json({ ok: true, move: moves[0], lines: result, missingTaxAccounts });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/sync/itc', async (req, res) => {
  const s   = await loadSettings();
  const cfg = {
    url:      req.body.url      || s.url,
    db:       req.body.db       || s.db,
    username: req.body.username || s.username,
    apiKey:   req.body.apiKey === '••••••••' ? s.apiKey : (req.body.apiKey || s.apiKey)
  };
  const { fromDate, toDate } = req.body;

  try {
    console.log(`\n📦 ITC Books sync (bill-level): ${fromDate} → ${toDate}`);
    const session = await odooAuthenticate(cfg.url, cfg.db, cfg.username, cfg.apiKey);

    const accounts = await odooCall(session, 'account.account', 'search_read',
      [[['code', 'in', ITC_ACCOUNT_CODES]]],
      { fields: ['id', 'code', 'name'], limit: 100 }
    );
    console.log(`   Found ${accounts.length} ITC accounts`);
    if (!accounts.length) {
      return res.json({ ok: true, count: 0, data: [],
        message: 'No ITC accounts found with codes: ' + ITC_ACCOUNT_CODES.join(', ') });
    }

    const acIdToCode = {};
    accounts.forEach(a => { acIdToCode[a.id] = a.code; });
    const acIds = accounts.map(a => a.id);

    const BATCH = 500;
    const domain = [
      ['account_id',   'in',  acIds],
      ['date',         '>=',  fromDate],
      ['date',         '<=',  toDate],
      ['parent_state', '=',   'posted'],
      ['move_type',    'in',  ['in_invoice', 'in_refund', 'entry']]   // 'entry' = MISC journal
    ];
    const lineFields = ['move_id', 'account_id', 'date', 'debit', 'credit', 'balance', 'name'];

    const allLines = [];
    let offset = 0;
    while (true) {
      const batch = await odooCall(session, 'account.move.line', 'search_read',
        [domain], { fields: lineFields, limit: BATCH, offset, order: 'date asc' }
      );
      allLines.push(...batch);
      console.log(`   ITC lines offset=${offset} → ${batch.length} (total: ${allLines.length})`);
      if (batch.length < BATCH) break;
      offset += BATCH;
    }
    console.log(`   ${allLines.length} ITC journal lines across all accounts`);

    const moveGroups = {};
    allLines.forEach(l => {
      const moveId  = l.move_id[0];
      const moveNo  = l.move_id[1] || '';
      const code    = acIdToCode[l.account_id[0]];
      const acInfo  = ITC_ACCOUNT_MAP[code];
      if (!acInfo) return;

      if (!moveGroups[moveId]) {
        const brInfo        = getBranch(moveNo);
        const usePrefix     = (brInfo.coKey !== 'other');
        const resolvedCoKey = usePrefix ? brInfo.coKey : acInfo.coKey;
        const isMiscEntry   = !usePrefix;   // no recognised prefix = MISC-style entry

        // Per-company default branch for MISC entries (no invoice prefix to guide us)
        const MISC_DEFAULT_BRANCH = { gsl:'Haryana', em:'Haryana', bt:'Goa', roxfo:'Haryana' };
        const defaultBranch = (isMiscEntry && resolvedCoKey in MISC_DEFAULT_BRANCH)
          ? MISC_DEFAULT_BRANCH[resolvedCoKey]
          : brInfo.branch;

        moveGroups[moveId] = {
          moveId,
          moveNo,
          billDate:     l.date || '',
          refNo:        '',
          vendorName:   '',
          isAdjustment: false,
          isMisc:       false,
          moveType:     '',             // ← populated later from account.move read
          itcType:      acInfo.itcType || 'Normal',
          branch:       usePrefix ? brInfo.branch : defaultBranch,
          company:      usePrefix ? brInfo.company : acInfo.company,
          coKey:        resolvedCoKey,
          taxable:      0,
          igst:         0,
          cgst:         0,
          sgst:         0
        };
      } else if (acInfo.itcType === 'ISD') {
        moveGroups[moveId].itcType = 'ISD';
      }

      // Use signed balance: positive for purchase bills (ITC debited),
      // negative for credit notes (ITC credited/reversed).
      // balance = debit - credit in Odoo; fallback to computing it manually.
      const amt = (l.balance !== undefined && l.balance !== false)
        ? l.balance
        : ((l.debit || 0) - (l.credit || 0));
      moveGroups[moveId][acInfo.taxType] += amt;
    });

    const moveIds = Object.keys(moveGroups).map(Number);
    console.log(`   Fetching ${moveIds.length} account.move records for bill details...`);
    const MOVE_BATCH = 200;
    for (let i = 0; i < moveIds.length; i += MOVE_BATCH) {
      const batchIds = moveIds.slice(i, i + MOVE_BATCH);
      const moves = await odooCall(session, 'account.move', 'read',
        [batchIds],
        { fields: ['id', 'name', 'ref', 'partner_id', 'date', 'amount_untaxed', 'amount_untaxed_signed', 'move_type', 'narration'] }
      );
      moves.forEach(m => {
        const g = moveGroups[m.id];
        if (!g) return;
        g.moveNo     = m.name || g.moveNo;
        g.refNo      = m.ref  || '';
        g.vendorName = m.partner_id ? m.partner_id[1] : '';
        g.billDate   = m.date || g.billDate;
        g.moveType   = m.move_type || '';
        g.isMisc     = (m.move_type === 'entry');
        // FIX: Do NOT use amount_untaxed_signed — Odoo returns it negative for in_invoice
        // and positive for in_refund (opposite of what we need for display).
        // Normalise: bills = +positive taxable, credit notes = -negative taxable, MISC = 0.
        // MISC/ISD distribution entries have amount_untaxed = 0; taxable stays 0 here.
        g.taxable    = (m.move_type === 'in_refund')
          ? -Math.abs(m.amount_untaxed || 0)
          : (m.move_type === 'in_invoice')
              ?  Math.abs(m.amount_untaxed || 0)
              :  0;   // 'entry' (MISC/ISD): taxable handled separately below

        // ── Skip GST liability set-off entries ──────────────────
        // These are MISC entries that offset ITC against GST payable.
        // Identified by narration or reference containing "GST Adjustment"
        // (case-insensitive). Add more keywords to GST_SKIP_KEYWORDS as needed.
        // ── Skip GST liability set-off / ISD transfer / adjustment entries ─
        // Matched against narration + reference fields (case-insensitive).
        // Substring match used for phrases; 'adjustment' alone uses word-boundary
        // to avoid false positives like "price adjustment for vendor".
        const GST_SKIP_KEYWORDS = [
          'gst adjustment',
          'gst set off',
          'gst setoff',
          'gst set-off',
          'liability set off',
          'isd transfer',
          'isd input transfer',
          'adjustment entry',
        ];
        // Also skip if the narration is EXACTLY "adjustment" or "adjustments" (standalone word)
        const GST_SKIP_EXACT = /^adjustments?$/i;

        const narr = ((m.narration || '') + ' ' + (m.ref || '')).toLowerCase().trim();
        const narrClean = narr.trim();
        const isGSTSetOff = GST_SKIP_KEYWORDS.some(kw => narrClean.includes(kw))
          || GST_SKIP_EXACT.test((m.narration || '').trim());

        // MISC entries legitimately have no vendor — only skip if:
        // (a) it's a GST set-off entry (narration match), OR
        // (b) it's a non-MISC entry without a vendor (pure adjustment line)
        g.isAdjustment = isGSTSetOff || (!m.partner_id && !g.isMisc);

        if (isGSTSetOff) {
          console.log(`   ⏭ Skipping GST set-off MISC entry: ${m.name} (${m.narration || m.ref || 'no narration'})`);
        }
      });
    }

    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const round = v => Math.round(v * 100) / 100;

    const allGroups  = Object.values(moveGroups);
    const skipped    = allGroups.filter(g => g.isAdjustment);
    const gstSetOffs = skipped.filter(g => g.isMisc);
    const bills      = allGroups.filter(g => !g.isAdjustment);

    if (skipped.length) {
      console.log(`   ⚠ Skipped ${skipped.length} entries (${gstSetOffs.length} GST set-off MISC, ${skipped.length - gstSetOffs.length} no-vendor adjustments):`,
        skipped.slice(0,5).map(g => g.moveNo).join(', ') + (skipped.length > 5 ? '…' : ''));
    }

    const data = bills.map(g => {
      const d     = g.billDate || '';
      const yr    = parseInt(d.slice(0, 4), 10);
      const mo    = parseInt(d.slice(5, 7), 10) - 1;
      const month = (!isNaN(yr) && !isNaN(mo) && mo >= 0 && mo <= 11)
        ? MONTH_SHORT[mo] + ' ' + yr : '';
      // For MISC (entry) moves, amount_untaxed = 0; derive taxable from GST amounts
      // (CGST+SGST = 2× effective; IGST alone — use proportional inverse for display)
      const isRefund = g.moveType === 'in_refund';
      // FIX: For MISC/ISD distribution entries, taxable base isn't available in Odoo's
      // amount_untaxed. Show 0 instead of an inaccurate approximation based on
      // hardcoded 18% rate (wrong for 5%, 12%, 28% invoices).
      const taxable  = round(g.taxable);
      return {
        moveId:     g.moveId,
        moveNo:     g.moveNo,
        isRefund,                                // true for credit notes (in_refund)
        billDate:   g.billDate,
        month,
        refNo:      g.refNo,
        vendorName: g.vendorName || (g.isMisc ? 'MISC Entry' : ''),
        branch:     g.branch,
        company:    g.company,
        coKey:      g.coKey,
        itcType:    g.itcType,
        isMisc:     g.isMisc || false,
        taxable,
        igst:       round(g.igst),
        cgst:       round(g.cgst),
        sgst:       round(g.sgst)
      };
    }).sort((a, b) => (a.billDate || '').localeCompare(b.billDate || ''));

    const isdCount    = data.filter(r => r.itcType === 'ISD').length;
    const miscCount   = data.filter(r => r.isMisc).length;
    const normalCount = data.filter(r => r.itcType === 'Normal' && !r.isMisc).length;
    console.log(`✅ ITC Books: ${data.length} entries (${skipped.length} skipped: ${gstSetOffs.length} GST set-off, ${skipped.length-gstSetOffs.length} other) — Normal: ${normalCount}, MISC ITC: ${miscCount}, ISD: ${isdCount}`);
    res.json({ ok: true, count: data.length, skipped: skipped.length, gstSetOffs: gstSetOffs.length, lineCount: allLines.length, data });
  } catch(e) {
    console.error('❌ ITC sync error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Serve the portal HTML
const portalFile = path.join(__dirname, 'gst-audit-portal-v5.html');
app.get('/', (req, res) => {
  fs.existsSync(portalFile)
    ? res.sendFile(portalFile)
    : res.send(`<h2 style="font-family:Segoe UI;padding:40px">⚠ Place gst-audit-portal-v5.html in this folder: ${__dirname}</h2>`);
});

// ══════════════════════════════════════════════════════════════
//  FIREBASE STATE PERSISTENCE  (storage-bridge.js calls these)
//
//  GET    /api/state         — load all keys
//  POST   /api/state/:key    — save one key (chunked if large)
//  DELETE /api/state         — wipe all state
// ══════════════════════════════════════════════════════════════
const STATE_KEYS = [
  'gst_cfg',
  // FY 2025-26
  'gst_sales_2526','gst_credit_2526','gst_g1_2526','gst_3b_2526','gst_rcm_2526',
  'gst_g2b_2526','gst_itc_2526','gst_isd_2526','gst_g1a_2526',
  // FY 2026-27
  'gst_sales_2627','gst_credit_2627','gst_g1_2627','gst_3b_2627','gst_rcm_2627',
  'gst_g2b_2627','gst_itc_2627','gst_isd_2627','gst_g1a_2627',
  // FY 2024-25
  'gst_sales_2425','gst_credit_2425','gst_g1_2425','gst_3b_2425','gst_rcm_2425',
  'gst_g2b_2425','gst_itc_2425','gst_isd_2425','gst_g1a_2425',
  // Legacy keys (migration / backup compat)
  'gst_cfg','gst_g1','gst_3b','gst_rcm','gst_sales','gst_credit',
  'gst_g2b','gst_itc','gst_isd','gst_audit_3b_v1','gst_audit_rcm_v1'
];

// GET /api/state — load all keys at once
app.get('/api/state', async (req, res) => {
  try {
    if (!db) return res.json({ ok: true, state: {} });

    const state = {};
    await Promise.all(STATE_KEYS.map(async (key) => {
      try {
        const val = await fbLoad(key);
        if (val !== undefined) state[key] = val;
      } catch (e) { /* skip missing */ }
    }));
    res.json({ ok: true, state });
  } catch (e) {
    console.error('State load error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/state/:key — save one key (auto-chunks large arrays)
app.post('/api/state/:key', async (req, res) => {
  try {
    const key   = req.params.key;
    const value = req.body?.value;
    if (value === undefined) return res.status(400).json({ ok: false, error: 'Missing value' });

    await fbSave(key, value);
    res.json({ ok: true });
  } catch (e) {
    console.error('State save error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/state — wipe all state
app.delete('/api/state', async (req, res) => {
  try {
    await Promise.all(STATE_KEYS.map(key => fbDelete(key).catch(() => {})));
    console.log('  🗑 Firebase state cleared');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Start server ───────────────────────────────────────────────
app.listen(PORT, async () => {
  const s = await loadSettings();
  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║  GST AUDIT PORTAL  v2.1  →  port ${PORT}            ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  Storage : Firebase Firestore (chunked writes)   ║`);
  console.log(`║  POST /api/test          — test Odoo login       ║`);
  console.log(`║  POST /api/sync/sales    — sync sales invoices   ║`);
  console.log(`║  POST /api/sync/credit   — sync credit notes     ║`);
  console.log(`║  POST /api/sync/rcm      — sync RCM accounts     ║`);
  console.log(`║  POST /api/sync/itc      — sync ITC books accs   ║`);
  console.log(`║  GET  /api/state         — load all portal state ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);
  console.log(`  Odoo : ${s.url}`);
  console.log(`  DB   : ${s.db}`);
  console.log(`  User : ${s.username}`);
  console.log(`\n  ➡  Open http://localhost:${PORT}/gst-audit-portal-v5.html\n`);
});
