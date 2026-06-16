import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRiskGuard, enrichRiskSignalsWithDomainAge, enrichRiskSignalsWithVat, findRiskSignals, translateRiskReason } from '../server/risk.js';

const products = [
  {
    name: 'Insulated Tumbler 600ml',
    sku: 'TB-600',
    price: 'USD 3.20-4.10 / pc',
    moq: '300 pcs',
    leadTime: '18-28 days',
    notes: 'Double wall vacuum'
  }
];

function baseModelResult(score = 70) {
  return {
    customer: { name: 'Buyer', company: 'Buyer Co', country: 'Germany', contact: '' },
    intent: 'RFQ',
    priority: 'medium',
    leadQuality: {
      type: 'qualified',
      score,
      reasons: ['Product requirements are detailed.'],
      recommendedAction: 'Send quotation.',
      safeReplyMode: 'full_quote'
    },
    quotationDraft: {
      currency: 'USD',
      items: [{ product: 'Insulated Tumbler 600ml', unitPrice: 'USD 3.20-4.10', quantity: '1000', subtotal: '', remarks: '' }],
      terms: 'FOB Ningbo'
    },
    emailSubject: 'Re: RFQ',
    emailReply: 'Dear Buyer, thank you for your inquiry.',
    followUpPlan: [],
    missingInfo: [],
    internalNotes: ''
  };
}

test('common positive risk reasons are displayed in Chinese', () => {
  assert.equal(
    translateRiskReason('New company but clear product specifications and quantity'),
    '对方可能是新客户/新公司，但产品规格和数量清楚，这本身不是风险信号。'
  );
  assert.equal(
    translateRiskReason('Professional inquiry with detailed requirements'),
    '询盘表达专业，需求细节较完整。'
  );
  assert.equal(
    translateRiskReason('No negative signals found'),
    '未发现明显负面风险信号。'
  );
  assert.equal(
    translateRiskReason('First-time overseas sourcing, but not a scam indicator'),
    '首次海外采购本身不是诈骗信号，仍按正常新客户流程核查。'
  );
});

test('seller-paid supplier validation fee is forced to scam and quote is held', () => {
  const inquiry = `
    We are Triton Handels GmbH. Please quote 1000 pcs bottles.
    To activate you as vendor, we need a refundable supplier validation fee of EUR 49.
    I will send a secure payment portal link after quotation.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.equal(result.leadQuality.type, 'scam');
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
  assert.equal(result.quotationDraft.items.length, 0);
  assert.match(result.emailReply, /do not click external payment links/i);
});

test('small business with free portal and risky payment terms is manual review, not scam', () => {
  const inquiry = `
    From: Michael Schneider m.schneider@online-home.de
    I am founder of Schneider Home & Living. Our website is www.schneider-home.de still under construction,
    but our Impressum is online. Registered at Amtsgericht Charlottenburg, HRB 234567.
    Please quote 1,000 pcs DDP Berlin. Payment terms: 30% deposit by PayPal or credit card,
    and 70% after we receive the goods and inspect them.
    Supplier compliance requires registration in Lieferanten-Check. Registration is free and takes 5 minutes.
    They ask for business license and bank details for verification. Our company email is being migrated,
    so this is my private business email for now.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.equal(result.leadQuality.type, 'low_intent');
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
  assert.notEqual(result.leadQuality.type, 'scam');
  assert.match(result.emailReply, /cannot accept balance payment only after goods are received/i);
});

test('standard detailed RFQ with safe terms can remain quoteable', () => {
  const inquiry = `
    From: Anna Weber anna.weber@retail-example.de
    We are Retail Example GmbH, Berlin. Website: www.retail-example.de. VAT DE123456789.
    Please quote 1000 pcs 500ml stainless steel insulated bottles, FOB Shanghai.
    Payment terms: 30% deposit by T/T, 70% against copy of B/L.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.notEqual(result.leadQuality.type, 'scam');
  assert.notEqual(result.leadQuality.safeReplyMode, 'manual_review');
  assert.equal(result.quotationDraft.items.length, 1);
});

test('matching email and website domains avoid mismatch even with repeated email domains', () => {
  const inquiry = `
    From: Dr. Markus Hoffmann m.hoffmann@tws-logistik.de
    We are TWS Logistik & Handels GmbH. Website: www.tws-logistik.de.
    Email: m.hoffmann@tws-logistik.de. Handelsregister: HRB 41238.
    Please quote 5,000 pcs insulated bottles. Payment 30% T/T, 70% against copy of B/L.
  `;

  const risks = findRiskSignals(inquiry, products);
  assert.equal(risks.some((risk) => risk.code === 'email-website-mismatch'), false);
});

test('young domain from RDAP adds high risk signal', async () => {
  const inquiry = 'From: buyer@new-example.de Website: www.new-example.de Please quote 5000 pcs.';
  const risks = await enrichRiskSignalsWithDomainAge([], inquiry, {
    now: new Date('2026-06-09T00:00:00Z'),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        events: [{ eventAction: 'registration', eventDate: '2026-05-20T00:00:00Z' }]
      })
    })
  });

  assert.equal(risks.some((risk) => risk.code === 'young-domain-new-example.de' && risk.severity === 'high'), true);
});

test('unchecked domain age does not add a risk signal', async () => {
  const inquiry = 'From: buyer@old-example.de Website: www.old-example.de Please quote 5000 pcs.';
  const risks = await enrichRiskSignalsWithDomainAge([], inquiry, {
    fetchImpl: async () => ({ ok: false })
  });

  assert.equal(risks.some((risk) => risk.code.includes('domain-age-unchecked')), false);
});

test('HRB and VAT presence are not risk signals by themselves', () => {
  const inquiry = `
    From: Anna Weber anna.weber@retail-example.de
    Retail Example GmbH. Website: www.retail-example.de. HRB 12345. VAT DE123456789.
    Please quote 1000 pcs. Payment 30% T/T, 70% against copy of B/L.
  `;

  const risks = findRiskSignals(inquiry, products);

  assert.equal(risks.some((risk) => risk.code === 'hrb-manual-check'), false);
  assert.equal(risks.some((risk) => risk.code === 'vat-manual-check'), false);
  assert.equal(risks.some((risk) => risk.code === 'official-registry-unverified'), false);
});

test('invalid VAT from VIES adds high risk and verification task', async () => {
  const inquiry = `
    We are Hansa Trading GmbH. Website: www.hansa-trading.de. VAT DE321456789.
    Please quote 5000 pcs for a confirmed retail-chain order.
  `;
  const risks = await enrichRiskSignalsWithVat(findRiskSignals(inquiry, products), inquiry, {
    fetchImpl: async () => ({
      ok: true,
      text: async () => '<checkVatResponse><valid>false</valid></checkVatResponse>'
    })
  });
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'vat-invalid-DE321456789'), true);
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
  assert.equal(result.leadQuality.verificationTasks.some((task) => task.id === 'vat'), true);
});

test('VAT owner mismatch from VIES adds high risk', async () => {
  const inquiry = `
    We are Hansa Trading GmbH. Website: www.hansa-trading.de. VAT DE321456789.
    Please quote 5000 pcs.
  `;
  const risks = await enrichRiskSignalsWithVat(findRiskSignals(inquiry, products), inquiry, {
    fetchImpl: async () => ({
      ok: true,
      text: async () => '<checkVatResponse><valid>true</valid><name>Other Company GmbH</name></checkVatResponse>'
    })
  });

  assert.equal(risks.some((risk) => risk.code === 'vat-name-mismatch-DE321456789'), true);
});

test('free email claiming known retailer authorization is high risk', () => {
  const inquiry = `
    From: procurement.rewe@gmail.com
    We are an authorized REWE buyer and need 8000 pcs insulated bottles.
    Please quote urgently. Our official registration will follow.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'free-email-impersonates-known-buyer'), true);
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
  assert.notEqual(result.leadQuality.type, 'qualified');
});

test('third-party payment and phishing payment link are critical scam signals', () => {
  const inquiry = `
    Please click here to open the secure link and enter your credit card in the payment portal.
    The validation payment should be sent to a different company third party account.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'phishing-credential-link'), true);
  assert.equal(risks.some((risk) => risk.code === 'third-party-payment-account'), true);
  assert.equal(result.leadQuality.type, 'scam');
});

test('unknown supplier platform and unrecognized forwarder require verification', () => {
  const inquiry = `
    We need you to register in our NewVendorTrust portal and upload business license.
    Our preferred forwarder is Baumann Logistics for pickup.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'unknown-supplier-platform'), true);
  assert.equal(risks.some((risk) => risk.code === 'unverifiable-forwarder'), true);
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
});

test('Alpine Outdoor style complete RFQ can score 100 with no negative signals', () => {
  const inquiry = `
    From: Eva Mueller e.mueller@alpine-outdoor.de
    We are Alpine Outdoor GmbH. Website: www.alpine-outdoor.de. HRB 45678. VAT DE123456789.
    Product: stainless steel insulated bottle. Capacity: 500ml. Lid: screw lid. Color: black and white.
    Packaging: kraft box. Logo: one color. Sample: we will pay sample cost and DHL shipping.
    Payment terms: 30% deposit by T/T, 70% against copy of B/L.
    Best regards,
    Eva Mueller
    Procurement Manager
    Alpine Outdoor GmbH
    Bergstrasse 10, 80331 Munich, Germany
    Tel: +49 89 123456
    Email: e.mueller@alpine-outdoor.de
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(70), risks, { inquiry });

  assert.equal(risks.length, 0);
  assert.equal(result.leadQuality.score, 100);
  assert.equal(result.leadQuality.type, 'qualified');
  assert.equal(result.leadQuality.safeReplyMode, 'full_quote');
  assert.equal(result.leadQuality.scoreBreakdown.tier, 'A1 Hot account');
});

test('advanced scoring exposes market fit intent risk dimensions', () => {
  const inquiry = `
    From: Lukas Braun l.braun@elbe-handel.de
    Elbe Handel GmbH. Website: www.elbe-handel.de. HRB 158234. VAT DE323456789.
    RFQ: 8,000 pcs 500ml 304 stainless steel insulated bottles.
    Logo: laser engraving. Packaging: white gift box. Certifications: LFGB and REACH.
    Payment: 30% deposit by T/T, 70% against copy of B/L.
    We will pay sample cost and DHL shipping. Quarterly reorder possible.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(80), risks, { inquiry });

  assert.equal(result.leadQuality.scoreBreakdown.model, 'global-b2b-risk-intent-v3');
  assert.ok(result.leadQuality.scoreBreakdown.buyerFit >= 70);
  assert.ok(result.leadQuality.scoreBreakdown.identityConfidence >= 70);
  assert.ok(result.leadQuality.scoreBreakdown.purchaseIntent >= 80);
  assert.ok(result.leadQuality.scoreBreakdown.commercialValue >= 80);
  assert.ok(result.leadQuality.scoreBreakdown.cyberSafety >= 90);
  assert.ok(result.leadQuality.scoreBreakdown.paymentSafety >= 90);
  assert.ok(result.leadQuality.scoreBreakdown.automationConfidence >= 80);
  assert.ok(result.leadQuality.score >= 90);
});

test('critical scam signal caps advanced score despite strong buying signals', () => {
  const inquiry = `
    From: Lukas Braun l.braun@elbe-handel.de
    Elbe Handel GmbH. Website: www.elbe-handel.de. HRB 158234. VAT DE323456789.
    RFQ: 8,000 pcs 500ml 304 stainless steel insulated bottles. Payment 30% deposit, 70% copy of B/L.
    Before approval, please pay a refundable supplier validation fee through our payment portal link.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(95), risks, { inquiry });

  assert.equal(result.leadQuality.type, 'scam');
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
  assert.ok(result.leadQuality.score <= 25);
  assert.ok(result.leadQuality.scoreBreakdown.riskSafety <= 10);
});

test('reply-to mismatch and urgent sensitive action force manual review', () => {
  const inquiry = `
    From: Anna Weber <anna.weber@retail-example.de>
    Reply-To: anna.procurement@secure-vendor-mail.com
    Please quote 5,000 pcs bottles urgently. Also open this verification link today for supplier setup.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(90), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'reply-to-domain-mismatch'), true);
  assert.equal(risks.some((risk) => risk.code === 'urgency-sensitive-action'), true);
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
  assert.ok(result.leadQuality.score <= 45);
  assert.ok(result.leadQuality.scoreBreakdown.cyberSafety < 60);
});

test('changed bank instructions are critical BEC risk', () => {
  const inquiry = `
    We accepted your quotation. Please note our beneficiary changed today.
    Transfer the deposit to the new bank account before shipment.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(92), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'payment-instruction-change'), true);
  assert.equal(result.leadQuality.type, 'scam');
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
});

test('short links and dangerous attachment lures are blocked', () => {
  const inquiry = `
    Please review our purchase order at https://bit.ly/vendor-po and open the attached PO.html file.
    Enable content if the document is protected.
  `;

  const risks = findRiskSignals(inquiry, products);
  const result = applyRiskGuard(baseModelResult(88), risks, { inquiry });

  assert.equal(risks.some((risk) => risk.code === 'shortened-link'), true);
  assert.equal(risks.some((risk) => risk.code === 'dangerous-attachment-lure'), true);
  assert.equal(result.leadQuality.type, 'scam');
  assert.equal(result.leadQuality.safeReplyMode, 'manual_review');
});
