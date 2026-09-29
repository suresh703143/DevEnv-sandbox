const express = require('express');
const { WebSocketServer } = require('ws');
const simpleGit = require('simple-git');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const activeProcesses = {};
const savedOutputs = {};

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const IS_PRODUCTION = !!process.env.PUBLIC_URL;
const IS_WINDOWS = process.platform === 'win32';

// Run a shell command cross-platform
function shellRun(command, cwd) {
  if (IS_WINDOWS) {
    return spawn('cmd', ['/c', command], { cwd, env: { ...process.env, PORT: '4000' } });
  } else {
    return spawn('sh', ['-c', command], { cwd, env: { ...process.env, PORT: '4000' } });
  }
}

function getRunCommand(dir) {
  if (fs.existsSync(path.join(dir, 'pom.xml'))) {
    return { cmdStr: 'mvn compile exec:java', cwd: dir };
  }
  if (fs.readdirSync(dir).some(f => f.endsWith('.java'))) {
    return {
      cmdStr: IS_WINDOWS
        ? 'for /r . %f in (*.java) do javac "%f" && for /r . %f in (*.class) do java "%~nf"'
        : 'find . -name "*.java" | head -1 | xargs javac && find . -name "*.class" | head -1 | sed "s|./||;s|.class||;s|/|.|g" | xargs java',
      cwd: dir
    };
  }
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
    return { cmdStr: 'pip install -r requirements.txt && python app.py || python main.py', cwd: dir };
  }
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const scripts = pkg?.scripts || {};
    if (scripts.dev) return { cmdStr: 'npm install && npm run dev -- --host 0.0.0.0 --port 4000', cwd: dir };
    if (scripts.start) return { cmdStr: 'npm install && npm start', cwd: dir };
    if (scripts.build) return { cmdStr: 'npm install && npm run build && npx --yes serve dist -p 4000', cwd: dir };
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    return { cmdStr: 'npx --yes serve . -p 4000', cwd: dir };
  }
  return null;
}

function detectAllRunnableFolders(cloneDir) {
  const results = [];

  const rootCmd = getRunCommand(cloneDir);
  if (rootCmd) results.push({ label: 'Root', runConfig: rootCmd });

  const subfolders = fs.readdirSync(cloneDir).filter(f => {
    try { return fs.statSync(path.join(cloneDir, f)).isDirectory() && !f.startsWith('.'); }
    catch { return false; }
  });

  for (const folder of subfolders) {
    const sub = path.join(cloneDir, folder);
    const cmd = getRunCommand(sub);
    if (cmd) results.push({ label: folder, runConfig: cmd });
  }

  return results;
}

function isServerApp(cmdStr) {
  return cmdStr.includes('npm start') || cmdStr.includes('npm run dev') ||
    cmdStr.includes('serve') || cmdStr.includes('node') ||
    cmdStr.includes('python') || cmdStr.includes('flask');
}

app.post('/scan', async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl required' });

  const sessionId = Date.now().toString();
  const cloneDir = path.join(os.tmpdir(), sessionId);

  try {
    await simpleGit().clone(repoUrl, cloneDir);
    const folders = detectAllRunnableFolders(cloneDir);
    savedOutputs[`session_${sessionId}`] = { cloneDir, folders };
    res.json({ sessionId, folders });
  } catch (err) {
    res.status(500).json({ error: 'Clone failed: ' + err.message });
  }
});

app.post('/run', async (req, res) => {
  const { sessionId, folderIndex } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  
  const sessionData = savedOutputs[`session_${sessionId}`];
  const folders = sessionData?.folders || [];
  const idx = parseInt(folderIndex) || 0;
  const selected = folders[idx];
  const serverApp = selected ? isServerApp(selected.runConfig.cmdStr) : false;
  
  res.json({ ok: true, serverApp });
});

app.post('/stop', async (req, res) => {
  const { sessionId } = req.body;
  const proc = activeProcesses[sessionId];
  if (!proc) return res.status(404).json({ error: 'No active process' });
  try {
    if (IS_WINDOWS) {
      spawn('taskkill', ['/pid', proc.pid, '/f', '/t']);
    } else {
      proc.kill('SIGTERM');
    }
    delete activeProcesses[sessionId];
    res.json({ message: 'Stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/save-output', (req, res) => {
  const { output, repoUrl } = req.body;
  if (!output) return res.status(400).json({ error: 'No output' });
  const id = crypto.randomBytes(4).toString('hex');
  savedOutputs[id] = { repoUrl: repoUrl || 'Unknown', output, createdAt: new Date().toLocaleString() };
  res.json({ id, url: `/output/${id}`, fullUrl: `${PUBLIC_URL}/output/${id}` });
});

app.get('/output/:id', (req, res) => {
  const data = savedOutputs[req.params.id];
  if (!data) return res.status(404).send('<h2>Output not found.</h2>');
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
    pre { max-width: 900px; margin: 0 auto; background: #111; border: 1px solid #2a2a2a; border-radius: 10px; padding: 24px; font-family: Menlo, Monaco, monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
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
  const folderIndex = parseInt(params.get('folderIndex') || '0');

  const sessionData = savedOutputs[`session_${sessionId}`];
  if (!sessionData) {
    ws.send('Error: session not found\r\n');
    ws.close();
    return;
  }

  const { cloneDir, folders } = sessionData;

  if (!folders.length) {
    ws.send('No runnable entry point found\r\n');
    ws.send('__CONTAINER_DONE__' + JSON.stringify({ output: 'No runnable entry point found' }));
    ws.close();
    return;
  }

  const selected = folders[folderIndex] || folders[0];
  const { cmdStr, cwd } = selected.runConfig;
  const serverApp = isServerApp(cmdStr);

  ws.send(`Detecting project type...\r\n`);
  ws.send(`Running: ${cmdStr}\r\n\n`);

  let fullOutput = `Running: ${cmdStr}\n\n`;

  try {
    const proc = shellRun(cmdStr, cwd);
    activeProcesses[sessionId] = proc;

    proc.stdout.on('data', (chunk) => {
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

    proc.stderr.on('data', (chunk) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(chunk.toString());
        fullOutput += chunk.toString();
      }
    });

    proc.on('close', (code) => {
      fullOutput += `\n--- Process finished (exit code: ${code}) ---`;
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n--- Process finished (exit code: ${code}) ---\r\n`);
        ws.send('__CONTAINER_DONE__' + JSON.stringify({ output: fullOutput }));
      }
      ws.close();
      delete activeProcesses[sessionId];
      try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch {}
      delete savedOutputs[`session_${sessionId}`];
    });

    proc.on('error', (err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`Error: ${err.message}\r\n`);
        ws.send('__CONTAINER_DONE__' + JSON.stringify({ output: err.message }));
      }
      ws.close();
    });

    setTimeout(() => {
      try {
        if (IS_WINDOWS) {
          spawn('taskkill', ['/pid', proc.pid, '/f', '/t']);
        } else {
          proc.kill('SIGTERM');
        }
        if (ws.readyState === ws.OPEN) ws.send('\r\nAuto-stopped after 2 minutes.\r\n');
      } catch {}
    }, 2 * 60 * 1000);

  } catch (err) {
    ws.send('Error: ' + err.message);
    ws.close();
  }
});

server.listen(PORT, () => console.log(`Server on ${PUBLIC_URL}`));