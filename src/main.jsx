import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  ClipboardList,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Inbox,
  KeyRound,
  Loader2,
  Mail,
  MailCheck,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload
} from 'lucide-react';
import './styles.css';

const STORE_KEY = 'trade-inquiry-ai-state-v2';
const LEGACY_STORE_KEY = 'trade-inquiry-ai-state-v1';
const LEADS_VIEWED_KEY = 'trade-inquiry-ai-viewed-lead-ids';

const sampleProducts = [
  {
    id: crypto.randomUUID(),
    name: 'Stainless Steel Water Bottle 750ml',
    sku: 'WB-750',
    price: 'USD 2.80-3.40 / pc',
    moq: '500 pcs',
    leadTime: '15-25 days',
    notes: '304 stainless steel, custom logo available'
  },
  {
    id: crypto.randomUUID(),
    name: 'Insulated Tumbler 600ml',
    sku: 'TB-600',
    price: 'USD 3.20-4.10 / pc',
    moq: '300 pcs',
    leadTime: '18-28 days',
    notes: 'Double wall vacuum, multiple colors'
  }
];

const initialState = {
  companyProfile: 'We are a China-based manufacturer. We support OEM/ODM, custom logo, sample orders, and bulk production.',
  products: sampleProducts,
  inquiry: `Hello,

We are looking for 1000 pcs insulated bottles for our retail brand in Germany. Please send your best price, MOQ, lead time, logo printing cost and shipping options.

Regards,
Anna`,
  result: null,
  leads: [],
  selectedLeadId: '',
  leadQuery: '',
  leadFilter: 'all'
};

const closedStatuses = ['已成交', '已丢单'];

const emptySettingsDraft = {
  ai: {
    model: 'deepseek-chat',
    apiKey: ''
  },
  mailAccounts: []
};

function newMailAccount() {
  return {
    id: `mail-${crypto.randomUUID().slice(0, 8)}`,
    label: '',
    pollIntervalSeconds: 15,
    imap: { host: '', port: 993, secure: true, user: '', pass: '' },
    smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' }
  };
}

const mailProviderPresets = {
  qq: { label: 'QQ邮箱', imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', imapPort: 993, smtpPort: 465 },
  gmail: { label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', imapPort: 993, smtpPort: 465 },
  tencent: { label: '腾讯企业邮箱', imapHost: 'imap.exmail.qq.com', smtpHost: 'smtp.exmail.qq.com', imapPort: 993, smtpPort: 465 },
  aliyun: { label: '阿里企业邮箱', imapHost: 'imap.qiye.aliyun.com', smtpHost: 'smtp.qiye.aliyun.com', imapPort: 993, smtpPort: 465 },
  netease: { label: '网易邮箱', imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', imapPort: 993, smtpPort: 465 }
};

const statuses = ['待处理', '待发送', '已自动回复', '待跟进', '客户已回复', '风险核查', '二次风险升级', '待人工核查', '发送失败', '已沉默', '已成交', '已丢单'];

const statusLabels = {
  待处理: '待处理',
  待发送: '待发送',
  已报价: '已报价，待客户确认',
  已自动回复: '已自动回复，待客户回复',
  待跟进: '待跟进客户',
  客户已回复: '客户已回复',
  风险核查: '风险核查',
  人工核查: '风险核查',
  待人工核查: '风险核查',
  二次风险升级: '二次风险升级',
  发送失败: '异常处理',
  已沉默: '已沉默',
  已成交: '已成交',
  已丢单: '已丢单'
};

const qualityLabels = {
  qualified: '有效客户',
  low_intent: '低意向',
  competitor: '疑似同行比价',
  scam: '疑似诈骗',
  spam: '垃圾/骚扰',
  unknown: '未判断'
};

const replyModeLabels = {
  full_quote: '正常报价',
  ask_more: '追问关键信息',
  standard_reply: '标准回复',
  ignore: '建议忽略',
  manual_review: '人工核查'
};

function normalizeState(value) {
  return {
    ...initialState,
    ...value,
    products: Array.isArray(value?.products) ? value.products : sampleProducts,
    leads: Array.isArray(value?.leads) ? value.leads : []
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(LEGACY_STORE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : initialState;
  } catch {
    return initialState;
  }
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function getCustomerName(result) {
  return result?.customer?.company || result?.customer?.name || '未知客户';
}

function statusForQuality(type) {
  if (type === 'scam' || type === 'spam' || type === 'low_intent') return '人工核查';
  if (type === 'qualified') return '已报价';
  return '待处理';
}

function buildLead({ inquiry, result, products }) {
  const quality = result?.leadQuality?.type || 'unknown';
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toLocaleString('zh-CN'),
    updatedAt: Date.now(),
    source: '手动粘贴',
    status: statusForQuality(quality),
    customer: getCustomerName(result),
    country: result?.customer?.country || '',
    contact: result?.customer?.contact || '',
    intent: result?.intent || '',
    priority: result?.priority || 'medium',
    quality,
    subject: result?.emailSubject || '',
    notes: result?.internalNotes || '',
    inquiry,
    result,
    productsSnapshot: products
  };
}

function mailLeadKey(lead) {
  return lead?.mail?.messageId || lead?.id;
}

function mergeMailLeads(existingLeads, mailLeads = []) {
  if (!Array.isArray(mailLeads) || !mailLeads.length) return existingLeads;
  const incoming = mailLeads.filter(Boolean);
  const incomingKeys = new Set(incoming.map(mailLeadKey));
  return [...incoming, ...existingLeads.filter((lead) => !incomingKeys.has(mailLeadKey(lead)))];
}

function leadBoardBucket(lead) {
  if (lead.status === '已成交' || lead.status === '已丢单') return 'closed';
  if (lead.status === '已沉默') return 'silent';
  if (lead.status === '二次风险升级' || lead.status === '发送失败' || lead.status === '风险核查' || lead.status === '待人工核查' || lead.status === '人工核查' || ['scam', 'spam', 'low_intent', 'competitor'].includes(lead.quality)) return 'risk';
  if (lead.status === '客户已回复') return 'replied';
  if (lead.status === '已自动回复' || lead.status === '待跟进' || lead.status === '已报价' || (lead.followUps || []).some((item) => item.status === 'pending')) return 'waiting';
  return 'new';
}

function displayStatus(status) {
  return statusLabels[status] || status || '待处理';
}

function formatDateTime(value) {
  if (!value) return '未记录时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN');
}

function latestCustomerReply(lead) {
  return (lead?.customerReplies || [])[0] || null;
}

function latestCustomerText(lead) {
  const reply = latestCustomerReply(lead);
  return [
    reply?.subject,
    reply?.preview,
    lead?.inquiry
  ].filter(Boolean).join('\n\n');
}

function normalizeReplyKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function cleanDisplayText(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const riskReasonTranslations = [
  ['Product requirements are detailed.', '产品需求描述清楚，包含可用于报价的关键信息。'],
  ['New company but clear product specifications and quantity', '对方可能是新客户/新公司，但产品规格和数量清楚，这本身不是风险信号。'],
  ['Professional inquiry with detailed requirements', '询盘表达专业，需求细节较完整。'],
  ['No negative signals found', '未发现明显负面风险信号。'],
  ['First-time overseas sourcing, but not a scam indicator', '首次海外采购本身不是诈骗信号，仍按正常新客户流程核查。'],
  ['No obvious rule-based risk signals.', '规则预检未发现明显风险信号。'],
  ['Detailed inquiry with specific product requirements', '询盘较详细，包含具体产品要求。'],
  ['Company registered in Germany with HRB number', '提供了德国 HRB 商业登记号。'],
  ['Willing to pay for samples and express shipping', '愿意支付样品费和快递费，符合正常采购流程。'],
  ['No upfront fees or third-party portals', '未要求卖方支付前置费用，也未引导第三方门户。'],
  ['Clear payment terms and process', '付款条款和交易流程较清楚。']
];

function normalizeRiskReason(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|and|or|to|from|with|for|of|is|are|by|before|after)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function translateRiskReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return '';
  const normalized = normalizeRiskReason(text);

  for (const [source, translated] of riskReasonTranslations) {
    const sourceNormalized = normalizeRiskReason(source);
    if (normalized === sourceNormalized || normalized.includes(sourceNormalized) || sourceNormalized.includes(normalized)) {
      return translated;
    }
  }

  if (/clear product specifications?.*quantity|quantity.*clear product specifications?/i.test(text)) {
    return '产品规格和数量清楚，可进入正常报价或进一步确认。';
  }
  if (/professional inquiry|detailed requirements|specific product requirements/i.test(text)) {
    return '询盘表达专业，需求细节较完整。';
  }
  if (/no negative signals?|no obvious.*risk signals?/i.test(text)) {
    return '未发现明显负面风险信号。';
  }
  if (/first[-\s]?time.*overseas|first[-\s]?time buyer|first[-\s]?time sourcing/i.test(text)) {
    return '首次接触或首次海外采购不是诈骗信号，按新客户标准流程核查即可。';
  }

  return text;
}

function customerOriginalText(lead) {
  const reply = latestCustomerReply(lead);
  if (reply) {
    return cleanDisplayText([
      reply.subject ? `Subject: ${reply.subject}` : '',
      reply.from ? `From: ${reply.from}` : '',
      reply.date ? `Date: ${formatDateTime(reply.date)}` : '',
      reply.preview || ''
    ].filter(Boolean).join('\n'));
  }
  return cleanDisplayText([
    lead?.mail?.subject ? `Subject: ${lead.mail.subject}` : '',
    lead?.mail?.from ? `From: ${lead.mail.from}` : '',
    lead?.mail?.to ? `To: ${lead.mail.to}` : '',
    lead?.mail?.date ? `Date: ${formatDateTime(lead.mail.date)}` : '',
    lead?.inquiry || ''
  ].filter(Boolean).join('\n'));
}

function isClosedLead(lead) {
  return closedStatuses.includes(lead?.status);
}

function latestSentTime(lead) {
  const values = [
    lead?.mail?.autoReply?.sentAt,
    ...(lead?.mail?.sentLog || []).map((item) => item.sentAt)
  ]
    .map((value) => new Date(value || '').getTime())
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : 0;
}

function hasUnansweredCustomerReply(lead) {
  const reply = latestCustomerReply(lead);
  if (!reply) return false;
  const replyKey = normalizeReplyKey(reply.messageId || reply.date || '');
  const sentLog = lead?.mail?.sentLog || [];
  if (replyKey) {
    const exact = sentLog.some((item) => (
      item.status === 'sent' &&
      item.stage === 'manual-reply' &&
      normalizeReplyKey(item.replyId || '') === replyKey
    ));
    if (exact) return false;
  }
  const replyAt = new Date(reply?.date || '').getTime();
  const legacyHandled = sentLog.some((item) => {
    if (item.status !== 'sent' || item.stage !== 'manual-reply' || item.replyId) return false;
    const sentAt = new Date(item.sentAt || '').getTime();
    return Number.isFinite(replyAt) && Number.isFinite(sentAt) && sentAt >= replyAt;
  });
  if (legacyHandled) return false;
  return Boolean(replyKey) || (Number.isFinite(replyAt) && replyAt > latestSentTime(lead));
}

function buildReplySuggestion(lead) {
  const reply = latestCustomerReply(lead);
  const customerName = lead?.result?.customer?.name || 'Sir/Madam';
  const product = lead?.result?.requirements?.products?.[0]?.name || lead?.result?.quotationDraft?.items?.[0]?.product || 'the project';
  if (lead?.status === '二次风险升级' || lead?.followUpRisk?.blocked) {
    return `Dear ${customerName},

Thank you for your update.

We have received your message and our team is reviewing the details internally. To keep the process secure, we will confirm the next step after our internal verification is complete.

We will get back to you shortly.

Best regards,`;
  }
  if ((lead?.status === '客户已回复' || hasUnansweredCustomerReply(lead)) && reply) {
    const text = `${reply.subject || ''}\n${reply.preview || ''}`.toLowerCase();
    const lines = [];
    if (/price|target|discount|best|quote|quotation|unit price|cost/.test(text)) {
      lines.push(`- Price: we can review the best workable price for ${product} based on the final quantity, logo method, packaging, and shipping term.`);
    }
    if (/sample|prototype|pre-production|pp sample|dhl|express/.test(text)) {
      lines.push('- Sample: we can prepare samples after confirming the logo artwork and sample shipping address. Please confirm whether DHL/UPS/FedEx is preferred.');
    }
    if (/lead time|delivery|ship|shipping|fob|cif|ddp|exw|warehouse|port|freight/.test(text)) {
      lines.push('- Lead time / shipping: please confirm the destination, preferred Incoterm, and whether you need EXW/FOB/CIF/DDP pricing.');
    }
    if (/payment|deposit|balance|t\/t|bank|paypal|credit card|b\/l|bill of lading/.test(text)) {
      lines.push('- Payment: for first cooperation, we suggest standard export terms such as T/T deposit with balance before shipment or against copy of B/L.');
    }
    if (/logo|artwork|print|printing|laser|engraving|silk|screen|color|colour|pantone|ral/.test(text)) {
      lines.push('- Logo / artwork: please send the logo file in AI/EPS/PDF format and confirm logo size, position, and color requirement.');
    }
    if (/cert|certificate|lfgb|reach|fda|ce|test report|compliance/.test(text)) {
      lines.push('- Certificates: please confirm the required market and test standard so we can check the matching documents or testing cost.');
    }
    if (/carton|box|packaging|package|label|barcode|ean|upc/.test(text)) {
      lines.push('- Packaging: please confirm individual box style, barcode/label requirement, and master carton marks.');
    }
    if (/quantity|qty|pcs|pieces|moq|order volume|trial order/.test(text)) {
      lines.push('- Quantity: please confirm the final order quantity and color split so we can calculate the most accurate unit price and production plan.');
    }
    if (!lines.length) {
      lines.push(`- We reviewed your latest message regarding ${product}; please confirm any updated quantity, shipping term, artwork, sample, or payment requirement so we can proceed accurately.`);
    }
    return `Dear ${customerName},\n\nThank you for your reply.\n\nBased on your latest message, please see our comments below:\n\n${lines.join('\n')}\n\nOnce you confirm the above details, we will update the quotation and next-step arrangement accordingly.\n\nBest regards,\nSales Team`;
  }
  if (lead?.status === '已沉默') return lead.takeoverSuggestion || '';
  return lead?.result?.emailReply || '';
}

function nextActionForLead(lead) {
  if (!lead) return { title: '选择一条线索', detail: '从历史库选择客户后查看下一步动作。', tone: 'neutral' };
  if (lead.status === '二次风险升级' || lead.followUpRisk?.blocked) {
    return { title: '暂停自动动作', detail: lead.followUpRisk?.note || '后续邮件出现高风险信号，先人工核验身份和链接。', tone: 'danger' };
  }
  if (['待人工核查', '人工核查', '风险核查', '发送失败'].includes(lead.status) || ['scam', 'spam', 'low_intent', 'competitor'].includes(lead.quality)) {
    return { title: '人工核查', detail: '先核验公司、邮箱域名、付款/门户/货代风险，再决定是否回复。', tone: 'warn' };
  }
  if (lead.status === '客户已回复') {
    return { title: '人工接管回复', detail: '客户已经回信，暂停自动跟进，建议阅读最新回复后发送人工确认邮件。', tone: 'good' };
  }
  if (lead.status === '已沉默') {
    return { title: '唤醒或关闭', detail: '已完成自动跟进但客户未回，可复制唤醒话术，或标记为已丢单。', tone: 'warn' };
  }
  if (lead.status === '已成交' || lead.status === '已丢单') {
    return { title: '已结束', detail: '该线索已关闭，可作为历史记录保留。', tone: 'neutral' };
  }
  if (lead.mail?.autoReply?.status === 'sent' || (lead.followUps || []).some((item) => item.status === 'pending')) {
    return { title: '等待客户回应', detail: '系统已回复或安排跟进，客户回信后会自动切到客户已回复。', tone: 'neutral' };
  }
  return { title: '处理新询盘', detail: '检查需求、报价、风险与缺失信息，决定回复或人工核查。', tone: 'good' };
}

function conversationItems(lead) {
  if (!lead) return [];
  const items = [];
  if (lead.mail) {
    items.push({
      id: `inbound-${lead.mail.messageId || lead.id}`,
      direction: 'in',
      title: lead.mail.subject || lead.subject || '原始询盘',
      at: lead.mail.date || lead.createdAtIso,
      meta: lead.mail.from || '',
      preview: (lead.inquiry || '').slice(0, 360)
    });
  } else if (lead.inquiry) {
    items.push({
      id: `manual-${lead.id}`,
      direction: 'in',
      title: lead.subject || '原始询盘',
      at: lead.createdAtIso || lead.createdAt,
      meta: lead.source || '手动粘贴',
      preview: (lead.inquiry || '').slice(0, 360)
    });
  }
  (lead.mail?.sentLog || []).forEach((item, index) => {
    items.push({
      id: `sent-${index}-${item.sentAt}`,
      direction: 'out',
      title: item.stage === 'initial' ? '已发送初次回复' : `已发送${item.stage || '跟进'}`,
      at: item.sentAt,
      meta: item.to || '',
      preview: item.mode || 'auto'
    });
  });
  (lead.customerReplies || []).forEach((reply, index) => {
    items.push({
      id: `reply-${reply.messageId || index}`,
      direction: reply.riskReview?.blocked ? 'risk' : 'in',
      title: reply.subject || '客户回复',
      at: reply.date,
      meta: reply.from || '',
      preview: reply.riskReview?.note || reply.preview || ''
    });
  });
  (lead.followUps || []).forEach((item) => {
    if (item.status !== 'pending') return;
    items.push({
      id: `follow-${item.id || item.stage}`,
      direction: 'plan',
      title: item.label || item.stage || '待跟进',
      at: item.dueAt,
      meta: item.status,
      preview: '系统计划自动跟进，客户回信后会暂停。'
    });
  });
  return items.sort((left, right) => new Date(left.at || 0).getTime() - new Date(right.at || 0).getTime());
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_\-./]+/g, '');
}

function pickColumn(row, aliases) {
  const normalized = Object.fromEntries(Object.keys(row).map((key) => [normalizeHeader(key), key]));
  const key = aliases.map(normalizeHeader).find((alias) => normalized[alias]);
  return key ? String(row[normalized[key]] ?? '').trim() : '';
}

function rowsToProducts(rows) {
  return rows
    .map((row) => ({
      id: crypto.randomUUID(),
      name: pickColumn(row, ['name', 'product', 'product name', '产品', '产品名', '品名', '名称']),
      sku: pickColumn(row, ['sku', 'model', 'item no', 'item number', '型号', '货号', '编号']),
      price: pickColumn(row, ['price', 'unit price', 'fob price', 'exw price', '报价', '价格', '单价']),
      moq: pickColumn(row, ['moq', 'minimum order quantity', '起订量', '最小起订量']),
      leadTime: pickColumn(row, ['lead time', 'leadtime', 'delivery time', 'production time', '交期', '生产周期']),
      notes: pickColumn(row, ['notes', 'description', 'remark', 'remarks', 'spec', 'specification', '备注', '描述', '规格'])
    }))
    .filter((product) => product.name || product.sku);
}

function parseCsvRows(text) {
  const rows = [];
  let cell = '';
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const header = (rows.shift() || []).map((item) => String(item || '').trim());
  return rows
    .filter((items) => items.some((item) => String(item || '').trim()))
    .map((items) => Object.fromEntries(header.map((key, index) => [key, items[index] || ''])));
}

function buildQuotationText(result) {
  if (!result) return '';
  const customer = getCustomerName(result);
  const items = result.quotationDraft?.items || [];
  const lines = [
    'QUOTATION',
    '',
    `To: ${customer}`,
    `Subject: ${result.emailSubject || 'Quotation'}`,
    `Date: ${new Date().toLocaleDateString('en-CA')}`,
    '',
    'Dear Sir/Madam,',
    '',
    'Thank you for your inquiry. Please find our quotation below:',
    '',
    'Items:'
  ];

  if (items.length) {
    items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.product || 'Product to be confirmed'}`);
      lines.push(`   Quantity: ${item.quantity || 'TBC'}`);
      lines.push(`   Unit Price: ${item.unitPrice || 'TBC'}`);
      if (item.subtotal) lines.push(`   Subtotal: ${item.subtotal}`);
      if (item.remarks) lines.push(`   Remarks: ${item.remarks}`);
    });
  } else {
    lines.push('Detailed quotation is held until verification or missing information is completed.');
  }

  lines.push('');
  lines.push(`Terms: ${result.quotationDraft?.terms || 'To be confirmed'}`);
  lines.push(`Lead time: ${result.requirements?.leadTime || 'To be confirmed'}`);
  lines.push(`Destination: ${result.requirements?.destination || 'To be confirmed'}`);
  lines.push('');
  lines.push('Best regards,');
  lines.push('Sales Team');
  return lines.join('\n');
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(value, fallback = 'quotation') {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || fallback;
}

function mailAccountDisplay(account = {}) {
  const email = account.imap?.user || account.smtp?.user || '';
  if (email) return email;
  const host = account.imap?.host || account.smtp?.host || '';
  return host || '未命名邮箱';
}

function Field({ label, value, onChange, placeholder, multiline = false }) {
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      )}
    </label>
  );
}

function App() {
  const [showLaunch, setShowLaunch] = useState(true);
  const [state, setState] = useState(loadState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [copied, setCopied] = useState('');
  const [importNotice, setImportNotice] = useState('');
  const [mailStatus, setMailStatus] = useState(null);
  const [mailLoading, setMailLoading] = useState(false);
  const [mailNotice, setMailNotice] = useState('');
  const [sendingLeadId, setSendingLeadId] = useState('');
  const [activeSection, setActiveSection] = useState('dashboard');
  const [queueFilter, setQueueFilter] = useState('all');
  const [queueQuery, setQueueQuery] = useState('');
  const [selectedQueueItem, setSelectedQueueItem] = useState(null);
  const [queueActionId, setQueueActionId] = useState('');
  const [settingsDraft, setSettingsDraft] = useState(emptySettingsDraft);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [mailEditorIndex, setMailEditorIndex] = useState(null);
  const [replyEditor, setReplyEditor] = useState(null);
  const [viewedLeadIds, setViewedLeadIds] = useState(() => {
    try {
      const raw = localStorage.getItem(LEADS_VIEWED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return state.leads.map((lead) => lead.id);
  });
  const [customerTranslationCache, setCustomerTranslationCache] = useState({});
  const [customerTranslation, setCustomerTranslation] = useState({
    leadId: '',
    loading: false,
    original: '',
    chinese: '',
    language: '',
    error: ''
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setShowLaunch(false), 1850);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    saveState(state);
  }, [state]);

  async function refreshHealth() {
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      setHealth(data);
    } catch {
      setHealth({ ok: false, hasKey: false, mailWorker: { running: false, lastError: 'Health check failed.' } });
    }
  }

  function settingsFromServer(data = {}) {
    return {
      ai: {
        model: data.ai?.model || 'deepseek-chat',
        apiKey: '',
        apiKeyMasked: data.ai?.apiKeyMasked || '',
        hasApiKey: Boolean(data.ai?.hasApiKey)
      },
      mailAccounts: (data.mailAccounts || []).map((account) => ({
        ...newMailAccount(),
        ...account,
        imap: { ...newMailAccount().imap, ...(account.imap || {}), pass: '' },
        smtp: { ...newMailAccount().smtp, ...(account.smtp || {}), pass: '' }
      }))
    };
  }

  async function refreshSettings() {
    try {
      const response = await fetch('/api/settings');
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '设置读取失败');
      setSettingsDraft(settingsFromServer(data));
    } catch (err) {
      setSettingsNotice(err.message);
    }
  }

  async function saveSettings() {
    setSettingsLoading(true);
    setSettingsNotice('');
    try {
      const payload = {
        ai: {
          model: settingsDraft.ai.model || 'deepseek-chat',
          ...(settingsDraft.ai.apiKey ? { apiKey: settingsDraft.ai.apiKey } : {})
        },
        mailAccounts: settingsDraft.mailAccounts.map((account) => ({
          ...account,
          imap: {
            ...account.imap,
            port: Number(account.imap?.port || 993),
            secure: Boolean(account.imap?.secure),
            ...(account.imap?.pass ? { pass: account.imap.pass } : {})
          },
          smtp: {
            ...account.smtp,
            port: Number(account.smtp?.port || 465),
            secure: Boolean(account.smtp?.secure),
            ...(account.smtp?.pass ? { pass: account.smtp.pass } : {})
          },
          pollIntervalSeconds: Number(account.pollIntervalSeconds || 15)
        }))
      };
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '设置保存失败');
      setSettingsDraft(settingsFromServer(data));
      setMailEditorIndex(null);
      setSettingsNotice('设置已保存。后台下一轮同步会自动使用新的 API Key 和邮箱配置。');
      await refreshHealth();
      await refreshMailStatus({ silent: true });
    } catch (err) {
      setSettingsNotice(err.message);
    } finally {
      setSettingsLoading(false);
    }
  }

  function updateSettingsAi(key, value) {
    setSettingsDraft((current) => ({
      ...current,
      ai: { ...current.ai, [key]: value }
    }));
  }

  function addMailAccount() {
    const account = newMailAccount();
    setSettingsDraft((current) => ({
      ...current,
      mailAccounts: [...current.mailAccounts, account]
    }));
    setMailEditorIndex(settingsDraft.mailAccounts.length);
  }

  function updateMailAccount(index, path, value) {
    setSettingsDraft((current) => ({
      ...current,
      mailAccounts: current.mailAccounts.map((account, accountIndex) => {
        if (accountIndex !== index) return account;
        if (path.length === 1) return { ...account, [path[0]]: value };
        const [group, key] = path;
        return { ...account, [group]: { ...(account[group] || {}), [key]: value } };
      })
    }));
  }

  function removeMailAccount(index) {
    setSettingsDraft((current) => ({
      ...current,
      mailAccounts: current.mailAccounts.filter((_, accountIndex) => accountIndex !== index)
    }));
    setMailEditorIndex(null);
  }

  function applyMailProviderPreset(index, presetKey) {
    const preset = mailProviderPresets[presetKey];
    if (!preset) return;
    setSettingsDraft((current) => ({
      ...current,
      mailAccounts: current.mailAccounts.map((account, accountIndex) => (
        accountIndex === index
          ? {
              ...account,
              label: account.label || preset.label,
              imap: { ...(account.imap || {}), host: preset.imapHost, port: preset.imapPort, secure: true },
              smtp: { ...(account.smtp || {}), host: preset.smtpHost, port: preset.smtpPort, secure: true }
            }
          : account
      ))
    }));
  }

  useEffect(() => {
    refreshHealth();
    refreshSettings();
    refreshMailStatus({ silent: true });
    const timer = window.setInterval(() => {
      refreshHealth();
      refreshMailStatus({ silent: true });
    }, 8000);
    const handleFocus = () => {
      refreshHealth();
      refreshMailStatus({ silent: true });
    };
    const handleVisibility = () => {
      if (!document.hidden) handleFocus();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    if (!['dashboard', 'replies', 'mail'].includes(activeSection)) return undefined;
    const timer = window.setInterval(() => {
      refreshMailStatus({ silent: true });
    }, activeSection === 'replies' ? 4000 : 6000);
    return () => window.clearInterval(timer);
  }, [activeSection]);

  useEffect(() => {
    if (activeSection !== 'leads') return;
    const ids = state.leads.map((lead) => lead.id);
    localStorage.setItem(LEADS_VIEWED_KEY, JSON.stringify(ids));
    setViewedLeadIds(ids);
  }, [activeSection, state.leads]);

  const summary = useMemo(() => {
    const total = state.leads.length;
    const active = state.leads.filter((lead) => !isClosedLead(lead)).length;
    const won = state.leads.filter((lead) => lead.status === '已成交').length;
    return { total, active, won };
  }, [state.leads]);

  const newLeadCount = useMemo(() => {
    const viewed = new Set(viewedLeadIds);
    return state.leads.filter((lead) => {
      if (isClosedLead(lead)) return false;
      return !viewed.has(lead.id);
    }).length;
  }, [state.leads, viewedLeadIds]);

  const replyInboxLeads = useMemo(() => {
    return state.leads
      .filter((lead) => !isClosedLead(lead) && (lead.status === '客户已回复' || hasUnansweredCustomerReply(lead)))
      .sort((left, right) => {
        const leftReply = latestCustomerReply(left);
        const rightReply = latestCustomerReply(right);
        return new Date(rightReply?.date || right.updatedAt || 0).getTime() - new Date(leftReply?.date || left.updatedAt || 0).getTime();
      });
  }, [state.leads]);

  const filteredLeads = useMemo(() => {
    const query = state.leadQuery.trim().toLowerCase();
    return state.leads.filter((lead) => {
      if (isClosedLead(lead) && state.leadFilter !== 'closed' && !closedStatuses.includes(state.leadFilter)) return false;
      if (state.leadFilter !== 'replied' && activeSection === 'replies' && !(lead.status === '客户已回复' || hasUnansweredCustomerReply(lead))) return false;
      const matchesFilter =
        state.leadFilter === 'all' ||
        lead.quality === state.leadFilter ||
        lead.status === state.leadFilter ||
        leadBoardBucket(lead) === state.leadFilter;
      const haystack = [
        lead.customer,
        lead.country,
        lead.contact,
        lead.intent,
        lead.subject,
        lead.source,
        lead.mail?.from,
        lead.mail?.subject,
        lead.inquiry
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return matchesFilter && (!query || haystack.includes(query));
    });
  }, [state.leads, state.leadFilter, state.leadQuery, activeSection]);

  const filteredMailQueue = useMemo(() => {
    const query = queueQuery.trim().toLowerCase();
    return (mailStatus?.mailQueue || []).filter((item) => {
      const matchesFilter = queueFilter === 'all' || item.status === queueFilter;
      const haystack = [item.subject, item.from, item.reason, item.messageId, item.accountLabel].join(' ').toLowerCase();
      return matchesFilter && (!query || haystack.includes(query));
    });
  }, [mailStatus?.mailQueue, queueFilter, queueQuery]);

  const sendQueueStats = useMemo(() => {
    const jobs = mailStatus?.sendQueue || [];
    return {
      total: jobs.length,
      pending: jobs.filter((job) => job.status === 'pending').length,
      sending: jobs.filter((job) => job.status === 'sending').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      sent: jobs.filter((job) => job.status === 'sent').length
    };
  }, [mailStatus?.sendQueue]);

  const replyAlerts = useMemo(() => {
    return replyInboxLeads
      .map((lead) => ({
        lead,
        reply: latestCustomerReply(lead),
        action: nextActionForLead(lead)
      }))
      .sort((left, right) => new Date(right.reply?.date || right.lead.updatedAt || 0).getTime() - new Date(left.reply?.date || left.lead.updatedAt || 0).getTime())
      .slice(0, 6);
  }, [replyInboxLeads]);

  useEffect(() => {
    if (activeSection !== 'detail' || !state.selectedLeadId) {
      setCustomerTranslation((current) => (
        current.leadId
          ? { leadId: '', loading: false, original: '', chinese: '', language: '', error: '' }
          : current
      ));
      return;
    }
    const lead = state.leads.find((item) => item.id === state.selectedLeadId);
    if (!lead) return;
    const original = customerOriginalText(lead);
    if (!original) {
      setCustomerTranslation({ leadId: lead.id, loading: false, original: '', chinese: '', language: '', error: '' });
      return;
    }
    const cached = customerTranslationCache[lead.id];
    if (cached?.original === original && cached?.chinese) {
      setCustomerTranslation({ leadId: lead.id, loading: false, original, chinese: cached.chinese, language: cached.language || '', error: '' });
      return;
    }

    let cancelled = false;
    setCustomerTranslation({ leadId: lead.id, loading: true, original, chinese: '', language: '', error: '' });
    fetch('/api/translate/customer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerText: original })
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || data.error || '客户原文翻译失败');
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        const next = {
          leadId: lead.id,
          loading: false,
          original,
          chinese: data.customerChinese || '',
          language: data.detectedLanguageName || data.detectedLanguage || '',
          error: ''
        };
        setCustomerTranslation(next);
        setCustomerTranslationCache((current) => ({
          ...current,
          [lead.id]: {
            original,
            chinese: next.chinese,
            language: next.language
          }
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setCustomerTranslation({
          leadId: lead.id,
          loading: false,
          original,
          chinese: '',
          language: '',
          error: err.message || '客户原文翻译失败'
        });
      });
    return () => {
      cancelled = true;
    };
  }, [activeSection, state.selectedLeadId, state.leads, customerTranslationCache]);

  const boardBuckets = useMemo(() => {
    const configs = [
      { id: 'new', label: '新询盘', hint: '待处理的新线索' },
      { id: 'waiting', label: '已回复，待客户回复', hint: '已报价或自动跟进中' },
      { id: 'replied', label: '客户已回复', hint: '需要你接手' },
      { id: 'risk', label: '风险核查', hint: '风险、失败或低意向' },
      { id: 'silent', label: '已沉默', hint: '超过周期未回复' }
    ];
    return configs.map((config) => {
      const items = state.leads.filter((lead) => !isClosedLead(lead) && leadBoardBucket(lead) === config.id);
      const top = [...items].sort((left, right) => {
        const leftScore = Number(left.result?.leadQuality?.score || 0);
        const rightScore = Number(right.result?.leadQuality?.score || 0);
        if (config.id === 'replied') return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
        return rightScore - leftScore || Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
      })[0];
      return { ...config, count: items.length, top };
    });
  }, [state.leads]);

  function updateProduct(id, key, value) {
    setState((current) => ({
      ...current,
      products: current.products.map((item) => (item.id === id ? { ...item, [key]: value } : item))
    }));
  }

  function addProduct() {
    setState((current) => ({
      ...current,
      products: [
        ...current.products,
        { id: crypto.randomUUID(), name: '', sku: '', price: '', moq: '', leadTime: '', notes: '' }
      ]
    }));
  }

  function removeProduct(id) {
    setState((current) => ({
      ...current,
      products: current.products.filter((item) => item.id !== id)
    }));
  }

  async function importProductsFromFile(file) {
    if (!file) return;
    setImportNotice('');
    try {
      const buffer = await file.arrayBuffer();
      let rows = [];
      if (/\.csv$/i.test(file.name)) {
        rows = parseCsvRows(new TextDecoder('utf-8').decode(buffer));
      } else {
        const ExcelJS = await import('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const sheet = workbook.worksheets[0];
        const header = [];
        sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
          header[colNumber - 1] = String(cell.value || '').trim();
        });
        sheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;
          const item = {};
          header.forEach((key, index) => {
            if (!key) return;
            const value = row.getCell(index + 1).value;
            item[key] = typeof value === 'object' && value?.text ? value.text : value ?? '';
          });
          rows.push(item);
        });
      }
      const imported = rowsToProducts(rows);
      if (!imported.length) {
        setImportNotice('未识别到产品行，请确认表格包含产品名或 SKU。');
        return;
      }
      setState((current) => ({
        ...current,
        products: imported
      }));
      setImportNotice(`已导入 ${imported.length} 个产品，原产品库已替换。`);
    } catch (err) {
      setImportNotice(`导入失败：${err.message}`);
    }
  }

  async function analyzeInquiry() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/analyze-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inquiry: state.inquiry,
          products: state.products,
          companyProfile: state.companyProfile
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '分析失败');

      const lead = buildLead({
        inquiry: state.inquiry,
        result: data,
        products: state.products
      });

      setState((current) => ({
        ...current,
        result: data,
        selectedLeadId: lead.id,
        leads: [lead, ...current.leads]
      }));
      setActiveSection('detail');
      window.requestAnimationFrame(() => {
        document.getElementById('section-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshMailStatus({ silent = false } = {}) {
    try {
      const response = await fetch('/api/mail/status');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '邮箱状态读取失败');
      setMailStatus(data);
      setState((current) => ({
        ...current,
        leads: mergeMailLeads(current.leads, data.leads)
      }));
    } catch (err) {
      if (!silent) setMailNotice(err.message);
    }
  }

  async function testMailConnection() {
    setMailLoading(true);
    setMailNotice('');
    try {
      const response = await fetch('/api/mail/test', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || '邮箱连接测试失败');
      const accountMessages = (data.accounts || []).map((account) => `${account.label || account.user}：IMAP ${account.imap.message} / SMTP ${account.smtp.message}`);
      setMailNotice(accountMessages.length ? accountMessages.join('；') : `IMAP：${data.imap.message} SMTP：${data.smtp.message}`);
      await refreshMailStatus({ silent: true });
    } catch (err) {
      setMailNotice(err.message);
    } finally {
      setMailLoading(false);
    }
  }

  async function syncMailboxNow() {
    setMailLoading(true);
    setMailNotice('');
    try {
      const response = await fetch('/api/mail/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: state.products,
          companyProfile: state.companyProfile
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '邮箱同步失败');
      setMailStatus(data.status);
      setState((current) => ({
        ...current,
        leads: mergeMailLeads(current.leads, data.status?.leads)
      }));
      setMailNotice(`同步完成：检查 ${data.checked} 封，新增 ${data.imported} 条，客户回信 ${data.threadReplies || 0} 条，自动回复 ${data.autoReplied} 条，自动跟进 ${data.followUpsSent || 0} 条，沉默标记 ${data.silentMarked || 0} 条，二次风险 ${data.status?.stats?.riskEscalations ?? 0} 条，人工核查 ${data.manualReview} 条。`);
    } catch (err) {
      setMailNotice(err.message);
    } finally {
      setMailLoading(false);
    }
  }

  async function sendLeadReply(lead, { force = false, attachQuotationPdf = false, subject, body } = {}) {
    if (!lead?.id) return;
    setSendingLeadId(lead.id);
    setMailNotice('');
    try {
      const response = await fetch(`/api/mail/leads/${lead.id}/send-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force, attachQuotationPdf, subject, body })
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.status) setMailStatus(data.status);
        if (data.lead) {
          setState((current) => ({
            ...current,
            result: data.lead.result || current.result,
            selectedLeadId: data.lead.id || current.selectedLeadId,
            leads: mergeMailLeads(current.leads, data.status?.leads || [data.lead])
          }));
        }
        throw new Error(data.detail || data.error || '发送失败');
      }
      setMailStatus(data.status);
      setState((current) => ({
        ...current,
        result: data.lead?.result || current.result,
        selectedLeadId: data.lead?.id || current.selectedLeadId,
        leads: mergeMailLeads(current.leads, data.status?.leads)
      }));
      setMailNotice(attachQuotationPdf ? '报价 PDF 已加入发送队列并完成发送。' : `SMTP 已接受邮件，已发送至 ${data.lead?.mail?.autoReply?.to || '客户邮箱'}。`);
      return true;
    } catch (err) {
      const message = err.message || '';
      setMailNotice(
        message.includes('Quotation PDF is empty')
          ? '详细报价还没有可发送的报价项。请先在产品报价库补充产品价格，或在客户详情里确认报价草稿后再发送。'
          : message
      );
      return false;
    } finally {
      setSendingLeadId('');
    }
  }

  async function openReplyEditor(lead, options = {}) {
    if (!lead) return;
    const fallbackSuggestion = buildReplySuggestion(lead) || lead.result?.emailReply || '';
    const initialCanAttachQuotationPdf = Boolean((lead.result?.quotationDraft?.items || []).length);
    const initialDraft = {
      leadId: lead.id,
      force: true,
      canAttachQuotationPdf: initialCanAttachQuotationPdf,
      attachQuotationPdf: Boolean(options.attachQuotationPdf && initialCanAttachQuotationPdf),
      subject: options.subject || lead.result?.emailSubject || `Re: ${lead.subject || lead.mail?.subject || 'Inquiry'}`,
      body: options.body || fallbackSuggestion || 'Generating AI draft...',
      drafting: true,
      translating: true,
      detectedLanguage: '',
      customerChinese: '',
      replyChinese: '',
      translationError: ''
    };
    setReplyEditor(initialDraft);

    try {
      let workingLead = lead;
      let workingDraft = initialDraft;
      if (lead.mail?.messageId || lead.mail?.from) {
        const draftResponse = await fetch(`/api/mail/leads/${lead.id}/draft-reply`, { method: 'POST' });
        const draftData = await draftResponse.json();
        if (!draftResponse.ok) throw new Error(draftData.detail || draftData.error || 'AI 草稿生成失败');
        workingLead = draftData.lead || lead;
        if (draftData.status) setMailStatus(draftData.status);
        setState((current) => ({
          ...current,
          result: workingLead.result || current.result,
          selectedLeadId: workingLead.id || current.selectedLeadId,
          leads: mergeMailLeads(current.leads, draftData.status?.leads || [workingLead])
        }));
        workingDraft = {
          ...initialDraft,
          subject: draftData.draft?.subject || workingLead.result?.emailSubject || initialDraft.subject,
          body: draftData.draft?.body || workingLead.result?.emailReply || initialDraft.body,
          canAttachQuotationPdf: Boolean(draftData.draft?.canAttachQuotationPdf || (workingLead.result?.quotationDraft?.items || []).length),
          attachQuotationPdf: Boolean(draftData.draft?.attachQuotationPdf || draftData.draft?.canAttachQuotationPdf || (workingLead.result?.quotationDraft?.items || []).length),
          drafting: false
        };
        setReplyEditor((current) => (current?.leadId === lead.id ? workingDraft : current));
      }

      const response = await fetch('/api/translate/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerText: latestCustomerText(workingLead),
          subject: workingDraft.subject,
          body: workingDraft.body
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '翻译失败');
      setReplyEditor((current) => (
        current?.leadId === lead.id
          ? {
              ...current,
              drafting: false,
              subject: data.replySubject || current.subject,
              body: data.replyBody || current.body,
              detectedLanguage: data.detectedLanguageName || data.detectedLanguage || '',
              customerChinese: data.customerChinese || '',
              replyChinese: data.replyChinese || '',
              translating: false,
              translationError: ''
            }
          : current
      ));
    } catch (err) {
      setReplyEditor((current) => (
        current?.leadId === lead.id
          ? { ...current, drafting: false, translating: false, translationError: err.message || 'AI 草稿或翻译失败，已保留原草稿' }
          : current
      ));
    }
  }

  async function sendEditedReply() {
    const lead = state.leads.find((item) => item.id === replyEditor?.leadId);
    if (!lead || !replyEditor) return;
    const ok = await sendLeadReply(lead, {
      force: replyEditor.force,
      attachQuotationPdf: replyEditor.attachQuotationPdf,
      subject: replyEditor.subject,
      body: replyEditor.body
    });
    if (ok !== false) setReplyEditor(null);
  }

  async function downloadQuotationPdf(lead = null) {
    try {
      if (lead?.id && lead.mail) {
        window.open(`/api/mail/leads/${lead.id}/quotation.pdf`, '_blank');
        return;
      }
      const result = lead?.result || state.result;
      if (!result) return;
      const response = await fetch('/api/quotation/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead: lead || selectedLead || {},
          result,
          companyProfile: state.companyProfile
        })
      });
      if (!response.ok) throw new Error('PDF 生成失败');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${safeFilename(getCustomerName(result))}-quotation.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMailNotice(err.message);
    }
  }

  async function reprocessQueueItem(item, { forceNew = false } = {}) {
    const id = item?.id || item?.messageKey || item?.messageId;
    if (!id) return;
    setQueueActionId(id);
    setMailNotice('');
    try {
      const response = await fetch(`/api/mail/queue/${encodeURIComponent(id)}/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceNew })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '重新处理失败');
      setMailStatus(data.status);
      setState((current) => ({
        ...current,
        result: data.lead?.result || current.result,
        selectedLeadId: data.lead?.id || current.selectedLeadId,
        leads: mergeMailLeads(current.leads, data.status?.leads || [data.lead])
      }));
      setMailNotice(forceNew ? '已从队列创建新线索。' : '已重新分析并入库。');
    } catch (err) {
      setMailNotice(`队列处理失败：${err.message}`);
    } finally {
      setQueueActionId('');
    }
  }

  function viewLead(lead) {
    setState((current) => ({
      ...current,
      selectedLeadId: lead.id,
      inquiry: lead.inquiry || current.inquiry,
      result: lead.result || current.result
    }));
    setActiveSection('detail');
    window.requestAnimationFrame(() => {
      document.getElementById('section-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  async function updateLead(id, status) {
    setState((current) => ({
      ...current,
      leads: current.leads.map((lead) => (lead.id === id ? { ...lead, status, updatedAt: Date.now() } : lead))
    }));
    try {
      const response = await fetch(`/api/mail/leads/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '状态保存失败');
      setMailStatus(data.status);
      setState((current) => ({
        ...current,
        leads: mergeMailLeads(current.leads, data.status?.leads)
      }));
    } catch (err) {
      setMailNotice(`状态保存失败：${err.message}`);
      refreshMailStatus({ silent: true });
    }
  }

  async function removeLead(leadOrId) {
    const id = typeof leadOrId === 'string' ? leadOrId : leadOrId?.id;
    const lead = typeof leadOrId === 'string' ? state.leads.find((item) => item.id === id) : leadOrId;
    if (!id) return;

    setState((current) => ({
      ...current,
      selectedLeadId: current.selectedLeadId === id ? '' : current.selectedLeadId,
      result: current.selectedLeadId === id ? null : current.result,
      leads: current.leads.filter((item) => item.id !== id)
    }));

    if (!lead?.mail) return;

    try {
      const response = await fetch(`/api/mail/leads/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || '删除失败');
      setMailStatus(data.status);
      setState((current) => ({
        ...current,
        leads: current.leads.filter((item) => item.id !== id)
      }));
      setMailNotice('线索已删除，后续同步不会重新导入这封邮件。');
    } catch (err) {
      setMailNotice(`删除失败：${err.message}`);
      refreshMailStatus({ silent: true });
    }
  }

  function setLeadQuery(leadQuery) {
    setState((current) => ({ ...current, leadQuery }));
  }

  function setLeadFilter(leadFilter) {
    setState((current) => ({ ...current, leadFilter }));
  }

  async function copyText(text, key) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1400);
  }

  async function exportQuotationWorkbook() {
    if (!state.result) return;
    const ExcelJS = await import('exceljs');
    const current = state.result;
    const customer = current.customer || {};
    const requirements = current.requirements || {};
    const quotation = current.quotationDraft || {};
    const items = quotation.items || [];
    const rows = [
      ['QUOTATION'],
      [],
      ['Date', new Date().toLocaleDateString('en-CA')],
      ['Customer', getCustomerName(current)],
      ['Country', customer.country || ''],
      ['Contact', customer.contact || ''],
      ['Subject', current.emailSubject || 'Quotation'],
      [],
      ['No.', 'Product', 'Quantity', 'Unit Price', 'Subtotal', 'Remarks']
    ];

    if (items.length) {
      items.forEach((item, index) => {
        rows.push([
          index + 1,
          item.product || 'Product to be confirmed',
          item.quantity || requirements.quantity || 'TBC',
          item.unitPrice || 'TBC',
          item.subtotal || '',
          item.remarks || ''
        ]);
      });
    } else {
      rows.push(['', 'Detailed quotation is held until verification or missing information is completed.', '', '', '', '']);
    }

    rows.push(
      [],
      ['Terms', quotation.terms || 'To be confirmed'],
      ['Lead time', requirements.leadTime || 'To be confirmed'],
      ['Destination', requirements.destination || 'To be confirmed'],
      ['Incoterms / shipping', requirements.incoterms || requirements.shipping || 'To be confirmed'],
      [],
      ['Missing information', (current.missingInfo || []).join('; ') || 'None'],
      ['Internal notes', current.internalNotes || '']
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Quotation');
    worksheet.addRows(rows);
    worksheet.columns = [
      { width: 8 },
      { width: 42 },
      { width: 18 },
      { width: 18 },
      { width: 16 },
      { width: 42 }
    ];
    worksheet.mergeCells(1, 1, 1, 6);
    worksheet.getRow(1).font = { bold: true, size: 16 };
    worksheet.getRow(9).font = { bold: true };
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
    });

    const output = await workbook.xlsx.writeBuffer();
    const blob = new Blob([output], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeFilename(getCustomerName(current))}-quotation.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const result = state.result;
  const selectedLead = state.leads.find((lead) => lead.id === state.selectedLeadId);
  const mailWorker = health?.mailWorker || {};
  const workerEventLabels = {
    'worker-started': '线程已启动',
    'sync-complete': '同步完成',
    'sync-error': '同步出错，等待重试',
    'sync-skipped': '未配置邮箱',
    'worker-error': '线程错误'
  };
  const workerStatusText = mailWorker.running ? '运行中' : '未运行';
  const workerEventText = workerEventLabels[mailWorker.lastEvent] || mailWorker.lastEvent || '等待启动';
  const sidebarGroups = [
    {
      title: '菜单',
      items: [
        { id: 'dashboard', label: '工作台', icon: Inbox, badge: summary.total },
        { id: 'mail', label: '邮箱自动化', icon: Mail, badge: mailStatus?.accounts?.length || 0 },
        { id: 'replies', label: '客户回信', icon: MailCheck, badge: replyInboxLeads.length, alert: replyInboxLeads.length > 0 },
        { id: 'products', label: '产品报价库', icon: PackagePlus, badge: state.products.length },
        { id: 'leads', label: '客户线索库', icon: CheckCircle2, badge: newLeadCount || summary.active, alert: newLeadCount > 0 },
        { id: 'settings', label: '系统设置', icon: Settings, badge: settingsDraft.mailAccounts.length }
      ]
    }
  ];

  function jumpToSection(id) {
    setActiveSection(id);
    window.requestAnimationFrame(() => {
      document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  return (
    <main className="app">
      <div className={`launch-screen ${showLaunch ? 'is-visible' : 'is-exiting'}`} aria-hidden="true">
        <div className="launch-orbit">
          <span />
          <span />
          <span />
        </div>
        <div className="launch-core">
          <Bot size={30} />
        </div>
        <div className="launch-copy">
          <strong>Trade Inquiry AI</strong>
          <span>Risk scoring · Mail automation · Quotation desk</span>
        </div>
        <div className="launch-bar" />
      </div>
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <Bot size={26} />
            <div>
              <strong>AI Inquiry Ops</strong>
              <span>外贸线索自动化</span>
            </div>
          </div>
          <nav className="side-nav" aria-label="Main sections">
            {sidebarGroups.map((group) => (
              <div className="side-group" key={group.title}>
                <span>{group.title}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      data-section={item.id}
                      className={activeSection === item.id ? 'active' : ''}
                      onClick={() => jumpToSection(item.id)}
                    >
                      <Icon size={18} />
                      <span>{item.label}</span>
                      <em className={item.alert ? 'nav-alert' : ''}>{item.badge}</em>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="side-mini-metrics">
            <Info label="总线索" value={summary.total} />
            <Info label="进行中" value={summary.active} />
            <Info label="已成交" value={summary.won} />
          </div>
        </aside>

        <div className={`main-flow section-${activeSection} ${activeSection === 'detail' ? 'detail-mode' : ''}`}>
      {activeSection === 'dashboard' ? (
      <header className="topbar" id="section-dashboard">
        <div>
          <div className="brand">
            <Bot size={28} />
            <span>外贸 AI 询盘助手</span>
          </div>
          <p>把客户询盘变成需求摘要、英文回复、报价草稿和跟进任务。</p>
        </div>
        <div className={health?.hasKey ? 'status online' : 'status'}>
          <span>{health?.hasKey ? '系统已就绪' : '请完成系统设置'}</span>
        </div>
      </header>
      ) : null}

      {activeSection === 'dashboard' ? (
      <section className="metrics">
        <Metric label="线索总数" value={summary.total} />
        <Metric label="进行中" value={summary.active} />
        <Metric label="已成交" value={summary.won} />
      </section>
      ) : null}

      {activeSection === 'dashboard' && replyAlerts.length ? (
        <section className="panel reply-alerts">
          <div className="panel-title between">
            <div>
              <Mail size={20} />
              <h2>客户回信提醒</h2>
            </div>
            <span className="saved-pill">{replyAlerts.length} 条待处理</span>
          </div>
          <div className="reply-alert-list">
            {replyAlerts.map(({ lead, reply, action }) => (
              <div className={`reply-alert ${action.tone}`} key={`${lead.id}-${reply?.messageId || reply?.date || ''}`}>
                <div>
                  <strong>{lead.customer || '未知客户'}</strong>
                  <span>{reply?.subject || lead.subject || '客户有新回信'}</span>
                  <small>{reply?.date ? new Date(reply.date).toLocaleString('zh-CN') : '未记录时间'} · {reply?.from || lead.contact || '未知发件人'}</small>
                </div>
                <div>
                  <em>{action.title}</em>
                  <small>{action.detail}</small>
                </div>
                <button className="secondary compact" onClick={() => viewLead(lead)}>查看详情</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {(activeSection === 'dashboard' || activeSection === 'mail') ? (
      <section className="panel mail-workbench section-block" id="section-mail">
        <div className="panel-title between">
          <div>
            <Inbox size={20} />
            <h2>邮箱自动处理</h2>
          </div>
          <div className="panel-actions">
            <button className="secondary" onClick={testMailConnection} disabled={mailLoading}>
              {mailLoading ? <Loader2 className="spin" size={17} /> : <Mail size={17} />}
              <span>测试连接</span>
            </button>
            <button className="primary compact" onClick={syncMailboxNow} disabled={mailLoading || !mailStatus?.configured?.imap}>
              {mailLoading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              <span>立即收取</span>
            </button>
          </div>
        </div>
        <div className="mail-grid">
          <Info label="邮箱接入" value={mailStatus?.configured?.imap && mailStatus?.configured?.smtp ? '已连接' : '待配置'} />
          <Info label="今日收件" value={mailStatus?.stats?.receivedToday ?? 0} />
          <Info label="自动回复" value={mailStatus?.stats?.autoRepliedToday ?? 0} />
          <Info label="待跟进" value={mailStatus?.stats?.dueFollowUps ?? 0} />
          <Info label="二次风险" value={mailStatus?.stats?.riskEscalations ?? 0} />
          <Info label="人工核查" value={mailStatus?.stats?.manualReviewToday ?? 0} />
        </div>
        <div className="mail-note">
          <Send size={16} />
          <span>
            {mailStatus?.configured?.imap
              ? `已接入 ${mailStatus.accounts?.length || 1} 个邮箱；系统会自动过滤无关通知，只保留外贸业务线索。`
              : '请到系统设置中接入邮箱。'}
          </span>
        </div>
        {mailStatus?.accounts?.length ? (
          <div className="connected-mail-list">
            {mailStatus.accounts.map((account) => (
              <span key={account.id}>{account.user || account.label || '未命名邮箱'}</span>
            ))}
          </div>
        ) : null}
        {mailStatus?.accounts?.length ? (
          <div className="mail-accounts internal-only">
            {mailStatus.accounts.map((account) => (
              <div key={account.id}>
                <strong>{account.label || account.user}</strong>
                <small>{account.user || '未填写邮箱'} · IMAP {account.configured?.imap ? '已配置' : '未配置'} · SMTP {account.configured?.smtp ? '已配置' : '未配置'}</small>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mail-ops-grid internal-only">
          <div className="mail-ops-panel">
            <div className="mini-title">
              <strong>最近同步日志</strong>
              <span>{mailStatus?.syncLogs?.length || 0} 轮</span>
            </div>
            <div className="ops-list">
              {(mailStatus?.syncLogs || []).slice(0, 6).map((log) => (
                <div className="ops-row" key={log.id || log.at}>
                  <strong>{new Date(log.at).toLocaleString('zh-CN')}</strong>
                  <span>检查 {log.checked || 0} · 新增 {log.imported || 0} · 合并 {log.threadReplies || 0} · 跳过 {log.skippedDuplicates || 0}</span>
                  <small>{log.errors?.length ? log.errors[0] : `耗时 ${Math.round((log.durationMs || 0) / 1000)} 秒`}</small>
                </div>
              ))}
              {!(mailStatus?.syncLogs || []).length ? <div className="empty compact">暂无同步日志。</div> : null}
            </div>
          </div>
          <div className="mail-ops-panel">
            <div className="mini-title">
              <strong>邮件处理队列</strong>
              <span>{filteredMailQueue.length}/{mailStatus?.mailQueue?.length || 0} 封</span>
            </div>
            <div className="queue-tools">
              <input value={queueQuery} onChange={(event) => setQueueQuery(event.target.value)} placeholder="搜索发件人、主题、原因" />
              <select value={queueFilter} onChange={(event) => setQueueFilter(event.target.value)}>
                <option value="all">全部状态</option>
                <option value="待分析">待分析</option>
                <option value="分析中">分析中</option>
                <option value="已入库">已入库</option>
                <option value="已合并">已合并</option>
                <option value="已跳过">已跳过</option>
                <option value="失败重试">失败重试</option>
                <option value="待人工核查">待人工核查</option>
              </select>
            </div>
            <div className="ops-list">
              {filteredMailQueue.slice(0, 12).map((item) => (
                <div className="ops-row queue" key={item.id || item.messageKey}>
                  <strong>{item.subject || '无主题'}</strong>
                  <span>{item.from || item.accountLabel || '未知发件人'}</span>
                  <small><em>{item.status || '待处理'}</em>{item.reason ? ` · ${item.reason}` : ''}</small>
                  <div className="queue-actions">
                    <button className="secondary compact" onClick={() => setSelectedQueueItem(item)}>查看原文</button>
                    {['待分析', '失败重试'].includes(item.status) ? (
                      <button className="secondary compact" onClick={() => reprocessQueueItem(item)} disabled={queueActionId === (item.id || item.messageKey)}>
                        {queueActionId === (item.id || item.messageKey) ? '处理中' : '重新分析'}
                      </button>
                    ) : null}
                    {['已跳过', '已合并'].includes(item.status) ? (
                      <button className="secondary compact" onClick={() => reprocessQueueItem(item, { forceNew: true })} disabled={queueActionId === (item.id || item.messageKey)}>
                        作为新线索
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
              {!filteredMailQueue.length ? <div className="empty compact">暂无匹配邮件。</div> : null}
            </div>
          </div>
          <div className="mail-ops-panel">
            <div className="mini-title">
              <strong>发送队列</strong>
              <span>{sendQueueStats.pending + sendQueueStats.sending} 待处理 · {sendQueueStats.failed} 失败</span>
            </div>
            <div className="ops-list">
              {(mailStatus?.sendQueue || []).slice(0, 8).map((job) => (
                <div className="ops-row queue" key={job.id || job.dedupeKey}>
                  <strong>{job.subject || '无主题'}</strong>
                  <span>{job.to || job.accountLabel || '未知收件人'}</span>
                  <small><em>{job.status || 'pending'}</em>{job.lastError ? ` · ${job.lastError}` : ` · ${job.mode || 'auto'} / ${job.stage || 'initial'}`}</small>
                </div>
              ))}
              {!(mailStatus?.sendQueue || []).length ? <div className="empty compact">暂无发送任务。</div> : null}
            </div>
          </div>
        </div>
        {selectedQueueItem ? (
          <div className="queue-drawer">
            <div className="panel-title between">
              <div>
                <Mail size={18} />
                <h2>原始邮件预览</h2>
              </div>
              <button className="secondary compact" onClick={() => setSelectedQueueItem(null)}>关闭</button>
            </div>
            <div className="queue-meta">
              <Info label="From" value={selectedQueueItem.from || '未知'} />
              <Info label="Subject" value={selectedQueueItem.subject || '无主题'} />
              <Info label="Date" value={selectedQueueItem.date ? new Date(selectedQueueItem.date).toLocaleString('zh-CN') : '未知'} />
              <Info label="Message-ID" value={selectedQueueItem.messageId || selectedQueueItem.messageKey || '未知'} />
            </div>
            <pre>{selectedQueueItem.rawText || selectedQueueItem.preview || '这条历史队列记录没有保存原文预览，请等待下一轮同步或手动粘贴邮件分析。'}</pre>
          </div>
        ) : null}
        {mailNotice ? (
          <div className="import-notice">{mailNotice}</div>
        ) : null}
      </section>
      ) : null}

      {activeSection === 'settings' ? (
      <section className="panel section-block settings-panel" id="section-settings">
        <div className="panel-title between">
          <div>
            <Settings size={20} />
            <h2>系统设置</h2>
          </div>
          <div className="panel-actions">
            <button className="secondary" onClick={refreshSettings} disabled={settingsLoading}>
              <RefreshCw size={17} />
              <span>重新读取</span>
            </button>
            <button className="primary compact" onClick={saveSettings} disabled={settingsLoading}>
              {settingsLoading ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
              <span>保存设置</span>
            </button>
          </div>
        </div>

        <div className="settings-summary">
          <Info label="AI 服务" value={settingsDraft.ai.hasApiKey ? '已配置' : '待配置'} />
          <Info label="接入邮箱" value={settingsDraft.mailAccounts.length} />
          <Info label="自动收发" value={mailStatus?.configured?.imap && mailStatus?.configured?.smtp ? '可用' : '待配置'} />
        </div>
        <div className="settings-mail-strip">
          <div className="connected-mail-list">
            {settingsDraft.mailAccounts.map((account, index) => (
              <button className="mail-account-chip" key={account.id || index} onClick={() => setMailEditorIndex(index)}>
                <Mail size={16} />
                <span>{mailAccountDisplay(account)}</span>
              </button>
            ))}
            {!settingsDraft.mailAccounts.length ? <span>未接入邮箱</span> : null}
          </div>
          <button className="secondary compact" onClick={addMailAccount}>
            <Plus size={15} />
            <span>添加邮箱</span>
          </button>
        </div>

        <details className="advanced-settings">
          <summary>高级配置</summary>
          <div className="settings-grid">
            <div className="settings-card">
            <div className="mini-title">
              <strong><KeyRound size={16} /> AI 模型</strong>
              <span>{settingsDraft.ai.hasApiKey ? `已配置 ${settingsDraft.ai.apiKeyMasked || ''}` : '未配置'}</span>
            </div>
            <Field
              label="DeepSeek API Key"
              value={settingsDraft.ai.apiKey}
              onChange={(value) => updateSettingsAi('apiKey', value)}
              placeholder={settingsDraft.ai.hasApiKey ? '留空则保留当前 Key；输入新 Key 可替换' : 'sk-...'}
            />
            <Field
              label="模型名称"
              value={settingsDraft.ai.model}
              onChange={(value) => updateSettingsAi('model', value)}
              placeholder="deepseek-chat"
            />
            </div>

            <div className="settings-card">
            <div className="mini-title">
              <strong><Mail size={16} /> 多邮箱接入</strong>
              <button className="secondary compact" onClick={addMailAccount}>
                <Plus size={15} />
                <span>新增邮箱</span>
              </button>
            </div>
            <div className="mail-account-list">
              {settingsDraft.mailAccounts.map((account, index) => (
                <button className="mail-account-chip" key={account.id || index} onClick={() => setMailEditorIndex(index)}>
                  <Mail size={16} />
                  <span>{mailAccountDisplay(account)}</span>
                </button>
              ))}
              {!settingsDraft.mailAccounts.length ? (
                <div className="empty compact">还没有在界面配置邮箱。可以继续使用 .env，或点击“新增邮箱”接入多个账号。</div>
              ) : null}
            </div>
            </div>
          </div>
        </details>
        {mailEditorIndex !== null && settingsDraft.mailAccounts[mailEditorIndex] ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="mail-editor-modal">
              <div className="panel-title between">
                <div>
                  <Mail size={20} />
                  <h2>邮箱设置</h2>
                </div>
                <div className="panel-actions">
                  <button className="secondary compact" onClick={() => setMailEditorIndex(null)}>关闭</button>
                  <button className="icon-button danger" onClick={() => removeMailAccount(mailEditorIndex)} title="删除邮箱">
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <label className="field">
                <span>邮箱类型</span>
                <select onChange={(event) => applyMailProviderPreset(mailEditorIndex, event.target.value)} defaultValue="">
                  <option value="" disabled>选择 QQ / Gmail / 企业邮箱</option>
                  {Object.entries(mailProviderPresets).map(([key, preset]) => (
                    <option value={key} key={key}>{preset.label}</option>
                  ))}
                </select>
              </label>
              <div className="settings-form-grid">
                <Field label="显示名称" value={settingsDraft.mailAccounts[mailEditorIndex].label || ''} onChange={(value) => updateMailAccount(mailEditorIndex, ['label'], value)} placeholder="QQ Sales / Gmail Sales" />
                <Field label="邮箱地址" value={settingsDraft.mailAccounts[mailEditorIndex].imap?.user || ''} onChange={(value) => {
                  const account = settingsDraft.mailAccounts[mailEditorIndex];
                  const previousUser = account.imap?.user || '';
                  const currentSmtpUser = account.smtp?.user || '';
                  const currentFrom = account.smtp?.from || '';
                  const shouldUpdateFrom = !currentFrom || currentFrom === previousUser || currentFrom === currentSmtpUser;
                  setSettingsDraft((current) => ({
                    ...current,
                    mailAccounts: current.mailAccounts.map((mailAccount, accountIndex) => (
                      accountIndex === mailEditorIndex
                        ? {
                            ...mailAccount,
                            imap: { ...(mailAccount.imap || {}), user: value },
                            smtp: {
                              ...(mailAccount.smtp || {}),
                              user: value,
                              from: shouldUpdateFrom ? value : mailAccount.smtp?.from
                            }
                          }
                        : mailAccount
                    ))
                  }));
                }} placeholder="sales@example.com" />
                <Field label="发件人显示" value={settingsDraft.mailAccounts[mailEditorIndex].smtp?.from || ''} onChange={(value) => updateMailAccount(mailEditorIndex, ['smtp', 'from'], value)} placeholder="Sales Team <sales@example.com>" />
                <Field label="轮询秒数" value={String(settingsDraft.mailAccounts[mailEditorIndex].pollIntervalSeconds || 15)} onChange={(value) => updateMailAccount(mailEditorIndex, ['pollIntervalSeconds'], value)} placeholder="15" />
                <Field label="IMAP Host" value={settingsDraft.mailAccounts[mailEditorIndex].imap?.host || ''} onChange={(value) => updateMailAccount(mailEditorIndex, ['imap', 'host'], value)} placeholder="imap.qq.com / imap.gmail.com" />
                <Field label="IMAP Port" value={String(settingsDraft.mailAccounts[mailEditorIndex].imap?.port || 993)} onChange={(value) => updateMailAccount(mailEditorIndex, ['imap', 'port'], value)} placeholder="993" />
                <Field label="IMAP 授权码" value={settingsDraft.mailAccounts[mailEditorIndex].imap?.pass || ''} onChange={(value) => updateMailAccount(mailEditorIndex, ['imap', 'pass'], value)} placeholder="留空保留已保存授权码" />
                <label className="check-field">
                  <input type="checkbox" checked={Boolean(settingsDraft.mailAccounts[mailEditorIndex].imap?.secure)} onChange={(event) => updateMailAccount(mailEditorIndex, ['imap', 'secure'], event.target.checked)} />
                  <span>IMAP SSL/TLS</span>
                </label>
                <Field label="SMTP Host" value={settingsDraft.mailAccounts[mailEditorIndex].smtp?.host || ''} onChange={(value) => updateMailAccount(mailEditorIndex, ['smtp', 'host'], value)} placeholder="smtp.qq.com / smtp.gmail.com" />
                <Field label="SMTP Port" value={String(settingsDraft.mailAccounts[mailEditorIndex].smtp?.port || 465)} onChange={(value) => updateMailAccount(mailEditorIndex, ['smtp', 'port'], value)} placeholder="465" />
                <Field label="SMTP 授权码" value={settingsDraft.mailAccounts[mailEditorIndex].smtp?.pass || ''} onChange={(value) => updateMailAccount(mailEditorIndex, ['smtp', 'pass'], value)} placeholder="留空保留已保存授权码" />
                <label className="check-field">
                  <input type="checkbox" checked={Boolean(settingsDraft.mailAccounts[mailEditorIndex].smtp?.secure)} onChange={(event) => updateMailAccount(mailEditorIndex, ['smtp', 'secure'], event.target.checked)} />
                  <span>SMTP SSL/TLS</span>
                </label>
              </div>
              <div className="modal-actions">
                <button className="secondary" onClick={() => setMailEditorIndex(null)}>完成</button>
                <button className="primary compact" onClick={saveSettings} disabled={settingsLoading}>
                  {settingsLoading ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
                  <span>保存</span>
                </button>
              </div>
            </div>
          </div>
        ) : null}
        {settingsNotice ? <div className="import-notice">{settingsNotice}</div> : null}
      </section>
      ) : null}

      {(activeSection === 'dashboard' || activeSection === 'products') ? (
      <section className="workspace section-block" id={activeSection === 'products' ? 'section-products' : 'section-analyze'}>
        {activeSection === 'dashboard' ? (
        <div className="panel input-panel">
          <div className="panel-title">
            <FileText size={20} />
            <h2>询盘分析</h2>
          </div>
          <Field
            label="公司资料"
            value={state.companyProfile}
            onChange={(companyProfile) => setState((current) => ({ ...current, companyProfile }))}
            multiline
          />
          <Field
            label="客户询盘"
            value={state.inquiry}
            onChange={(inquiry) => setState((current) => ({ ...current, inquiry }))}
            multiline
          />
          {error ? <div className="error">{error}</div> : null}
          <button className="primary" onClick={analyzeInquiry} disabled={loading}>
            {loading ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            <span>{loading ? '正在分析' : '生成分析并自动保存'}</span>
          </button>
        </div>
        ) : null}

        {activeSection === 'products' ? (
        <div className="panel product-panel">
          <div className="panel-title between">
            <div>
              <PackagePlus size={20} />
              <h2>产品报价库</h2>
            </div>
            <div className="panel-actions">
              <label className="secondary file-button">
                <Upload size={17} />
                <span>导入表格</span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(event) => {
                    importProductsFromFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              <button type="button" className="icon-button" onClick={addProduct} title="新增产品">
                <Plus size={18} />
              </button>
            </div>
          </div>
          {importNotice ? <div className="import-notice">{importNotice}</div> : null}
          <div className="product-list">
            {state.products.length ? state.products.map((product) => (
              <div className="product-row" key={product.id}>
                <input value={product.name} onChange={(event) => updateProduct(product.id, 'name', event.target.value)} placeholder="产品名" />
                <input value={product.sku} onChange={(event) => updateProduct(product.id, 'sku', event.target.value)} placeholder="SKU" />
                <input value={product.price} onChange={(event) => updateProduct(product.id, 'price', event.target.value)} placeholder="价格" />
                <input value={product.moq} onChange={(event) => updateProduct(product.id, 'moq', event.target.value)} placeholder="MOQ" />
                <input value={product.leadTime} onChange={(event) => updateProduct(product.id, 'leadTime', event.target.value)} placeholder="交期" />
                <input value={product.notes} onChange={(event) => updateProduct(product.id, 'notes', event.target.value)} placeholder="备注" />
                <button type="button" className="icon-button danger" onClick={() => removeProduct(product.id)} title="删除产品">
                  <Trash2 size={17} />
                </button>
              </div>
            )) : (
              <div className="empty compact">
                产品报价库为空。点击右上角 + 新增产品，或导入 Excel/CSV。
              </div>
            )}
          </div>
        </div>
        ) : null}
      </section>
      ) : null}

      {result && activeSection === 'detail' ? (
        <section className="results section-block detail-page" id="section-detail">
          <div className="panel">
            <div className="panel-title between">
              <div>
                <ClipboardList size={20} />
                <h2>客户详情 · 需求摘要</h2>
              </div>
              <button className="secondary compact" onClick={() => setActiveSection('dashboard')}>
                <ArrowRight size={15} />
                <span>返回工作台</span>
              </button>
            </div>
            <div className="detail-summary-grid">
              <div className="detail-left-column">
                <div className="info-grid compact">
                  <Info label="意向" value={result.intent || '未识别'} />
                  <Info label="优先级" value={result.priority || 'medium'} />
                </div>
                <ConversationFlow lead={selectedLead} />
                <MailMeta lead={selectedLead} sending={sendingLeadId === selectedLead?.id} onSend={openReplyEditor} onPdf={downloadQuotationPdf} onCopy={copyText} copied={copied} />
              </div>
              <div className="detail-right-column">
                <div className="info-grid">
                  <Info label="客户" value={getCustomerName(result)} />
                  <Info label="国家" value={result.customer?.country || '未识别'} />
                  <Info label="线索质量" value={qualityLabels[result.leadQuality?.type] || result.leadQuality?.type || '未判断'} />
                  <Info label="建议动作" value={result.leadQuality?.recommendedAction || '未提供'} />
                  <Info label="数量" value={result.requirements?.quantity || '未提供'} />
                  <Info label="交期" value={result.requirements?.leadTime || '未提供'} />
                </div>
                <ThreadSummary lead={selectedLead} />
                <NextActionPanel
                  lead={selectedLead}
                  onCopy={copyText}
                  onSend={openReplyEditor}
                  copied={copied}
                  sending={sendingLeadId === selectedLead?.id}
                />
                <QualityPanel quality={result.leadQuality} />
                <TagBlock title="缺失信息" items={result.missingInfo} />
                <p className="notes">{result.internalNotes}</p>
              </div>
            </div>
          </div>

          <CustomerOriginalPanel lead={selectedLead} translation={customerTranslation} />

          <div className="panel">
            <div className="panel-title between">
              <div>
                <Mail size={20} />
                <h2>英文邮件草稿</h2>
              </div>
              <button className="secondary" onClick={() => copyText(`${result.emailSubject}\n\n${result.emailReply}`, 'email')}>
                {copied === 'email' ? <ClipboardCheck size={17} /> : <Clipboard size={17} />}
                <span>{copied === 'email' ? '已复制' : '复制邮件'}</span>
              </button>
            </div>
            <div className="email-box">
              <strong>{result.emailSubject}</strong>
              <pre>{result.emailReply}</pre>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title between">
              <div>
                <ArrowRight size={20} />
                <h2>报价与跟进</h2>
              </div>
              <div className="panel-actions">
                <button className="secondary" onClick={() => copyText(buildQuotationText(result), 'quote')}>
                  {copied === 'quote' ? <ClipboardCheck size={17} /> : <Clipboard size={17} />}
                  <span>{copied === 'quote' ? '已复制' : '复制报价'}</span>
                </button>
                <button className="icon-button" onClick={() => downloadText('quotation.txt', buildQuotationText(result))} title="下载报价单">
                  <Download size={17} />
                </button>
                <button className="icon-button" onClick={exportQuotationWorkbook} title="导出 Excel 报价单">
                  <FileSpreadsheet size={17} />
                </button>
                <button className="icon-button" onClick={() => downloadQuotationPdf(selectedLead || { result })} title="下载 PDF 报价单">
                  <FileText size={17} />
                </button>
              </div>
            </div>
            <div className="quote-list">
              {(result.quotationDraft?.items || []).length ? (
                result.quotationDraft.items.map((item, index) => (
                  <div className="quote-item" key={`${item.product}-${index}`}>
                    <strong>{item.product || '待确认产品'}</strong>
                    <span>{item.unitPrice || '价格待确认'}</span>
                    <small>{item.quantity || '数量未提供'} · {item.remarks || '无备注'}</small>
                  </div>
                ))
              ) : (
                <div className="empty compact">当前模式暂停详细报价。</div>
              )}
            </div>
            <div className="follow-list">
              {(result.followUpPlan || []).map((item, index) => (
                <div key={`${item.day}-${index}`}>
                  <RefreshCw size={16} />
                  <span>第 {item.day} 天：{item.action}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {activeSection === 'replies' ? (
      <section className="panel leads section-block" id="section-replies">
        <div className="panel-title between">
          <div>
            <MailCheck size={20} />
            <h2>客户回信</h2>
          </div>
          <span className={`saved-pill ${replyInboxLeads.length ? 'alert-pill' : ''}`}>{replyInboxLeads.length} 封待处理</span>
        </div>

        {replyInboxLeads.length === 0 ? (
          <div className="empty">暂无新的客户回信。已成交或已丢单的线索会自动从这里移除。</div>
        ) : (
          <div className="lead-list reply-inbox-list">
            {replyInboxLeads.map((lead) => {
              const reply = latestCustomerReply(lead);
              const action = nextActionForLead(lead);
              return (
                <div className={`lead-row reply-row quality-${lead.quality || 'unknown'} bucket-${leadBoardBucket(lead)} ${lead.id === state.selectedLeadId ? 'selected' : ''}`} key={lead.id}>
                  <button className="lead-main" onClick={() => viewLead(lead)}>
                    <strong>
                      {lead.customer}
                      <em>{formatDateTime(reply?.date || lead.updatedAt)}</em>
                    </strong>
                    <span>{reply?.subject || lead.subject || '客户回信'} · {reply?.from || lead.contact || '未知发件人'}</span>
                    <small>{reply?.preview || action.detail}</small>
                  </button>
                  <select value={lead.status} onChange={(event) => updateLead(lead.id, event.target.value)}>
                    {statuses.map((status) => (
                      <option key={status} value={status}>{displayStatus(status)}</option>
                    ))}
                  </select>
                  <button className="secondary compact" onClick={() => viewLead(lead)}>
                    <Eye size={16} />
                    <span>处理</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      ) : null}

      {activeSection === 'leads' ? (
      <section className="panel leads section-block" id="section-leads">
        <div className="panel-title between">
          <div>
            <CheckCircle2 size={20} />
            <h2>客户线索库</h2>
          </div>
          <span className="saved-pill">{filteredLeads.length}/{state.leads.length}</span>
        </div>

        <div className="lead-board" id="section-risk">
          {boardBuckets.map((bucket) => (
            <button
              className={`board-card ${state.leadFilter === bucket.id ? 'active' : ''}`}
              key={bucket.id}
              onClick={() => setLeadFilter(bucket.id)}
            >
              <span>{bucket.label}</span>
              <strong>{bucket.count}</strong>
              <small>{bucket.top?.customer || bucket.hint}</small>
            </button>
          ))}
        </div>

        <div className="history-tools">
          <label className="search-box">
            <Search size={17} />
            <input value={state.leadQuery} onChange={(event) => setLeadQuery(event.target.value)} placeholder="搜索客户、国家、邮箱、产品或原始询盘" />
          </label>
          <select value={state.leadFilter} onChange={(event) => setLeadFilter(event.target.value)}>
            <option value="all">全部线索</option>
            <option value="new">新询盘</option>
            <option value="waiting">已回复，待客户回复</option>
            <option value="replied">客户已回复</option>
            <option value="risk">风险核查</option>
            <option value="二次风险升级">二次风险升级</option>
            <option value="silent">已沉默</option>
            <option value="closed">已结束</option>
            <option value="qualified">有效客户</option>
            <option value="low_intent">低意向</option>
            <option value="competitor">疑似同行</option>
            <option value="scam">疑似诈骗</option>
            <option value="spam">垃圾/骚扰</option>
            <option value="人工核查">人工核查</option>
            <option value="已成交">已成交</option>
          </select>
        </div>

        {filteredLeads.length === 0 ? (
          <div className="empty">还没有匹配的历史记录。分析一封询盘后会自动保存到这里。</div>
        ) : (
          <div className="lead-list">
            {filteredLeads.map((lead) => (
              <div className={`lead-row quality-${lead.quality || 'unknown'} bucket-${leadBoardBucket(lead)} ${lead.id === state.selectedLeadId ? 'selected' : ''}`} key={lead.id}>
                <button className="lead-main" onClick={() => viewLead(lead)}>
                  <strong>
                    {lead.customer}
                    <em>{lead.source || '手动粘贴'}</em>
                  </strong>
                  <span>{displayStatus(lead.status)} · {qualityLabels[lead.quality] || lead.quality || '未判断'} · {lead.country || '未知国家'} · {lead.intent || '未记录意向'} · {lead.createdAt}</span>
                </button>
                <select value={lead.status} onChange={(event) => updateLead(lead.id, event.target.value)}>
                  {statuses.map((status) => (
                    <option key={status} value={status}>{displayStatus(status)}</option>
                  ))}
                </select>
                <button className="icon-button" onClick={() => viewLead(lead)} title="查看详情">
                  <Eye size={17} />
                </button>
                <button className="icon-button danger" onClick={(event) => { event.stopPropagation(); removeLead(lead); }} title="删除线索">
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      ) : null}
        </div>
        {replyEditor ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="mail-editor-modal reply-editor-modal">
              <div className="panel-title between">
                <div>
                  <Mail size={20} />
                  <h2>人工编辑邮件</h2>
                </div>
                <button className="secondary compact" onClick={() => setReplyEditor(null)}>关闭</button>
              </div>
              <div className="translation-panel">
                <div>
                  <strong>
                    {replyEditor.drafting
                      ? 'AI 正在检查客户回信并生成报价草稿...'
                      : replyEditor.translating
                        ? '正在翻译客户邮件和回复草稿...'
                        : `客户语言：${replyEditor.detectedLanguage || '自动识别'}`}
                  </strong>
                  {replyEditor.translationError ? <small>{replyEditor.translationError}</small> : null}
                </div>
                {replyEditor.customerChinese ? (
                  <div className="translation-box">
                    <span>客户回信中文译文</span>
                    <p>{replyEditor.customerChinese}</p>
                  </div>
                ) : null}
                {replyEditor.replyChinese ? (
                  <div className="translation-box">
                    <span>待发送草稿中文参考</span>
                    <p>{replyEditor.replyChinese}</p>
                  </div>
                ) : null}
              </div>
              <Field
                label="邮件主题"
                value={replyEditor.subject}
                onChange={(value) => setReplyEditor((current) => ({ ...current, subject: value }))}
                placeholder="Re: Inquiry"
              />
              <label className="field">
                <span>邮件正文</span>
                <textarea
                  className="reply-editor-body"
                  value={replyEditor.body}
                  onChange={(event) => setReplyEditor((current) => ({ ...current, body: event.target.value }))}
                  placeholder="Write the reply email here..."
                />
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={replyEditor.attachQuotationPdf}
                  disabled={!replyEditor.canAttachQuotationPdf}
                  onChange={(event) => setReplyEditor((current) => ({
                    ...current,
                    attachQuotationPdf: current.canAttachQuotationPdf ? event.target.checked : false
                  }))}
                />
                <span>{replyEditor.canAttachQuotationPdf ? '附带 PDF 报价单' : '暂无报价项，先发送文字回复'}</span>
              </label>
              <div className="modal-actions">
                <button className="secondary" onClick={() => setReplyEditor(null)}>取消</button>
                <button className="primary compact" onClick={sendEditedReply} disabled={sendingLeadId === replyEditor.leadId || replyEditor.drafting || !replyEditor.body.trim()}>
                  {sendingLeadId === replyEditor.leadId ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
                  <span>发送邮件</span>
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ThreadSummary({ lead }) {
  if (!lead) return null;
  const score = lead.result?.leadQuality?.score;
  const latestReply = latestCustomerReply(lead);
  return (
    <div className="thread-summary">
      <div>
        <span>当前阶段</span>
        <strong>{displayStatus(lead.status)}</strong>
      </div>
      <div>
        <span>来源邮箱</span>
        <strong>{lead.mail?.accountLabel || lead.mail?.accountId || lead.source || '手动粘贴'}</strong>
      </div>
      <div>
        <span>评分</span>
        <strong>{score ? `${score}/100` : '未评分'}</strong>
      </div>
      <div>
        <span>最近客户动作</span>
        <strong>{latestReply ? formatDateTime(latestReply.date) : '暂无回信'}</strong>
      </div>
    </div>
  );
}

function NextActionPanel({ lead, onCopy, onSend, copied, sending = false }) {
  if (!lead) return null;
  const action = nextActionForLead(lead);
  return (
    <div className={`next-action ${action.tone}`}>
      <div>
        <span>下一步动作</span>
        <strong>{action.title}</strong>
        <small>{action.detail}</small>
      </div>
    </div>
  );
}

function ConversationFlow({ lead }) {
  const items = conversationItems(lead);
  if (!items.length) return null;
  return (
    <div className="conversation-flow">
      <span>对话流</span>
      {items.map((item) => (
        <div className={`conversation-item ${item.direction}`} key={item.id}>
          <div>
            <strong>{item.title}</strong>
            <small>{formatDateTime(item.at)} · {item.meta || '无来源信息'}</small>
          </div>
          {item.preview ? <p>{item.preview}</p> : null}
        </div>
      ))}
    </div>
  );
}

function CustomerOriginalPanel({ lead, translation }) {
  const original = translation?.original || customerOriginalText(lead);
  if (!original) return null;
  return (
    <div className="panel customer-original-panel">
      <div className="panel-title between">
        <div>
          <Eye size={20} />
          <h2>客户原文与中文译文</h2>
        </div>
        <span className="language-pill">
          {translation?.loading ? '翻译中' : translation?.language || '自动识别'}
        </span>
      </div>
      <div className="original-translation-grid">
        <div className="original-box">
          <span>客户原文</span>
          <pre>{original}</pre>
        </div>
        <div className="original-box translated">
          <span>中文译文</span>
          {translation?.loading ? (
            <p className="muted-line">正在翻译客户原文...</p>
          ) : translation?.error ? (
            <p className="muted-line warning">{translation.error}</p>
          ) : (
            <pre>{translation?.chinese || '暂无译文。'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function MailMeta({ lead, onSend, onCopy, onPdf, copied = '', sending = false }) {
  if (!lead?.mail) return null;
  const autoReply = lead.mail.autoReply || {};
  const alreadySent = autoReply.status === 'sent';
  const canSend = (!alreadySent || hasUnansweredCustomerReply(lead)) && (lead.result?.emailReply || buildReplySuggestion(lead));
  const isManual = ['二次风险升级', '待人工核查', '人工核查'].includes(lead.status);
  const sentLog = lead.mail.sentLog?.length ? lead.mail.sentLog : alreadySent ? [autoReply] : [];
  return (
    <div className="mail-meta">
      <span>原始邮件</span>
      <div>
        <strong>{lead.mail.subject || '无主题'}</strong>
        <small>From: {lead.mail.from || '未知发件人'}</small>
        <small>To: {lead.mail.to || '未知收件人'}</small>
        <small>Date: {lead.mail.date ? new Date(lead.mail.date).toLocaleString('zh-CN') : '未提供'}</small>
        <small>自动回复：{alreadySent ? `已发送至 ${autoReply.to}` : autoReply.reason || '未发送'}</small>
        {sentLog.length ? (
          <small>发件日志：{sentLog.map((item) => `${item.mode || 'auto'} ${new Date(item.sentAt).toLocaleString('zh-CN')}`).join('；')}</small>
        ) : null}
        {lead.followUps?.length ? (
          <div className="followup-status">
            {lead.followUps.map((item) => (
              <small key={item.id || item.stage}>
                {item.label || item.stage}：{item.status}
                {item.dueAt ? ` · ${new Date(item.dueAt).toLocaleString('zh-CN')}` : ''}
              </small>
            ))}
          </div>
        ) : null}
        {lead.customerReplies?.length ? (
          <div className="timeline-box">
            <span>客户回复</span>
            {lead.customerReplies.map((reply) => (
              <small key={reply.messageId || reply.date}>
                {new Date(reply.date).toLocaleString('zh-CN')} · {reply.from} · {reply.subject || '无主题'}
                {reply.riskReview?.blocked ? ' · 二次风险升级' : ''}
              </small>
            ))}
          </div>
        ) : null}
        {lead.followUpRisk ? (
          <div className={`risk-review ${lead.followUpRisk.blocked ? 'blocked' : ''}`}>
            <span>{lead.followUpRisk.blocked ? '二次风险升级' : '后续邮件风控'}</span>
            <small>{lead.followUpRisk.note}</small>
          </div>
        ) : null}
        {lead.takeoverSuggestion ? (
          <div className="takeover-box">
            <div>
              <span>人工接管建议</span>
              <button className="secondary compact" onClick={() => onCopy?.(lead.takeoverSuggestion, `takeover-${lead.id}`)}>
                {copied === `takeover-${lead.id}` ? <ClipboardCheck size={15} /> : <Clipboard size={15} />}
                <span>{copied === `takeover-${lead.id}` ? '已复制' : '复制'}</span>
              </button>
            </div>
            <pre>{lead.takeoverSuggestion}</pre>
          </div>
        ) : null}
        {canSend ? (
          <div className="mail-actions">
            <button className="soft-primary" onClick={() => onSend?.(lead, { force: true })} disabled={sending}>
              {sending ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
              <span>编辑并发送</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QualityPanel({ quality }) {
  if (!quality) return null;
  const type = quality.type || 'unknown';
  const mode = quality.safeReplyMode || '';
  return (
    <div className={`quality ${type}`}>
      <div>
        <ShieldAlert size={17} />
        <strong>{qualityLabels[type] || type}</strong>
        <span>{quality.score ? `评分 ${quality.score}/100` : '未评分'}</span>
        <span>{replyModeLabels[mode] || mode}</span>
      </div>
      {quality.reasons?.length ? (
        <ul>
          {quality.reasons.map((reason) => (
            <li key={reason}>{translateRiskReason(reason)}</li>
          ))}
        </ul>
      ) : null}
      {quality.scoreBreakdown ? <ScoreBreakdown breakdown={quality.scoreBreakdown} /> : null}
      {quality.verificationTasks?.length ? (
        <div className="verification-list">
          <span>身份核验清单</span>
          {quality.verificationTasks.map((task) => (
            <div key={task.id}>
              <strong>{task.label}</strong>
              <small>{task.method}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ScoreBreakdown({ breakdown }) {
  const metrics = [
    ['身份可信度', breakdown.identityConfidence ?? breakdown.buyerFit],
    ['采购意图', breakdown.purchaseIntent],
    ['成交准备', breakdown.dealReadiness],
    ['商业价值', breakdown.commercialValue],
    ['网络安全', breakdown.cyberSafety ?? breakdown.riskSafety],
    ['付款物流安全', breakdown.paymentSafety ?? breakdown.riskSafety],
    ['自动化置信度', breakdown.automationConfidence ?? breakdown.riskSafety]
  ];

  return (
    <div className="score-breakdown">
      <div>
        <span>{breakdown.tier || '未分层'}</span>
        <small>{breakdown.model || 'market scoring'}</small>
      </div>
      {metrics.map(([label, value]) => (
        <div className="score-row" key={label}>
          <span>{label}</span>
          <meter min="0" max="100" value={Number(value || 0)} />
          <strong>{Number(value || 0)}</strong>
        </div>
      ))}
    </div>
  );
}

function TagBlock({ title, items = [] }) {
  if (!items.length) return null;
  return (
    <div className="tag-block">
      <span>{title}</span>
      <div>
        {items.map((item) => (
          <em key={item}>{item}</em>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
