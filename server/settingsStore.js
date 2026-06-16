import { mkdir, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.TRADE_AI_DATA_DIR || path.resolve(__dirname, '..', '.data');
const settingsFile = path.join(dataDir, 'settings.json');

const defaultSettings = {
  ai: {
    provider: 'deepseek',
    apiKey: '',
    model: 'deepseek-chat'
  },
  mailAccounts: []
};

function envMailAccounts() {
  if (!process.env.MAIL_IMAP_HOST && !process.env.MAIL_SMTP_HOST && !process.env.MAIL_IMAP_USER) return [];
  const imapPort = Number(process.env.MAIL_IMAP_PORT || 993);
  const smtpPort = Number(process.env.MAIL_SMTP_PORT || 465);
  return [{
    id: process.env.MAIL_ACCOUNT_ID || 'default',
    label: process.env.MAIL_ACCOUNT_LABEL || process.env.MAIL_IMAP_USER || 'Default mailbox',
    pollIntervalSeconds: Number(process.env.MAIL_POLL_INTERVAL_SECONDS || 15),
    imap: {
      host: process.env.MAIL_IMAP_HOST || '',
      port: imapPort,
      secure: /^(1|true|yes)$/i.test(process.env.MAIL_IMAP_SECURE || String(imapPort === 993)),
      user: process.env.MAIL_IMAP_USER || '',
      pass: process.env.MAIL_IMAP_PASSWORD || ''
    },
    smtp: {
      host: process.env.MAIL_SMTP_HOST || '',
      port: smtpPort,
      secure: /^(1|true|yes)$/i.test(process.env.MAIL_SMTP_SECURE || String(smtpPort === 465)),
      user: process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER || '',
      pass: process.env.MAIL_SMTP_PASSWORD || '',
      from: process.env.MAIL_FROM || process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER || ''
    }
  }];
}

function readSettingsFile() {
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeSettings(value = {}) {
  return {
    ...defaultSettings,
    ...value,
    ai: {
      ...defaultSettings.ai,
      ...(value.ai || {})
    },
    mailAccounts: Array.isArray(value.mailAccounts) ? value.mailAccounts : []
  };
}

export function getSettingsSync() {
  return normalizeSettings(readSettingsFile());
}

export function maskSecret(value = '') {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 8) return '********';
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

export function getPublicSettings() {
  const settings = getSettingsSync();
  const visibleAccounts = settings.mailAccounts.length ? settings.mailAccounts : envMailAccounts();
  return {
    ai: {
      provider: settings.ai.provider,
      model: settings.ai.model,
      hasApiKey: Boolean(settings.ai.apiKey || process.env.DEEPSEEK_API_KEY),
      apiKeyMasked: maskSecret(settings.ai.apiKey || process.env.DEEPSEEK_API_KEY || '')
    },
    mailAccounts: visibleAccounts.map((account) => ({
      ...account,
      imap: {
        ...(account.imap || {}),
        pass: account.imap?.pass ? maskSecret(account.imap.pass) : ''
      },
      smtp: {
        ...(account.smtp || {}),
        pass: account.smtp?.pass ? maskSecret(account.smtp.pass) : ''
      }
    }))
  };
}

export async function saveSettingsPatch(patch = {}) {
  const current = getSettingsSync();
  const currentAccounts = new Map([...(envMailAccounts() || []), ...(current.mailAccounts || [])].map((account) => [String(account.id || account.imap?.user || ''), account]));
  const patchedAccounts = Array.isArray(patch.mailAccounts)
    ? patch.mailAccounts.map((account) => {
        const key = String(account.id || account.imap?.user || '');
        const previous = currentAccounts.get(key) || {};
        return {
          ...account,
          imap: {
            ...(account.imap || {}),
            pass: account.imap?.pass || previous.imap?.pass || ''
          },
          smtp: {
            ...(account.smtp || {}),
            pass: account.smtp?.pass || previous.smtp?.pass || ''
          }
        };
      })
    : current.mailAccounts;
  const next = {
    ...current,
    ...patch,
    ai: {
      ...current.ai,
      ...(patch.ai || {})
    },
    mailAccounts: patchedAccounts
  };

  if (patch.ai && !patch.ai.apiKey && current.ai.apiKey) {
    next.ai.apiKey = current.ai.apiKey;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify(normalizeSettings(next), null, 2), 'utf8');
  return getPublicSettings();
}

export function getAISettings() {
  const settings = getSettingsSync();
  return {
    apiKey: settings.ai.apiKey || process.env.DEEPSEEK_API_KEY || '',
    model: settings.ai.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
  };
}
