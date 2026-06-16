import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('settings can be saved to a fresh data directory', async () => {
  const previousDataDir = process.env.TRADE_AI_DATA_DIR;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'trade-ai-settings-'));
  process.env.TRADE_AI_DATA_DIR = dataDir;

  try {
    const moduleUrl = `${pathToFileURL(path.resolve('server/settingsStore.js')).href}?case=${Date.now()}`;
    const { getPublicSettings, saveSettingsPatch } = await import(moduleUrl);
    const saved = await saveSettingsPatch({
      ai: { apiKey: 'sk-test-settings', model: 'deepseek-chat' },
      mailAccounts: [
        {
          id: 'qq-sales',
          label: 'QQ Sales',
          imap: {
            host: 'imap.qq.com',
            port: 993,
            secure: true,
            user: 'sales@qq.com',
            pass: 'imap-auth-code'
          },
          smtp: {
            host: 'smtp.qq.com',
            port: 465,
            secure: true,
            user: 'sales@qq.com',
            pass: 'smtp-auth-code',
            from: 'sales@qq.com'
          }
        }
      ]
    });

    assert.equal(saved.ai.hasApiKey, true);
    assert.equal(saved.mailAccounts[0].imap.pass, 'imap****code');
    assert.equal(getPublicSettings().mailAccounts[0].smtp.pass, 'smtp****code');
  } finally {
    if (previousDataDir === undefined) delete process.env.TRADE_AI_DATA_DIR;
    else process.env.TRADE_AI_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
