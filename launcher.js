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

let settings = { servers: [] };
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
const watchIntervalMs = 2000;

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
  httpsAgent: new https.Agent({
    cert: pems.cert,
    key: pems.private,
    ca: pems.cert,
    rejectUnauthorized: false
  })
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

const serverWatcherLoop = async () => {
  const platform = os.platform();
  const executableName = platform === 'win32' ? 'SiegeUpServer.exe' : 'SiegeUpLinuxServer.x86_64';

  const desiredPorts = new Set(settings.servers.map(s => s.port));
  const currentPorts = new Set(children.keys());

  // Stop orphaned processes
  for (const port of currentPorts) {
    if (!desiredPorts.has(port)) {
      console.log(`Stopping server on port ${port} (no longer in config)`);
      children.get(port)?.kill();
      children.delete(port);
    }
  }

  // Start missing servers
  for (const { version, port, args = [] } of settings.servers) {
    if (children.has(port)) continue;

    const exe = findFileRecursive(path.join(BUILDS_DIR, version), executableName);
    if (!exe) {
      console.warn(`Executable not found for version "${version}"`);
      continue;
    }

    const child = spawn(exe, ['--server_port', port, ...args]);
    children.set(port, child);
    console.log(`Started server ${port} with version "${version}"`);

    child.on('exit', (code, signal) => {
      console.warn(`Server ${port} exited with code ${code || 'unknown'}, signal ${signal || 'none'}`);
      children.delete(port);
    });

    child.on('error', err => {
      console.error(`Error in server ${port}:`, err);
      children.delete(port);
    });
  }
};

// Start loop
setInterval(serverWatcherLoop, watchIntervalMs);


app.post('/upload', upload.single('gameZip'), async (req, res) => {
  await fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: BUILDS_DIR }))
    .promise();
  fs.unlinkSync(req.file.path);
  res.json({ ok: true });
});

app.post('/servers/launch', async (req, res) => {
  const { servers } = req.body;
  if (!Array.isArray(servers)) return res.status(400).json({ error: 'Missing or invalid servers array' });

  settings.servers = servers;
  saveSettings();

  res.json({ ok: true });
});

app.post('/update', (_, res) => {
  res.json({ ok: true });
  process.exit(0);
});

app.get('/status', async (_, res) => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const memoryTotalMB = Math.round(os.totalmem() / 1024 / 1024);

  const servers = settings.servers.map(({ version, port, args }) => {
    const proc = children.get(port);
    const memMB = proc?.pid
      ? Math.round(process.memoryUsage().rss / 1024 / 1024)
      : 0;

    return {
      version,
      port,
      args,
      pid: proc?.pid || null,
      running: !!proc,
      memoryMB: memMB
    };
  });

  const archives = fs.readdirSync(BUILDS_DIR).filter(f =>
    fs.statSync(path.join(BUILDS_DIR, f)).isDirectory()
  );

  res.json({
    hostname: os.hostname(),
    platform,
    servers,
    archives,
    memoryMB: memoryTotalMB
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
  });
