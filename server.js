const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');

const config = require('./server/config');
const aiRouteFactory = require('./server/routes/ai');
const neuroSanClientRouteFactory = require('./server/routes/neurosan_client');

const app = express();
const PORT = config.port || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight runtime config exposure (non-secret) so frontend knows if a Neuro-SAN
// summary analysis project is configured. Only expose the project name (already non-sensitive label)
// and a boolean for convenience. Do NOT expose API keys or base URLs.
app.get('/api/app-config', (req,res)=>{
  res.json({
    neuroSanSummaryProjectConfigured: Boolean(config.neuro.summaryProjectName),
    neuroSanSummaryProjectName: config.neuro.summaryProjectName || null
  });
});

// simple GET/PUT to persist gesture tuner settings
const TUNER_FILE = path.join(__dirname, 'data', 'tuner.json');
app.get('/api/tuner', (req, res) => {
  fs.readFile(TUNER_FILE, 'utf8', (err, data) => {
    if (err) return res.json({});
    try { return res.json(JSON.parse(data)); } catch(e) { return res.json({}); }
  });
});

app.put('/api/tuner', (req, res) => {
  const payload = req.body || {};
  fs.writeFile(TUNER_FILE, JSON.stringify(payload, null, 2), (err) => {
    if (err) return res.status(500).json({ error: 'failed to save' });
    return res.json({ saved: true });
  });
});

// cars API - list available cars
app.get('/api/cars', (req, res) => {
  fs.readFile(config.carsFile, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'failed to read cars' });
    try { const payload = JSON.parse(data); return res.json(payload); } catch(e) { return res.status(500).json({ error: 'invalid cars file' }); }
  });
});

// fleet summary: totals and operational/out-of-service counts
app.get('/api/fleet-summary', (req, res) => {
  fs.readFile(config.carsFile, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'failed to read cars' });
    try {
      const payload = JSON.parse(data);
      const all = (payload.cars || []);
      const statusRank = { 'Good': 0, 'Warning': 1, 'Critical': 2 };
      let total = all.length;
      let countGoodCars = 0, countWarningCars = 0, countCriticalCars = 0;
      let operationalCount = 0;
      const perCar = all.map(c => {
        const comps = c.components || [];
        let worst = 0;
        comps.forEach(comp => {
          const r = statusRank[comp.status] !== undefined ? statusRank[comp.status] : 1;
          if (r > worst) worst = r;
        });
        if (worst === 2) countCriticalCars++; else if (worst === 1) countWarningCars++; else countGoodCars++;
        if (worst < 2) operationalCount++;
        return { id: c.id, displayName: c.displayName, worstStatus: worst === 2 ? 'Critical' : (worst === 1 ? 'Warning' : 'Good') };
      });
      const outOfServiceCount = total - operationalCount;
      const operationalPct = total > 0 ? Math.round((operationalCount/total)*100) : 0;
      return res.json({ totalCars: total, carsAllGood: countGoodCars, carsWithWarnings: countWarningCars, carsWithCritical: countCriticalCars, operationalCount, operationalPct, outOfServiceCount, perCar });
    } catch(e) { return res.status(500).json({ error: 'invalid cars file' }); }
  });
});

// get specific car data (if a per-car file exists in data/cars/<id>.json will prefer that)
app.get('/api/cars/:id', (req, res) => {
  const id = req.params.id;
  const perFile = path.join(__dirname, 'data', 'cars', `${id}.json`);
  fs.readFile(perFile, 'utf8', (err, data) => {
    if (!err) {
      try { return res.json(JSON.parse(data)); } catch(e) { /* fallthrough to default list */ }
    }
    fs.readFile(config.carsFile, 'utf8', (err2, d2) => {
      if (err2) return res.status(404).json({ error: 'car not found' });
      try {
        const all = JSON.parse(d2);
        const c = (all.cars || []).find(x => x.id === id);
        if (!c) return res.status(404).json({ error: 'car not found' });
        return res.json(c);
      } catch(e) { return res.status(500).json({ error: 'invalid cars file' }); }
    });
  });
});

// save per-car data
app.put('/api/cars/:id', (req, res) => {
  const id = req.params.id;
  const payload = req.body || {};
  const dir = path.join(__dirname, 'data', 'cars');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const perFile = path.join(dir, `${id}.json`);
  fs.writeFile(perFile, JSON.stringify(payload, null, 2), (err) => {
    if (err) return res.status(500).json({ error: 'failed to save car' });
    return res.json({ saved: true });
  });
});

// append gesture sampling logs (one-line JSON per entry) for long-run traces
app.post('/api/gesture-log', (req, res) => {
  const payload = req.body || {};
  const dir = path.join(__dirname, 'data', 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gesture.log');
  const entry = JSON.stringify({ ts: new Date().toISOString(), payload }) + '\n';
  fs.appendFile(file, entry, (err) => {
    if (err) return res.status(500).json({ error: 'failed to append log' });
    return res.json({ saved: true });
  });
});

// mount AI route
app.use('/api/ai-chat', aiRouteFactory(config));

// Log Neuro-SAN configuration
console.log('[CONFIG] Neuro-SAN API URL:', config.neuro.apiUrl);
console.log('[CONFIG] Neuro-SAN Project Name:', config.neuro.projectName);

// Log when Neuro-SAN route is mounted
console.log('[ROUTE] Mounting Neuro-SAN route at /api/neurosan-chat');

// Add middleware to log requests to Neuro-SAN route
app.use('/api/neurosan-chat', (req, res, next) => {
    console.log(`[REQUEST] Neuro-SAN route hit: ${req.method} ${req.originalUrl}`);
    next();
});

// mount Neuro-SAN client chat route (provides alternative chat backend)
app.use('/api/neurosan-chat', neuroSanClientRouteFactory(config));

// --- AI Summary Cache Persistence ---
// Stores the last generated squadron AI analysis so it survives server restarts until user refreshes.
const AI_SUMMARY_CACHE_FILE = path.join(__dirname, 'data', 'ai_summary_cache.json');

app.get('/api/ai-summary-cache', (req,res)=>{
  fs.readFile(AI_SUMMARY_CACHE_FILE,'utf8',(err,data)=>{
    if (err) return res.json({});
    try { return res.json(JSON.parse(data)); } catch(e){ return res.json({}); }
  });
});

app.post('/api/ai-summary-cache', (req,res)=>{
  const payload = req.body || {};
  if (!payload || typeof payload.summary !== 'string') return res.status(400).json({ error:'invalid-summary' });
  const entry = { summary: payload.summary, backend: payload.backend||null, project: payload.project||null, ts: Date.now(), stats: payload.stats||null };
  try {
    fs.writeFile(AI_SUMMARY_CACHE_FILE, JSON.stringify(entry,null,2), (err)=>{
      if (err) return res.status(500).json({ error:'persist-failed' });
      return res.json({ saved:true, ts: entry.ts });
    });
  } catch(e){ return res.status(500).json({ error:'persist-exception' }); }
});

// AI chat is mounted from `server/routes/ai.js` above. The modular route provides local classification,
// deterministic squadron/flight summary short-circuit, and Azure proxying. Keep that single source of truth.

// Log incoming requests to AI and Neuro-SAN routes
app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/api/ai-chat') || req.originalUrl.startsWith('/api/neurosan-chat')) {
        console.log('[SERVER] Incoming request:', {
            path: req.originalUrl,
            method: req.method,
            body: req.body,
        });
    }
    next();
});

// fallback: serve index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`BMW Fleet Monitor running on http://localhost:${PORT} (env=${config.nodeEnv})`));
