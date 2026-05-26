import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const ST_API_KEY = process.env.SOLANATRACKER_API_KEY;

if (!ST_API_KEY) {
  console.error('Missing SOLANATRACKER_API_KEY in .env');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'data', 'traders.json');
const MAX_WALLETS = 200;

async function loadStore() {
  try {
    const text = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return {
      scans: Array.isArray(parsed?.scans) ? parsed.scans : [],
      tokens: Array.isArray(parsed?.tokens) ? parsed.tokens : [],
    };
  } catch {
    return { scans: [], tokens: [] };
  }
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

function aggregateByWallet(scans) {
  const byWallet = new Map();
  for (const s of scans) {
    const w = byWallet.get(s.wallet) || {
      wallet: s.wallet, pnl: 0, entrySum: 0, entryCount: 0, exitSum: 0, exitCount: 0,
      multipleSum: 0, multipleCount: 0, tokens: 0, lastSeen: 0,
    };
    w.pnl += Number(s.pnl) || 0;
    const entry = Number(s.entryMcap) || 0;
    const exit = Number(s.exitMcap) || 0;
    if (entry) { w.entrySum += entry; w.entryCount++; }
    if (exit) { w.exitSum += exit; w.exitCount++; }
    if (entry > 0 && exit > 0) { w.multipleSum += exit / entry; w.multipleCount++; }
    w.tokens++;
    if (s.scannedAt > w.lastSeen) w.lastSeen = s.scannedAt;
    byWallet.set(s.wallet, w);
  }
  return [...byWallet.values()].map(w => ({
    wallet: w.wallet,
    pnl: w.pnl,
    avgEntryMcap: w.entryCount ? w.entrySum / w.entryCount : 0,
    avgExitMcap: w.exitCount ? w.exitSum / w.exitCount : 0,
    avgMultiple: w.multipleCount ? w.multipleSum / w.multipleCount : 0,
    tokens: w.tokens,
    lastSeen: w.lastSeen,
  })).sort((a, b) => b.avgMultiple - a.avgMultiple);
}

function summarizeToken(tokenAddress, items, scannedAt) {
  let totalPnl = 0, entrySum = 0, entryCount = 0, exitSum = 0, exitCount = 0;
  for (const it of items) {
    totalPnl += Number(it.realizedPnl) || 0;
    const entry = Number(it.entryMcap) || 0;
    const exit = Number(it.exitMcap) || 0;
    if (entry) { entrySum += entry; entryCount++; }
    if (exit) { exitSum += exit; exitCount++; }
  }
  return {
    address: tokenAddress,
    scannedAt,
    traderCount: items.length,
    totalPnl,
    avgEntryMcap: entryCount ? entrySum / entryCount : 0,
    avgExitMcap: exitCount ? exitSum / exitCount : 0,
  };
}

async function recordScan(tokenAddress, items) {
  const store = await loadStore();
  const now = Date.now();
  const byKey = new Map();
  for (const s of store.scans) byKey.set(`${s.wallet}#${s.token}`, s);
  for (const it of items) {
    if (!it.owner) continue;
    byKey.set(`${it.owner}#${tokenAddress}`, {
      wallet: it.owner,
      token: tokenAddress,
      pnl: Number(it.realizedPnl) || 0,
      entryMcap: Number(it.entryMcap) || 0,
      exitMcap: Number(it.exitMcap) || 0,
      scannedAt: now,
    });
  }
  const merged = [...byKey.values()];
  const topWallets = new Set(aggregateByWallet(merged).slice(0, MAX_WALLETS).map(w => w.wallet));
  const trimmed = merged.filter(s => topWallets.has(s.wallet));

  const tokens = store.tokens.filter(t => t.address !== tokenAddress);
  tokens.push(summarizeToken(tokenAddress, items, now));

  await saveStore({ scans: trimmed, tokens });
}

async function stGet(pathname) {
  const r = await fetch(`https://data.solanatracker.io${pathname}`, {
    headers: { accept: 'application/json', 'x-api-key': ST_API_KEY },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Solana Tracker HTTP ${r.status}: ${body?.error || body?.message || 'unknown error'}`);
  if (body && !Array.isArray(body) && body.error) throw new Error(`Solana Tracker: ${body.error}`);
  return body;
}

async function fetchSolanaTracker(address) {
  if (!ST_API_KEY) throw new Error('SOLANATRACKER_API_KEY not configured');
  const [traders, tokenInfo] = await Promise.all([
    stGet(`/top-traders/${encodeURIComponent(address)}`),
    stGet(`/tokens/${encodeURIComponent(address)}`).catch(() => null),
  ]);
  const totalSupply = Number(tokenInfo?.pools?.[0]?.tokenSupply || 0);
  const list = Array.isArray(traders) ? traders : (traders?.traders || traders?.data || []);
  return list.map(it => {
    const held = Number(it.held || 0);
    const sold = Number(it.sold || 0);
    const bought = held + sold;
    const totalInvested = Number(it.total_invested || 0);
    const realized = Number(it.realized || 0);
    const total = it.total != null ? Number(it.total) : (realized + Number(it.unrealized || 0));
    const avgEntry = bought > 0 ? totalInvested / bought : 0;
    const costOfSold = bought > 0 ? totalInvested * (sold / bought) : 0;
    const avgExit = sold > 0 ? (realized + costOfSold) / sold : 0;
    return {
      owner: it.wallet || it.address,
      volumeBuy: bought,
      volumeSell: sold,
      volumeBuyUsd: totalInvested,
      volumeSellUsd: realized + costOfSold,
      tradeBuy: Number(it.tx_counts?.buys || it.buys || 0),
      tradeSell: Number(it.tx_counts?.sells || it.sells || 0),
      realizedPnl: total,
      entryMcap: avgEntry * totalSupply,
      exitMcap: avgExit * totalSupply,
    };
  });
}

app.get('/api/top-traders', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'address query parameter is required' });

  try {
    const store = await loadStore();
    if (store.tokens.some(t => t.address === address) || store.scans.some(s => s.token === address)) {
      return res.status(409).json({ error: 'Token already scanned' });
    }
    const items = await fetchSolanaTracker(address);
    recordScan(address, items).catch(err => console.error('recordScan failed:', err));
    res.json({ source: 'solanatracker', items });
  } catch (err) {
    res.status(502).json({ error: err.message || String(err) });
  }
});

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const { scans } = await loadStore();
    const wallets = aggregateByWallet(scans).slice(0, MAX_WALLETS);
    res.json({ wallets });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/history', async (_req, res) => {
  try {
    const { tokens } = await loadStore();
    const sorted = [...tokens].sort((a, b) => (b.scannedAt || 0) - (a.scannedAt || 0));
    res.json({ tokens: sorted });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Wallet Spotter running at http://localhost:${PORT}`);
});
