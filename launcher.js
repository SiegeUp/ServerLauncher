#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import express from 'express';
import axios from 'axios';
import selfsigned from 'selfsigned';
import multer from 'multer';
import unzipper from 'unzipper';
import { spawn } from 'child_process';
import { glob } from 'glob';

const HOME = os.homedir();
const BASE_DIR = process.env.SETTINGS_DIR || path.join(HOME, '.siegeup');
const BUILDS_DIR = process.env.BUILDS_DIR || path.join(BASE_DIR, 'builds');
const CERT_PEM = path.join(BASE_DIR, 'cert.pem');
const KEY_PEM = path.join(BASE_DIR, 'key.pem');
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');
const ORCH_URL = process.env.ORCHESTRATOR_URL || 'https://siegeup.com/orchestrator';
const DEFAULT_PORT = 8443;

fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

let settings = { nextPort: 9000, servers: {} };
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const children = new Map();
const app = express();
app.use(express.json());
const upload = multer({ dest: BASE_DIR });

const portArg = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
const port = portArg ? parseInt(portArg, 10) : DEFAULT_PORT;

const pems = selfsigned.generate(
  [{ name: 'commonName', value: os.hostname() }],
  { days: 365, keySize: 2048, algorithm: 'sha256' }
);

try {
  await axios.post(
    `${ORCH_URL}/register`,
    { name: os.hostname(), port, cert: pems.cert },
    {
      httpsAgent: ORCH_URL.startsWith('https')
        ? new https.Agent({ cert: pems.cert, key: pems.private, ca: pems.cert, rejectUnauthorized: false })
        : undefined
    }
  );
  fs.writeFileSync(CERT_PEM, pems.cert);
  fs.writeFileSync(KEY_PEM, pems.private);
  console.log('Registered with orchestrator');
} catch (err) {
  console.error('Registration failed:', err.message);
  process.exit(1);
}

const httpsOpts = {
  key: fs.readFileSync(KEY_PEM),
  cert: fs.readFileSync(CERT_PEM),
  ca: fs.readFileSync(CERT_PEM),
  requestCert: true,
  rejectUnauthorized: true
};

app.post('/upload', upload.single('gameZip'), async (req, res, next) => {
  try {
    await fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: BUILDS_DIR }))
      .promise();
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/servers/launch', async (req, res, next) => {
  try {
    const { version, args = [] } = req.body;
    const port = settings.nextPort++;
    const id = port;
    settings.servers[id] = { version, args, port };
    saveSettings();

    const pattern = path.join(BUILDS_DIR, version, '**', 'SiegeUpLinuxServer.x86_64');
    const matches = await glob(pattern);
    if (!matches.length) return res.status(404).json({ error: 'Executable not found' });

    const exe = matches[0];
    const child = spawn(exe, ['--port', port, ...args], { detached: true });
    children.set(id, child);

    child.on('exit', () => {
      console.warn(`Server ${id} exited; restarting`);
      children.delete(id);
      app.handle({ method: 'POST', url: '/servers/launch', body: { version, args } }, res);
    });

    console.log(`Server ${id} started on port ${port}`);
    res.json({ id, port });
  } catch (err) {
    next(err);
  }
});

app.post('/servers/:id/restart', (req, res, next) => {
  try {
    const { id } = req.params;
    const meta = settings.servers[id];
    if (!meta) return res.status(404).json({ error: 'Not found' });

    const child = children.get(id);
    if (child) child.kill();
    else app.handle({ method: 'POST', url: '/servers/launch', body: meta }, res);

    res.json({ ok: true, message: `Restarting ${id}` });
  } catch (err) {
    next(err);
  }
});

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

app.post('/settings', (req, res) => {
  Object.assign(settings, req.body);
  saveSettings();
  res.json(settings);
});

app.post('/update', (_, res) => {
  res.json({ ok: true });
  process.exit(0);
});

app.use((err, req, res, next) => {
  res.status(500);
  res.json({ status: 'error', error: err?.message || 'Unknown error' });
  next();
});

https.createServer(httpsOpts, app)
  .listen(port, () => console.log(`Launcher listening on port ${port}`));
