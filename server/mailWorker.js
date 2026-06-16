import 'dotenv/config';
import { parentPort } from 'node:worker_threads';
import { analyzeInquiry } from './analyzer.js';
import { getMailAccounts, syncMailbox } from './mailService.js';

const MIN_RETRY_MS = 5000;
const DEFAULT_POLL_INTERVAL_SECONDS = 15;

function getIntervalMs() {
  const accounts = getMailAccounts();
  const seconds = accounts.length
    ? Math.min(...accounts.map((account) => Number(account.pollIntervalSeconds || process.env.MAIL_POLL_INTERVAL_SECONDS || DEFAULT_POLL_INTERVAL_SECONDS)))
    : Number(process.env.MAIL_POLL_INTERVAL_SECONDS || DEFAULT_POLL_INTERVAL_SECONDS);
  return Math.max(8, Number.isFinite(seconds) ? seconds : DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
}

function hasConfiguredImap() {
  return getMailAccounts().some((account) => account.imap?.host && account.imap?.user && account.imap?.pass);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stopped = false;
let running = false;

parentPort?.on('message', (message) => {
  if (message?.type === 'stop') stopped = true;
});

async function runOnce() {
  if (running) return;
  running = true;
  const startedAt = new Date().toISOString();
  try {
    const result = await syncMailbox({ analyzeInquiry });
    parentPort?.postMessage({
      type: 'sync-complete',
      startedAt,
      finishedAt: new Date().toISOString(),
      checked: result.checked,
      imported: result.imported,
      autoReplied: result.autoReplied,
      sendQueued: result.sendQueued,
      sendProcessed: result.sendProcessed,
      manualReview: result.manualReview,
      errors: result.errors || []
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'sync-error',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error.message || String(error)
    });
  } finally {
    running = false;
  }
}

async function main() {
  parentPort?.postMessage({ type: 'worker-started', startedAt: new Date().toISOString() });
  await delay(3000);
  while (!stopped) {
    const started = Date.now();
    if (hasConfiguredImap()) {
      await runOnce();
    } else {
      parentPort?.postMessage({
        type: 'sync-skipped',
        skippedAt: new Date().toISOString(),
        reason: 'IMAP is not configured.'
      });
    }
    const waitMs = Math.max(MIN_RETRY_MS, getIntervalMs() - (Date.now() - started));
    await delay(waitMs);
  }
  parentPort?.postMessage({ type: 'worker-stopped', stoppedAt: new Date().toISOString() });
}

main().catch((error) => {
  parentPort?.postMessage({
    type: 'worker-fatal',
    error: error.message || String(error),
    at: new Date().toISOString()
  });
  throw error;
});
