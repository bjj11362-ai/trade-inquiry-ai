import { loadMailState, saveMailState } from './mailStore.js';
import { getAISettings } from './settingsStore.js';

function productLinesFrom(products) {
  return Array.isArray(products)
    ? products
        .filter((item) => item?.name)
        .map((item) => `- ${item.name}; SKU: ${item.sku || 'N/A'}; Price: ${item.price || 'N/A'}; MOQ: ${item.moq || 'N/A'}; Lead time: ${item.leadTime || 'N/A'}; Notes: ${item.notes || 'N/A'}`)
        .join('\n')
    : '';
}

function latestCustomerReply(lead) {
  return (lead?.customerReplies || [])[0] || null;
}

function parseJsonObject(text = '') {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
  }
  return null;
}

function buildPrompt({ lead, products, companyProfile }) {
  const latestReply = latestCustomerReply(lead);
  const result = lead.result || {};
  const productLines = productLinesFrom(products);
  const existingQuote = JSON.stringify(result.quotationDraft || {}, null, 2);
  const latestReplyText = [
    latestReply?.subject ? `Subject: ${latestReply.subject}` : '',
    latestReply?.from ? `From: ${latestReply.from}` : '',
    latestReply?.preview || ''
  ].filter(Boolean).join('\n');

  return `
You are a senior export sales assistant. Generate the next customer-facing reply after reading the full thread.

Company profile:
${companyProfile || 'Not provided'}

Product library:
${productLines || 'Not provided'}

Original inquiry:
${lead.inquiry || ''}

Existing analysis:
${JSON.stringify({
    customer: result.customer,
    requirements: result.requirements,
    matchedProducts: result.matchedProducts,
    leadQuality: result.leadQuality,
    missingInfo: result.missingInfo
  }, null, 2)}

Existing quotation draft:
${existingQuote}

Latest customer reply:
${latestReplyText || '(No latest reply)'}

Rules:
1. Return JSON only. No Markdown.
2. The reply must be customer-facing and ready to send.
3. If the latest customer reply provides destination, Incoterm, quantity, logo method/artwork, and packaging, treat those fields as confirmed. Do NOT ask for them again.
4. If the buyer asks for an updated quote and enough details are available, generate a revised quotationDraft with at least one item.
5. Use product library prices where possible. If exact price depends on final confirmation, use the product library price/range and mark remarks clearly.
6. Do not invent bank details, payment links, URLs, attachments, certificates, or guarantees.
7. Keep the reply concise, professional, and in English. Translation to customer language is handled later.
8. If there is a high-risk latest reply, use a safe holding reply and do not include detailed quotation. Otherwise, quote normally.
9. Set canAttachQuotationPdf true only when quotationDraft.items is non-empty.

Return JSON:
{
  "emailSubject": "",
  "emailReply": "",
  "quotationDraft": {
    "currency": "USD",
    "items": [
      {
        "product": "",
        "unitPrice": "",
        "quantity": "",
        "subtotal": "",
        "remarks": ""
      }
    ],
    "terms": ""
  },
  "requirementsPatch": {
    "quantity": "",
    "destination": "",
    "leadTime": "",
    "certifications": []
  },
  "missingInfo": [],
  "internalNotes": "",
  "canAttachQuotationPdf": false,
  "quoteReady": false
}
`;
}

async function callDeepSeekJson(prompt) {
  const aiSettings = getAISettings();
  if (!aiSettings.apiKey) {
    const error = new Error('Please configure AI API key before drafting replies.');
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEEPSEEK_TIMEOUT_MS || 45000));
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${aiSettings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: aiSettings.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You generate accurate B2B export follow-up replies and quotation drafts. Return valid JSON only.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error('AI follow-up draft request failed.');
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    const data = await response.json();
    return parseJsonObject(data.choices?.[0]?.message?.content || '{}') || {};
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeQuotationDraft(value, fallback = {}) {
  const items = Array.isArray(value?.items) ? value.items.filter((item) => item?.product || item?.unitPrice || item?.quantity) : [];
  return {
    currency: value?.currency || fallback.currency || 'USD',
    items: items.map((item) => ({
      product: item.product || 'Product to be confirmed',
      unitPrice: item.unitPrice || 'To be confirmed',
      quantity: item.quantity || '',
      subtotal: item.subtotal || '',
      remarks: item.remarks || ''
    })),
    terms: value?.terms || fallback.terms || 'To be confirmed'
  };
}

function extractQuantity(text = '') {
  const match = String(text).match(/([\d,，.]+)\s*(pcs|pieces|件|个|只|units?)/i);
  return match ? `${match[1].replace('，', ',')} ${match[2]}` : '';
}

function extractConfirmedTradeTerm(lead) {
  const latest = latestCustomerReply(lead);
  const text = `${latest?.preview || ''}\n${latest?.subject || ''}`;
  if (/fob/i.test(text) && /宁波|ningbo|瀹佹尝/i.test(text)) return 'FOB Ningbo';
  if (/fob/i.test(text) && /上海|shanghai/i.test(text)) return 'FOB Shanghai';
  if (/fob[\s:：-]*宁波|fob[\s:：-]*ningbo|FOB宁波/i.test(text)) return 'FOB Ningbo';
  if (/fob[\s:：-]*上海|fob[\s:：-]*shanghai|FOB上海/i.test(text)) return 'FOB Shanghai';
  if (/cif\s*hamburg/i.test(text)) return 'CIF Hamburg';
  if (/ddp\s*berlin/i.test(text)) return 'DDP Berlin';
  const match = text.match(/\b(EXW|FOB|CIF|DDP)\b\s*([A-Za-z\u4e00-\u9fff-]+)?/i);
  return match ? [match[1].toUpperCase(), match[2] || ''].join(' ').trim() : '';
}

function shouldFallbackQuote(lead) {
  const latest = latestCustomerReply(lead);
  const text = `${latest?.subject || ''}\n${latest?.preview || ''}`.toLowerCase();
  return /quote|quotation|报价|更新后的报价|provide.*price|unit price|fob|ddp|cif/.test(text);
}

function ensureQuotationItems({ lead, quotationDraft, products }) {
  if (quotationDraft.items.length || !shouldFallbackQuote(lead)) return quotationDraft;
  const product = (products || []).find((item) => item?.name) || {};
  const latest = latestCustomerReply(lead);
  const text = `${latest?.preview || ''}\n${lead.inquiry || ''}`;
  const quantity = extractQuantity(text) || lead.result?.requirements?.quantity || '';
  const fallbackProduct = lead.result?.requirements?.products?.[0]?.name || lead.result?.matchedProducts?.[0]?.name || product.name || 'Stainless steel insulated bottle';
  const unitPrice = product.price || lead.result?.matchedProducts?.[0]?.price || 'To be confirmed';
  return {
    ...quotationDraft,
    currency: quotationDraft.currency || 'USD',
    items: [
      {
        product: fallbackProduct,
        unitPrice,
        quantity,
        subtotal: '',
        remarks: [
          product.sku ? `SKU: ${product.sku}` : '',
          product.moq ? `MOQ: ${product.moq}` : '',
          product.leadTime ? `Lead time: ${product.leadTime}` : '',
          'Final price subject to confirmed specification, logo artwork, packaging, and current material cost.'
        ].filter(Boolean).join('; ')
      }
    ],
    terms: quotationDraft.terms || 'FOB China port; payment terms and sample cost to be confirmed.'
  };
}

function latestReplyConfirmsCoreInfo(lead) {
  const latest = latestCustomerReply(lead);
  const text = `${latest?.preview || ''}\n${latest?.subject || ''}`.toLowerCase();
  const hasQuantity = /([\d,，.]+)\s*(pcs|pieces|件|个|只|units?)/i.test(text);
  const hasTerm = /\b(fob|cif|ddp|exw)\b|贸易术语|宁波|shanghai|ningbo/i.test(text);
  const hasLogo = /logo|artwork|laser|engraving|标志|图稿|激光/i.test(text);
  const hasPackaging = /packaging|package|box|carton|包装|礼品盒|外箱/i.test(text);
  return hasQuantity && hasTerm && hasLogo && hasPackaging;
}

function replyStillAsksConfirmedInfo(text = '') {
  const value = String(text).toLowerCase();
  return /please confirm (the )?(destination|preferred incoterm|quantity|logo|artwork|packaging)|请确认(目的地|贸易术语|数量|标志|图稿|包装)/i.test(value);
}

function buildQuoteReply({ lead, quotationDraft }) {
  const customerName = lead.result?.customer?.name || 'Sir/Madam';
  const itemLines = quotationDraft.items.map((item) => (
    `- ${item.product}: ${item.unitPrice || 'To be confirmed'}; quantity: ${item.quantity || 'as confirmed'}${item.remarks ? `; ${item.remarks}` : ''}`
  )).join('\n');
  return `Dear ${customerName},

Thank you for your confirmation.

Based on the details you provided, we have updated the quotation as follows:

${itemLines}

Trade term: ${quotationDraft.terms || 'FOB Ningbo, subject to final confirmation.'}

The above quotation is based on the confirmed quantity, logo method, and packaging requirement. Please review it and let us know if you would like us to prepare samples or update any specification.

Best regards,
Sales Team`;
}

function enforceConfirmedTradeTerm({ lead, body, quotationDraft }) {
  const confirmedTerm = extractConfirmedTradeTerm(lead);
  if (!confirmedTerm) return { body, quotationDraft };
  const normalizedBody = String(body || '')
    .replace(/FOB\s+Shanghai/gi, confirmedTerm)
    .replace(/FOB上海/gi, confirmedTerm)
    .replace(/FOB\s+Ningbo/gi, confirmedTerm)
    .replace(/\(FOB\)/gi, `(${confirmedTerm})`)
    .replace(/\bFOB\b(?!\s+(Ningbo|Shanghai))/gi, confirmedTerm);
  const normalizedTerms = quotationDraft.terms
    ? String(quotationDraft.terms)
        .replace(/FOB\s+Shanghai/gi, confirmedTerm)
        .replace(/FOB上海/gi, confirmedTerm)
        .replace(/\bFOB\b(?!\s+(Ningbo|Shanghai))/gi, confirmedTerm)
    : confirmedTerm;
  return {
    body: normalizedBody.includes(confirmedTerm) ? normalizedBody : `${normalizedBody}\n\nTrade term: ${confirmedTerm}`,
    quotationDraft: {
      ...quotationDraft,
      terms: normalizedTerms.includes(confirmedTerm) ? normalizedTerms : `${confirmedTerm}; ${normalizedTerms}`,
      items: quotationDraft.items.map((item) => ({
        ...item,
        remarks: (() => {
          const remarks = String(item.remarks || '')
            .replace(/FOB\s+Shanghai/gi, confirmedTerm)
            .replace(/FOB上海/gi, confirmedTerm)
            .replace(/\bFOB\b(?!\s+(Ningbo|Shanghai))/gi, confirmedTerm);
          return remarks.includes(confirmedTerm) ? remarks : [confirmedTerm, remarks].filter(Boolean).join('; ');
        })()
      }))
    }
  };
}

export async function draftLeadReply(leadId) {
  const state = await loadMailState();
  const leadIndex = (state.leads || []).findIndex((lead) => lead.id === leadId);
  if (leadIndex < 0) {
    const error = new Error('Lead not found.');
    error.status = 404;
    throw error;
  }

  const lead = state.leads[leadIndex];
  const products = lead.productsSnapshot?.length ? lead.productsSnapshot : state.context?.products || [];
  const prompt = buildPrompt({ lead, products, companyProfile: state.context?.companyProfile || '' });
  const draft = await callDeepSeekJson(prompt);

  const normalizedQuotation = normalizeQuotationDraft(draft.quotationDraft, lead.result?.quotationDraft);
  const nextQuotation = ensureQuotationItems({ lead, quotationDraft: normalizedQuotation, products });
  const generatedBody = draft.emailReply || lead.result?.emailReply || '';
  const shouldReplaceBody = nextQuotation.items.length && latestReplyConfirmsCoreInfo(lead) && (!generatedBody.trim() || replyStillAsksConfirmedInfo(generatedBody));
  const nextBody = shouldReplaceBody ? buildQuoteReply({ lead, quotationDraft: nextQuotation }) : generatedBody;
  const termSafe = enforceConfirmedTradeTerm({ lead, body: nextBody, quotationDraft: nextQuotation });
  const nextResult = {
    ...(lead.result || {}),
    requirements: {
      ...(lead.result?.requirements || {}),
      ...(draft.requirementsPatch || {})
    },
    quotationDraft: termSafe.quotationDraft,
    emailSubject: draft.emailSubject || lead.result?.emailSubject || `Re: ${lead.subject || lead.mail?.subject || 'Inquiry'}`,
    emailReply: termSafe.body,
    missingInfo: Array.isArray(draft.missingInfo) ? draft.missingInfo : lead.result?.missingInfo || [],
    internalNotes: draft.internalNotes || lead.result?.internalNotes || lead.notes || ''
  };
  const nextLead = {
    ...lead,
    updatedAt: Date.now(),
    status: lead.followUpRisk?.blocked ? lead.status : '客户已回复',
    result: nextResult,
    draftMeta: {
      generatedAt: new Date().toISOString(),
      quoteReady: Boolean(draft.quoteReady || nextQuotation.items.length),
      canAttachQuotationPdf: Boolean(draft.canAttachQuotationPdf || nextQuotation.items.length)
    }
  };
  state.leads[leadIndex] = nextLead;
  await saveMailState(state);

  return {
    lead: nextLead,
    draft: {
      subject: nextResult.emailSubject,
      body: nextResult.emailReply,
      canAttachQuotationPdf: nextLead.draftMeta.canAttachQuotationPdf,
      attachQuotationPdf: nextLead.draftMeta.canAttachQuotationPdf,
      quoteReady: nextLead.draftMeta.quoteReady
    }
  };
}
