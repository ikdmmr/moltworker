import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /cleanup - Public cleanup endpoint to sweep zombie processes
// Mounted at the very top to ensure accessibility during resource exhaustion
publicRoutes.get('/cleanup', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const killed: string[] = [];

    for (const p of processes) {
      if (p.status === 'running' || p.status === 'starting') {
        try {
          await p.kill();
          killed.push(p.id);
        } catch { }
      }
    }

    return c.html(`
      <html>
        <head>
          <title>Moltworker Cleanup</title>
          <style>
            body { background: #1a1a2e; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #16213e; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 20px rgba(0,0,0,0.5); text-align: center; }
            h1 { color: #f08e2e; }
            a { color: #4ecca3; text-decoration: none; font-weight: bold; }
            .stats { font-size: 1.2rem; margin: 1rem 0; color: #a2a8d3; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Cleanup Complete</h1>
            <div class="stats">Killed ${killed.length} zombie processes.</div>
            <p>The system has been reset.</p>
            <p><a href="/">👉 Return to App</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    return c.text('Cleanup failed: ' + (e instanceof Error ? e.message : String(e)));
  }
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

// GET /cleanup - Public cleanup endpoint to sweep zombie processes
publicRoutes.get('/cleanup', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const killed: string[] = [];

    for (const p of processes) {
      if (p.status === 'running' || p.status === 'starting') {
        try {
          await p.kill();
          killed.push(p.id);
        } catch { }
      }
    }

    return c.html(`
      <html>
        <head>
          <title>Moltworker Cleanup</title>
          <style>
            body { background: #1a1a2e; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #16213e; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 20px rgba(0,0,0,0.5); text-align: center; }
            h1 { color: #f08e2e; }
            a { color: #4ecca3; text-decoration: none; font-weight: bold; }
            .stats { font-size: 1.2rem; margin: 1rem 0; color: #a2a8d3; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Cleanup Complete</h1>
            <div class="stats">Killed ${killed.length} zombie processes.</div>
            <p>The system has been reset.</p>
            <p><a href="/">👉 Return to App</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (e) {
    return c.text('Cleanup failed: ' + (e instanceof Error ? e.message : String(e)));
  }
});

export { publicRoutes };
