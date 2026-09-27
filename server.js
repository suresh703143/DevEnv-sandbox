const express = require('express');
const Docker = require('dockerode');
const { WebSocketServer } = require('ws');
const simpleGit = require('simple-git');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const docker = new Docker();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const activeContainers = {};
const savedOutputs = {};

// PORT config — uses environment variable on Render, 3000 locally
const PORT = process.env.PORT || 3000;

// Public base URL — set this on Render as environment variable
// e.g. https://devenv-sandbox.onrender.com
// Locally it falls back to localhost
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// App port that containers expose — on Render we can't use 4000
// so we use a dynamic port or just use the same server port via a proxy approach
// For simplicity: locally use 4000, on Render we proxy through the main server
const IS_PRODUCTION = !!process.env.PUBLIC_URL;

function toDockerPath(p) {
  return p.replace(/\\/g, '/');
}

function getRunCommand(dir) {
  if (fs.existsSync(path.join(dir, 'pom.xml'))) {
    return 'mvn compile 2>&1 && mvn exec:java 2>&1';
  }
  if (fs.readdirSync(dir).some(f => f.endsWith('.java'))) {
    return 'find . -name "*.java" | head -1 | xargs javac 2>&1 && find . -name "*.class" | head -1 | sed "s|./||;s|.class||;s|/|.|g" | xargs java 2>&1';
  }
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
    return 'pip install -r requirements.txt 2>&1 && python app.py 2>&1 || python main.py 2>&1';
  }
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts || {};
    if (scripts.dev) return 'npm install 2>&1 && npm run dev -- --host 0.0.0.0 --port 3000 2>&1';
    if (scripts.start) return 'npm install 2>&1 && npm start 2>&1';
    if (scripts.build) return 'npm install 2>&1 && npm run build 2>&1 && npx --yes serve dist -p 3000 2>&1';
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    return 'npx --yes serve . -p 3000 2>&1';
  }
  return null;
}

function detectAllRunnableFolders(cloneDir) {
  const results = [];

  const rootCmd = getRunCommand(cloneDir);
  if (rootCmd) results.push({ label: 'Root', cmd: rootCmd, subdir: null });

  const subfolders = fs.readdirSync(cloneDir)
    .filter(f => {
      try { return fs.statSync(path.join(cloneDir, f)).isDirectory() && !f.startsWith('.'); }
      catch { return false; }
    });

  for (const folder of subfolders) {
    const sub = path.join(cloneDir, folder);
    const cmd = getRunCommand(sub);
    if (cmd) {
      results.push({
        label: folder,
        cmd: `cd /app/${folder} && ${cmd}`,
        subdir: folder,
      });
    }
  }

  return results;
}

function isServerCmd(cmd) {
  return !cmd.includes('echo "No runnable entry point found"') &&
    !cmd.includes('javac') &&
    !cmd.includes('mvn');
}

app.post('/scan', async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });

  const sessionId = Date.now().toString();
  const cloneDir = path.join(os.tmpdir(), sessionId);

  try {
    await simpleGit().clone(repoUrl, cloneDir);
    const folders = detectAllRunnableFolders(cloneDir);
    res.json({ sessionId, folders });
  } catch (err) {
    res.status(500).json({ error: 'Clone failed: ' + err.message });
  }
});

app.post('/run', async (req, res) => {
  const { sessionId, cmd } = req.body;
  if (!sessionId || !cmd) return res.status(400).json({ error: 'sessionId and cmd required' });
  const serverApp = isServerCmd(cmd);
  res.json({ ok: true, serverApp });
});

app.post('/stop', async (req, res) => {
  const { sessionId } = req.body;
  const container = activeContainers[sessionId];
  if (!container) return res.status(404).json({ error: 'No active container for this session' });

  try {
    await container.stop();
    delete activeContainers[sessionId];
    res.json({ message: 'Container stopped' });
  } catch (err) {
    res.status(500).json({ error: 'Stop failed: ' + err.message });
  }
});

app.post('/save-output', (req, res) => {
  const { output, repoUrl } = req.body;
  if (!output) return res.status(400).json({ error: 'No output provided' });

  const id = crypto.randomBytes(4).toString('hex');
  savedOutputs[id] = {
    repoUrl: repoUrl || 'Unknown repo',
    output,
    createdAt: new Date().toLocaleString(),
  };

  res.json({ id, url: `/output/${id}`, fullUrl: `${PUBLIC_URL}/output/${id}` });
});

app.get('/output/:id', (req, res) => {
  const data = savedOutputs[req.params.id];
  if (!data) return res.status(404).send('<h2>Output not found or expired.</h2>');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Output — ${data.repoUrl}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f0f0f; color: #eee; font-family: -apple-system, sans-serif; padding: 40px 20px; }
    .header { max-width: 900px; margin: 0 auto 24px; }
    h1 { font-size: 18px; margin-bottom: 6px; }
    .meta { font-size: 13px; color: #666; }
    .meta a { color: #06b6d4; text-decoration: none; }
    .meta a:hover { text-decoration: underline; }
    pre {
      max-width: 900px; margin: 0 auto;
      background: #111; border: 1px solid #2a2a2a;
      border-radius: 10px; padding: 24px;
      font-family: Menlo, Monaco, monospace; font-size: 13px;
      line-height: 1.6; white-space: pre-wrap; word-break: break-all;
    }
    .badge { display: inline-block; background: #06b6d4; color: #000; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="badge">DevEnv Sandbox — Output</div>
    <h1>${data.repoUrl}</h1>
    <p class="meta">Run at ${data.createdAt} · <a href="${PUBLIC_URL}">Run your own repo →</a></p>
  </div>
  <pre>${data.output.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`);
});

// Send config to frontend so it knows the correct app URL
app.get('/config', (req, res) => {
  res.json({
    appUrl: IS_PRODUCTION ? null : 'http://localhost:4000',
    isProduction: IS_PRODUCTION,
    publicUrl: PUBLIC_URL,
  });
});

wss.on('connection', async (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const sessionId = params.get('session');
  const runCmd = decodeURIComponent(params.get('cmd') || '');
  const cloneDir = path.join(os.tmpdir(), sessionId);
  const dockerCloneDir = toDockerPath(cloneDir);
  const serverApp = isServerCmd(runCmd);

  ws.send(`Running: ${runCmd}\r\n\n`);

  let fullOutput = `Repo run output\nRunning: ${runCmd}\n\n`;

  try {
    const container = await docker.createContainer({
      Image: 'sandbox-env',
      Cmd: ['sh', '-c', runCmd],
      ExposedPorts: {
        '3000/tcp': {}, '8080/tcp': {}, '5000/tcp': {}, '5173/tcp': {}, '4173/tcp': {},
      },
      HostConfig: {
        Binds: [`${dockerCloneDir}:/app`],
        AutoRemove: true,
        Memory: 512 * 1024 * 1024,
        // Only bind ports locally — on production we can't expose ports this way
        ...(!IS_PRODUCTION && {
          PortBindings: {
            '3000/tcp': [{ HostPort: '4000' }],
            '8080/tcp': [{ HostPort: '4001' }],
            '5000/tcp': [{ HostPort: '4002' }],
            '5173/tcp': [{ HostPort: '4003' }],
            '4173/tcp': [{ HostPort: '4004' }],
          },
        }),
      },
    });

    activeContainers[sessionId] = container;

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });

    stream.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString());
        fullOutput += chunk.toString();
        const text = chunk.toString().toLowerCase();
        if (serverApp && (
          text.includes('running') || text.includes('started') ||
          text.includes('listening') || text.includes('ready') ||
          text.includes('localhost') || text.includes('serving')
        )) {
          ws.send('__APP_RUNNING__');
        }
      }
    });

    stream.on('end', () => {
      fullOutput += '\n--- Container finished ---';
      ws.send('\r\n--- Container finished ---\r\n');
      ws.send('__CONTAINER_DONE__' + JSON.stringify({ output: fullOutput }));
      ws.close();
      delete activeContainers[sessionId];
      fs.rmSync(cloneDir, { recursive: true, force: true });
    });

    await container.start();

    if (serverApp) {
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) ws.send('__APP_RUNNING__');
      }, 15000);
    }

    setTimeout(async () => {
      try { await container.stop(); ws.send('\r\nAuto-stopped after 2 minutes.\r\n'); } catch {}
    }, 2 * 60 * 1000);

  } catch (err) {
    ws.send('Error: ' + err.message);
    ws.close();
  }
});

server.listen(PORT, () => console.log(`Server on ${PUBLIC_URL}`));