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
import osu from 'node-os-utils';
import { Transform } from 'stream'; 

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

const createTimestampTransform = () => {
  return new Transform({
    transform(chunk, encoding, callback) {
      // Initialize leftover buffer if it doesn't exist
      if (this._leftover === undefined) this._leftover = '';
      
      const lines = (this._leftover + chunk.toString()).split('\n');
      this._leftover = lines.pop(); // Save the partial line for the next chunk

      const timestamp = `[${new Date().toISOString()}] `;
      const output = lines.map(line => timestamp + line).join('\n') + (lines.length > 0 ? '\n' : '');
      
      callback(null, output);
    },
    flush(callback) {
      // Write out any remaining text in the buffer
      if (this._leftover) {
        callback(null, `[${new Date().toISOString()}] ` + this._leftover + '\n');
      } else {
        callback();
      }
    }
  });
};

const serverWatcherLoop = async () => {
  for (const s of settings.servers) {
    if (children.has(s.port)) continue;
    if (!s.run) continue;

    const exe = findExecutable(path.join(BUILDS_DIR, s.version));
    if (!exe) {
      serverErrors.set(s.port, `Executable not found for "${s.version}"`);
      continue;
    }

    const logDir = path.join(LOGS_DIR, `${s.port}`);
    await cleanUpLogDirectory(logDir);

    try {
      const now = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logDir, `${now}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });

      const gameArgs = [
        '-batchmode',
        '-nographics',
        '-logFile', '-',
        '--server-port', s.port.toString(),
        ...s.args
      ];

      const gdbArgs = [
        '-batch',
        '-return-child-result',
        '-ex', 'handle SIGPWR nostop noprint',
        '-ex', 'handle SIGXCPU nostop noprint',
        '-ex', 'run',
        '-ex', 'thread apply all bt',
        '-ex', 'quit',
        '--args', exe, ...gameArgs
      ];

      const child = spawn('gdb', gdbArgs, {
        cwd: path.dirname(exe),
        env: {
          ...process.env,
          MONO_XDEBUG: "1",     
          MONO_LOG_LEVEL: "info",
          MONO_LOG_MASK: "asm",  
        }
      });

      const tsStdout = createTimestampTransform();
      const tsStderr = createTimestampTransform();

      child.stdout.pipe(tsStdout).pipe(logStream);
      child.stderr.pipe(tsStderr).pipe(logStream);

      children.set(s.port, child);
      console.log(`Started server ${s.port} under GDB (PID: ${child.pid})`);

      child.on('exit', async (code, signal) => {
        logStream.end();
        if (code !== 0) {
          const msg = `Server ${s.port} crashed. Check logs for GDB Backtrace.`;
          serverErrors.set(s.port, msg);
        }
        await waitForPortToBeFree(s.port, 2000);
        children.delete(s.port);
      });

    } catch (err) {
      serverErrors.set(s.port, `Launcher Error: ${err.message}`);
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

  if (!fs.existsSync(logDir)) return res.status(404).json({ error: 'No logs' });

  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtime }))
    .sort((a, b) => b.time - a.time);

  if (index >= files.length) return res.status(404).json({ error: 'Index out of range' });

  const filePath = path.join(logDir, files[index].name);

  // Use a stream or limit the size (e.g., last 1MB) to prevent memory crashes
  const stats = fs.statSync(filePath);
  const maxSize = 2 * 1024 * 1024; // 2MB limit for the API response
  
  if (stats.size > maxSize) {
    const stream = fs.createReadStream(filePath, { start: stats.size - maxSize });
    let data = '';
    stream.on('data', chunk => data += chunk);
    stream.on('end', () => {
      res.json({ 
        data: "[Truncated...]\n" + data, 
        name: files[index].name, 
        fullSize: stats.size 
      });
    });
  } else {
    res.json({ 
      data: fs.readFileSync(filePath, 'utf8'), 
      name: files[index].name,
      fullSize: stats.size
    });
  }
});

app.get('/status', async (_, res) => {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const memoryMB = Math.round(os.totalmem() / 1024 / 1024);
  const usedMemoryMB = memoryMB - Math.round(os.freemem() / 1024 / 1024);

  // Get CPU usage percentage
  let cpuUsagePercent = 0;
  try {
    cpuUsagePercent = await osu.cpu.usage();
  } catch (err) {
    console.warn('Failed to get CPU usage:', err.message);
  }

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
    cpuUsagePercent: Math.round(cpuUsagePercent * 100) / 100, // Round to 2 decimal places
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
