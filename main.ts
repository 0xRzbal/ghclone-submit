/**
 * Entrypoint for the ghclone forge contest container.
 *
 * The job of this process is deliberately small: boot the HTTP server that app.ts builds,
 * tell the competition environment which ephemeral port we grabbed, and then wait until the
 * environment announces the trial is finished. Everything the scorer measures lives in app.ts
 * and its route handlers; this module only talks to the outside world (the environment's
 * /register and /done endpoints), so it stays dependency-free — importing just the app builder
 * and leaning on the platform globals for HTTP, process, and timers.
 *
 * Lifecycle, in order:
 *   1. MAKEFUN_ENV_URL must be present; it is the environment's base origin. If it's missing
 *      there is no one to report to, so we bail out immediately with exit code 1.
 *   2. Bind the app to port 0 and let the OS hand us a free port. We never bind 8080 — that
 *      is the environment's own port and we must not fight for it.
 *   3. POST $MAKEFUN_ENV_URL/register with a JSON body of the chosen port. A 200 (accepted)
 *      or 409 (someone else already claimed the slot — keep waiting) both count as success.
 *      A 400/405 means the harness rejects our payload as malformed, which is a contract error
 *      that ends the program. Any other failure is transient and retried with exponential
 *      backoff.
 *   4. GET $MAKEFUN_ENV_URL/done until the body parses to {"done": true}. This can read false
 *      for a long time, and individual polls can fail, so we loop indefinitely, backing off on
 *      flaky or slow responses, and never exit before done is true.
 *   5. Close the server and exit 0.
 *
 * Observability: every step prints a timestamped, newline-delimited JSON log line to stdout
 * (info) or stderr (warn/error). Set MAKEFUN_VERBOSE=1 or pass --verbose to also see
 * per-attempt retry detail. SIGINT/SIGTERM trigger a graceful shutdown that still reports the
 * process ending.
 */

import { createApp } from './app.ts';
import type { Server } from 'node:http';

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/** The environment's base origin. Trailing slashes are stripped before any path is appended. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Whether to log verbose per-attempt retry detail. */
const VERBOSE = process.env.MAKEFUN_VERBOSE === '1' || process.argv.includes('--verbose');

/** How long a single register/done HTTP call may take before we abandon it. */
const HTTP_TIMEOUT_MS = 30_000;

/** Exponential backoff: first delay and the ceiling it must never exceed. */
const BACKOFF_INITIAL_MS = 250;
const BACKOFF_MAX_MS = 2_000;

/** Growth factor applied to the delay after each consecutive failure. */
const BACKOFF_FACTOR = 2;

/* ------------------------------------------------------------------ *
 * Logging: structured, timestamped JSON lines.
 * ------------------------------------------------------------------ */

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(`${record}\n`);
}

const logInfo = (message: string, fields: Record<string, unknown> = {}) => log('info', message, fields);
const logWarn = (message: string, fields: Record<string, unknown> = {}) => log('warn', message, fields);
const logError = (message: string, fields: Record<string, unknown> = {}) => log('error', message, fields);

/* ------------------------------------------------------------------ *
 * Small async utilities
 * ------------------------------------------------------------------ */

/** Wait for the given number of milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute the backoff delay for a given attempt index (0-based). Starts at BACKOFF_INITIAL_MS
 * and grows exponentially until it hits BACKOFF_MAX_MS, where it stays.
 */
function delayForAttempt(attempt: number): number {
  const grown = BACKOFF_INITIAL_MS * Math.pow(BACKOFF_FACTOR, attempt);
  return Math.min(BACKOFF_MAX_MS, grown);
}

/**
 * Fetch with a hard timeout. Node's fetch accepts an AbortSignal; we use AbortSignal.timeout so
 * that a hung connection can never keep the process alive indefinitely.
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

/* ------------------------------------------------------------------ *
 * Registering the port
 * ------------------------------------------------------------------ */

/** Signals a permanent contract violation that should terminate the process. */
class ContractViolation extends Error {}

/**
 * POST our bound port to /register. Resolves once on a status that represents forward progress
 * (200 accepted, 409 already-won). Throws a ContractViolation for 400/405, which the caller
 * treats as fatal. Every other outcome (network fault, timeout, unexpected status) propagates as
 * a retryable error.
 */
async function submitPort(port: number): Promise<void> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${ENV_URL}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch (cause) {
    throw new Error(`register request failed (network or timeout): ${String(cause)}`, { cause });
  }

  if (res.status === 200) {
    logInfo('register accepted', { port });
    return;
  }
  if (res.status === 409) {
    logWarn('register conflict: another entry claims the slot; keeping waiting', { port });
    return;
  }
  if (res.status === 400 || res.status === 405) {
    const detail = await res.text().catch(() => '');
    throw new ContractViolation(`register rejected ${res.status} (contract error): ${detail}`);
  }

  throw new Error(`register returned unexpected status ${res.status}`);
}

/* ------------------------------------------------------------------ *
 * Waiting for completion
 * ------------------------------------------------------------------ */

/**
 * Poll /done once. Returns true when the body carries done=true; false for any other observation
 * (non-200, unparseable body, or a thrown network/timeout error). Never throws — transient
 * failures are just treated as "not done yet" so the caller can back off and retry.
 */
async function checkDone(): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${ENV_URL}/done`);
  } catch {
    return false;
  }

  if (!res.ok) {
    return false;
  }

  try {
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

/**
 * Poll /done until it reports true, backing off between attempts. This never returns early —
 * it keeps looping until the environment signals completion.
 */
async function awaitCompletion(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const finished = await checkDone();
    if (finished) {
      logInfo('environment reports done');
      return;
    }

    const waitMs = delayForAttempt(attempt);
    if (VERBOSE) {
      logWarn('done not yet true; resuming poll', { attempt, waitMs });
    }
    await sleep(waitMs);
  }
}

/* ------------------------------------------------------------------ *
 * Server lifecycle
 * ------------------------------------------------------------------ */

/**
 * Create the app, bind it to port 0, and resolve with both the server and the OS-chosen port.
 * Any bind error rejects the promise.
 */
function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createApp();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind an ephemeral TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Main orchestrator
 * ------------------------------------------------------------------ */

/**
 * The whole process life: bind, register (with backoff, fatal on contract violations), wait for
 * done (never exits early), then close the server.
 */
async function run(): Promise<void> {
  const { server, port } = await listenOnEphemeralPort();
  logInfo('listening on ephemeral port', { port });

  // Register with backoff. Contract violations stop the program; everything else is retried.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await submitPort(port);
      break;
    } catch (err) {
      if (err instanceof ContractViolation) {
        logError(err.message);
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      const waitMs = delayForAttempt(attempt);
      if (VERBOSE) {
        logWarn('register not yet accepted; retrying', { attempt, detail, waitMs });
      } else {
        logWarn('register not yet accepted; retrying', { waitMs });
      }
      await sleep(waitMs);
    }
  }

  logInfo('registered; waiting for the environment to mark the trial done');
  await awaitCompletion();

  server.close();
  logInfo('completion confirmed; server closed');
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

if (ENV_URL === '') {
  logError('MAKEFUN_ENV_URL is not set; there is no environment to register with');
  process.exit(1);
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    logError('fatal', { detail });
    process.exit(1);
  });

let shuttingDown = false;
function requestShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logWarn(`received ${signal}; exiting`);
  process.exit(0);
}
process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));
