import crypto from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { loadMailState, saveMailState, updateMailContext } from './mailStore.js';
import { createQuotationPdfBuffer } from './pdf.js';
import { findRiskSignals } from './risk.js';
import { getSettingsSync } from './settingsStore.js';

const AUTO_REPLY_STATUSES = new Set(['full_quote', 'ask_more']);
const STOP_QUALITY_TYPES = new Set(['scam', 'spam', 'competitor', 'low_intent']);
const FOLLOW_UP_DAY_MS = Number(process.env.MAIL_FOLLOWUP_DAY_MS || 24 * 60 * 60 * 1000);
const MAIL_CONNECTION_TIMEOUT_MS = Number(process.env.MAIL_CONNECTION_TIMEOUT_MS || 15000);
const SYNC_LOCK_STALE_MS = Number(process.env.MAIL_SYNC_LOCK_STALE_MS || 10 * 60 * 1000);
const DEFAULT_MAIL_POLL_INTERVAL_SECONDS = 15;
const DEFAULT_MAIL_PROCESS_LIMIT = 10;
const DEFAULT_MAIL_FETCH_LIMIT = 120;
const DEFAULT_MAIL_SEND_PROCESS_LIMIT = 5;
const SEND_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const syncLockFile = path.resolve(__dirname, '..', '.data', 'mail-sync.lock');

function boolFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeMailHost(host = '', kind = 'imap') {
  const raw = String(host || '').trim();
  const key = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const providerHosts = {
    qq: { imap: 'imap.qq.com', smtp: 'smtp.qq.com' },
    'qq.com': { imap: 'imap.qq.com', smtp: 'smtp.qq.com' },
    gmail: { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
    'gmail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
    tencent: { imap: 'imap.exmail.qq.com', smtp: 'smtp.exmail.qq.com' },
    exmail: { imap: 'imap.exmail.qq.com', smtp: 'smtp.exmail.qq.com' },
    'exmail.qq.com': { imap: 'imap.exmail.qq.com', smtp: 'smtp.exmail.qq.com' },
    aliyun: { imap: 'imap.qiye.aliyun.com', smtp: 'smtp.qiye.aliyun.com' },
    'qiye.aliyun.com': { imap: 'imap.qiye.aliyun.com', smtp: 'smtp.qiye.aliyun.com' },
    '163': { imap: 'imap.163.com', smtp: 'smtp.163.com' },
    '163.com': { imap: 'imap.163.com', smtp: 'smtp.163.com' },
    netease: { imap: 'imap.163.com', smtp: 'smtp.163.com' }
  };
  return providerHosts[key]?.[kind] || raw;
}

async function acquireSyncLock() {
  await mkdir(path.dirname(syncLockFile), { recursive: true });
  try {
    const lockStat = await stat(syncLockFile);
    if (Date.now() - lockStat.mtimeMs > SYNC_LOCK_STALE_MS) {
      await rm(syncLockFile, { force: true });
    }
  } catch {
    // No existing lock.
  }

  try {
    const handle = await open(syncLockFile, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
    return async () => {
      await rm(syncLockFile, { force: true });
    };
  } catch {
    const error = new Error('Mail sync is already running.');
    error.status = 409;
    throw error;
  }
}

export function getMailConfig() {
  const imapPort = numberFromEnv(process.env.MAIL_IMAP_PORT, 993);
  const smtpPort = numberFromEnv(process.env.MAIL_SMTP_PORT, 465);
  return {
    id: process.env.MAIL_ACCOUNT_ID || 'default',
    label: process.env.MAIL_ACCOUNT_LABEL || process.env.MAIL_IMAP_USER || 'Default mailbox',
    pollIntervalSeconds: numberFromEnv(process.env.MAIL_POLL_INTERVAL_SECONDS, DEFAULT_MAIL_POLL_INTERVAL_SECONDS),
    imap: {
      host: normalizeMailHost(process.env.MAIL_IMAP_HOST || '', 'imap'),
      port: imapPort,
      secure: boolFromEnv(process.env.MAIL_IMAP_SECURE, imapPort === 993),
      user: process.env.MAIL_IMAP_USER || '',
      pass: process.env.MAIL_IMAP_PASSWORD || ''
    },
    smtp: {
      host: normalizeMailHost(process.env.MAIL_SMTP_HOST || '', 'smtp'),
      port: smtpPort,
      secure: boolFromEnv(process.env.MAIL_SMTP_SECURE, smtpPort === 465),
      user: process.env.MAIL_SMTP_USER || '',
      pass: process.env.MAIL_SMTP_PASSWORD || '',
      from: process.env.MAIL_FROM || process.env.MAIL_SMTP_USER || ''
    },
    lookbackDays: numberFromEnv(process.env.MAIL_LOOKBACK_DAYS, 3),
    fetchLimit: numberFromEnv(process.env.MAIL_FETCH_LIMIT, DEFAULT_MAIL_FETCH_LIMIT),
    processLimit: numberFromEnv(process.env.MAIL_PROCESS_LIMIT, DEFAULT_MAIL_PROCESS_LIMIT)
  };
}

function normalizeAccountConfig(account = {}, index = 0) {
  const imapPort = numberFromEnv(account.imap?.port ?? account.imapPort, 993);
  const smtpPort = numberFromEnv(account.smtp?.port ?? account.smtpPort, 465);
  const user = account.imap?.user || account.imapUser || account.user || '';
  return {
    id: String(account.id || account.accountId || user || `mailbox-${index + 1}`).trim(),
    label: account.label || account.name || user || `Mailbox ${index + 1}`,
    pollIntervalSeconds: numberFromEnv(account.pollIntervalSeconds, numberFromEnv(process.env.MAIL_POLL_INTERVAL_SECONDS, DEFAULT_MAIL_POLL_INTERVAL_SECONDS)),
    imap: {
      host: normalizeMailHost(account.imap?.host || account.imapHost || '', 'imap'),
      port: imapPort,
      secure: boolFromEnv(account.imap?.secure ?? account.imapSecure, imapPort === 993),
      user,
      pass: account.imap?.pass || account.imap?.password || account.imapPassword || account.password || ''
    },
    smtp: {
      host: normalizeMailHost(account.smtp?.host || account.smtpHost || '', 'smtp'),
      port: smtpPort,
      secure: boolFromEnv(account.smtp?.secure ?? account.smtpSecure, smtpPort === 465),
      user: account.smtp?.user || account.smtpUser || user,
      pass: account.smtp?.pass || account.smtp?.password || account.smtpPassword || account.password || '',
      from: account.smtp?.from || account.from || account.smtpUser || user
    },
    lookbackDays: numberFromEnv(account.lookbackDays, numberFromEnv(process.env.MAIL_LOOKBACK_DAYS, 3)),
    fetchLimit: numberFromEnv(account.fetchLimit, numberFromEnv(process.env.MAIL_FETCH_LIMIT, DEFAULT_MAIL_FETCH_LIMIT)),
    processLimit: numberFromEnv(account.processLimit, numberFromEnv(process.env.MAIL_PROCESS_LIMIT, DEFAULT_MAIL_PROCESS_LIMIT))
  };
}

export function getMailAccounts() {
  const savedAccounts = getSettingsSync().mailAccounts || [];
  if (savedAccounts.length) {
    return savedAccounts.map(normalizeAccountConfig).filter((account) => account.id);
  }
  if (process.env.MAIL_ACCOUNTS_JSON) {
    try {
      const parsed = JSON.parse(process.env.MAIL_ACCOUNTS_JSON);
      const rawAccounts = Array.isArray(parsed) ? parsed : parsed.accounts;
      const accounts = (rawAccounts || []).map(normalizeAccountConfig).filter((account) => account.id);
      if (accounts.length) return accounts;
    } catch {
      // Fall back to the legacy single-account env vars.
    }
  }
  return [getMailConfig()];
}

function isImapConfigured(config = getMailConfig()) {
  return Boolean(config.imap.host && config.imap.user && config.imap.pass);
}

function isSmtpConfigured(config = getMailConfig()) {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
}

function mailTlsOptions(host = '') {
  return {
    servername: host,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: boolFromEnv(process.env.MAIL_TLS_REJECT_UNAUTHORIZED, true)
  };
}

function createImapClient(config = getMailConfig()) {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    connectionTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    tls: mailTlsOptions(config.imap.host),
    auth: {
      user: config.imap.user,
      pass: config.imap.pass
    },
    logger: false
  });
}

function createTransport(config = getMailConfig()) {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass
    },
    tls: mailTlsOptions(config.smtp.host),
    connectionTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    greetingTimeout: MAIL_CONNECTION_TIMEOUT_MS,
    socketTimeout: MAIL_CONNECTION_TIMEOUT_MS
  });
}

function describeNetworkError(error, service = 'mail') {
  const message = error?.message || String(error || 'Unknown error');
  const code = error?.code || error?.cause?.code || '';
  if (/Invalid login|AUTHENTICATIONFAILED|Authentication failed|Login failed/i.test(message)) {
    return `${service} authentication failed. Check the mailbox address and app password/authorization code.`;
  }
  if (/Client network socket disconnected before secure TLS connection was established|ECONNRESET|socket hang up/i.test(message)) {
    return `${service} TLS connection was disconnected before login. Check host, port, secure setting, firewall/VPN, and whether IMAP/SMTP is enabled.`;
  }
  if (/ETIMEDOUT|timeout|timed out/i.test(message)) {
    return `${service} connection timed out. Check network access to the mail server and try again.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `${service} DNS lookup failed. Check the mail server host name. QQ mail should use IMAP imap.qq.com:993 SSL and SMTP smtp.qq.com:465 SSL.`;
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `${service} connection refused. Check host, port, and SSL setting.`;
  }
  if (/fetch failed/i.test(message)) {
    return `${service} network request failed. Check network connectivity and provider availability.`;
  }
  return code ? `${service} error (${code}): ${message}` : `${service} error: ${message}`;
}

function connectionLabel(config, kind) {
  const mailConfig = config?.[kind] || {};
  const host = mailConfig.host || '';
  const port = mailConfig.port || '';
  return `${config.label || config.id} ${kind.toUpperCase()} (${host}${port ? `:${port}` : ''})`;
}

async function withMailTimeout(operation, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${MAIL_CONNECTION_TIMEOUT_MS}ms`)), MAIL_CONNECTION_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatAddressList(addresses) {
  return addresses?.text || addresses?.value?.map((item) => item.address || item.name).filter(Boolean).join(', ') || '';
}

function firstAddress(addresses) {
  return addresses?.value?.find((item) => item.address)?.address || '';
}

function extractFirstEmail(value = '') {
  return String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

function normalizeEmail(value = '') {
  return extractFirstEmail(value).toLowerCase();
}

function decodeLooseText(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeAttachmentName(value = 'quotation') {
  const cleaned = String(value || 'quotation')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return cleaned || 'quotation';
}

function extractEmbeddedHeader(text = '', headerName = '') {
  const escaped = headerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizedText = String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  const matches = normalizedText.matchAll(new RegExp(`^[^\\S\\r\\n]*${escaped}[^\\S\\r\\n]*:[^\\S\\r\\n]*([^\\r\\n]*)`, 'gim'));
  for (const match of matches) {
    const value = decodeLooseText(match[1]);
    if (value && !/^(from|to|date|message-id)\s*:/i.test(value)) return value;
  }
  return '';
}

function normalizeIdentity(value = '') {
  return decodeLooseText(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(gmbh|ug|ag|kg|ltd|limited|inc|llc|co|company)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmbeddedEmail(text = '') {
  return extractFirstEmail(extractEmbeddedHeader(text, 'From'));
}

function extractCompanyName(text = '') {
  const decoded = decodeLooseText(text);
  const patterns = [
    /\b(?:at|of|from)\s+([A-Z][A-Za-z0-9&.' -]{2,80}?(?:GmbH|UG|AG|KG|Ltd|Limited|Inc|LLC))\b/,
    /\b(We are|I am from)\s+([A-Z][A-Za-z0-9&.' -]{2,80}?(?:GmbH|UG|AG|KG|Ltd|Limited|Inc|LLC))\b/i,
    /\b([A-Z][A-Za-z0-9&.' -]{2,80}?(?:GmbH|UG|AG|KG|Ltd|Limited|Inc|LLC))\b/
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    const value = match?.[2] || match?.[1];
    if (value && !/we are|i am from/i.test(value)) return decodeLooseText(value);
  }
  return '';
}

function tokenSet(value = '') {
  return new Set(
    normalizeSubject(value)
      .replace(/\brfq\b|\bre\b|\bquote\b|\bquotation\b|\bthank\b|\byou\b|\bfor\b|\byour\b|\bpcs\b|\bpc\b|\bml\b/gi, ' ')
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3)
  );
}

function subjectOverlap(left = '', right = '') {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return false;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared >= 2 || shared / Math.min(leftTokens.size, rightTokens.size) >= 0.45;
}

function mailIdentity(mail = {}) {
  const envelopeEmail = normalizeEmail(mail.fromAddress || mail.from);
  const claimedEmail = normalizeEmail(mail.embeddedFromEmail || extractEmbeddedEmail(mail.text));
  return {
    email: envelopeEmail || claimedEmail,
    claimedEmail,
    company: normalizeIdentity(extractCompanyName(mail.text || '') || mail.embeddedCompany || ''),
    subject: mail.subject || mail.embeddedSubject || extractEmbeddedHeader(mail.text, 'Subject')
  };
}

function leadIdentity(lead = {}) {
  const envelopeEmail = normalizeEmail(
    lead.mail?.fromAddress ||
    lead.mail?.from ||
    lead.mail?.replyTo
  );
  const claimedEmail = normalizeEmail(
    lead.result?.customer?.contact ||
    lead.contact ||
    lead.mail?.embeddedFromEmail ||
    extractEmbeddedEmail(lead.inquiry || '')
  );
  return {
    email: envelopeEmail || claimedEmail,
    claimedEmail,
    company: normalizeIdentity(
      lead.result?.customer?.company ||
      lead.customer ||
      extractCompanyName(lead.inquiry || '')
    ),
    subject: lead.mail?.subject || lead.subject || lead.result?.emailSubject || ''
  };
}

export function isNonBusinessNoiseMail(mail = {}) {
  const from = `${mail.from || ''} ${mail.fromAddress || ''}`.toLowerCase();
  const subject = String(mail.subject || '').toLowerCase();
  const text = String(mail.text || '').toLowerCase();
  const haystack = `${from} ${subject} ${text}`;
  const hasTradeIntent = /\b(rfq|quotation|quote|purchase order|po\b|buyer|supplier|factory|manufacturer|sample|bulk order|moq|pcs|piece|pieces|incoterms|fob|cif|ddp|exw|lead time|logo|private label|payment terms|shipping|customs|b\/l|bill of lading)\b/i.test(haystack);
  if (hasTradeIntent) return false;

  const systemSender = /(^|[<\s"'])(no-?reply|noreply|notification|notifications|account|security|support|newsletter|marketing|promo|steam|google|microsoft|facebook|linkedin|github|qq邮箱团队|腾讯客服)/i.test(from);
  const knownNoiseDomain = /@(steampowered\.com|accounts\.google\.com|google\.com|mail\.qq\.com|service\.mail\.qq\.com|account\.microsoft\.com|facebookmail\.com|linkedin\.com|github\.com)>?$/i.test(from);
  const noiseContent = /(unsubscribe|newsletter|promotion|promotional|security alert|sign-in|login alert|verification code|account alert|trial version|wishlist|steam|验证码|安全提醒|登录提醒|账号安全|广告|促销|订阅|退订|通知邮件|系统通知|试用版|愿望单)/i.test(haystack);

  return (systemSender || knownNoiseDomain) && noiseContent;
}

function purgeNonBusinessNoiseLeads(state) {
  const leads = state.leads || [];
  const kept = [];
  const removedIds = [];
  for (const lead of leads) {
    const mail = {
      from: lead.mail?.from || lead.contact || '',
      fromAddress: lead.mail?.fromAddress || extractFirstEmail(lead.mail?.from || lead.contact || ''),
      subject: lead.mail?.subject || lead.subject || '',
      text: lead.inquiry || lead.notes || ''
    };
    if (isNonBusinessNoiseMail(mail)) {
      removedIds.push(lead.id);
      continue;
    }
    kept.push(lead);
  }
  if (removedIds.length) {
    state.leads = kept;
    state.mailQueue = (state.mailQueue || []).filter((item) => !removedIds.includes(item.leadId));
  }
  return removedIds.length;
}

function buildInquiryFromMail(mail) {
  return [
    `Subject: ${mail.subject || ''}`,
    `From: ${mail.from || ''}`,
    `To: ${mail.to || ''}`,
    `Date: ${mail.date || ''}`,
    `Message-ID: ${mail.messageId || ''}`,
    '',
    mail.text || ''
  ].join('\n');
}

function normalizeMessageId(messageId, uid) {
  return String(messageId || `imap-uid-${uid}`).trim().toLowerCase();
}

function normalizeSubject(subject = '') {
  return decodeLooseText(subject)
    .toLowerCase()
    .replace(/^(re|fw|fwd)\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReplyLikeSubject(subject = '') {
  return /^(re|回复)\s*:/i.test(decodeLooseText(subject));
}

function timelineEvent(type, data = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    at: new Date().toISOString(),
    ...data
  };
}

function pushSyncLog(state, log) {
  state.syncLogs = [
    {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...log
    },
    ...(state.syncLogs || [])
  ].slice(0, 80);
}

function upsertMailQueueItem(state, item) {
  const key = item.messageKey || item.messageId || item.uid || crypto.randomUUID();
  const existing = (state.mailQueue || []).filter((entry) => (entry.messageKey || entry.messageId || entry.uid) !== key);
  state.mailQueue = [
    {
      id: key,
      messageKey: key,
      updatedAt: new Date().toISOString(),
      ...item
    },
    ...existing
  ].slice(0, 300);
}

function mailFromQueueItem(item = {}) {
  return {
    from: item.from || '',
    fromAddress: item.fromAddress || extractFirstEmail(item.from || ''),
    to: item.to || '',
    replyTo: item.replyTo || '',
    subject: item.subject || '',
    embeddedSubject: item.embeddedSubject || '',
    accountId: item.accountId || 'default',
    accountLabel: item.accountLabel || '',
    date: item.date || '',
    messageId: item.messageId || '',
    text: item.rawText || item.preview || ''
  };
}

function statusForMailLead(result, autoReply) {
  if (autoReply.status === 'sent') return '已自动回复';
  if (autoReply.status === 'failed') return '发送失败';
  if (autoReply.status === 'queued' || autoReply.status === 'sending') return '待发送';
  const mode = result?.leadQuality?.safeReplyMode;
  const type = result?.leadQuality?.type;
  if (mode === 'manual_review' || STOP_QUALITY_TYPES.has(type)) return '待人工核查';
  return '待处理';
}

function fallbackAnalysisResult(mail, error) {
  return {
    customer: {
      name: '',
      company: extractCompanyName(mail.text || '') || mail.from || '未知客户',
      country: '',
      contact: mail.embeddedFromEmail || extractEmbeddedEmail(mail.text || '') || mail.fromAddress || mail.from || ''
    },
    intent: 'AI 分析暂时失败，需人工查看原始邮件。',
    priority: 'medium',
    leadQuality: {
      type: 'unknown',
      score: 0,
      reasons: ['AI analysis failed; saved for manual review instead of blocking mailbox sync.'],
      recommendedAction: '人工查看原始邮件，网络恢复后可重新复制内容到询盘分析。',
      safeReplyMode: 'manual_review',
      verificationTasks: []
    },
    requirements: {
      products: [],
      quantity: '',
      targetPrice: '',
      destination: '',
      leadTime: '',
      certifications: []
    },
    matchedProducts: [],
    quotationDraft: {
      currency: '',
      items: [],
      terms: ''
    },
    emailSubject: `Re: ${mail.subject || 'Inquiry'}`,
    emailReply: '',
    followUpPlan: [],
    missingInfo: ['AI analysis failed'],
    internalNotes: `AI 分析失败：${error.message || error}`
  };
}

export function explainAutoReplyDecision(result) {
  const quality = result?.leadQuality || {};
  const hasBlockingVerificationTasks = Array.isArray(quality.verificationTasks) && quality.verificationTasks.some((task) => {
    const text = `${task.id || ''} ${task.label || ''} ${task.method || ''}`.toLowerCase();
    return /\b(payment|bank|portal|link|fee|third-party|personal account|forwarder|young domain|newly registered|mismatch|invalid|phishing)\b/i.test(text);
  });
  const blockers = [];
  if (quality.type !== 'qualified') blockers.push(`线索类型不是有效客户：${quality.type || 'unknown'}`);
  if (Number(quality.score || 0) < 85) blockers.push(`评分低于 85：${quality.score || 0}`);
  if (!AUTO_REPLY_STATUSES.has(quality.safeReplyMode)) blockers.push(`回复模式不允许自动发送：${quality.safeReplyMode || 'unknown'}`);
  if (hasBlockingVerificationTasks) blockers.push('存在付款、门户、域名异常、无效信息等高风险核验任务');
  if (!result?.emailReply) blockers.push('没有可发送的英文回复正文');
  return {
    allowed: blockers.length === 0,
    blockers
  };
}

export function canAutoReply(result) {
  return explainAutoReplyDecision(result).allowed;
}

async function sendAutoReply(mail, result, config = getMailConfig(), options = {}) {
  if (!isSmtpConfigured(config)) {
    return { status: 'skipped', reason: 'SMTP is not configured.' };
  }

  const to = mail.replyTo || mail.fromAddress;
  if (!to) return { status: 'skipped', reason: 'No reply address found.' };

  const transport = createTransport(config);
  const info = await transport.sendMail({
    from: config.smtp.from || config.smtp.user,
    to,
    subject: result.emailSubject || `Re: ${mail.subject || 'Inquiry'}`,
    text: result.emailReply,
    attachments: options.attachments || [],
    envelope: {
      from: config.smtp.user,
      to
    }
  });

  return {
    status: 'sent',
    to,
    sentAt: new Date().toISOString(),
    mode: options.mode || 'auto',
    stage: options.stage || 'initial',
    replyId: options.replyId || '',
    accountId: config.id || 'default',
    accountLabel: config.label || config.imap.user || '',
    messageId: info.messageId || '',
    response: info.response || ''
  };
}

function makeQueuedReply(mail, result, config = getMailConfig(), options = {}) {
  const to = mail.replyTo || mail.fromAddress || extractFirstEmail(mail.from);
  return {
    status: 'queued',
    reason: 'Waiting in SMTP send queue.',
    to,
    queuedAt: new Date().toISOString(),
    mode: options.mode || 'auto',
    stage: options.stage || 'initial',
    replyId: options.replyId || '',
    accountId: config.id || mail.accountId || 'default',
    accountLabel: config.label || mail.accountLabel || config.imap?.user || '',
    subject: options.subject || result?.emailSubject || `Re: ${mail.subject || 'Inquiry'}`
  };
}

function sendJobKey(leadId, options = {}) {
  return [leadId, options.stage || 'initial', options.mode || 'auto', options.followUpId || '', options.replyId || ''].join(':');
}

function enqueueLeadSend(state, lead, options = {}) {
  state.sendQueue = state.sendQueue || [];
  const dedupeKey = sendJobKey(lead.id, options);
  const existing = state.sendQueue.find((job) => job.dedupeKey === dedupeKey && ['pending', 'sending', 'sent'].includes(job.status));
  if (existing) return existing;
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    dedupeKey,
    leadId: lead.id,
    accountId: options.accountId || lead.mail?.accountId || 'default',
    accountLabel: options.accountLabel || lead.mail?.accountLabel || '',
    mode: options.mode || 'auto',
    stage: options.stage || 'initial',
    followUpId: options.followUpId || '',
    replyId: options.replyId || '',
    status: 'pending',
    attempts: 0,
    to: options.to || lead.mail?.autoReply?.to || lead.mail?.replyTo || lead.mail?.fromAddress || extractFirstEmail(lead.mail?.from),
    subject: options.subject || lead.result?.emailSubject || `Re: ${lead.subject || lead.mail?.subject || 'Inquiry'}`,
    body: options.body || '',
    attachQuotationPdf: Boolean(options.attachQuotationPdf),
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    lastError: ''
  };
  state.sendQueue = [job, ...state.sendQueue].slice(0, 200);
  return job;
}

function customerReplySendKey(reply = {}) {
  return normalizeMessageId(reply.messageId || reply.date || '', '');
}

function isManualReplyLog(item = {}) {
  return item.status === 'sent' && item.stage === 'manual-reply';
}

export function hasSentReplyForCustomerMessage(lead, reply) {
  if (!reply) return false;
  const replyKey = customerReplySendKey(reply);
  const sentLog = lead.mail?.sentLog || [];
  if (replyKey) {
    const exact = sentLog.some((item) => isManualReplyLog(item) && normalizeMessageId(item.replyId || '', '') === replyKey);
    if (exact) return true;
  }

  // Legacy sent logs did not store replyId. Use time only as a fallback for those old entries.
  const replyAt = new Date(reply.date || '').getTime();
  if (!Number.isFinite(replyAt)) return false;
  return sentLog.some((item) => {
    if (!isManualReplyLog(item) || item.replyId) return false;
    const sentAt = new Date(item.sentAt || '').getTime();
    return Number.isFinite(sentAt) && sentAt >= replyAt;
  });
}

function latestSentTimeForLead(lead) {
  const sentTimes = [
    lead.mail?.autoReply?.sentAt,
    ...(lead.mail?.sentLog || []).filter((item) => item.status === 'sent').map((item) => item.sentAt)
  ]
    .map((value) => new Date(value || '').getTime())
    .filter((value) => Number.isFinite(value));
  return sentTimes.length ? Math.max(...sentTimes) : 0;
}

function markSendJob(state, jobId, patch = {}) {
  state.sendQueue = (state.sendQueue || []).map((job) => (
    job.id === jobId ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job
  ));
}

function normalizeManualReplyAutoReplyState(state) {
  let changed = false;
  state.leads = (state.leads || []).map((lead) => {
    const autoReply = lead.mail?.autoReply;
    if (!lead.mail || autoReply?.stage !== 'manual-reply' || autoReply.status === 'sent') return lead;

    const initialSent = (lead.mail.sentLog || []).find((item) => item.status === 'sent' && (item.stage || 'initial') === 'initial');
    const latestSent = (lead.mail.sentLog || []).find((item) => item.status === 'sent');
    const restored = initialSent || latestSent;
    if (!restored) return lead;

    changed = true;
    return {
      ...lead,
      mail: {
        ...lead.mail,
        autoReply: restored
      }
    };
  });
  return changed;
}

function nextRetryAt(attempts) {
  const delay = SEND_RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), SEND_RETRY_DELAYS_MS.length - 1)];
  return new Date(Date.now() + delay).toISOString();
}

async function processSendQueue(state, summary = {}, options = {}) {
  const limit = Number(options.limit || process.env.MAIL_SEND_PROCESS_LIMIT || DEFAULT_MAIL_SEND_PROCESS_LIMIT);
  const now = Date.now();
  let processed = 0;
  for (const job of [...(state.sendQueue || [])]) {
    if (processed >= limit) break;
    if (!['pending', 'failed'].includes(job.status)) continue;
    if (job.nextAttemptAt && new Date(job.nextAttemptAt).getTime() > now) continue;

    const leadIndex = (state.leads || []).findIndex((lead) => lead.id === job.leadId);
    if (leadIndex < 0) {
      markSendJob(state, job.id, { status: 'cancelled', lastError: 'Lead no longer exists.' });
      continue;
    }

    const lead = state.leads[leadIndex];
    const alreadySent = job.stage === 'initial' && (
      lead.mail?.autoReply?.status === 'sent' ||
      (lead.mail?.sentLog || []).some((item) => item.status === 'sent' && (item.stage || 'initial') === 'initial')
    );
    if (alreadySent) {
      markSendJob(state, job.id, { status: 'sent', lastError: 'Duplicate prevented: lead already has an initial sent reply.' });
      continue;
    }

    const account = getMailAccounts().find((item) => item.id === (job.accountId || lead.mail?.accountId)) || getMailConfig();
    const attempts = Number(job.attempts || 0) + 1;
    markSendJob(state, job.id, { status: 'sending', attempts, lastError: '' });
    processed += 1;

    try {
      const mail = {
        ...lead.mail,
        fromAddress: lead.mail?.fromAddress || extractFirstEmail(lead.mail?.from),
        replyTo: lead.mail?.replyTo || '',
        subject: lead.mail?.subject || lead.subject || ''
      };
      const result = job.followUpId
        ? {
            ...lead.result,
            emailSubject: `Re: ${lead.subject || lead.result?.emailSubject || 'Quotation follow-up'}`,
            emailReply: makeFollowUpText(lead, job.stage)
          }
        : lead.result;
      const sendResult = {
        ...result,
        emailSubject: job.subject || result?.emailSubject,
        emailReply: job.body || result?.emailReply
      };
      const attachments = job.attachQuotationPdf
        ? [{
            filename: `${safeAttachmentName(lead.customer || lead.contact || 'quotation')}.pdf`,
            content: createQuotationPdfBuffer({
              lead,
              result: lead.result,
              companyProfile: state.context?.companyProfile || ''
            }),
            contentType: 'application/pdf'
          }]
        : [];
      const sent = await sendAutoReply(mail, sendResult, account, {
        mode: job.mode,
        stage: job.stage,
        replyId: job.replyId || '',
        attachments
      });
      if (sent.status !== 'sent') throw new Error(sent.reason || 'SMTP did not accept the message.');

      const latestLead = state.leads[leadIndex];
      let updatedLead;
      if (job.followUpId) {
        updatedLead = {
          ...latestLead,
          status: job.stage === 'day7' ? '已沉默' : '待跟进',
          silentAt: job.stage === 'day7' ? new Date().toISOString() : latestLead.silentAt,
          takeoverSuggestion: job.stage === 'day7' ? (latestLead.takeoverSuggestion || makeTakeoverSuggestion(latestLead)) : latestLead.takeoverSuggestion,
          updatedAt: Date.now(),
          followUps: (latestLead.followUps || []).map((item) => item.id === job.followUpId ? { ...item, status: 'sent', sentAt: sent.sentAt } : item),
          mail: {
            ...latestLead.mail,
            sentLog: [sent, ...(latestLead.mail?.sentLog || [])]
          },
          timeline: [
            timelineEvent('follow-up', { subject: sendResult.emailSubject, to: sent.to, stage: job.stage }),
            ...(job.stage === 'day7' ? [timelineEvent('silent', { subject: latestLead.subject || latestLead.mail?.subject || 'No customer reply after final follow-up' })] : []),
            ...(latestLead.timeline || [])
          ]
        };
        summary.followUpsSent = (summary.followUpsSent || 0) + 1;
        if (job.stage === 'day7') summary.silentMarked = (summary.silentMarked || 0) + 1;
      } else {
        const isManualReply = job.stage === 'manual-reply';
        const baseUpdatedLead = {
          ...latestLead,
          status: isManualReply ? '待跟进' : '已自动回复',
          updatedAt: Date.now(),
          mail: {
            ...latestLead.mail,
            autoReply: isManualReply ? latestLead.mail?.autoReply : sent,
            sentLog: [sent, ...(latestLead.mail?.sentLog || [])]
          },
          timeline: [
            timelineEvent('outbound', { subject: result?.emailSubject || latestLead.subject, to: sent.to, mode: sent.mode, stage: sent.stage }),
            ...(latestLead.timeline || [])
          ]
        };
        updatedLead = isManualReply ? baseUpdatedLead : attachFollowUps(baseUpdatedLead, sent);
        summary.autoReplied = (summary.autoReplied || 0) + 1;
      }
      state.leads[leadIndex] = updatedLead;
      markSendJob(state, job.id, { status: 'sent', sentAt: sent.sentAt, smtpMessageId: sent.messageId || '', response: sent.response || '' });
    } catch (error) {
      const errorMessage = describeNetworkError(error, `${job.accountLabel || job.accountId || 'SMTP'} send queue`);
      markSendJob(state, job.id, {
        status: 'failed',
        attempts,
        lastError: errorMessage,
        nextAttemptAt: nextRetryAt(attempts)
      });
      const failedLead = state.leads[leadIndex];
      if (!job.followUpId && job.stage !== 'manual-reply' && failedLead?.mail) {
        state.leads[leadIndex] = {
          ...failedLead,
          status: '发送失败',
          updatedAt: Date.now(),
          mail: {
            ...failedLead.mail,
            autoReply: {
              ...(failedLead.mail.autoReply || {}),
              status: 'failed',
              reason: errorMessage,
              failedAt: new Date().toISOString()
            }
          }
        };
      } else if (!job.followUpId && job.stage === 'manual-reply' && failedLead?.mail) {
        state.leads[leadIndex] = {
          ...failedLead,
          status: '发送失败',
          updatedAt: Date.now(),
          lastManualReplyError: errorMessage
        };
      } else if (job.followUpId && failedLead) {
        state.leads[leadIndex] = {
          ...failedLead,
          updatedAt: Date.now(),
          followUps: (failedLead.followUps || []).map((item) => item.id === job.followUpId ? { ...item, status: 'failed', error: errorMessage, failedAt: new Date().toISOString() } : item)
        };
      }
      summary.errors = summary.errors || [];
      summary.errors.push(`Send queue failed for ${failedLead?.customer || job.leadId}: ${errorMessage}`);
    }
  }
  return processed;
}

function makeFollowUpText(lead, stage) {
  const customerName = lead.result?.customer?.name || 'Sir/Madam';
  const product = lead.result?.requirements?.products?.[0]?.name || lead.result?.quotationDraft?.items?.[0]?.product || 'your project';
  if (stage === 'day7') {
    return `Dear ${customerName},

I hope you are doing well.

I am following up again regarding ${product}. If the project is still active, we would be happy to support the sample and quotation confirmation.

Please let us know whether the price, lead time, or sample arrangement needs any adjustment. If your purchasing schedule has changed, we can also update the quotation accordingly.

Best regards,
Sales Team`;
  }

  return `Dear ${customerName},

I hope you are doing well.

I just wanted to follow up on our quotation for ${product}. Please let us know if you have any questions about the price, sample cost, lead time, packaging, or certification documents.

We will be happy to support the next step when you are ready.

Best regards,
Sales Team`;
}

export function makeTakeoverSuggestion(lead) {
  const customerName = lead.result?.customer?.name || 'Sir/Madam';
  const product = lead.result?.requirements?.products?.[0]?.name || lead.result?.quotationDraft?.items?.[0]?.product || 'your project';
  const quantity = lead.result?.requirements?.quantity;
  const quantityLine = quantity ? `We understand the original requirement was around ${quantity}.` : 'We understand the project details may still be under internal review.';
  return `Dear ${customerName},

I hope you are doing well.

I wanted to check whether ${product} is still an active project on your side. ${quantityLine}

If the timing, quantity, target price, or packaging plan has changed, please feel free to let us know. We can update the quotation or prepare a revised sample plan based on your current schedule.

If this project is on hold, no problem. I will close the follow-up on our side for now and remain available when you need support again.

Best regards,
Sales Team`;
}

export function createFollowUps(sentAt = new Date().toISOString()) {
  const base = new Date(sentAt).getTime();
  return [
    {
      id: crypto.randomUUID(),
      stage: 'day3',
      label: '第 3 天跟进',
      dueAt: new Date(base + 3 * FOLLOW_UP_DAY_MS).toISOString(),
      status: 'pending'
    },
    {
      id: crypto.randomUUID(),
      stage: 'day7',
      label: '第 7 天跟进',
      dueAt: new Date(base + 7 * FOLLOW_UP_DAY_MS).toISOString(),
      status: 'pending'
    }
  ];
}

export function attachFollowUps(lead, autoReply) {
  if (autoReply.status !== 'sent') return lead;
  return {
    ...lead,
    followUps: lead.followUps?.length ? lead.followUps : createFollowUps(autoReply.sentAt)
  };
}

function buildLead({ mail, inquiry, result, productsSnapshot, autoReply }) {
  const quality = result?.leadQuality?.type || 'unknown';
  const now = new Date();
  return attachFollowUps({
    id: crypto.randomUUID(),
    createdAt: now.toLocaleString('zh-CN'),
    createdAtIso: now.toISOString(),
    updatedAt: Date.now(),
    source: '邮箱自动',
    status: statusForMailLead(result, autoReply),
    customer: result?.customer?.company || result?.customer?.name || mail.from || '未知客户',
    country: result?.customer?.country || '',
    contact: result?.customer?.contact || mail.from || '',
    intent: result?.intent || '',
    priority: result?.priority || 'medium',
    quality,
    subject: mail.subject || result?.emailSubject || '',
    notes: result?.internalNotes || '',
    inquiry,
    result,
    productsSnapshot,
    mail: {
      from: mail.from,
      fromAddress: mail.fromAddress,
      to: mail.to,
      subject: mail.subject,
      date: mail.date,
      messageId: mail.messageId,
      replyTo: mail.replyTo,
      accountId: mail.accountId,
      accountLabel: mail.accountLabel,
      embeddedFromEmail: mail.embeddedFromEmail,
      embeddedCompany: mail.embeddedCompany,
      autoReply,
      sentLog: autoReply.status === 'sent' ? [autoReply] : []
    },
    timeline: [
      timelineEvent('inbound', {
        subject: mail.subject,
        from: mail.from,
        preview: (mail.text || '').slice(0, 500)
      }),
      ...(autoReply.status === 'sent'
        ? [timelineEvent('outbound', { subject: result.emailSubject || `Re: ${mail.subject || 'Inquiry'}`, to: autoReply.to, mode: autoReply.mode, stage: autoReply.stage })]
        : [])
    ]
  }, autoReply);
}

function todayStats(leads) {
  const today = new Date().toISOString().slice(0, 10);
  const todaysLeads = leads.filter((lead) => String(lead.createdAtIso || '').startsWith(today));
  const now = Date.now();
  return {
    receivedToday: todaysLeads.length,
    autoRepliedToday: todaysLeads.filter((lead) => lead.mail?.autoReply?.status === 'sent').length,
    manualReviewToday: todaysLeads.filter((lead) => lead.status === '待人工核查' || lead.status === '人工核查' || lead.status === '二次风险升级').length,
    silentLeads: leads.filter((lead) => lead.status === '已沉默').length,
    riskEscalations: leads.filter((lead) => lead.status === '二次风险升级').length,
    dueFollowUps: leads.reduce((sum, lead) => sum + (lead.followUps || []).filter((item) => item.status === 'pending' && new Date(item.dueAt).getTime() <= now).length, 0)
  };
}

function sortLeadsByActivity(leads = []) {
  return [...leads].sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
}

function mergeLeadIntoPrimary(primary, duplicate) {
  const duplicateReplies = [
    {
      from: duplicate.mail?.from || duplicate.contact || '',
      subject: duplicate.mail?.subject || duplicate.subject || '',
      date: duplicate.mail?.date || duplicate.createdAtIso || '',
      messageId: duplicate.mail?.messageId || duplicate.id,
      preview: (duplicate.inquiry || duplicate.notes || '').slice(0, 800),
      mergedFromLeadId: duplicate.id
    },
    ...(duplicate.customerReplies || [])
  ];
  return {
    ...primary,
    status: primary.status === '二次风险升级' || duplicate.status === '二次风险升级' ? '二次风险升级' : '客户已回复',
    updatedAt: Math.max(Number(primary.updatedAt || 0), Number(duplicate.updatedAt || 0), Date.now()),
    customerReplies: [...duplicateReplies, ...(primary.customerReplies || [])],
    mergedLeadIds: Array.from(new Set([...(primary.mergedLeadIds || []), duplicate.id, ...(duplicate.mergedLeadIds || [])])),
    followUps: primary.followUps?.length ? primary.followUps : duplicate.followUps,
    timeline: [
      timelineEvent('merged-thread', { subject: duplicate.subject || duplicate.mail?.subject || '', from: duplicate.mail?.from || duplicate.contact || '' }),
      ...(duplicate.timeline || []),
      ...(primary.timeline || [])
    ]
  };
}

export function consolidateCustomerThreads(state) {
  const leads = sortLeadsByActivity(state.leads || []);
  const kept = [];
  let changed = false;
  for (const lead of leads) {
    const current = leadIdentity(lead);
    const index = kept.findIndex((existing) => {
      const identity = leadIdentity(existing);
      const sameEmail = current.email && identity.email && current.email === identity.email;
      const sameCompany = current.company && identity.company && current.company === identity.company;
      const sameProject = subjectOverlap(current.subject, identity.subject);
      return sameEmail || (sameCompany && (sameProject || sameCompany));
    });
    if (index >= 0) {
      kept[index] = mergeLeadIntoPrimary(kept[index], lead);
      changed = true;
    } else {
      kept.push(lead);
    }
  }
  if (changed) state.leads = kept;
  return changed;
}

export function ensureThreadReplyStatuses(state) {
  let changed = false;
  state.leads = (state.leads || []).map((lead) => {
    if (!(lead.customerReplies || []).length || ['二次风险升级', '已成交', '已丢单'].includes(lead.status)) {
      return lead;
    }
    const latestReply = (lead.customerReplies || [])[0] || null;
    const latestReplyAt = new Date(latestReply?.date || '').getTime();
    const latestSentAt = latestSentTimeForLead(lead);
    const latestReplyHandled = hasSentReplyForCustomerMessage(lead, latestReply);
    const hasUnansweredReply = latestReply && !latestReplyHandled && (
      customerReplySendKey(latestReply) || (Number.isFinite(latestReplyAt) && latestReplyAt > latestSentAt)
    );
    const desiredStatus = hasUnansweredReply ? '客户已回复' : '待跟进';
    if (lead.status !== desiredStatus) {
      changed = true;
      return { ...lead, status: desiredStatus };
    }
    return lead;
  });
  return changed;
}

function ensureFollowUpsForSentLeads(state) {
  let changed = false;
  state.leads = (state.leads || []).map((lead) => {
    if (lead.mail?.autoReply?.status === 'sent' && !(lead.followUps || []).length) {
      changed = true;
      return attachFollowUps(lead, lead.mail.autoReply);
    }
    return lead;
  });
  return changed;
}

function ensureMailSubjectsFromInquiry(state) {
  let changed = false;
  state.leads = (state.leads || []).map((lead) => {
    if (lead.mail && (!lead.mail.subject || /^from\s*:/i.test(lead.mail.subject))) {
      const embeddedSubject = extractEmbeddedHeader(lead.inquiry || '', 'Subject');
      if (embeddedSubject) {
        changed = true;
        return {
          ...lead,
          mail: {
            ...lead.mail,
            subject: embeddedSubject,
            embeddedSubject
          }
        };
      }
    }
    return lead;
  });
  return changed;
}

export function markSilentLeads(state) {
  let changedCount = 0;
  state.leads = (state.leads || []).map((lead) => {
    if (lead.status === '已沉默' || lead.status === '客户已回复' || lead.status === '二次风险升级' || lead.status === '待人工核查' || lead.status === '人工核查' || lead.status === '发送失败') {
      return lead;
    }
    if (lead.mail?.autoReply?.status !== 'sent' || (lead.customerReplies || []).length) return lead;

    const day7 = (lead.followUps || []).find((item) => item.stage === 'day7');
    if (!day7 || day7.status !== 'sent') return lead;

    changedCount += 1;
    return {
      ...lead,
      status: '已沉默',
      silentAt: lead.silentAt || new Date().toISOString(),
      takeoverSuggestion: lead.takeoverSuggestion || makeTakeoverSuggestion(lead),
      updatedAt: Date.now(),
      timeline: [
        timelineEvent('silent', { subject: lead.subject || lead.mail?.subject || 'No customer reply after scheduled follow-ups' }),
        ...(lead.timeline || [])
      ]
    };
  });
  return changedCount;
}

export async function getMailStatus() {
  const accounts = getMailAccounts();
  const primary = accounts[0] || getMailConfig();
  const state = await loadMailState();
  const followUpsChanged = ensureFollowUpsForSentLeads(state);
  const subjectsChanged = ensureMailSubjectsFromInquiry(state);
  const threadsChanged = consolidateCustomerThreads(state);
  const replyStatusesChanged = ensureThreadReplyStatuses(state);
  const manualReplyStateChanged = normalizeManualReplyAutoReplyState(state);
  const silentMarked = markSilentLeads(state);
  const noisePurged = purgeNonBusinessNoiseLeads(state);
  const changed = followUpsChanged || subjectsChanged || threadsChanged || replyStatusesChanged || manualReplyStateChanged || silentMarked > 0 || noisePurged > 0;
  if (changed) {
    await saveMailState(state);
  }
  return {
    configured: {
      imap: accounts.some((account) => isImapConfigured(account)),
      smtp: accounts.some((account) => isSmtpConfigured(account))
    },
    user: primary.imap.user || '',
    pollIntervalSeconds: primary.pollIntervalSeconds,
    lookbackDays: primary.lookbackDays,
    accounts: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      user: account.imap.user || '',
      configured: {
        imap: isImapConfigured(account),
        smtp: isSmtpConfigured(account)
      },
      lookbackDays: account.lookbackDays,
      fetchLimit: account.fetchLimit,
      processLimit: account.processLimit
    })),
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    stats: todayStats(state.leads || []),
    syncLogs: (state.syncLogs || []).slice(0, 20),
    mailQueue: (state.mailQueue || []).slice(0, 80),
    sendQueue: (state.sendQueue || []).slice(0, 80),
    leads: sortLeadsByActivity(state.leads || [])
  };
}

export async function sendLeadReply(leadId, options = {}) {
  const state = await loadMailState();
  const leadIndex = (state.leads || []).findIndex((lead) => lead.id === leadId);
  if (leadIndex < 0) {
    const error = new Error('Lead not found.');
    error.status = 404;
    throw error;
  }

  const lead = state.leads[leadIndex];
  if (!lead.mail) {
    const error = new Error('This lead does not have original mail metadata.');
    error.status = 400;
    throw error;
  }
  const latestCustomerReply = (lead.customerReplies || [])[0] || null;
  const latestReplyTime = new Date(latestCustomerReply?.date || '').getTime();
  const latestReplyAt = Number.isFinite(latestReplyTime) ? latestReplyTime : 0;
  const latestSentAt = latestSentTimeForLead(lead);
  const alreadySent = lead.mail?.autoReply?.status === 'sent' || (lead.mail?.sentLog || []).some((item) => item.status === 'sent');
  const latestReplyAlreadyHandled = hasSentReplyForCustomerMessage(lead, latestCustomerReply);
  const canSendCustomerReply = alreadySent && latestCustomerReply && !latestReplyAlreadyHandled && (
    customerReplySendKey(latestCustomerReply) || latestReplyAt > latestSentAt
  );
  if (alreadySent && !canSendCustomerReply) {
    const error = new Error(latestReplyAlreadyHandled
      ? 'This customer reply has already been answered. Wait for the next customer reply before sending again.'
      : 'This lead already has a sent reply. Duplicate sending is blocked until a new customer reply arrives.');
    error.status = 409;
    error.lead = lead;
    throw error;
  }

  const decision = options.force ? { allowed: true, blockers: [] } : explainAutoReplyDecision(lead.result);
  if (!decision.allowed) {
    const error = new Error(`Reply is blocked: ${decision.blockers.join('; ')}`);
    error.status = 400;
    error.blockers = decision.blockers;
    throw error;
  }

  if (options.attachQuotationPdf && !(lead.result?.quotationDraft?.items || []).length) {
    const error = new Error('Quotation PDF is empty. Please add quotation items or complete buyer verification before sending a detailed quote.');
    error.status = 400;
    error.lead = lead;
    throw error;
  }

  const mail = {
    ...lead.mail,
    fromAddress: lead.mail.fromAddress || extractFirstEmail(lead.mail.from),
    replyTo: lead.mail.replyTo || '',
    text: ''
  };
  const account = getMailAccounts().find((item) => item.id === lead.mail.accountId) || getMailConfig();
  const stage = canSendCustomerReply ? 'manual-reply' : 'initial';
  const mode = canSendCustomerReply ? 'manual-reply' : (options.force ? 'manual-confirmed' : 'manual-resend');
  const replyId = canSendCustomerReply ? customerReplySendKey(latestCustomerReply) : '';
  const resultForSend = {
    ...lead.result,
    emailSubject: options.subject || lead.result?.emailSubject,
    emailReply: options.body || lead.result?.emailReply
  };
  const queuedReply = makeQueuedReply(mail, resultForSend, account, {
    mode,
    stage,
    attachQuotationPdf: Boolean(options.attachQuotationPdf),
    subject: resultForSend.emailSubject
  });
  const queuedLead = {
    ...lead,
    status: '待发送',
    updatedAt: Date.now(),
    result: resultForSend,
    mail: {
      ...lead.mail,
      fromAddress: mail.fromAddress,
      autoReply: stage === 'manual-reply' ? lead.mail.autoReply : queuedReply
    }
  };
  state.leads[leadIndex] = queuedLead;
  const sendJob = enqueueLeadSend(state, queuedLead, {
    accountId: account.id,
    accountLabel: account.label,
    mode: queuedReply.mode,
    stage: queuedReply.stage,
    replyId,
    to: queuedReply.to,
    subject: queuedReply.subject,
    body: resultForSend.emailReply,
    attachQuotationPdf: Boolean(options.attachQuotationPdf)
  });
  const summary = { autoReplied: 0, followUpsSent: 0, silentMarked: 0, errors: [] };
  await processSendQueue(state, summary, { limit: 1 });
  await saveMailState(state);

  const updatedLead = (state.leads || []).find((item) => item.id === leadId) || queuedLead;
  const updatedJob = (state.sendQueue || []).find((job) => job.id === sendJob.id);
  if (updatedJob?.status !== 'sent') {
    const error = new Error(updatedJob?.lastError || updatedLead.mail?.autoReply?.reason || summary.errors[0] || 'SMTP did not accept the message.');
    error.status = 502;
    error.lead = updatedLead;
    throw error;
  }

  return {
    lead: updatedLead,
    status: await getMailStatus()
  };
}

export async function deleteMailLead(leadId) {
  const state = await loadMailState();
  const leads = state.leads || [];
  const lead = leads.find((item) => item.id === leadId);
  if (!lead) {
    const error = new Error('Lead not found.');
    error.status = 404;
    throw error;
  }

  const processed = new Set(state.processedMessageIds || []);
  const accountId = lead.mail?.accountId || 'default';
  const messageIds = [
    lead.mail?.messageId,
    ...(lead.customerReplies || []).map((reply) => reply.messageId)
  ].filter(Boolean);

  for (const messageId of messageIds) {
    processed.add(messageId);
    processed.add(`${accountId}:${messageId}`);
  }

  const mergedIds = new Set(lead.mergedLeadIds || []);
  state.leads = leads.filter((item) => item.id !== leadId && !mergedIds.has(item.id));
  state.processedMessageIds = [...processed].slice(-1500);
  await saveMailState(state);
  return {
    ok: true,
    deletedId: leadId,
    status: await getMailStatus()
  };
}

export async function updateMailLeadStatus(leadId, status) {
  const state = await loadMailState();
  const leadIndex = (state.leads || []).findIndex((lead) => lead.id === leadId);
  if (leadIndex < 0) {
    const error = new Error('Lead not found.');
    error.status = 404;
    throw error;
  }

  const allowed = new Set(['待处理', '待发送', '已自动回复', '待跟进', '客户已回复', '风险核查', '二次风险升级', '待人工核查', '发送失败', '已沉默', '已成交', '已丢单']);
  if (!allowed.has(status)) {
    const error = new Error('Invalid lead status.');
    error.status = 400;
    throw error;
  }

  state.leads[leadIndex] = {
    ...state.leads[leadIndex],
    status,
    updatedAt: Date.now(),
    closedAt: status === '已成交' || status === '已丢单' ? new Date().toISOString() : state.leads[leadIndex].closedAt
  };
  await saveMailState(state);
  return {
    lead: state.leads[leadIndex],
    status: await getMailStatus()
  };
}

export async function getLeadQuotationPdf(leadId) {
  const state = await loadMailState();
  const lead = (state.leads || []).find((item) => item.id === leadId);
  if (!lead) {
    const error = new Error('Lead not found.');
    error.status = 404;
    throw error;
  }
  return {
    filename: `${safeAttachmentName(lead.customer || lead.contact || 'quotation')}.pdf`,
    buffer: createQuotationPdfBuffer({
      lead,
      result: lead.result,
      companyProfile: state.context?.companyProfile || ''
    })
  };
}

export async function reprocessMailQueueItem(queueId, { analyzeInquiry, forceNew = false } = {}) {
  const state = await loadMailState();
  const queue = state.mailQueue || [];
  const item = queue.find((entry) => entry.id === queueId || entry.messageKey === queueId || entry.messageId === queueId);
  if (!item) {
    const error = new Error('Queue item not found.');
    error.status = 404;
    throw error;
  }
  if (!item.rawText && !item.preview) {
    const error = new Error('This queue item does not have enough raw email content to reprocess. Please wait for the next sync or paste the email manually.');
    error.status = 400;
    throw error;
  }

  const context = state.context || {};
  const mail = mailFromQueueItem(item);
  const inquiry = buildInquiryFromMail(mail);
  let result;
  let analysisFailed = false;
  try {
    result = await analyzeInquiry({
      inquiry,
      products: context.products || [],
      companyProfile: context.companyProfile || ''
    });
  } catch (error) {
    analysisFailed = true;
    result = fallbackAnalysisResult(mail, error);
  }

  const decision = explainAutoReplyDecision(result);
  const autoReply = {
    status: 'skipped',
    reason: forceNew
      ? 'Manual queue reprocess; automatic sending is disabled for safety.'
      : decision.blockers.join('; ') || 'Manual queue reprocess; automatic sending is disabled for safety.'
  };
  const lead = buildLead({
    mail,
    inquiry,
    result,
    productsSnapshot: context.products || [],
    autoReply
  });

  state.leads = [lead, ...(state.leads || [])].slice(0, 500);
  if (item.messageKey) {
    state.processedMessageIds = [item.messageKey, ...(state.processedMessageIds || [])].slice(0, 1500);
  }
  upsertMailQueueItem(state, {
    ...item,
    status: analysisFailed ? '待人工核查' : '已入库',
    reason: forceNew ? `已手动创建新线索：${lead.customer}` : `已重新分析并入库：${lead.customer}`,
    leadId: lead.id
  });
  await saveMailState(state);
  return {
    ok: true,
    lead,
    status: await getMailStatus()
  };
}

function findThreadLeadIndex(state, mail) {
  const identity = mailIdentity(mail);
  const sender = identity.email || normalizeEmail(mail.fromAddress || mail.from);
  const rawSubject = mail.subject || mail.embeddedSubject || extractEmbeddedHeader(mail.text, 'Subject');
  const subject = normalizeSubject(rawSubject);
  const messageId = normalizeMessageId(mail.messageId || '', '');
  if (!sender && !subject && !messageId) return -1;

  return (state.leads || []).findIndex((lead) => {
    const current = leadIdentity(lead);
    const leadEmail = current.email;
    const leadSubject = normalizeSubject(current.subject);
    const sentIds = [lead.mail?.messageId, ...(lead.mail?.sentLog || []).map((item) => item.messageId)].filter(Boolean).map((item) => normalizeMessageId(item, ''));
    const sameEmail = sender && leadEmail && sender === leadEmail;
    const sameCompany = identity.company && current.company && identity.company === current.company;
    const sameProject = subject && leadSubject && subjectOverlap(subject, leadSubject);
    return (
      (messageId && sentIds.includes(messageId)) ||
      sameEmail ||
      (sameCompany && (isReplyLikeSubject(rawSubject) || sameProject || !leadSubject))
    );
  });
}

export function followUpRiskReview(mail, products = []) {
  const risks = findRiskSignals(buildInquiryFromMail(mail), products);
  const highRisks = risks.filter((risk) => risk.severity === 'critical' || risk.severity === 'high');
  const mediumRisks = risks.filter((risk) => risk.severity === 'medium');
  return {
    risks,
    blocked: highRisks.length > 0,
    status: highRisks.length ? '二次风险升级' : '客户已回复',
    note: highRisks.length
      ? `后续邮件触发高风险：${highRisks.map((risk) => risk.text).join('；')}`
      : mediumRisks.length
        ? `后续邮件有待核查信号：${mediumRisks.map((risk) => risk.text).join('；')}`
        : '后续邮件未发现新增高风险。'
  };
}

export function appendCustomerReply(state, mail, options = {}) {
  const index = findThreadLeadIndex(state, mail);
  if (index < 0) return false;
  const lead = state.leads[index];
  if (lead.mail?.messageId === mail.messageId) return false;

  const lastSentAt = lead.mail?.sentLog?.[0]?.sentAt || lead.mail?.autoReply?.sentAt;
  if (lastSentAt && mail.date && new Date(mail.date).getTime() <= new Date(lastSentAt).getTime()) return false;
  const riskReview = followUpRiskReview(mail, options.products || []);

  const updatedLead = {
    ...lead,
    status: riskReview.status,
    updatedAt: Date.now(),
    followUpRisk: riskReview,
    customerReplies: [
      {
        from: mail.from,
        subject: mail.subject,
        date: mail.date,
        messageId: mail.messageId,
        preview: (mail.text || '').slice(0, 800),
        riskReview
      },
      ...(lead.customerReplies || [])
    ],
    followUps: (lead.followUps || []).map((item) => item.status === 'pending' ? { ...item, status: 'paused', pausedAt: new Date().toISOString(), reason: '客户已回信' } : item),
    timeline: [
      timelineEvent(riskReview.blocked ? 'risk-escalation' : 'inbound-reply', {
        subject: mail.subject,
        from: mail.from,
        preview: (mail.text || '').slice(0, 500),
        note: riskReview.note
      }),
      ...(lead.timeline || [])
    ]
  };
  state.leads = [updatedLead, ...state.leads.filter((_, leadIndex) => leadIndex !== index)];
  return true;
}

async function processDueFollowUps(state, summary, config = getMailConfig()) {
  const now = Date.now();
  for (let index = 0; index < (state.leads || []).length; index += 1) {
    let lead = state.leads[index];
    if (lead.status === '客户已回复' || lead.status === '二次风险升级' || lead.status === '待人工核查' || lead.status === '人工核查') continue;
    if (lead.mail?.autoReply?.status !== 'sent') continue;
    if ((lead.mail?.accountId || 'default') !== (config.id || 'default')) continue;

    const pending = (lead.followUps || []).find((item) => item.status === 'pending' && new Date(item.dueAt).getTime() <= now);
    if (!pending) continue;

    enqueueLeadSend(state, lead, {
      accountId: config.id,
      accountLabel: config.label,
      mode: 'auto-follow-up',
      stage: pending.stage,
      followUpId: pending.id,
      to: lead.mail?.replyTo || lead.mail?.fromAddress || extractFirstEmail(lead.mail?.from),
      subject: `Re: ${lead.subject || lead.result?.emailSubject || 'Quotation follow-up'}`
    });
    summary.sendQueued = (summary.sendQueued || 0) + 1;
    lead = {
      ...lead,
      updatedAt: Date.now(),
      followUps: (lead.followUps || []).map((item) => item.id === pending.id ? { ...item, status: 'queued', queuedAt: new Date().toISOString() } : item)
    };
    state.leads[index] = lead;
  }
}

export async function testMailConnection() {
  const accounts = getMailAccounts();
  const results = [];
  for (const config of accounts) {
    const result = {
      id: config.id,
      label: config.label,
      user: config.imap.user || '',
      imap: { ok: false, message: '' },
      smtp: { ok: false, message: '' }
    };

    if (!isImapConfigured(config)) {
      result.imap.message = 'IMAP is not configured.';
    } else {
      const client = createImapClient(config);
      try {
        await withMailTimeout(client.connect(), `${connectionLabel(config, 'imap')} login`);
        await client.logout();
        result.imap = { ok: true, message: 'IMAP login succeeded.' };
      } catch (error) {
        result.imap.message = describeNetworkError(error, connectionLabel(config, 'imap'));
      }
    }

    if (!isSmtpConfigured(config)) {
      result.smtp.message = 'SMTP is not configured.';
    } else {
      try {
        await withMailTimeout(createTransport(config).verify(), `${connectionLabel(config, 'smtp')} login`);
        result.smtp = { ok: true, message: 'SMTP login succeeded.' };
      } catch (error) {
        result.smtp.message = describeNetworkError(error, connectionLabel(config, 'smtp'));
      }
    }

    results.push(result);
  }
  return {
    accounts: results,
    imap: results[0]?.imap || { ok: false, message: 'No mail account configured.' },
    smtp: results[0]?.smtp || { ok: false, message: 'No mail account configured.' }
  };
}

async function syncSingleMailbox(config, { analyzeInquiry, products, companyProfile, limit } = {}) {
  if (!isImapConfigured(config)) {
    const error = new Error(`IMAP is not configured for ${config.label || config.id}.`);
    error.status = 400;
    throw error;
  }

  await updateMailContext({ products, companyProfile });
  let state = await loadMailState();
  ensureFollowUpsForSentLeads(state);
  const context = state.context || {};
  const client = createImapClient(config);
  const summary = {
    accountId: config.id,
    accountLabel: config.label,
    imap: { ok: false, message: '' },
    checked: 0,
    imported: 0,
    skippedDuplicates: 0,
    skippedNoise: 0,
    autoReplied: 0,
    sendQueued: 0,
    sendProcessed: 0,
    followUpsSent: 0,
    silentMarked: 0,
    threadReplies: 0,
    manualReview: 0,
    skippedNoise: 0,
    errors: []
  };
  const syncStartedAt = Date.now();

  try {
    await withMailTimeout(client.connect(), `${config.label || config.id} IMAP login`);
    const lock = await client.getMailboxLock('INBOX');
    try {
      const cutoff = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000);
      const fetchLimit = Number(limit || config.fetchLimit || process.env.MAIL_FETCH_LIMIT || 100);
      const processLimit = Number(config.processLimit || process.env.MAIL_PROCESS_LIMIT || 3);
      const recentIds = await client.search({ since: cutoff });
      const unseenIds = await client.search({ seen: false });
      const unseenSet = new Set(unseenIds);
      const ids = [...new Set([...recentIds, ...unseenIds])]
        .sort((a, b) => Number(a) - Number(b))
        .slice(-fetchLimit);
      const idsToFetch = [...ids].reverse();
      let processedThisRun = 0;
      summary.checked = ids.length;
      if (!ids.length) {
        await processDueFollowUps(state, summary, config);
        summary.sendProcessed += await processSendQueue(state, summary, { limit: DEFAULT_MAIL_SEND_PROCESS_LIMIT });
        summary.silentMarked += markSilentLeads(state);
        state.lastSyncAt = new Date().toISOString();
        state.lastError = '';
        pushSyncLog(state, {
          accountId: config.id,
          accountLabel: config.label,
          checked: 0,
          imported: 0,
          skippedDuplicates: 0,
          skippedNoise: summary.skippedNoise,
          threadReplies: 0,
          autoReplied: summary.autoReplied,
          sendQueued: summary.sendQueued,
          sendProcessed: summary.sendProcessed,
          followUpsSent: summary.followUpsSent,
          silentMarked: summary.silentMarked,
          manualReview: 0,
          errors: summary.errors,
          durationMs: Date.now() - syncStartedAt
        });
        await saveMailState(state);
        return {
          ...summary,
          status: await getMailStatus()
        };
      }

      for await (const message of client.fetch(idsToFetch, { uid: true, flags: true, envelope: true, source: true })) {
        try {
          const parsed = await simpleParser(message.source);
          const rawMessageKey = normalizeMessageId(parsed.messageId || message.envelope?.messageId, message.uid);
          const messageKey = `${config.id}:${rawMessageKey}`;
          const queueBase = {
            messageKey,
            messageId: parsed.messageId || message.envelope?.messageId || '',
            uid: message.uid,
            accountId: config.id,
            accountLabel: config.label,
            from: formatAddressList(parsed.from),
            fromAddress: firstAddress(parsed.from),
            to: formatAddressList(parsed.to),
            replyTo: firstAddress(parsed.replyTo),
            subject: parsed.subject || message.envelope?.subject || '',
            date: parsed.date?.toISOString?.() || ''
          };
          if (state.processedMessageIds.includes(messageKey) || state.processedMessageIds.includes(rawMessageKey)) {
            summary.skippedDuplicates += 1;
            upsertMailQueueItem(state, {
              ...queueBase,
              status: '已跳过',
              reason: '重复邮件，已处理过'
            });
            continue;
          }
          const isUnread = Array.from(message.flags || []).includes('\\Seen') ? false : unseenSet.has(message.uid);
          const text = parsed.text?.trim() || htmlToText(parsed.html || '');
          const embeddedSubject = extractEmbeddedHeader(text, 'Subject');
          queueBase.preview = text.slice(0, 1000);
          queueBase.rawText = text.slice(0, 6000);
          queueBase.embeddedSubject = embeddedSubject;

          const mail = {
            from: formatAddressList(parsed.from),
            fromAddress: firstAddress(parsed.from),
            to: formatAddressList(parsed.to),
            replyTo: firstAddress(parsed.replyTo),
            subject: parsed.subject || message.envelope?.subject || embeddedSubject || '',
            embeddedSubject,
            accountId: config.id,
            accountLabel: config.label,
            date: parsed.date?.toISOString?.() || '',
            messageId: parsed.messageId || message.envelope?.messageId || '',
            text,
            isUnread
          };
          if (isNonBusinessNoiseMail(mail)) {
            state.processedMessageIds = [messageKey, ...(state.processedMessageIds || [])].slice(0, 1000);
            summary.skippedNoise += 1;
            processedThisRun += 1;
            continue;
          }
          const appendedToThread = appendCustomerReply(state, mail, { products: context.products || [] });
          if (appendedToThread) {
            state.processedMessageIds = [messageKey, ...(state.processedMessageIds || [])].slice(0, 1000);
            summary.threadReplies = (summary.threadReplies || 0) + 1;
            processedThisRun += 1;
            upsertMailQueueItem(state, {
              ...queueBase,
              from: mail.from,
              subject: mail.subject,
              status: '已合并',
              reason: '同客户后续邮件，已合并进客户详情'
            });
            continue;
          }
          if (processedThisRun >= processLimit) {
            upsertMailQueueItem(state, {
              ...queueBase,
              from: mail.from,
              subject: mail.subject,
              status: '待分析',
              reason: `本轮处理额度已满，每轮最多 ${processLimit} 封`
            });
            continue;
          }
          upsertMailQueueItem(state, {
            ...queueBase,
            from: mail.from,
            subject: mail.subject,
            status: '分析中',
            reason: '正在调用 AI 分析'
          });
          const inquiry = buildInquiryFromMail(mail);
          let analysisFailed = false;
          let result;
          try {
            result = await analyzeInquiry({
              inquiry,
              products: context.products || [],
              companyProfile: context.companyProfile || ''
            });
          } catch (error) {
            analysisFailed = true;
            result = fallbackAnalysisResult(mail, error);
            summary.errors.push(`AI analysis failed for ${mail.fromAddress || mail.from}: ${error.message}`);
            upsertMailQueueItem(state, {
              ...queueBase,
              from: mail.from,
              subject: mail.subject,
              status: '失败重试',
              reason: `AI 分析失败：${error.message}`
            });
          }
          const decision = explainAutoReplyDecision(result);
          let autoReply = {
            status: 'skipped',
            reason: decision.blockers.join('; ') || 'Risk gate did not allow automatic reply.'
          };
          if (!analysisFailed && decision.allowed) {
            const latestState = await loadMailState();
            const alreadyReplied = (latestState.leads || []).some((existingLead) => {
              const sameMessage = existingLead.mail?.messageId && mail.messageId && existingLead.mail.messageId === mail.messageId;
              const sent = existingLead.mail?.autoReply?.status === 'sent' || (existingLead.mail?.sentLog || []).some((item) => item.status === 'sent');
              return sameMessage && sent;
            });
            autoReply = alreadyReplied
              ? { status: 'skipped', reason: 'Duplicate auto-reply blocked: this message already has a sent reply.' }
              : makeQueuedReply(mail, result, config);
          }
          const lead = buildLead({
            mail,
            inquiry,
            result,
            productsSnapshot: context.products || [],
            autoReply
          });

          state.leads = [lead, ...(state.leads || [])].slice(0, 500);
          state.processedMessageIds = [messageKey, ...(state.processedMessageIds || [])].slice(0, 1000);
          summary.imported += 1;
          if (autoReply.status === 'queued') {
            enqueueLeadSend(state, lead, {
              accountId: config.id,
              accountLabel: config.label,
              mode: autoReply.mode,
              stage: autoReply.stage,
              to: autoReply.to,
              subject: autoReply.subject
            });
            summary.sendQueued += 1;
            summary.sendProcessed += await processSendQueue(state, summary, { limit: DEFAULT_MAIL_SEND_PROCESS_LIMIT });
          }
          if (lead.status === '待人工核查') summary.manualReview += 1;
          upsertMailQueueItem(state, {
            ...queueBase,
            from: mail.from,
            subject: mail.subject,
            status: analysisFailed ? '待人工核查' : '已入库',
            reason: analysisFailed ? 'AI 失败，已作为人工核查线索保存' : `已创建线索：${lead.customer}`,
            leadId: lead.id
          });
          processedThisRun += 1;
        } catch (error) {
          summary.errors.push(describeNetworkError(error, `${config.label || config.id} message processing`));
          upsertMailQueueItem(state, {
            messageKey: `${config.id}:${message.uid}`,
            uid: message.uid,
            accountId: config.id,
            accountLabel: config.label,
            status: '失败重试',
            reason: describeNetworkError(error, `${config.label || config.id} message processing`)
          });
        }
      }
    } finally {
      lock.release();
    }

    await processDueFollowUps(state, summary, config);
    summary.sendProcessed += await processSendQueue(state, summary, { limit: DEFAULT_MAIL_SEND_PROCESS_LIMIT });
    summary.silentMarked += markSilentLeads(state);
    state.lastSyncAt = new Date().toISOString();
    state.lastError = summary.errors[0] || '';
    pushSyncLog(state, {
      accountId: config.id,
      accountLabel: config.label,
      checked: summary.checked,
      imported: summary.imported,
      skippedDuplicates: summary.skippedDuplicates,
      skippedNoise: summary.skippedNoise,
      threadReplies: summary.threadReplies,
      autoReplied: summary.autoReplied,
      sendQueued: summary.sendQueued,
      sendProcessed: summary.sendProcessed,
      manualReview: summary.manualReview,
      errors: summary.errors,
      durationMs: Date.now() - syncStartedAt
    });
    await saveMailState(state);
    return {
      ...summary,
      status: await getMailStatus()
    };
  } catch (error) {
    state = await loadMailState();
    state.lastError = describeNetworkError(error, `${config.label || config.id} IMAP`);
    pushSyncLog(state, {
      accountId: config.id,
      accountLabel: config.label,
      checked: summary.checked,
      imported: summary.imported,
      skippedDuplicates: summary.skippedDuplicates,
      skippedNoise: summary.skippedNoise,
      threadReplies: summary.threadReplies,
      autoReplied: summary.autoReplied,
      sendQueued: summary.sendQueued,
      sendProcessed: summary.sendProcessed,
      manualReview: summary.manualReview,
      errors: [state.lastError],
      durationMs: Date.now() - syncStartedAt
    });
    await saveMailState(state);
    throw error;
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors after connection failures.
    }
  }
}

export async function syncMailbox(options = {}) {
  const releaseSyncLock = await acquireSyncLock();
  try {
  const accounts = getMailAccounts();
  const configuredAccounts = accounts.filter((account) => isImapConfigured(account));
  if (!configuredAccounts.length) {
    const error = new Error('IMAP is not configured.');
    error.status = 400;
    throw error;
  }

  const total = {
    checked: 0,
    imported: 0,
    skippedDuplicates: 0,
    autoReplied: 0,
    sendQueued: 0,
    sendProcessed: 0,
    followUpsSent: 0,
    silentMarked: 0,
    threadReplies: 0,
    manualReview: 0,
    errors: [],
    accountResults: []
  };

  for (const account of configuredAccounts) {
    try {
      const result = await syncSingleMailbox(account, options);
      total.accountResults.push(result);
      for (const key of ['checked', 'imported', 'skippedDuplicates', 'skippedNoise', 'autoReplied', 'sendQueued', 'sendProcessed', 'followUpsSent', 'silentMarked', 'threadReplies', 'manualReview']) {
        total[key] += Number(result[key] || 0);
      }
      total.errors.push(...(result.errors || []));
    } catch (error) {
      total.errors.push(describeNetworkError(error, `${account.label || account.id} IMAP`));
      total.accountResults.push({
        accountId: account.id,
        accountLabel: account.label,
        checked: 0,
        imported: 0,
        skippedDuplicates: 0,
        skippedNoise: 0,
        autoReplied: 0,
        sendQueued: 0,
        sendProcessed: 0,
        followUpsSent: 0,
        silentMarked: 0,
        threadReplies: 0,
        manualReview: 0,
        errors: [describeNetworkError(error, `${account.label || account.id} IMAP`)]
      });
    }
  }

  const state = await loadMailState();
  state.lastError = total.errors[0] || '';
  await saveMailState(state);
  return {
    ...total,
    status: await getMailStatus()
  };
  } finally {
    await releaseSyncLock();
  }
}

export function startMailPolling({ analyzeInquiry }) {
  const accounts = getMailAccounts();
  if (!accounts.some((account) => isImapConfigured(account))) return null;
  const intervalMs = Math.min(...accounts.map((account) => account.pollIntervalSeconds || DEFAULT_MAIL_POLL_INTERVAL_SECONDS)) * 1000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncMailbox({ analyzeInquiry });
    } catch {
      // Mail status stores sync errors; keep the background worker alive.
    } finally {
      running = false;
    }
  };

  setTimeout(run, 3000);
  return setInterval(() => {
    run();
  }, intervalMs);
}
