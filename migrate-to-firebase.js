/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  GST Portal — One-Time Firebase Migration Script             ║
 * ║  Uploads your existing gst-portal-state.json to Firestore   ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 *  Run ONCE after setting up Firebase:
 *    node migrate-to-firebase.js
 *
 *  Requirements:
 *    - serviceAccountKey.json must be in the same folder
 *    - gst-portal-state.json must be in the same folder
 *    - npm install firebase-admin  (already in package.json)
 */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');

// ── Chunking config (must match gst-server.js) ─────────────────
const CHUNK_SIZE  = 400;
const CHUNK_LIMIT = 900000; // 900 KB

// ── Firebase init ──────────────────────────────────────────────
const saPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(saPath)) {
  console.error('❌ serviceAccountKey.json not found in this folder.');
  console.error('   Download it from Firebase Console → Project Settings → Service Accounts');
  process.exit(1);
}

const stateFile = path.join(__dirname, 'gst-portal-state.json');
if (!fs.existsSync(stateFile)) {
  console.error('❌ gst-portal-state.json not found in this folder.');
  process.exit(1);
}

const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db  = admin.firestore();
const col = db.collection('gst_state');

// ── Helpers ────────────────────────────────────────────────────
function sizeKB(v) {
  return Math.round(Buffer.byteLength(JSON.stringify(v), 'utf8') / 1024);
}

async function saveKey(key, value) {
  const byteSize  = Buffer.byteLength(JSON.stringify(value), 'utf8');
  const needChunk = Array.isArray(value) && byteSize > CHUNK_LIMIT;

  if (!needChunk) {
    await col.doc(key).set({ value, updatedAt: new Date().toISOString() });
    console.log(`  ✅ [${key}]  ${sizeKB(value)} KB  →  single doc`);
    return;
  }

  // Build chunks
  const chunks = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }

  // Firestore batch write (max 500 ops; our chunks are well within that)
  const batch = db.batch();
  batch.set(col.doc(key), {
    chunked:    true,
    chunkCount: chunks.length,
    totalCount: value.length,
    updatedAt:  new Date().toISOString()
  });
  chunks.forEach((chunk, i) => {
    batch.set(col.doc(`${key}_chunk_${i}`), { items: chunk });
  });
  await batch.commit();
  console.log(`  ✅ [${key}]  ${sizeKB(value)} KB  →  ${chunks.length} chunks (${value.length} records)`);
}

// ── Main ───────────────────────────────────────────────────────
async function migrate() {
  console.log('\n🚀 GST Portal → Firebase migration starting...\n');

  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const keys = Object.keys(raw);

  console.log(`   Found ${keys.length} keys in gst-portal-state.json:\n`);
  keys.forEach(k => {
    const v = raw[k];
    const count = Array.isArray(v) ? `${v.length} records` : 'object';
    console.log(`   • ${k.padEnd(15)} ${sizeKB(v)} KB   (${count})`);
  });
  console.log('');

  for (const key of keys) {
    const value = raw[key];
    if (value === null || value === undefined) {
      console.log(`  ⏭ [${key}]  empty — skipped`);
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      console.log(`  ⏭ [${key}]  empty array — skipped`);
      continue;
    }
    await saveKey(key, value);
  }

  console.log('\n✅ Migration complete! All data is now in Firebase Firestore.');
  console.log('   You can verify at: https://console.firebase.google.com');
  console.log('   → Firestore Database → gst_state collection\n');

  // Verify by reading back gst_sales count
  const meta = await col.doc('gst_sales').get();
  if (meta.exists) {
    const d = meta.data();
    if (d.chunked) {
      console.log(`   gst_sales: ${d.totalCount} records in ${d.chunkCount} chunks ✅`);
    } else {
      console.log(`   gst_sales: stored as single doc ✅`);
    }
  }

  process.exit(0);
}

migrate().catch(e => {
  console.error('❌ Migration failed:', e.message);
  process.exit(1);
});
