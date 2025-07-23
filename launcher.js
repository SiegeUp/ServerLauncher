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
const BASE_SERVER_PORT = 9000;

fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

let settings = { version: '', count: 0 };
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

const localIP = await axios.get('https://api.ipify.org').then(res => res.data);
const pems = selfsigned.generate(
  [{ name: 'commonName', value: os.hostname() }],
  {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: os.hostname() },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: localIP }
        ]
      }
    ]
  }
);

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

const startManagedServers = () => {
  // Kill all old
  for (const child of children.values()) child.kill();
  children.clear();

  const executableName = os.platform() == 'win32' ? 'SiegeUpServer.exe' : 'SiegeUpLinuxServer.x86_64';
  const exe = findFileRecursive(path.join(BUILDS_DIR, settings.version), executableName);
  if (!exe) {
    console.warn(`Executable for ${settings.version} not found`);
    return;
  }

  for (let i = 0; i < settings.count; ++i) {
    const port = BASE_SERVER_PORT + i;
    const id = port;

    const spawnAndWatch = () => {
      const child = spawn(exe, ['--port', port], { detached: true });
      children.set(id, child);
      console.log(`Server ${id} started on port ${port}`);

      child.on('exit', () => {
        console.warn(`Server ${id} exited, restarting...`);
        children.delete(id);
        setTimeout(spawnAndWatch, 1000);
      });

      child.on('error', err => {
        console.error(`Error in server ${id}:`, err);
        children.delete(id);
      });
    };

    spawnAndWatch();
  }
};

app.post('/upload', upload.single('gameZip'), async (req, res) => {
  await fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: BUILDS_DIR }))
    .promise();
  fs.unlinkSync(req.file.path);
  res.json({ ok: true });
});

app.post('/servers/launch', async (req, res) => {
  const { version, count } = req.body;
  if (!version || typeof count !== 'number') return res.status(400).json({ error: 'Missing version or count' });

  settings.version = version;
  settings.count = count;
  saveSettings();
  startManagedServers();

  res.json({ ok: true, version, count });
});

app.get('/status', async (_, res) => {
  const running = Array.from(children.entries()).map(([id, proc]) => ({
    id, port: id, running: true, pid: proc.pid
  }));

  const archives = fs.readdirSync(BUILDS_DIR).filter(f => fs.statSync(path.join(BUILDS_DIR, f)).isDirectory());

  res.json({
    hostname: os.hostname(),
    platform: process.platform === 'win32' ? 'windows' : process.platform,
    version: settings.version,
    expectedCount: settings.count,
    running,
    archives
  });
});

app.use((err, req, res, _) => {
  const id = Math.floor(Math.random() * 1e6);
  console.error(`Error ${id}:`, err);
  res.status(500).json({ status: 'error', id });
});

https.createServer(httpsOpts, app)
  .listen(port, () => {
    console.log(`Launcher listening on port ${port}`);
    if (settings.version && settings.count > 0) startManagedServers();
  });
