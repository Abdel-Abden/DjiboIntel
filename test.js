/**
 * DjiboIntel Backend — Script de test rapide
 * Lancez avec : node test.js
 * (Le serveur doit tourner sur localhost:3001)
 */

'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:3001';

const tests = [
  { name: 'Santé serveur',        url: '/health' },
  { name: 'Statut APIs',          url: '/api/status' },
  { name: 'News Djibouti (FR)',   url: '/api/news?q=Djibouti&lang=fr&pageSize=5' },
  { name: 'IDE — tous secteurs',  url: '/api/ide?geo=all' },
  { name: 'IDE — Djibouti seul',  url: '/api/ide?geo=dj' },
  { name: 'Pétrole Brent',        url: '/api/brent' },
  { name: 'Brent + historique',   url: '/api/brent?history=1' },
  { name: 'Pétrole WTI',         url: '/api/wti' },
  { name: 'RSS Maritime',         url: '/api/maritime/rss' },
  { name: 'AIS (doit échouer)',   url: '/api/maritime/ais' },
  { name: 'Dashboard agrégé',     url: '/api/dashboard' },
];

async function run() {
  console.log(`\n🔍 DjiboIntel Backend — Tests (${BASE})\n`);
  let passed = 0, failed = 0;

  for (const t of tests) {
    try {
      const start = Date.now();
      const res  = await fetch(`${BASE}${t.url}`);
      const data = await res.json();
      const ms   = Date.now() - start;
      const ok   = res.ok || data.ok !== false;
      const sym  = ok ? '✅' : '⚠️ ';
      console.log(`${sym} ${t.name.padEnd(28)} ${res.status} — ${ms}ms — cache:${data.fromCache ? 'HIT' : 'MISS'}`);
      if (ok) passed++; else failed++;
    } catch (err) {
      console.log(`❌ ${t.name.padEnd(28)} ERREUR — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n═══════════════════════════════════`);
  console.log(`  ✅ Réussis : ${passed}  ❌ Échoués : ${failed}`);
  console.log(`═══════════════════════════════════\n`);
}

run();
