import { applyRiskGuard, enrichRiskSignalsWithDomainAge, enrichRiskSignalsWithVat, findRiskSignals } from './risk.js';
import { getAISettings } from './settingsStore.js';

function productLinesFrom(products) {
  return Array.isArray(products)
    ? products
        .filter((item) => item?.name)
        .map((item) => `- ${item.name}; SKU: ${item.sku || 'N/A'}; Price: ${item.price || 'N/A'}; MOQ: ${item.moq || 'N/A'}; Lead time: ${item.leadTime || 'N/A'}; Notes: ${item.notes || 'N/A'}`)
        .join('\n')
    : '';
}

function buildPrompt({ inquiry, products, companyProfile, riskSignals }) {
  const productLines = productLinesFrom(products);
  const riskLines = riskSignals.map((risk) => `- [${risk.severity}] ${risk.text}`).join('\n');

  return `
You are a senior export sales assistant and cautious trade-risk reviewer. Analyze the inquiry and product data.

Company profile:
${companyProfile || 'Not provided'}

Product data:
${productLines || 'Not provided'}

Customer inquiry:
${inquiry}

Rule-based precheck signals:
${riskLines || 'No obvious rule-based risk signals.'}

Instructions:
1. Return JSON only. No Markdown.
2. Write the email reply in professional, concise B2B English.
3. First classify lead quality, then decide whether to quote.
4. Do not treat small-company traits or unverified-but-provided identity fields as fraud by themselves. Website under construction, private business email, DDP request, PayPal/card deposit, first-time buyer, self-reported HRB, and self-reported VAT should not be penalized unless a negative fact is found.
5. Any seller-paid validation fee, activation fee, certification fee, refundable fee, payment portal, payment link, or required third-party fee is "scam" and must use "manual_review".
6. Free supplier registration that asks for business license or bank details is not automatically scam, but it requires manual_review and verification before clicking links or submitting sensitive data.
7. If buyer asks for 70% after receiving/inspecting goods, do not mark scam by itself. Recommend safer terms.
8. Missing external verification is not a negative signal by itself. Only penalize concrete negative findings, such as young domain age, invalid VAT, domain mismatch, third-party payment, phishing links, seller-paid fees, unsafe payment terms, or unverifiable portal/forwarder.
9. safeReplyMode: full_quote means normal quote; ask_more means request missing info; standard_reply means conservative reply; ignore means no reply; manual_review means hold detailed quote.

JSON schema:
{
  "customer": {
    "name": "",
    "company": "",
    "country": "",
    "contact": ""
  },
  "intent": "",
  "priority": "high | medium | low",
  "leadQuality": {
    "type": "qualified | low_intent | competitor | scam | spam",
    "score": 0,
    "reasons": [],
    "recommendedAction": "",
    "safeReplyMode": "full_quote | ask_more | standard_reply | ignore | manual_review",
    "verificationTasks": [
      {
        "id": "",
        "label": "",
        "method": "",
        "status": "pending"
      }
    ]
  },
  "requirements": {
    "products": [],
    "quantity": "",
    "targetPrice": "",
    "destination": "",
    "leadTime": "",
    "certifications": []
  },
  "matchedProducts": [
    {
      "name": "",
      "sku": "",
      "price": "",
      "moq": "",
      "leadTime": "",
      "reason": ""
    }
  ],
  "quotationDraft": {
    "currency": "",
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
  "emailSubject": "",
  "emailReply": "",
  "followUpPlan": [
    {
      "day": 3,
      "action": ""
    }
  ],
  "missingInfo": [],
  "internalNotes": ""
}
`;
}

export async function analyzeInquiry({ inquiry, products = [], companyProfile = '' }) {
  const aiSettings = getAISettings();
  if (!aiSettings.apiKey) {
    const error = new Error('Please configure DEEPSEEK_API_KEY in .env.');
    error.status = 400;
    throw error;
  }

  if (!inquiry || typeof inquiry !== 'string') {
    const error = new Error('Please provide the customer inquiry.');
    error.status = 400;
    throw error;
  }

  const domainSignals = await enrichRiskSignalsWithDomainAge(findRiskSignals(inquiry, products), inquiry);
  const riskSignals = await enrichRiskSignalsWithVat(domainSignals, inquiry);
  const prompt = buildPrompt({ inquiry, products, companyProfile, riskSignals });

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.DEEPSEEK_TIMEOUT_MS || 45000));
  try {
    response = await fetch('https://api.deepseek.com/chat/completions', {
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
            content: 'You are a rigorous export sales AI assistant. Return valid JSON only.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2
      })
    });
  } catch (error) {
    const wrapped = new Error(error.name === 'AbortError' ? 'DeepSeek request timed out. Please retry later.' : `DeepSeek network request failed: ${error.message || 'network unavailable'}`);
    wrapped.status = 502;
    wrapped.detail = error.message;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text();
    const error = new Error('DeepSeek request failed.');
    error.status = response.status;
    error.detail = detail;
    throw error;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  return applyRiskGuard(parsed, riskSignals, { inquiry });
}
