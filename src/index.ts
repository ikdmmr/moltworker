/** Moltbot + Cloudflare Sandbox Proxy */


import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAccessMiddleware } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, syncToR2, buildEnvVars } from './gateway';
import { publicRoutes, api, adminUi, debug } from './routes';
import { redactSensitiveParams } from './utils/logging';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  // MOLTBOT_GATEWAY_TOKEN is now optional (recommended to use Cloudflare Access instead)
  /*
  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }
  */

  // CF Access vars not required in dev/test mode since auth is skipped
  if (!isTestMode) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
      missing.push('CF_ACCESS_AUD');
    }
  }

  // Check for AI provider configuration (at least one must be set)
  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;

  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey) {
    missing.push(
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID',
    );
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 *
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  console.log(`[REQ] Has ANTHROPIC_API_KEY: ${!!c.env.ANTHROPIC_API_KEY}`);
  console.log(`[REQ] DEV_MODE: ${c.env.DEV_MODE}`);
  console.log(`[REQ] DEBUG_ROUTES: ${c.env.DEBUG_ROUTES}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);
  c.set('sandbox', sandbox);

  // GET /cleanup - Public rescue/diagnostic dashboard
  if (c.req.path.startsWith('/cleanup')) {
    const isNuclear = c.req.path === '/cleanup/nuclear';
    const isStart = c.req.path === '/cleanup/start';
    let startResult: string | null = null;

    if (isStart) {
      try {
        console.log('[RESCUE] Manual start triggered (fire and forget)');
        // Trigger startup without waiting for port to avoid worker timeouts
        const envVars = buildEnvVars(c.env);
        const command = '/usr/local/bin/start-openclaw.sh';

        c.executionCtx.waitUntil(
          sandbox.startProcess(command, {
            env: Object.keys(envVars).length > 0 ? envVars : undefined,
          }).then(p => {
            console.log('[RESCUE] Background start success:', p.id);
          }).catch(err => {
            console.error('[RESCUE] Background start failed:', err);
          })
        );
        startResult = "Startup triggered in background. Please wait ~1 minute and refresh.";
      } catch (e) {
        startResult = `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    try {
      const processes = await sandbox.listProcesses();
      const killed: string[] = [];
      const report: any[] = [];

      for (const p of processes) {
        const isGateway = p.command.includes('start-openclaw.sh') || p.command.includes('openclaw gateway');

        const pData: any = {
          id: p.id,
          command: p.command,
          status: p.status,
          exitCode: p.exitCode
        };

        if (p.status === 'running' || p.status === 'starting' || p.status === 'failed' || p.status === 'completed') {
          try {
            const logs = await p.getLogs();
            pData.stdout = (logs.stdout || '').split('\n').slice(-30).join('\n');
            pData.stderr = (logs.stderr || '').split('\n').slice(-30).join('\n');
          } catch { }
        }
        report.push(pData);

        if (isNuclear && (p.status === 'running' || p.status === 'starting')) {
          try {
            await p.kill();
            killed.push(p.id);
          } catch { }
        }
      }

      const versionStr = "v14 - RESCUE_V14_FINAL_DIAG";

      // Check if port 18789 is listening
      let portStatus = "Check pending...";
      try {
        // Better: try a quick internal fetch or check processes
        const gatewayProc = processes.find(p => p.command.includes('gateway') && (p.status === 'running' || p.status === 'starting'));
        if (gatewayProc) {
          try {
            const ready = await gatewayProc.waitForPort(18789, { timeout: 1000 }).then(() => true).catch(() => false);
            portStatus = ready ? "✅ LISTENING" : "⏳ WAITING FOR PORT";
          } catch { portStatus = "❌ PORT BLOCKED/CLOSED"; }
        } else {
          portStatus = "⚪ GATEWAY NOT STARTED";
        }
      } catch { }

      return c.html(`
        <html>
          <head>
            <title>Moltworker Final Rescue (v14)</title>
            <style>
              body { background: #0f172a; color: #f8fafc; font-family: monospace; padding: 1.5rem; line-height: 1.4; }
              .card { background: #1e293b; padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem; border-left: 4px solid #38bdf8; position: relative; }
              .card.failed { border-left-color: #ef4444; }
              .card.completed { border-left-color: #94a3b8; }
              .card.killed { border-left-color: #fbbf24; opacity: 0.7; }
              .banner { background: #1e293b; padding: 1.5rem; border-radius: 0.5rem; margin-bottom: 1.5rem; border: 1px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
              .result-box { background: #064e3b; color: #34d399; padding: 1rem; border-radius: 0.5rem; margin-bottom: 1rem; border: 1px solid #059669; }
              h1 { color: #38bdf8; margin-top: 0; font-size: 1.5rem; }
              h2 { color: #94a3b8; font-size: 1rem; margin: 1rem 0 0.5rem; }
              pre { background: #000; padding: 0.5rem; overflow: auto; max-height: 300px; color: #4ade80; font-size: 0.75rem; border: 1px solid #334155; margin-top: 0.5rem; }
              .label { font-weight: bold; color: #94a3b8; margin-right: 0.5rem; }
              .status { font-weight: bold; }
              .running { color: #4ade80; }
              .failed { color: #ef4444; }
              .btn { display: inline-block; background: #38bdf8; color: #0f172a; padding: 0.6rem 1.2rem; border-radius: 0.25rem; text-decoration: none; font-weight: bold; margin-right: 0.5rem; border: none; cursor: pointer; font-size: 0.9rem; }
              .btn-start { background: #fbbf24; }
              .btn-nuclear { background: #ef4444; color: #fff; }
              .btn-refresh { background: #10b981; }
              .btn-secondary { background: #475569; color: #fff; }
              .port-badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 1rem; font-size: 0.8rem; background: #334155; font-weight: bold; }
              .port-up { background: #065f46; color: #34d399; }
              .port-down { background: #7f1d1d; color: #fecaca; }
            </style>
          </head>
          <body>
            <h1>Moltworker Rescue Dashboard (v14)</h1>
            
            ${startResult ? `<div class="result-box"><strong>Action:</strong> ${startResult}</div>` : ''}
            ${isNuclear ? `<div class="result-box" style="background:#7f1d1d;color:#fecaca;border-color:#b91c1c;"><strong>Safety Reset:</strong> Killed ${killed.length} processes.</div>` : ''}

            <div class="banner">
              <h2>System Control</h2>
              <div style="margin-bottom: 1rem;">
                <a href="/cleanup/nuclear" class="btn btn-nuclear" onclick="return confirm('Kill ALL processes and start fresh?')">☢️ Nuclear Reset</a>
                <a href="/cleanup/start" class="btn btn-start">⚡ Force Start Gateway</a>
                <button onclick="location.reload()" class="btn btn-refresh">🔄 Refresh Status</button>
              </div>
              
              <h2>App Navigation</h2>
              <div>
                <a href="/" class="btn">🏠 Home App</a>
                <a href="/_admin/" class="btn btn-secondary">🔑 Pairing Page (Login)</a>
                <a href="/sandbox-health" class="btn btn-secondary" target="_blank">🩺 Raw Health</a>
              </div>

              <div style="margin-top: 1.5rem; border-top: 1px solid #334155; padding-top: 1rem;">
                <span class="label">DEPLOY_ID:</span> <code>${c.env.DEPLOY_ID || 'PROD'}</code> | 
                <span class="label">PORT 18789:</span> <span class="port-badge ${portStatus.includes('✅') ? 'port-up' : 'port-down'}">${portStatus}</span>
              </div>
            </div>
            
            <h2>Process Management (${processes.length} active)</h2>

            ${report.length === 0 ? '<p><i>No processes found. Use "Nuclear Reset" then "Force Start" to begin.</i></p>' : ''}
            
            ${report.map(p => `
              <div class="card ${p.status} ${killed.includes(p.id) ? 'killed' : ''}">
                <div><span class="label">ID:</span> ${p.id}</div>
                <div><span class="label">CMD:</span> ${p.command}</div>
                <div><span class="label">STATUS:</span> <span class="status ${p.status}">${p.status}</span> ${p.exitCode !== undefined ? `(Exit: ${p.exitCode})` : ''}</div>
                ${p.stdout || p.stderr ? `
                  <pre>STDOUT:\n${p.stdout}\n\nSTDERR:\n${p.stderr}</pre>
                ` : '<p><i>(No logs generated yet)</i></p>'}
              </div>
            `).reverse().join('')}
          </body>
        </html>
      `);
    } catch (e) {
      return c.text('Rescue operation failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  await next();
});

// Cleanup route moved to middleware for guaranteed priority.


// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
// app.route('/cdp', cdp);


// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503,
    );
  }

  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
app.use('*', async (c, next) => {
  // TEMP: Skip auth for debug routes to allow automated diagnostics
  // This must be done HERE, not in a prior middleware, to prevent the Access middleware from running
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml,
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    return c.json(
      {
        error: 'Moltbot gateway failed to start',
        details: errorMessage,
        hint,
      },
      503,
    );
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to Moltbot');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Inject gateway token into WebSocket request if not already present.
    // CF Access redirects strip query params, so authenticated users lose ?token=.
    // Since the user already passed CF Access auth, we inject the token server-side.
    let wsRequest = request;
    if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const tokenUrl = new URL(url.toString());
      tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
      wsRequest = new Request(tokenUrl.toString(), request);
    }

    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Relay messages from container to client, with error transformation
    containerWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client (raw):',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      // Try to intercept and transform error messages
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (debugLogs) {
            console.log('[WS] Parsed JSON, has error.message:', !!parsed.error?.message);
          }
          if (parsed.error?.message) {
            if (debugLogs) {
              console.log('[WS] Original error.message:', parsed.error.message);
            }
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            if (debugLogs) {
              console.log('[WS] Transformed error.message:', parsed.error.message);
            }
            data = JSON.stringify(parsed);
          }
        } catch (e) {
          if (debugLogs) {
            console.log('[WS] Not JSON or parse error:', e);
          }
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Handle close events
    serverWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(event.code, event.reason);
    });

    containerWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Container closed:', event.code, event.reason);
      }
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
      }
      serverWs.close(event.code, reason);
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);
  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // Add debug header to verify worker handled the request
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

/**
 * Scheduled handler for cron triggers.
 * Syncs moltbot config/state from container to R2 for persistence.
 */
async function scheduled(
  _event: ScheduledEvent,
  env: MoltbotEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const options = buildSandboxOptions(env);
  const sandbox = getSandbox(env.Sandbox, 'moltbot', options);

  const gatewayProcess = await findExistingMoltbotProcess(sandbox);
  if (!gatewayProcess) {
    console.log('[cron] Gateway not running yet, skipping sync');
    return;
  }

  console.log('[cron] Starting backup sync to R2...');
  const result = await syncToR2(sandbox, env);

  if (result.success) {
    console.log('[cron] Backup sync completed successfully at', result.lastSync);
  } else {
    console.error('[cron] Backup sync failed:', result.error, result.details || '');
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
