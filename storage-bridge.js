/**
 * GST Audit Portal — Storage Bridge v2.0
 * Syncs all app state to Firebase via the Express server.
 * Uses relative URLs so it works both locally and on Render.com.
 */
(function () {
  'use strict';

<<<<<<< HEAD
  const API = '/api/state';
=======
  const API = 'https://gst-audit-portal-1.onrender.com/api/state';
>>>>>>> 302a4ef052685ce5d28bc08ef92a31a268ddb00e

  const STATE_KEYS = [
    'gst_cfg', 'gst_g1', 'gst_3b', 'gst_rcm',
    'gst_sales', 'gst_credit', 'gst_g2b', 'gst_itc', 'gst_isd'
  ];

  function patchLsSet() {
    if (typeof window._lsSet_original === 'function') return;
    if (typeof window._lsSet !== 'function') return;

    window._lsSet_original = window._lsSet;

    window._lsSet = function (key, data) {
      var ok = window._lsSet_original(key, data);
      try {
        fetch(API + '/' + encodeURIComponent(key), {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ value: data })
        }).catch(function () {});
      } catch (e) {}
      return ok;
    };
    console.log('[StorageBridge] Patched — saves go to Firebase');
  }

  async function loadFromServer() {
    try {
      const res = await fetch(API);
      if (!res.ok) return;
      const json = await res.json();
      if (!json || !json.state) return;

      const serverState = json.state;
      const srvCfg = serverState['gst_cfg'];
      const locCfgRaw = localStorage.getItem('gst_cfg');
      let serverIsNewer = false;

      if (srvCfg && locCfgRaw) {
        try {
          const locCfg  = JSON.parse(locCfgRaw);
          serverIsNewer = new Date(srvCfg.savedAt||0) > new Date(locCfg.savedAt||0);
        } catch (e) {}
      } else if (srvCfg && !locCfgRaw) {
        serverIsNewer = true;
      }

      let seeded = 0;
      STATE_KEYS.forEach(function (key) {
        if (serverState[key] !== undefined && (serverIsNewer || !localStorage.getItem(key))) {
          try { localStorage.setItem(key, JSON.stringify(serverState[key])); seeded++; } catch (e) {}
        }
      });

      if (seeded) console.log('[StorageBridge] Loaded', seeded, 'keys from Firebase', serverIsNewer ? '(server newer)' : '(missing keys)');
    } catch (e) {
      console.info('[StorageBridge] Offline — using localStorage only');
    }
  }

  async function init() {
    await loadFromServer();
    patchLsSet();
    try {
      if (typeof window.loadAppState === 'function') window.loadAppState();
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
