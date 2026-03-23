/**
 * ╔══════════════════════════════════════════════════════════════╗
<<<<<<< HEAD
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
 *    4. Open http://localhost:3002/gst-audit-portal.html
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
=======
 * ║       GST AUDIT PORTAL — Odoo Local Proxy Server  v1.1      ║
 * ║   Runs on http://localhost:3002                              ║
 * ║   Fetches: Sales Invoices (out_invoice)                      ║
 * ║            Credit Notes  (out_refund)                        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  SETUP (one-time):
 *    1. Install Node.js  →  https://nodejs.org  (LTS version)
 *    2. Open terminal / command prompt in THIS folder
 *    3. Run:  npm install express cors node-fetch
 *    4. Run:  node gst-server.js
 *    5. Open  http://localhost:3002  in your browser
 */

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = 3002;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Settings (persisted to gst-odoo-settings.json) ────────────
const SETTINGS_FILE = path.join(__dirname, 'gst-odoo-settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
  } catch (e) {}
  return {
    url:      'https://ginesys.odoo.com',
    db:       'ginesys',
    username: 'kunal.g@gsl.in',
<<<<<<< HEAD
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
=======
    apiKey:   'Anni@2312'
  };
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
  // ── Browntape — Sales, Credit & Purchase journals ─────────────
  'SBTM':'Goa',         'CMS':'Goa',        'SBTE':'Goa',
  'SBT':'Goa',          'CENT':'Goa',       'CDIY':'Goa',
  'BTBIL':'Goa',        'MISBT':'Goa',
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
  // ── Browntape ────────────────────────────────────────────────
  'SBTM':'Browntape Infrosolution Pvt Ltd', 'CMS':'Browntape Infrosolution Pvt Ltd',
  'SBTE':'Browntape Infrosolution Pvt Ltd', 'SBT':'Browntape Infrosolution Pvt Ltd',
  'CENT':'Browntape Infrosolution Pvt Ltd', 'CDIY':'Browntape Infrosolution Pvt Ltd',
  'BTBIL':'Browntape Infrosolution Pvt Ltd','MISBT':'Browntape Infrosolution Pvt Ltd',
  // ── Easemy Business ───────────────────────────────────────────
  'BILLE':'Easemy Business Pvt Ltd',
  // ── Roxfortech ───────────────────────────────────────────────
  'BILRO':'Roxfortech Infosolutions Private Limited',
  'CNRX': 'Roxfortech Infosolutions Private Limited',
  'SRX':  'Roxfortech Infosolutions Private Limited',
  'RBHR': 'Roxfortech Infosolutions Private Limited',
};
<<<<<<< HEAD
=======

>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
const COKEY_MAP = {
  // ── Ginni ────────────────────────────────────────────────────
  'SWB':'gsl', 'SKN':'gsl',  'SEM':'em',    'SMH':'gsl',  'SHR':'gsl',
  'CMH':'gsl', 'CHR':'gsl',  'STN':'gsl',   'CWB':'gsl',  'CKN':'gsl',
  'CEM':'em',
  // ── Ginni purchase bill ──────────────────────────────────────
  'BWB':'gsl', 'BHR':'gsl',  'BTL':'gsl',   'BMH':'gsl',  'BKN':'gsl',
  // ── Ginni debit notes & BILL ─────────────────────────────────
  'DHR':'gsl', 'DKN':'gsl',  'DWB':'gsl',   'DMH':'gsl',  'DTL':'gsl',
  'BILL':'gsl',
  // ── Browntape ────────────────────────────────────────────────
  'SBTM':'bt', 'CMS':'bt',   'SBTE':'bt',   'SBT':'bt',
  'CENT':'bt', 'CDIY':'bt',  'BTBIL':'bt',  'MISBT':'bt',
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
<<<<<<< HEAD
  const session = { uid, cookie, baseUrl, companyIds: [] };

  // Fetch ALL company IDs this user can access
=======

  // Build a temporary session to fetch company list
  const session = { uid, cookie, baseUrl, companyIds: [] };

  // ── Fetch ALL company IDs this user can access ─────────────────────────
  // CRITICAL FIX: Without allowed_company_ids in the API context, Odoo's
  // search_read silently returns records for the user's ONE default company.
  // All invoices from other companies (Easemy Business, Browntape, other
  // Ginni branches) are excluded — this is why only ~189 of 834 invoices appear.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
=======
          // Merge allowed_company_ids into context so Odoo searches ALL companies
          // the user can access, not just the default one.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
=======
// Root cause of missing Feb 19-28 invoices:
// When syncing a full FY (Apr 2025 → Mar 2026), limit:5000 would
// fill up with Apr-Feb18 invoices and cut off Feb19-28.
// Fix: paginate in batches of 500 until Odoo returns fewer than
// the batch size, meaning we have reached the last page.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
    if (batch.length < BATCH) break;
=======
    if (batch.length < BATCH) break;   // last page reached
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mo = d ? (MONTH_SHORT[parseInt(d.slice(5, 7), 10) - 1] + ' ' + d.slice(0, 4)) : '';
    const { branch, company, coKey } = getBranch(m.name);

    const invoiceCurrency   = m.currency_id?.[1] || 'INR';
    const isForeignCurrency = invoiceCurrency !== 'INR';

=======
    // Use a fixed month map — toLocaleString('en-IN') gives 'Sept' for September
    // but the portal dropdown uses 'Sep', causing a mismatch. Fixed map ensures
    // both always produce identical strings e.g. "Sep 2025".
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    // Parse date parts directly from 'YYYY-MM-DD' — never use new Date(d).getMonth()
    // because ISO strings parse as UTC midnight; on IST (+5:30) the month rolls back.
    const mo = d ? (MONTH_SHORT[parseInt(d.slice(5, 7), 10) - 1] + ' ' + d.slice(0, 4)) : '';
    const { branch, company, coKey } = getBranch(m.name);

    // ── Detect foreign currency ────────────────────────────────
    // currency_id comes as [id, 'USD'] from Odoo
    const invoiceCurrency    = m.currency_id?.[1] || 'INR';
    const isForeignCurrency  = invoiceCurrency !== 'INR';

    // ── Taxable value — always in INR ──────────────────────────
    // • amount_untaxed_signed  → always in company currency (INR), even for USD invoices  ✅
    // • amount_untaxed         → in invoice currency (USD for export invoices)            ❌
    // We use amount_untaxed_signed and fall back to amount_untaxed only if the field is
    // unavailable (very old Odoo versions that don't expose _signed fields).
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const taxableINR = Math.abs(
      (m.amount_untaxed_signed !== undefined && m.amount_untaxed_signed !== false)
        ? m.amount_untaxed_signed
        : m.amount_untaxed
    );

<<<<<<< HEAD
=======
    // ── GST amounts — always in INR ────────────────────────────
    // Priority 1 — account.move.line tax lines using `balance` field.
    // `balance` is ALWAYS stored in company currency (INR) in Odoo,
    // whereas `debit`/`credit` are in the invoice's own currency.
    // So for a USD export invoice, balance gives the correct INR GST amount.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    let cgst = 0, sgst = 0, igst = 0;
    (taxLineMap[m.id] || []).forEach(l => {
      const n   = (l.name || l.tax_line_id?.[1] || '').toUpperCase();
      const amt = Math.abs(l.balance !== undefined ? l.balance : (l.credit || 0) - (l.debit || 0));
      if      (n.includes('CGST'))                        cgst += amt;
      else if (n.includes('SGST') || n.includes('UTGST')) sgst += amt;
      else if (n.includes('IGST'))                        igst += amt;
    });

<<<<<<< HEAD
=======
    // Priority 2 — tax_totals JSON on account.move.
    // Odoo stores tax_totals in company currency (INR) — safe for foreign currency invoices.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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

<<<<<<< HEAD
=======
    // Priority 3 — last resort: split amount_tax_signed 50/50 as CGST+SGST.
    // amount_tax_signed is also always in INR — safe for foreign currency invoices.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    if (cgst === 0 && sgst === 0 && igst === 0) {
      const totalTaxINR = Math.abs(
        (m.amount_tax_signed !== undefined && m.amount_tax_signed !== false)
          ? m.amount_tax_signed
          : m.amount_tax
      );
      if (totalTaxINR) { cgst = totalTaxINR / 2; sgst = cgst; }
    }

    const round = v => Math.round(v * 100) / 100;
<<<<<<< HEAD
    const gstin = '';
=======
    const gstin = ''; // GSTIN fetched separately if needed
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e

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
<<<<<<< HEAD
        currency:            invoiceCurrency,
        is_foreign_currency: isForeignCurrency,
        taxable:             round(taxableINR),
        cgst:                round(cgst),
        sgst:                round(sgst),
        igst:                round(igst),
=======
        currency:            invoiceCurrency,       // 'USD', 'EUR', 'INR' etc. — shown as badge
        is_foreign_currency: isForeignCurrency,     // true for export invoices
        taxable:             round(taxableINR),      // always INR ✅
        cgst:                round(cgst),            // always INR ✅
        sgst:                round(sgst),            // always INR ✅
        igst:                round(igst),            // always INR ✅
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
        amount:              round(taxableINR),
        cgst:                round(cgst),
        sgst:                round(sgst),
        igst:                round(igst),
=======
        amount:              round(taxableINR),      // always INR ✅
        cgst:                round(cgst),            // always INR ✅
        sgst:                round(sgst),            // always INR ✅
        igst:                round(igst),            // always INR ✅
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
        gstr1_status:        'Pending'
      };
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
<<<<<<< HEAD
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
=======
  res.json({ status: 'ok', server: 'GST Audit Proxy v1.2 — multi-company fix', port: PORT, time: new Date().toISOString() });
});

app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({ ...s, apiKey: s.apiKey ? '••••••••' : '' });
});

app.post('/api/settings', (req, res) => {
  try {
    const s = loadSettings();
    const incoming = req.body;
    if (incoming.apiKey === '••••••••') delete incoming.apiKey;
    saveSettings({ ...s, ...incoming });
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/test', async (req, res) => {
<<<<<<< HEAD
  const s = { ...await loadSettings(), ...req.body };
  if (req.body.apiKey === '••••••••') s.apiKey = (await loadSettings()).apiKey;
=======
  const s = { ...loadSettings(), ...req.body };
  if (req.body.apiKey === '••••••••') s.apiKey = loadSettings().apiKey;
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
  const s   = await loadSettings();
=======
  const s   = loadSettings();
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
<<<<<<< HEAD
  const s   = await loadSettings();
=======
  const s   = loadSettings();
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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

<<<<<<< HEAD
// ── RCM Sync (transaction-wise) ───────────────────────────────
const RCM_ACCOUNT_TYPE = {
  '234005':  'igst',
  '2341013': 'igst',
  '234006':  'cgst',
  '2341015': 'cgst',
  '234007':  'sgst',
  '2341017': 'sgst',
=======
// ══════════════════════════════════════════════════════════════
//  NEW ROUTE — RCM Sync (all code above is untouched)
// ══════════════════════════════════════════════════════════════

const RCM_ACCOUNT_TYPE = {
  '234005':  'igst',   // RCM IGST Receivable
  '2341013': 'igst',   // RCM IGST Receivable-BT
  '234006':  'cgst',   // RCM CGST Receivable
  '2341015': 'cgst',   // RCM CGST Receivable-Zwing
  '234007':  'sgst',   // RCM SGST Receivable
  '2341017': 'sgst',   // RCM SGST Receivable-Zwing
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
};
const RCM_ACCOUNT_CODES = Object.keys(RCM_ACCOUNT_TYPE);
const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

<<<<<<< HEAD
=======
// ── Journal prefix → Branch / Company mapping ─────────────────
// Journal Entry No format in Odoo: PREFIX/YYYY/NNNNN  e.g. BHR/2025/00123
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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
  'BILLE': { branch: 'Haryana',       company: 'Easemy Business Private Limited',          coKey: 'em'    },
  'RBHR':  { branch: 'Haryana',       company: 'Roxfortech Infosolutions Private Limited', coKey: 'roxfo' },
  'BILRO': { branch: 'Haryana',       company: 'Roxfortech Infosolutions Private Limited', coKey: 'roxfo' },
<<<<<<< HEAD
=======
  // NOTE: BILL/* entries are intentionally excluded from RCM sync (cross-company Roxfortech entries)
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
};

function getRCMJournalInfo(moveName) {
  const prefix = (moveName || '').split('/')[0].toUpperCase().trim();
  return RCM_JOURNAL_MAP[prefix] || { branch: prefix || 'Unknown', company: 'Unknown', coKey: 'other' };
}

app.post('/api/sync/rcm', async (req, res) => {
<<<<<<< HEAD
  const s   = await loadSettings();
=======
  const s   = loadSettings();
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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

<<<<<<< HEAD
=======
    // Step 1: Resolve account IDs from codes
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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

<<<<<<< HEAD
=======
    // Step 2: Fetch posted journal lines for RCM accounts (paginated)
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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

<<<<<<< HEAD
    const moveIdSet = new Set(allLines.map(l => l.move_id[0]));
    const moveIds   = Array.from(moveIdSet);

=======
    // Step 3: Collect unique move IDs
    const moveIdSet = new Set(allLines.map(l => l.move_id[0]));
    const moveIds   = Array.from(moveIdSet);
    console.log(`   ${moveIds.length} unique journal entries`);

    // Step 4: Fetch parent moves — name, date, vendor (partner_id), taxable value
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const movesMap = {};
    for (let i = 0; i < moveIds.length; i += 200) {
      const batch = await odooCall(session, 'account.move', 'read',
        [moveIds.slice(i, i + 200)],
        { fields: ['id', 'name', 'invoice_date', 'date', 'partner_id',
                   'amount_untaxed_signed', 'amount_untaxed', 'ref'] }
      );
      batch.forEach(m => { movesMap[m.id] = m; });
    }

<<<<<<< HEAD
=======
    // Step 5: Aggregate IGST/CGST/SGST per move
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const moveTax = {};
    allLines.forEach(line => {
      const mid  = line.move_id[0];
      const code = acIdToCode[line.account_id[0]];
      const type = RCM_ACCOUNT_TYPE[code];
      const amt  = Math.abs(line.debit || 0);
      if (!moveTax[mid]) moveTax[mid] = { igst: 0, cgst: 0, sgst: 0 };
      if      (type === 'igst') moveTax[mid].igst += amt;
      else if (type === 'cgst') moveTax[mid].cgst += amt;
      else if (type === 'sgst') moveTax[mid].sgst += amt;
    });

<<<<<<< HEAD
    const round = v => Math.round(v * 100) / 100;
    const data = moveIds
      .map(mid => {
        const move  = movesMap[mid];
        const tax   = moveTax[mid] || { igst: 0, cgst: 0, sgst: 0 };
        const info  = getRCMJournalInfo(move ? move.name : '');
        const d     = (move && (move.date || move.invoice_date)) || '';
        const month = d
          ? MONTH_LABELS[parseInt(d.slice(5, 7), 10) - 1] + ' ' + d.slice(0, 4)
=======
    // Step 6: Build transaction-wise result
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const round = v => Math.round(v * 100) / 100;

    const data = moveIds
      .map(mid => {
        const move    = movesMap[mid];
        const tax     = moveTax[mid] || { igst: 0, cgst: 0, sgst: 0 };
        const info    = getRCMJournalInfo(move ? move.name : '');
        const d       = (move && (move.date || move.invoice_date)) || '';  // accounting date first
        const month   = d
          ? MONTH_SHORT[parseInt(d.slice(5, 7), 10) - 1] + ' ' + d.slice(0, 4)
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
          : '';
        const taxable = move
          ? Math.abs(
              (move.amount_untaxed_signed !== undefined && move.amount_untaxed_signed !== false)
                ? move.amount_untaxed_signed
                : (move.amount_untaxed || 0)
            )
          : 0;
        return {
          moveId:  mid,
          entryNo: move ? move.name : String(mid),
          date:    d,
          month,
<<<<<<< HEAD
          vendor:  move?.partner_id?.[1] || '—',
          ref:     move?.ref || '',
=======
          vendor:  move?.partner_id?.[1]  || '—',
          ref:     move?.ref              || '',
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
          branch:  info.branch,
          company: info.company,
          coKey:   info.coKey,
          taxable: round(taxable),
          igst:    round(tax.igst),
          cgst:    round(tax.cgst),
          sgst:    round(tax.sgst),
        };
      })
      .filter(r => {
<<<<<<< HEAD
=======
        // Exclude journal entries whose name starts with BILL/ — these belong to
        // Roxfortech (cross-company) and should not appear in RCM sync
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
        const prefix = (r.entryNo || '').split('/')[0].toUpperCase();
        if (prefix === 'BILL') {
          console.log(`   ⛔ Skipping BILL entry: ${r.entryNo}`);
          return false;
        }
        return r.igst > 0 || r.cgst > 0 || r.sgst > 0;
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    console.log(`✅ RCM: ${data.length} transactions from ${allLines.length} journal lines`);
    res.json({ ok: true, count: allLines.length, txCount: data.length, data });
  } catch (e) {
    console.error('❌ RCM error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

<<<<<<< HEAD
// ── ITC Books Sync ────────────────────────────────────────────
const ITC_ACCOUNT_MAP = {
  '234001':  { taxType: 'cgst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234002':  { taxType: 'sgst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234003':  { taxType: 'igst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234004':  { taxType: 'igst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234008':  { taxType: 'cgst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234009':  { taxType: 'sgst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '2341002': { taxType: 'cgst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341006': { taxType: 'sgst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341010': { taxType: 'igst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341003': { taxType: 'cgst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  '2341007': { taxType: 'sgst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  '2341011': { taxType: 'igst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
=======
// Serve the portal HTML at http://localhost:3002
const portalFile = path.join(__dirname, 'gst-audit-portal-v5.html');
app.get('/', (req, res) => {
  fs.existsSync(portalFile)
    ? res.sendFile(portalFile)
    : res.send(`<h2 style="font-family:Segoe UI;padding:40px">⚠ Place gst-audit-portal-v5.html in this folder: ${__dirname}</h2>`);
});

// ══════════════════════════════════════════════════════════════
//  NEW ROUTE: RCM Sync — Fetches debit balances of RCM receivable
//  accounts from Odoo Journal Items (account.move.line)
//  Accounts: 234005, 2341013 (IGST), 234006, 2341015 (CGST),
//            234007, 2341017 (SGST)
// ══════════════════════════════════════════════════════════════
app.post('/api/sync/rcm', async (req, res) => {
  const RCM_ACCOUNTS = ['234005', '2341013', '234006', '234007', '2341015', '2341017'];

  // Map account code prefix → tax type
  const RCM_TYPE = {
    '234005':  'igst',
    '2341013': 'igst',
    '234006':  'cgst',
    '2341015': 'cgst',
    '234007':  'sgst',
    '2341017': 'sgst'
  };

  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Company name → key mapping (lowercase fragment match)
  const CO_MATCH = [
    { key: 'gsl',    frags: ['ginni'] },
    { key: 'em',     frags: ['easemy'] },
    { key: 'bt',     frags: ['browntape'] },
    { key: 'roxfo',  frags: ['roxfortech'] }
  ];
  function getCoKey(name) {
    const n = (name || '').toLowerCase();
    for (const co of CO_MATCH) {
      if (co.frags.some(f => n.includes(f))) return co.key;
    }
    return 'gsl'; // default
  }

  const s   = loadSettings();
  const cfg = {
    url:      req.body.url      || s.url,
    db:       req.body.db       || s.db,
    username: req.body.username || s.username,
    apiKey:   req.body.apiKey === '••••••••' ? s.apiKey : (req.body.apiKey || s.apiKey)
  };
  const { fromDate, toDate } = req.body;

  try {
    console.log(`\n📦 RCM sync: ${fromDate} → ${toDate}`);
    const session = await odooAuthenticate(cfg.url, cfg.db, cfg.username, cfg.apiKey);

    // Fetch all RCM journal lines within the date range
    const lines = await odooCall(session, 'account.move.line', 'search_read', [[
      ['account_id.code', 'in', RCM_ACCOUNTS],
      ['move_id.state', '=', 'posted'],
      ['date', '>=', fromDate],
      ['date', '<=', toDate]
    ]], {
      fields: ['date', 'name', 'account_id', 'debit', 'credit', 'balance', 'move_id', 'company_id'],
      limit:  10000,
      order:  'date asc'
    });

    console.log(`   ${lines.length} RCM journal lines`);

    // Group by company × month
    const groups = {};
    lines.forEach(l => {
      // Parse date directly from string to avoid timezone issues
      const d  = l.date || '';               // "2025-04-15"
      const yr = parseInt(d.slice(0, 4));
      const mo = parseInt(d.slice(5, 7)) - 1;  // 0-based
      if (isNaN(yr) || isNaN(mo)) return;
      const mKey   = MONTHS_SHORT[mo] + ' ' + yr;   // "Apr 2025"

      const coRaw  = l.company_id?.[1] || '';
      const coKey  = getCoKey(coRaw);
      const gKey   = coKey + '|' + mKey;

      if (!groups[gKey]) {
        groups[gKey] = { month: mKey, company: coRaw, coKey, igst: 0, cgst: 0, sgst: 0 };
      }

      // Identify tax type from account display name (format: "CODE Account Name")
      const accDisplay = l.account_id?.[1] || '';
      const codeToken  = accDisplay.split(/[\s-]/)[0];  // take first word before space or dash
      const taxType    = RCM_TYPE[codeToken];

      if (taxType) {
        // Use debit amount — RCM receivable accounts are debited when RCM is applicable
        const amt = Math.abs(l.debit || 0);
        groups[gKey][taxType] += amt;
      } else {
        // Fallback: match any of the codes in the display name
        for (const [code, type] of Object.entries(RCM_TYPE)) {
          if (accDisplay.includes(code)) {
            groups[gKey][type] += Math.abs(l.debit || 0);
            break;
          }
        }
      }
    });

    const data = Object.values(groups).map(g => ({
      month:   g.month,
      company: g.company,
      coKey:   g.coKey,
      igst:    Math.round(g.igst * 100) / 100,
      cgst:    Math.round(g.cgst * 100) / 100,
      sgst:    Math.round(g.sgst * 100) / 100
    }));

    console.log(`✅ RCM: ${data.length} company-month groups`);
    res.json({ ok: true, count: data.length, data });
  } catch(e) {
    console.error('❌ RCM error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  NEW ROUTE: ITC Books Sync — Fetches credit balances of ITC
//  receivable accounts from Odoo Journal Items (account.move.line)
//  Company is determined by ACCOUNT CODE (not journal prefix).
//
//  Account → Tax Type + Company mapping:
//    234001  CGST Receivable          → Ginni Systems Limited
//    234002  SGST Receivable          → Ginni Systems Limited
//    234003  IGST Receivable          → Ginni Systems Limited
//    234004  ISD IGST Receivable      → Ginni Systems Limited
//    234008  ISD CGST Receivable      → Ginni Systems Limited
//    234009  ISD SGST Receivable      → Ginni Systems Limited
//    2341002 CGST Receivable-BT       → Browntape Technologies Pvt Ltd
//    2341006 SGST Receivable-BT       → Browntape Technologies Pvt Ltd
//    2341010 IGST Receivable-BT       → Browntape Technologies Pvt Ltd
//    2341003 CGST Receivable-EMG      → Easemy Business Private Limited
//    2341007 SGST Receivable-EMG      → Easemy Business Private Limited
//    2341011 IGST Receivable-EMG      → Easemy Business Private Limited
//    2341001 CGST Receivable-Zwing    → Roxfortech Infosolutions Pvt Ltd
//    2341005 SGST Receivable-Zwing    → Roxfortech Infosolutions Pvt Ltd
//    2341009 IGST Receivable-Zwing    → Roxfortech Infosolutions Pvt Ltd
// ══════════════════════════════════════════════════════════════
const ITC_ACCOUNT_MAP = {
  // ── Ginni Systems — Normal ITC ──────────────────────────────────────────────
  '234001':  { taxType: 'cgst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234002':  { taxType: 'sgst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  '234003':  { taxType: 'igst', itcType: 'Normal', coKey: 'gsl',   company: 'Ginni Systems Limited'                    },
  // ── Ginni Systems — ISD ITC (Input Service Distributor) ────────────────────
  '234004':  { taxType: 'igst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },  // ISD IGST
  '234008':  { taxType: 'cgst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },  // ISD CGST
  '234009':  { taxType: 'sgst', itcType: 'ISD',    coKey: 'gsl',   company: 'Ginni Systems Limited'                    },  // ISD SGST
  // ── Browntape — Normal ITC ──────────────────────────────────────────────────
  '2341002': { taxType: 'cgst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341006': { taxType: 'sgst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  '2341010': { taxType: 'igst', itcType: 'Normal', coKey: 'bt',    company: 'Browntape Technologies Private Limited'   },
  // ── Easemy Business — Normal ITC ────────────────────────────────────────────
  '2341003': { taxType: 'cgst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  '2341007': { taxType: 'sgst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  '2341011': { taxType: 'igst', itcType: 'Normal', coKey: 'em',    company: 'Easemy Business Private Limited'          },
  // ── Roxfortech — Normal ITC ─────────────────────────────────────────────────
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
  '2341001': { taxType: 'cgst', itcType: 'Normal', coKey: 'roxfo', company: 'Roxfortech Infosolutions Private Limited' },
  '2341005': { taxType: 'sgst', itcType: 'Normal', coKey: 'roxfo', company: 'Roxfortech Infosolutions Private Limited' },
  '2341009': { taxType: 'igst', itcType: 'Normal', coKey: 'roxfo', company: 'Roxfortech Infosolutions Private Limited' },
};
const ITC_ACCOUNT_CODES = Object.keys(ITC_ACCOUNT_MAP);

app.post('/api/sync/itc', async (req, res) => {
<<<<<<< HEAD
  const s   = await loadSettings();
=======
  const s   = loadSettings();
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
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

<<<<<<< HEAD
=======
    // Step 1: Resolve account IDs from codes
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const accounts = await odooCall(session, 'account.account', 'search_read',
      [[['code', 'in', ITC_ACCOUNT_CODES]]],
      { fields: ['id', 'code', 'name'], limit: 100 }
    );
    console.log(`   Found ${accounts.length} ITC accounts`);
    if (!accounts.length) {
      return res.json({ ok: true, count: 0, data: [],
        message: 'No ITC accounts found with codes: ' + ITC_ACCOUNT_CODES.join(', ') });
    }

<<<<<<< HEAD
=======
    // Build id → code map
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const acIdToCode = {};
    accounts.forEach(a => { acIdToCode[a.id] = a.code; });
    const acIds = accounts.map(a => a.id);

<<<<<<< HEAD
=======
    // Step 2: Fetch posted journal lines for ITC accounts (paginated)
    // move_type filter: only 'in_invoice' (vendor bills) and 'in_refund' (vendor credit notes).
    // This excludes move_type='entry' (general journal / GST adjustment entries like MISC/MISBT)
    // at the Odoo query level — the most reliable way to filter them out.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const BATCH = 500;
    const domain = [
      ['account_id',   'in',  acIds],
      ['date',         '>=',  fromDate],
      ['date',         '<=',  toDate],
      ['parent_state', '=',   'posted'],
      ['move_type',    'in',  ['in_invoice', 'in_refund']]
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

<<<<<<< HEAD
    const moveGroups = {};
=======
    // Step 3: Group by move_id — one record per journal entry (bill)
    // Company priority: journal prefix (if explicitly mapped) > account code.
    // Rationale: BTBIL/MISBT clearly signal Browntape even if their ITC lines
    // accidentally hit a Ginni account in Odoo.
    const moveGroups = {};   // key = move_id (numeric)

>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    allLines.forEach(l => {
      const moveId  = l.move_id[0];
      const moveNo  = l.move_id[1] || '';
      const code    = acIdToCode[l.account_id[0]];
      const acInfo  = ITC_ACCOUNT_MAP[code];
<<<<<<< HEAD
      if (!acInfo) return;

      if (!moveGroups[moveId]) {
        const brInfo    = getBranch(moveNo);
=======
      if (!acInfo) return;   // unknown account — skip

      if (!moveGroups[moveId]) {
        const brInfo = getBranch(moveNo);
        // If the journal prefix is explicitly in our maps, let it override the account-code
        // company — this correctly assigns BTBIL → Browntape even when it posts to Ginni accounts.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
        const usePrefix = (brInfo.coKey !== 'other');
        moveGroups[moveId] = {
          moveId,
          moveNo,
<<<<<<< HEAD
          billDate:     l.date || '',
          refNo:        '',
          vendorName:   '',
          isAdjustment: false,
          itcType:      acInfo.itcType || 'Normal',
          branch:       brInfo.branch,
          company:      usePrefix ? brInfo.company : acInfo.company,
          coKey:        usePrefix ? brInfo.coKey   : acInfo.coKey,
          taxable:      0,
          igst:         0,
          cgst:         0,
          sgst:         0
        };
      } else if (acInfo.itcType === 'ISD') {
        moveGroups[moveId].itcType = 'ISD';
      }

      const amt = Math.abs(l.credit || 0) > Math.abs(l.debit || 0)
        ? Math.abs(l.credit || 0)
        : Math.abs(l.debit  || 0);
      moveGroups[moveId][acInfo.taxType] += amt;
    });

=======
          billDate:   l.date || '',
          refNo:      '',
          vendorName: '',
          isAdjustment: false,   // flagged in Step 4 when partner_id is empty
          // itcType set from first line's account; upgraded to 'ISD' if any line
          // hits an ISD account (234004 / 234008 / 234009).
          itcType:    acInfo.itcType || 'Normal',
          branch:     brInfo.branch,
          company:    usePrefix ? brInfo.company : acInfo.company,
          coKey:      usePrefix ? brInfo.coKey   : acInfo.coKey,
          taxable:    0,
          igst:       0,
          cgst:       0,
          sgst:       0
        };
      } else if (acInfo.itcType === 'ISD') {
        // Upgrade to ISD if a subsequent line for the same move hits an ISD account.
        moveGroups[moveId].itcType = 'ISD';
      }

      // ITC receivable accounts: credited when ITC is booked.
      // Use whichever side carries the value (credit for booking, debit for reversal).
      const amt = Math.abs(l.credit || 0) > Math.abs(l.debit || 0)
        ? Math.abs(l.credit || 0)
        : Math.abs(l.debit  || 0);

      moveGroups[moveId][acInfo.taxType] += amt;
    });

    // Step 4: Batch-fetch account.move records to get ref, vendor, accounting date, taxable value
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const moveIds = Object.keys(moveGroups).map(Number);
    console.log(`   Fetching ${moveIds.length} account.move records for bill details...`);
    const MOVE_BATCH = 200;
    for (let i = 0; i < moveIds.length; i += MOVE_BATCH) {
      const batchIds = moveIds.slice(i, i + MOVE_BATCH);
      const moves = await odooCall(session, 'account.move', 'read',
        [batchIds],
        { fields: ['id', 'name', 'ref', 'partner_id', 'date', 'amount_untaxed'] }
      );
      moves.forEach(m => {
        const g = moveGroups[m.id];
        if (!g) return;
        g.moveNo     = m.name || g.moveNo;
        g.refNo      = m.ref  || '';
        g.vendorName = m.partner_id ? m.partner_id[1] : '';
        g.billDate   = m.date || g.billDate;
        g.taxable    = Math.abs(m.amount_untaxed || 0);
<<<<<<< HEAD
=======
        // Secondary guard: flag entries with no vendor as adjustments.
        // Primary filter is the move_type domain above, but this catches
        // any edge cases where a 'entry'-type move still slips through.
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
        g.isAdjustment = !m.partner_id;
      });
    }

<<<<<<< HEAD
=======
    // Step 5: Build final result array — exclude adjustment entries, add month string
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const round = v => Math.round(v * 100) / 100;

    const allGroups = Object.values(moveGroups);
    const skipped   = allGroups.filter(g => g.isAdjustment);
    const bills     = allGroups.filter(g => !g.isAdjustment);

    if (skipped.length) {
<<<<<<< HEAD
      console.log(`   ⚠ Skipped ${skipped.length} adjustment entries:`,
=======
      console.log(`   ⚠ Skipped ${skipped.length} adjustment entries (no vendor/partner_id):`,
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
        skipped.slice(0,5).map(g => g.moveNo).join(', ') + (skipped.length > 5 ? '…' : ''));
    }

    const data = bills.map(g => {
<<<<<<< HEAD
      const d     = g.billDate || '';
      const yr    = parseInt(d.slice(0, 4), 10);
      const mo    = parseInt(d.slice(5, 7), 10) - 1;
=======
      const d  = g.billDate || '';
      const yr = parseInt(d.slice(0, 4), 10);
      const mo = parseInt(d.slice(5, 7), 10) - 1;  // 0-based
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
      const month = (!isNaN(yr) && !isNaN(mo) && mo >= 0 && mo <= 11)
        ? MONTH_SHORT[mo] + ' ' + yr : '';
      return {
        moveId:     g.moveId,
        moveNo:     g.moveNo,
        billDate:   g.billDate,
        month,
        refNo:      g.refNo,
        vendorName: g.vendorName,
        branch:     g.branch,
        company:    g.company,
        coKey:      g.coKey,
<<<<<<< HEAD
        itcType:    g.itcType,
=======
        itcType:    g.itcType,   // 'ISD' | 'Normal'
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
        taxable:    round(g.taxable),
        igst:       round(g.igst),
        cgst:       round(g.cgst),
        sgst:       round(g.sgst)
      };
    }).sort((a, b) => (a.billDate || '').localeCompare(b.billDate || ''));

    const isdCount    = data.filter(r => r.itcType === 'ISD').length;
    const normalCount = data.filter(r => r.itcType === 'Normal').length;
<<<<<<< HEAD
    console.log(`✅ ITC Books: ${data.length} bills (${skipped.length} excluded) — Normal: ${normalCount}, ISD: ${isdCount}`);
=======
    console.log(`✅ ITC Books: ${data.length} bills (${skipped.length} adjustment entries excluded) — Normal: ${normalCount}, ISD: ${isdCount} — from ${allLines.length} journal lines`);
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
    res.json({ ok: true, count: data.length, skipped: skipped.length, lineCount: allLines.length, data });
  } catch(e) {
    console.error('❌ ITC sync error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

<<<<<<< HEAD
// Serve the portal HTML
const portalFile = path.join(__dirname, 'gst-audit-portal.html');
app.get('/', (req, res) => {
  fs.existsSync(portalFile)
    ? res.sendFile(portalFile)
    : res.send(`<h2 style="font-family:Segoe UI;padding:40px">⚠ Place gst-audit-portal.html in this folder: ${__dirname}</h2>`);
});

// ══════════════════════════════════════════════════════════════
//  FIREBASE STATE PERSISTENCE  (storage-bridge.js calls these)
//
//  GET    /api/state         — load all keys
//  POST   /api/state/:key    — save one key (chunked if large)
//  DELETE /api/state         — wipe all state
// ══════════════════════════════════════════════════════════════
const STATE_KEYS = ['gst_cfg','gst_g1','gst_3b','gst_rcm','gst_sales','gst_credit','gst_g2b','gst_itc','gst_isd'];

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
=======

// ══════════════════════════════════════════════════════════════
//  SERVER-SIDE STORAGE  — persists portal data across browsers
//  GET  /api/storage        → returns all saved data
//  POST /api/storage        → saves all data (full replace)
//  POST /api/storage/merge  → merges keys into existing data
// ══════════════════════════════════════════════════════════════
const STORAGE_FILE = path.join(__dirname, 'gst-portal-data.json');

// In-memory cache — survives requests, lost only on process restart
let _storageCache = null;

function loadStorageCache() {
  if (_storageCache) return _storageCache;
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      _storageCache = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
      console.log(`📂 Loaded portal data from disk (${Object.keys(_storageCache.keys||{}).length} keys)`);
    }
  } catch(e) { console.warn('Storage load error:', e.message); }
  if (!_storageCache) _storageCache = { keys: {}, _saved: null };
  return _storageCache;
}

function saveStorageToDisk(data) {
  try {
    data._saved = new Date().toISOString();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf8');
  } catch(e) { console.warn('Storage write error:', e.message); }
}

// GET /api/storage — client calls on init to restore data
app.get('/api/storage', (req, res) => {
  const data = loadStorageCache();
  res.json({ ok: true, keys: data.keys || {}, saved: data._saved });
});

// POST /api/storage — client calls on every save (full snapshot)
app.post('/api/storage', (req, res) => {
  const { keys } = req.body;
  if (!keys || typeof keys !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing keys object' });
  }
  _storageCache = { keys, _saved: new Date().toISOString() };
  saveStorageToDisk(_storageCache);
  console.log(`💾 Storage saved (${Object.keys(keys).length} keys)`);
  res.json({ ok: true, saved: _storageCache._saved });
});

// POST /api/storage/merge — merges specific keys (partial update)
app.post('/api/storage/merge', (req, res) => {
  const { keys } = req.body;
  if (!keys || typeof keys !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing keys object' });
  }
  const existing = loadStorageCache();
  Object.assign(existing.keys, keys);
  saveStorageToDisk(existing);
  console.log(`🔀 Storage merged (${Object.keys(keys).length} keys updated)`);
  res.json({ ok: true, saved: existing._saved });
});

app.listen(PORT, () => {
  const s = loadSettings();
  console.log(`╔══════════════════════════════════════════════════╗`);
  console.log(`║  GST AUDIT PORTAL  Proxy v1.2  →  localhost:${PORT}  ║`);
  console.log(`╠══════════════════════════════════════════════════╣`);
  console.log(`║  FX Fix: amount_untaxed_signed + balance field   ║`);
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
  console.log(`║  POST /api/test          — test Odoo login       ║`);
  console.log(`║  POST /api/sync/sales    — sync sales invoices   ║`);
  console.log(`║  POST /api/sync/credit   — sync credit notes     ║`);
  console.log(`║  POST /api/sync/rcm      — sync RCM accounts     ║`);
  console.log(`║  POST /api/sync/itc      — sync ITC books accs   ║`);
<<<<<<< HEAD
  console.log(`║  GET  /api/state         — load all portal state ║`);
=======
  console.log(`║  GET  /api/storage       — load portal data      ║`);
  console.log(`║  POST /api/storage       — save portal data      ║`);
  console.log(`║  GET  /                  — open portal           ║`);
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
  console.log(`╚══════════════════════════════════════════════════╝\n`);
  console.log(`  Odoo : ${s.url}`);
  console.log(`  DB   : ${s.db}`);
  console.log(`  User : ${s.username}`);
<<<<<<< HEAD
  console.log(`\n  ➡  Open http://localhost:${PORT}/gst-audit-portal.html\n`);
=======
  console.log(`\n  ➡  Open http://localhost:${PORT} in your browser\n`);
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e
});
