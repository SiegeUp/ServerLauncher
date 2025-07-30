#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import net from 'net';
import express from 'express';
import axios from 'axios';
import selfsigned from 'selfsigned';
import multer from 'multer';
import unzipper from 'unzipper';
import { spawn } from 'child_process';

const HOME = os.homedir();
const BASE_DIR = process.env.SETTINGS_DIR || path.join(HOME, '.siegeup');
const BUILDS_DIR = process.env.BUILDS_DIR || path.join(BASE_DIR, 'builds');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const CERT_PEM = path.join(BASE_DIR, 'cert.pem');
const KEY_PEM = path.join(BASE_DIR, 'key.pem');
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');
const ORCH_URL = process.env.ORCHESTRATOR_URL || 'https://siegeup.com/orchestrator';
const DEFAULT_PORT = 8443;
const watchIntervalMs = 2000;

fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

let gitHash = 'unknown';
try {
  gitHash = fs.readFileSync('.git/HEAD', 'utf8').trim();
  if (gitHash.startsWith('ref:')) {
    const refPath = path.join('.git', gitHash.split(' ')[1]);
    gitHash = fs.readFileSync(refPath, 'utf8').trim().slice(0, 7);
  } else {
    gitHash = gitHash.slice(0, 7);
  }
} catch {
  console.warn('Could not determine Git commit hash');
}

let settings = { servers: [] };
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

const children = new Map();
const serverErrors = new Map();
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

const findExecutable = (dir) => {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findExecutable(fullPath);
        if (found) return found;
      } else if (
        !entry.name.includes('UnityCrashHandler') &&
        (entry.name.endsWith('.exe') || entry.name.endsWith('.x86_64'))
      ) {
        return fullPath;
      }
    }
  }
  catch (err) {
    console.error(`Error reading directory ${dir}:`, err);
  }

  return null;
};

const shutdownChild = async (port, child) => {
  console.log(`Shutting down server ${port}...`);

  if (!child?.pid) return;

  try { child.kill('SIGTERM'); } catch {}

  const killedGracefully = await waitForPortToBeFree(port, 2000);

  if (!killedGracefully) {
    console.warn(`Port ${port} still in use, sending SIGKILL`);
    try { child.kill('SIGKILL'); } catch {}
    await waitForPortToBeFree(port, 1000);
  }

  const stillInUse = !(await isPortFree(port));
  if (stillInUse)
    console.error(`Server ${port} still alive after forced kill`);
  else {
    console.log(`Server ${port} has stopped`);
    children.delete(port);
  }
};
;

function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '0.0.0.0');
  });
}

async function waitForPortToBeFree(port, timeoutMs = 3000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(port)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

async function cleanUpLogDirectory(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtime }))
      .sort((a, b) => b.time - a.time);

    if (files.length > 10) {
      const toDelete = files.slice(10);
      for (const file of toDelete) {
        fs.unlinkSync(path.join(logDir, file.name));
      }
    }
  } catch (err) {
    console.error(`Error clean up log directory for port ${s.port}:`, err);
  }
}

const serverWatcherLoop = async () => {
  for (const s of settings.servers) {
    if (children.has(s.port)) continue;
    if (!s.run) continue;

    const exe = findExecutable(path.join(BUILDS_DIR, s.version));
    if (!exe) {
      const msg = `Executable not found for "${s.version}"`;
      console.warn(msg);
      serverErrors.set(s.port, msg);
      continue;
    }

    const logDir = path.join(LOGS_DIR, `${s.port}`);
    cleanUpLogDirectory(logDir);

    try {
      const now = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logDir, `${now}.log`);

      const child = spawn(exe, [
        `-logFile`, logFile,
        '--server-port', s.port,
        '--server_port', s.port,
        ...s.args
      ]);

      const tailN = 20;
      const stderrLines = [];
      child.stderr?.on('data', data => {
        const lines = data.toString().split('\n').filter(Boolean);
        stderrLines.push(...lines);
        if (stderrLines.length > tailN)
          stderrLines.splice(0, stderrLines.length - tailN);
      });

      children.set(s.port, child);

      console.log(`Started server ${s.port} with version "${s.version}"`);

      child.on('exit', async (code, signal) => {
        const sErr = stderrLines.join('\n');

        if (signal) { // Check if the exit was due to a signal
          console.warn(`Server ${s.port} exited due to signal: ${signal}\n${sErr}`);
          serverErrors.set(s.port, `Exited due to signal: ${signal}\n${sErr}`);
        } else if (code !== 0) { // Check if the exit was due to a non-zero exit code
          console.warn(`Server ${s.port} exited with code ${code}\n${sErr}`);
          serverErrors.set(s.port, `Exited with code ${code}\n${sErr}`);
        }

        await waitForPortToBeFree(port, 2000);

        if (await isPortFree(s.port)) {
          children.delete(s.port);
        }
      });

      child.on('error', err => {
        const msg = `Error in server ${s.port}: ${err.message}`;
        console.error(msg);
        serverErrors.set(s.port, msg);
        children.delete(s.port);
      });
    } catch (err) {
      const msg = `Failed to start server ${s.port}: ${err.message}`;
      console.error(msg);
      serverErrors.set(s.port, msg);
    }
  }
};
setInterval(serverWatcherLoop, watchIntervalMs);

app.post('/upload', upload.single('gameZip'), async (req, res) => {
  const version = path.basename(req.file.originalname, '.zip') || `archive_${Date.now()}`;
  const targetPath = path.join(BUILDS_DIR, version);

  await fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: targetPath }))
    .promise();

  const exePath = findExecutable(targetPath);
  if (exePath) fs.chmodSync(exePath, 0o755);

  fs.unlinkSync(req.file.path);

  console.log(`Uploaded and extracted ${req.file.originalname} into ${targetPath}`);
  res.json({ ok: true });
});;

app.post('/launch', async (req, res) => {
  const { servers } = req.body;
  if (!Array.isArray(servers))
    return res.status(400).json({ error: 'Missing or invalid servers array' });

  // Check for duplicate ports
  const ports = servers.map(s => s.port);
  const portSet = new Set(ports);
  if (ports.length !== portSet.size)
    return res.status(400).json({ error: 'Duplicate port detected in servers array' });

  const nextSettings = servers.map((s, i) => ({
    name: s.name || `Server ${i + 1}`,
    visible: s.visible ?? false,
    version: s.version,
    port: s.port,
    args: s.args || [],
    run: s.run ?? true
  }));

  const nextMap = new Map(nextSettings.map(s => [s.port, s]));

  for (const { port, version, args } of settings.servers) {
    const existingChild = children.get(port);
    const next = nextMap.get(port);
    const shouldStop = !next || next.version !== version || next.args.join(' ') !== args.join(' ') || !next.run;
    if (shouldStop && existingChild) {
      await shutdownChild(port, existingChild);
    }
  }

  settings.servers = nextSettings;
  saveSettings();
  res.json({ ok: true });
});

app.post('/update', async (_, res) => {
  res.json({ ok: true });
  for (const [port, child] of children.entries()) {
    try {
      await shutdownChild(port, child);
    } catch (err) {
      console.error(`Failed to shutdown server on port ${port}:`, err);
    }
  }
  process.exit(0);
});

app.post('/restart', async (req, res) => {
  const portToRestart = parseInt(req.query.port, 10);

  const serverConfig = settings.servers.find(s => s.port === portToRestart);
  if (!serverConfig)
    return res.status(404).json({ error: 'Server not found' });

  const proc = children.get(portToRestart);
  if (proc) {
    await shutdownChild(portToRestart, proc);
  } else {
    res.json({ ok: true, restarted: false, message: 'Server was not running, will start if configured' });
  }
  res.json({ ok: true, restarted: true });
});

app.post('/purge', (_, res) => {
  const runningVersions = new Set(
    Array.from(children.values()).map((proc, i) => {
      const s = settings.servers[i];
      return s?.version;
    }).filter(Boolean)
  );

  const dirs = fs.readdirSync(BUILDS_DIR);
  let purged = [];

  for (const dir of dirs) {
    const fullPath = path.join(BUILDS_DIR, dir);
    if (
      fs.statSync(fullPath).isDirectory() &&
      !runningVersions.has(dir)
    ) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      purged.push(dir);
      console.log(`Purged archive: ${dir}`);
    }
  }

  res.json({ ok: true, purged });
});

app.get('/logs/:port', (req, res) => {
  const port = req.params.port;
  const index = parseInt(req.query.index || '0', 10);
  const logDir = path.join(LOGS_DIR, `${port}`);

  if (!fs.existsSync(logDir))
    return res.status(404).json({ error: 'No logs for this port' });

  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtime }))
    .sort((a, b) => b.time - a.time);

  if (index >= files.length)
    return res.status(404).json({ error: 'Log index out of range' });

  const file = files[index];
  const filePath = path.join(logDir, file.name);
  res.sendFile(filePath);
});

app.get('/status', async (_, res) => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const memoryMB = Math.round(os.totalmem() / 1024 / 1024);
  const usedMemoryMB = memoryMB - Math.round(os.freemem() / 1024 / 1024);

  const servers = settings.servers.map(({ version, port, args, name, visible, run }) => {
    const proc = children.get(port);
    const memMB = proc?.pid
      ? Math.round(process.memoryUsage().rss / 1024 / 1024)
      : 0;

    return {
      version,
      port,
      args,
      name: name || '',
      visible: !!visible,
      run: !!run,
      pid: proc?.pid || null,
      running: !!proc,
      memoryMB: memMB,
      commit: gitHash,
      launchError: serverErrors.get(port) || null
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
    memoryMB,
    usedMemoryMB,
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
