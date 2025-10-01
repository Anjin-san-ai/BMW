const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const router = express.Router();

module.exports = function(config){
  const CARS_FILE = config.carsFile;
  const AZURE = config.azure;
  const promptsPath = path.join(__dirname, '..', 'prompts.json');
  let prompts = {};
  try { prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8')); } catch(e) { prompts = {}; }

  // ensure logs dir exists
  try { if (!fs.existsSync(config.logsDir)) fs.mkdirSync(config.logsDir, { recursive: true }); } catch(e) {}
  const aiLogFile = path.join(config.logsDir, 'ai.log');

  function appendAiLog(entry) {
    try {
      const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), backend: 'azure' }, entry)) + '\n';
      fs.appendFile(aiLogFile, line, () => {});
    } catch (e) { /* ignore logging errors */ }
  }

  // tiny deterministic intent classifier (module-scoped so it can be invoked for every request)
  function classifyIntent(text) {
    const t = String(text || '').toLowerCase();
    let score = 0;
    // strong signals
    if (/\bhow many\b/.test(t)) score += 3;
    if (/\bfleet summary\b|\bfleet\b/.test(t)) score += 3;
    if (/\boverall health\b|\boverall status\b/.test(t)) score += 2;
    if (/\boperational\b|\boperational state\b|\bout-of-service\b/.test(t)) score += 2;
    if (/\btotal vehicles\b|\btotal cars\b/.test(t)) score += 2;
    // moderate signals
    if (/\bsummary\b/.test(t)) score += 1;
    if (/\bhealth\b/.test(t)) score += 1;
    // presence of a car id reduces ambiguity but still relevant
    const carIdMention = /bmw-x5m-\d{1,2}/.test(t);
    if (carIdMention) score += 1;
    // normalize to confidence 0..1 (max possible ~8)
    const confidence = Math.min(1, score / 6);
    const intent = confidence > 0.25 ? 'summary' : 'other';
    return { intent, confidence, carIdMention };
  }

  router.post('/', async (req, res) => {
    try {
  const { message, carId, history, promptId, bypassLocal } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'missing message' });

  // log incoming request summary (do not log secrets)
  appendAiLog({ event: 'route-hit', path: '/api/ai-chat' });
  appendAiLog({ event: 'request', message: String(message).slice(0,512), carId: carId || null, promptId: promptId || null });
  console.log(`[AI] request car=${carId||'<none>'} prompt=${promptId||'default'} msg="${String(message).slice(0,120).replace(/\n/g,' ')}"`);

      // load cars master file
      let carsPayload = {};
      try { carsPayload = JSON.parse(fs.readFileSync(CARS_FILE, 'utf8')); } catch (e) { carsPayload = {}; }

      // select car context
      let carInfo = null;
      if (carId) {
        const c = (carsPayload.cars || []).find(x => x.id === carId);
        if (c) {
          const perFile = path.join(config.dataDir, 'cars', `${carId}.json`);
          try { if (fs.existsSync(perFile)) carInfo = JSON.parse(fs.readFileSync(perFile, 'utf8')); else carInfo = c; } catch(e) { carInfo = c; }
        }
      }

  // classifyIntent is defined at module scope and invoked per-request below

      // helpers to compute summaries
      function computeFleet(payload) {
        const allCars = (payload.cars || []);
        const statusRank = { 'Good': 0, 'Warning': 1, 'Critical': 2 };
        let total = allCars.length;
        let countGoodCars = 0, countWarningCars = 0, countCriticalCars = 0;
        let operationalCount = 0;
        const criticalIds = [];
        allCars.forEach(c => {
          const comps = c.components || [];
          let worst = 0;
          comps.forEach(comp => { const r = statusRank[comp.status] !== undefined ? statusRank[comp.status] : 1; if (r > worst) worst = r; });
          if (worst === 2) { countCriticalCars++; criticalIds.push(c.id); } else if (worst === 1) countWarningCars++; else countGoodCars++;
          if (worst < 2) operationalCount++;
        });
        const outOfServiceCount = total - operationalCount;
        const operationalPct = total > 0 ? Math.round((operationalCount/total)*100) : 0;
        return { total, countGoodCars, countWarningCars, countCriticalCars, operationalCount, operationalPct, outOfServiceCount, criticalIds };
      }

      function computeCarSummary(c) {
        const comps = (c && c.components) || [];
        const critical = comps.find(comp => String(comp.status).toLowerCase() === 'critical');
        const warning = comps.find(comp => String(comp.status).toLowerCase() === 'warning');
        const worst = critical ? 'Critical' : (warning ? 'Warning' : 'Good');
        let keyIssue = null;
  if (critical) keyIssue = `${critical.componentName || critical.displayName || critical.id} (${critical.faultCode || 'N/A'}) = Critical (maintenanceDue: ${critical.maintenanceDue || 'unknown'})`;
  else if (warning) keyIssue = `${warning.componentName || warning.displayName || warning.id} (${warning.faultCode || 'N/A'}) = Warning (maintenanceDue: ${warning.maintenanceDue || 'unknown'})`;
        else keyIssue = 'No issues detected.';
        return { worst, keyIssue };
      }

  // decide: local short-circuit or enrich prompt and call Azure
  const cls = classifyIntent(message);
  // persist classifier result for debugging/visibility
  try { appendAiLog({ event: 'classification', message: String(message).slice(0,256), classification: cls }); } catch(e) {}
  try { console.log(`[AI] classification intent=${cls.intent} confidence=${cls.confidence.toFixed(2)} carMention=${cls.carIdMention}`); } catch(e) {}
      try {
  if (!bypassLocal && cls.intent === 'summary' && cls.confidence >= 0.7) {
          // confident: return deterministic local reply
          const fleet = computeFleet(carsPayload);
          let reply = '';
          if (carInfo) {
            const carSummary = computeCarSummary(carInfo);
            reply += `Context: ${carInfo.id}\n\n`;
            reply += `I\u2019m currently scoped to ${carInfo.displayName || carInfo.id}. Do you want:\n- A: a short summary for this selected vehicle, or\n- B: a fleet-level summary (aggregate across all vehicles)?\n\n`;
            reply += `If you want the fleet summary now, here\'s the latest from the dataset:\n- Total vehicles: ${fleet.total}\n- Operational (no Critical components): ${fleet.operationalCount} (${fleet.operationalPct}%)\n- Out-of-service (\u2265 1 Critical): ${fleet.countCriticalCars} (${Math.round((fleet.countCriticalCars/fleet.total)*100)}%) — IDs: ${JSON.stringify(fleet.criticalIds)}\n\n`;
            reply += `Quick summary for ${carInfo.id}:\n- Worst status: ${carSummary.worst}\n- Key issue: ${carSummary.keyIssue} — vehicle is ${carSummary.worst === 'Critical' ? 'out-of-service' : 'operational'} until the issue is resolved.\n\nTell me which view you want (A or B), or ask for per-component details for ${carInfo.id}.`;
          } else {
            reply += `Fleet summary (from local data):\n- Total vehicles: ${fleet.total}\n- Cars all good: ${fleet.countGoodCars}\n- Cars with warnings: ${fleet.countWarningCars}\n- Cars with critical issues: ${fleet.countCriticalCars}\n- Operational: ${fleet.operationalCount} (${fleet.operationalPct}%)\n- Out-of-service/maintenance planned: ${fleet.outOfServiceCount}\n`;
            if (fleet.criticalIds && fleet.criticalIds.length) reply += `- Out-of-service IDs: ${JSON.stringify(fleet.criticalIds)}\n`;
            reply += `\nIf you want details for a specific vehicle, mention its car id (for example: BMW-X5M-003).`;
          }
          appendAiLog({ event: 'local-reply', carId: carId || null, message: String(message).slice(0,512), reply: reply.slice(0,2000) });
          return res.json({ reply });
        }
      } catch (e) {
        // on any error, fall through to Azure path
      }


      // build system prompt from promptId and inject computed local context when classifier is not confident
      const sysPrompt = prompts[promptId] || prompts['default'] || '';
      let systemPrompt = sysPrompt;

      // If classifier identifies a squadron/group summary intent, instruct the assistant to default to
      // providing a concise squadron-level summary first (even if a flightId was provided). This ensures
      // responses are aggregated when the user asks about overall health.
      if (cls && cls.intent === 'summary') {
        const squadronInstruction = "When the user asks for overall or squadron-level health, provide a concise squadron-level summary first using only the provided dataset. If the user later requests per-flight details, provide them on follow-up. Keep the initial reply short and factual.";
        systemPrompt = squadronInstruction + "\n\n" + systemPrompt;
      }
      if (flightInfo) {
  const comps = (flightInfo.components || []).slice(0, 80).map(c => ({ id: c.id, displayName: c.displayName, componentName: c.componentName, status: c.status, maintenanceDue: c.maintenanceDue, faultCode: c.faultCode || null }));
        systemPrompt += `\n\nFlight context (id: ${flightInfo.id}, displayName: ${flightInfo.displayName || ''}): ${JSON.stringify({ components: comps })}`;
        // also add a concise, human-readable component list that explicitly includes fault codes
        try {
          const flightComponentLines = comps.map(c => `- ${c.componentName || c.displayName || c.id} (id:${c.id}) — status: ${c.status || 'unknown'} — faultCode: ${c.faultCode || 'N/A'} — maintenanceDue: ${c.maintenanceDue || 'N/A'}`);
          systemPrompt += `\n\nFlight components:\n${flightComponentLines.join('\n')}`;
        } catch (e) { /* ignore formatting errors */ }
        // if classifier not confident, also add a short flight summary
        if (typeof cls === 'object' && cls.intent === 'summary' && cls.confidence < 0.7) {
          const fs = computeFlightSummary(flightInfo);
          systemPrompt += `\n\nLocal flight summary: worstStatus=${fs.worst}; keyIssue=${fs.keyIssue}`;
        }
      } else {
        const allFlights = (flightsPayload.flights || []);
        const top = allFlights.slice(0,10).map(f => ({ id: f.id, displayName: f.displayName }));
        // compute squadron summary: total, worst-status per-flight, deployable vs in-service
        const squad = computeSquadron(flightsPayload);
        const squadronSummary = `Squadron summary: totalFlights=${squad.total}; flightsAllGood=${squad.countGoodFlights}; flightsWithWarnings=${squad.countWarningFlights}; flightsWithCritical=${squad.countCriticalFlights}; deployable=${squad.deployableCount} (${squad.deployablePct}%); inServiceOrMaintenancePlanned=${squad.inServiceCount}.`;
        systemPrompt += `\n\nAvailable flights: ${JSON.stringify(top)}\n\n${squadronSummary}`;
        // if classifier not confident, also inject the critical IDs list for context
        if (typeof cls === 'object' && cls.intent === 'summary' && cls.confidence < 0.7) {
          systemPrompt += `\n\nLocal squadron critical IDs: ${JSON.stringify(squad.criticalIds)}`;
        }
      }

      // prepare messages
      const messages = [{ role: 'system', content: systemPrompt }];
      if (Array.isArray(history)) history.forEach(h => { if (h && h.role && h.content) messages.push({ role: h.role, content: h.content }); });
      messages.push({ role: 'user', content: message });

      if (!AZURE.endpoint || !AZURE.key || !AZURE.deployment) return res.status(500).json({ error: 'azure openai not configured' });

      const apiUrl = new URL(`${AZURE.endpoint.replace(/\/+$/,'')}/openai/deployments/${AZURE.deployment}/chat/completions?api-version=2023-05-15`);
  const payload = { messages, max_tokens: bypassLocal ? 800 : 512, temperature: 0.2 };

      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': AZURE.key } };
  // log outbound dispatch (exclude api key)
  try { appendAiLog({ event: 'dispatch', model: AZURE.deployment, messages: messages.length }); } catch(e){}

  const request = https.request(apiUrl, opts, (resp) => {
        let data = '';
        resp.on('data', (chunk) => data += chunk);
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // If Azure returned an error status, forward it with details
            if (resp.statusCode && resp.statusCode >= 400) {
              const detail = (parsed && parsed.error && parsed.error.message) ? parsed.error.message : (parsed && parsed.message) ? parsed.message : JSON.stringify(parsed);
              appendAiLog({ event: 'azure-error', status: resp.statusCode, detail: String(detail).slice(0,1000) });
              console.warn(`[AI] azure error status=${resp.statusCode} detail=${String(detail).slice(0,180)}`);
              return res.status(resp.statusCode).json({ error: 'azure-error', detail });
            }
            const reply = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) ? parsed.choices[0].message.content : (parsed.error ? parsed.error.message : 'No reply');
            appendAiLog({ event: 'reply', status: resp.statusCode, reply: String(reply).slice(0,1000) });
            console.log(`[AI] reply len=${String(reply||'').length} status=${resp.statusCode}`);
            return res.json({ reply });
          } catch (e) {
            appendAiLog({ event: 'parse-error', raw: String(data).slice(0,2000) });
            console.error('[AI] failed to parse azure response', e);
            return res.status(500).json({ error: 'failed-to-parse-azure-response', raw: data });
          }
        });
      });
      request.on('error', (err) => { return res.status(500).json({ error: 'azure-request-failed', detail: String(err) }); });
      request.write(JSON.stringify(payload));
      request.end();

    } catch (err) { return res.status(500).json({ error: 'ai-chat-failed', detail: String(err) }); }
  });

  return router;
};
