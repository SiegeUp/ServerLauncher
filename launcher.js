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
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

const children = new Map();
const app = express();
app.use(express.json());

const upload = multer({
  dest: BASE_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

const portArg = process.argv.find(a => a.startsWith('--port='))?.split('=')[1];
const port = portArg ? parseInt(portArg, 10) : DEFAULT_PORT;

const pems = selfsigned.generate(
  [{ name: 'commonName', value: os.hostname() }],
  {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName', altNames: [
          { type: 2, value: os.hostname() },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  }
);

// Register with orchestrator before starting server
await axios.post(`${ORCH_URL}/register`, {
  name: os.hostname(),
  port,
  cert: pems.cert
}, {
  httpsAgent: ORCH_URL.startsWith('https')
    ? new https.Agent({ cert: pems.cert, key: pems.private, ca: pems.cert, rejectUnauthorized: false })
    : undefined
});

fs.writeFileSync(CERT_PEM, pems.cert);
fs.writeFileSync(KEY_PEM, pems.private);
console.log('Registered with orchestrator');

const httpsOpts = {
  key: fs.readFileSync(KEY_PEM),
  cert: fs.readFileSync(CERT_PEM),
  ca: fs.readFileSync(CERT_PEM),
  requestCert: false,
  rejectUnauthorized: false
};

const findFileRecursive = (dir, filename) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) return fullPath;
  }
  return null;
};

app.get('/archives', async (_, res) => {
  const files = fs.readdirSync(BUILDS_DIR);
  res.json({ archives: files });
});

app.post('/upload', upload.single('gameZip'), async (req, res) => {
  await fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: BUILDS_DIR }))
    .promise();
  fs.unlinkSync(req.file.path);
  res.json({ ok: true });
});

app.post('/launch', async (req, res) => {
  const { version, args = [], port: requestedPort } = req.body;
  const port = requestedPort || settings.nextPort++;
  const id = port;
  settings.servers[id] = { version, args, port };
  saveSettings();

  let exe = findFileRecursive(path.join(BUILDS_DIR, version), os.platform() == "win32" ? 'SiegeUpServer.exe' : 'SiegeUpLinuxServer.x86_64');

  if (!exe) return res.status(404).json({ error: 'Executable not found' });

  const child = spawn(exe, ['--port', port, ...args], { detached: true });
  children.set(port, child); // <-- use port directly here

  child.on('exit', () => {
    console.warn(`Server ${port} exited; restarting`);
    children.delete(port);
    app.handle({ method: 'POST', url: '/servers/launch', body: { version, args, port } }, res);
  });

  console.log(`Server ${id} started on port ${port}`);
  res.json({ id, port });
});

app.post('/servers/:id/restart', async (req, res) => {
  const { id } = req.params;
  const meta = settings.servers[id];
  if (!meta) return res.status(404).json({ error: 'Not found' });

  const child = children.get(id);
  if (child) child.kill();
  else app.handle({ method: 'POST', url: '/servers/launch', body: meta }, res);

  res.json({ ok: true, message: `Restarting ${id}` });
});

app.get('/status', async (_, res) => {
  const servers = Object.entries(settings.servers).map(([port, m]) => ({
    id: port,
    ...m,
    running: children.has(parseInt(port, 10)) // <- ensure it's a number
  }));
  res.json({ servers });
});


app.get('/platform', async (_, res) => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  res.json({ platform });
});

app.get('/servers', async (_, res) => {
  const list = Object.entries(settings.servers).map(([id, m]) => ({
    id, ...m, running: children.has(id)
  }));
  res.json(list);
});

app.post('/settings', async (req, res) => {
  Object.assign(settings, req.body);
  saveSettings();
  res.json(settings);
});

app.post('/update', async (_, res) => {
  res.json({ ok: true });
  process.exit(0);
});

app.use((err, req, res, _) => {
  const id = Math.floor(Math.random() * 1e6);
  console.error(`Error ${id}:`, err);
  res.status(500).json({ status: 'error', id });
});

https.createServer(httpsOpts, app)
  .listen(port, () => console.log(`Launcher listening on port ${port}`));
