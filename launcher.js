#!/usr/bin/env node
// launcher.js — HTTPS + mTLS Express launcher for Unity game servers

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const express = require('express');
const axios = require('axios');
const selfsigned = require('selfsigned');
const multer = require('multer');
const unzipper = require('unzipper');
const { spawn } = require('child_process');
const glob = require('glob');
const winston = require('winston');

// ─── CONFIG & ENV ───────────────────────────────────────────────────────────────

const HOME = os.homedir();
const BASE_DIR = process.env.SETTINGS_DIR || path.join(HOME, '.siegeup');
const BUILDS_DIR = process.env.BUILDS_DIR || path.join(BASE_DIR, 'builds');
const CERT_PEM = path.join(BASE_DIR, 'cert.pem');
const KEY_PEM = path.join(BASE_DIR, 'key.pem');
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');
const ORCH_URL = process.env.ORCHESTRATOR_URL || 'https://siegeup.com/orchestrator/register';
const DEFAULT_PORT = 8443;

fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

// logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: path.join(BASE_DIR, 'launcher.log') })
  ]
});

// ─── TLS CERTIFICATE ─────────────────────────────────────────────────────────────

// generate self-signed on first run
if (!fs.existsSync(CERT_PEM) || !fs.existsSync(KEY_PEM)) {
  logger.info('Generating self-signed certificate');
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: os.hostname() }],
    {
      days: 365,
      keySize: 2048, // ← increase key size
      algorithm: 'sha256'
    }
  );

  fs.writeFileSync(CERT_PEM, pems.cert);
  fs.writeFileSync(KEY_PEM, pems.private);
}

// ─── SETTINGS PERSISTENCE ───────────────────────────────────────────────────────

let settings = { nextPort: 9000, servers: {} };
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// track child processes
const children = new Map();

// ─── EXPRESS APP + mTLS ────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const httpsOpts = {
  key: fs.readFileSync(KEY_PEM),
  cert: fs.readFileSync(CERT_PEM),
  ca: fs.readFileSync(CERT_PEM),
  requestCert: true,
  rejectUnauthorized: true
};

// multer for ZIP uploads
const upload = multer({ dest: BASE_DIR });

// ─── REGISTER WITH ORCHESTRATOR ────────────────────────────────────────────────

(async () => {
  const portArg = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
  const port = portArg ? parseInt(portArg, 10) : DEFAULT_PORT;
  try {
    await axios.post(
      ORCH_URL,
      { host: os.hostname(), port, cert: fs.readFileSync(CERT_PEM, 'utf8') },
      {
        httpsAgent: new https.Agent({
          key: fs.readFileSync(KEY_PEM),
          cert: fs.readFileSync(CERT_PEM),
          ca: fs.readFileSync(CERT_PEM),
          rejectUnauthorized: false
        })
      }
    );
    logger.info('Registered with orchestrator');
  } catch (err) {
    logger.error('Orchestrator register failed: ' + err.message);
  }
})();

// ─── ROUTES ────────────────────────────────────────────────────────────────────

// 1) upload a Unity ZIP (field=gameZip), unpack into BUILDS_DIR
app.post('/upload', upload.single('gameZip'), async (req, res) => {
  try {
    await fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: BUILDS_DIR }))
      .promise();
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Upload error: ' + err);
    res.status(500).json({ error: err.message });
  }
});

// 2) launch a new server
app.post('/servers/launch', (req, res) => {
  const { version, args = [] } = req.body;
  const id = Date.now().toString();
  const port = settings.nextPort++;
  settings.servers[id] = { version, args, port };
  saveSettings();

  // find the executable anywhere under BUILDS_DIR/version
  const pattern = path.join(BUILDS_DIR, version, '**', 'SiegeUpLinuxServer.x86_64');
  const matches = glob.sync(pattern);
  if (!matches.length) {
    return res.status(404).json({ error: 'Executable not found' });
  }

  const exe = matches[0];
  const child = spawn(exe, ['--port', port, ...args], { detached: true });
  children.set(id, child);

  child.on('exit', () => {
    logger.warn(`Server ${id} exited; restarting…`);
    children.delete(id);
    // respawn
    app.handle(
      { method: 'POST', url: '/servers/launch', body: { version, args } },
      res
    );
  });

  logger.info(`Launched server ${id} on port ${port}`);
  res.json({ id, port });
});

// 3) restart a server by index
app.post('/servers/:id/restart', (req, res) => {
  const { id } = req.params;
  const meta = settings.servers[id];
  if (!meta) return res.status(404).json({ error: 'Not found' });
  const child = children.get(id);
  if (child) child.kill();
  else app.handle({ method: 'POST', url: '/servers/launch', body: meta }, res);
  res.json({ ok: true, message: `Restarting ${id}` });
});

// 4) status endpoints
app.get('/servers/:id/status', (req, res) => {
  const id = req.params.id;
  const m = settings.servers[id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json({ id, ...m, running: children.has(id) });
});
app.get('/servers', (_, res) => {
  res.json(Object.entries(settings.servers).map(([id, m]) => ({
    id, ...m, running: children.has(id)
  })));
});

// 5) update global settings at runtime
app.post('/settings', (req, res) => {
  Object.assign(settings, req.body);
  saveSettings();
  res.json(settings);
});

// 6) trigger update (causes systemd to git-pull & restart)
app.post('/update', (_, res) => {
  res.json({ ok: true });
  process.exit(0);
});

// ─── START HTTPS ───────────────────────────────────────────────────────────────

const portArg = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
const port = portArg ? parseInt(portArg, 10) : DEFAULT_PORT;

https.createServer(httpsOpts, app)
  .listen(port, () => logger.info(`Launcher listening on ${port}`));
