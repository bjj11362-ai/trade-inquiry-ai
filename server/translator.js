import { getAISettings } from './settingsStore.js';

const LANGUAGE_NAMES = {
  zh: 'Chinese',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  ar: 'Arabic',
  tr: 'Turkish'
};

function stripHtml(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectLanguage(text = '') {
  const value = stripHtml(text);
  if (/[\u4e00-\u9fff]/.test(value)) return 'zh';
  if (/[äöüß]|\b(guten|bitte|danke|angebot|lieferzeit|zahlung|stück|anfrage)\b/i.test(value)) return 'de';
  if (/[éèêàçù]|\b(bonjour|merci|devis|livraison|paiement|quantité)\b/i.test(value)) return 'fr';
  if (/[áéíóúñ¿¡]|\b(hola|gracias|cotización|precio|entrega|pago|cantidad)\b/i.test(value)) return 'es';
  if (/[àèéìòù]|\b(buongiorno|grazie|preventivo|prezzo|consegna|pagamento)\b/i.test(value)) return 'it';
  if (/\b(olá|obrigado|cotação|preço|entrega|pagamento)\b/i.test(value)) return 'pt';
  if (/\b(hallo|bedankt|offerte|prijs|levering|betaling)\b/i.test(value)) return 'nl';
  if (/[ąćęłńóśźż]|\b(dzień dobry|wycena|cena|dostawa|płatność)\b/i.test(value)) return 'pl';
  if (/[\u3040-\u30ff]/.test(value)) return 'ja';
  if (/[\uac00-\ud7af]/.test(value)) return 'ko';
  if (/[а-яё]/i.test(value)) return 'ru';
  if (/[\u0600-\u06ff]/.test(value)) return 'ar';
  if (/[ğüşöçıİ]|\b(merhaba|teklif|fiyat|teslimat|ödeme)\b/i.test(value)) return 'tr';
  return 'en';
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

async function callDeepSeekJson(prompt) {
  const aiSettings = getAISettings();
  if (!aiSettings.apiKey) {
    const error = new Error('Please configure AI API key before translation.');
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
            content: 'You are a professional B2B export email translator. Return valid JSON only.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      })
    });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error('Translation request failed.');
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

export async function translateReplyDraft({ customerText = '', subject = '', body = '' } = {}) {
  const cleanCustomerText = stripHtml(customerText).slice(0, 6000);
  const detectedLanguage = detectLanguage(cleanCustomerText || subject || body);
  const targetLanguage = LANGUAGE_NAMES[detectedLanguage] || 'English';

  const prompt = `
Customer's latest email:
${cleanCustomerText || '(not provided)'}

Draft reply subject:
${subject || ''}

Draft reply body:
${body || ''}

Tasks:
1. Translate the customer's latest email into Simplified Chinese for a Chinese salesperson.
2. Translate or lightly polish the draft reply into the customer's detected language: ${targetLanguage}.
3. Also provide a Simplified Chinese reference version of the exact outgoing reply draft for the Chinese salesperson.
4. Keep all prices, quantities, Incoterms, product names, email addresses, dates, and technical terms accurate.
5. Keep the reply professional, concise, and natural for international B2B trade.
6. Do not add bank details, links, attachments, or commitments not present in the draft.
7. replyChinese must be a customer-facing Chinese translation of replyBody only. Do not include internal risk analysis, "do not reply" instructions, reasons, recommended actions, or verification notes unless the same wording is explicitly part of replyBody.
8. If the draft body contains internal hold/review language, convert replyBody into a neutral customer-facing holding reply and make replyChinese the Chinese translation of that neutral reply.

Return JSON:
{
  "detectedLanguage": "${detectedLanguage}",
  "detectedLanguageName": "${targetLanguage}",
  "customerChinese": "",
  "replyChinese": "",
  "replySubject": "",
  "replyBody": ""
}
`;

  const translated = await callDeepSeekJson(prompt);
  return {
    detectedLanguage,
    detectedLanguageName: targetLanguage,
    customerChinese: translated.customerChinese || '',
    replyChinese: translated.replyChinese || '',
    replySubject: translated.replySubject || subject || '',
    replyBody: translated.replyBody || body || ''
  };
}

export async function translateCustomerText({ customerText = '' } = {}) {
  const cleanCustomerText = stripHtml(customerText).slice(0, 8000);
  const detectedLanguage = detectLanguage(cleanCustomerText);
  const targetLanguage = LANGUAGE_NAMES[detectedLanguage] || 'English';

  if (!cleanCustomerText) {
    return {
      detectedLanguage,
      detectedLanguageName: targetLanguage,
      customerChinese: ''
    };
  }

  const prompt = `
Customer email text:
${cleanCustomerText}

Task:
Translate the customer email text into clear Simplified Chinese for a Chinese export salesperson.
Keep all prices, quantities, Incoterms, product names, email addresses, dates, technical terms, and risk-related wording accurate.
Do not summarize, omit buying requirements, add advice, add links, or add internal analysis.

Return JSON:
{
  "detectedLanguage": "${detectedLanguage}",
  "detectedLanguageName": "${targetLanguage}",
  "customerChinese": ""
}
`;

  const translated = await callDeepSeekJson(prompt);
  return {
    detectedLanguage,
    detectedLanguageName: targetLanguage,
    customerChinese: translated.customerChinese || ''
  };
}
