function addRisk(risks, code, severity, text) {
  if (!risks.some((risk) => risk.code === code)) {
    risks.push({ code, severity, text });
  }
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractEmailDomains(inquiry) {
  return unique(
    [...inquiry.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)].map((match) =>
      match[1].toLowerCase()
    )
  );
}

function extractWebsiteDomains(inquiry, emailDomains = []) {
  const explicitDomains = [...inquiry.matchAll(/(?:https?:\/\/|www\.)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((match) =>
    match[1].toLowerCase()
  );
  const labelledDomains = [...inquiry.matchAll(/(?:website|homepage|site|web)\s*(?:is|:)?\s*(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((match) =>
    match[1].toLowerCase()
  );

  return unique([...explicitDomains, ...labelledDomains].filter((domain) => !emailDomains.includes(domain)));
}

function domainsRelated(left, right) {
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

function hasFreeEmailDomain(emailDomains) {
  return emailDomains.some((domain) =>
    [
      'gmail.com',
      'googlemail.com',
      'yahoo.com',
      'outlook.com',
      'hotmail.com',
      'live.com',
      'icloud.com',
      'aol.com',
      'proton.me',
      'protonmail.com',
      'web.de',
      't-online.de',
      'gmx.de',
      'qq.com',
      '163.com',
      '126.com',
      'foxmail.com'
    ].includes(domain)
  );
}

function extractLinks(inquiry) {
  return unique(
    [...inquiry.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)]
      .map((match) => match[0].replace(/[),.;]+$/g, ''))
  );
}

function extractLinkDomains(inquiry) {
  return unique(
    extractLinks(inquiry)
      .map((link) => {
        try {
          return new URL(link).hostname.replace(/^www\./i, '').toLowerCase();
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );
}

function hasUrlShortenerDomain(domains) {
  return domains.some((domain) =>
    /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rebrand\.ly|shorturl\.at|s\.id|lnkd\.in)$/i.test(domain)
  );
}

function extractHeaderDomain(inquiry, label) {
  const match = inquiry.match(new RegExp(`^\\s*${label}\\s*:\\s*[^\\n<]*<?[A-Z0-9._%+-]+@([A-Z0-9.-]+\\.[A-Z]{2,})>?`, 'im'));
  return match?.[1]?.toLowerCase() || '';
}

function mentionsKnownForwarder(inquiry) {
  return /kuehne\s*\+?\s*nagel|kühne\s*\+?\s*nagel|dsv|rhenus|db schenker|dhl|gefco|pilot freight|maersk|msc|cma cgm|ups|fedex/i.test(inquiry);
}

function mentionsKnownSupplierPlatform(inquiry) {
  return /sedex|walmart|amazon|suppliercentral|supplier portal|lieferanten-check|bafa|ecovadis|tradebyte/i.test(inquiry);
}

export function extractVatIds(inquiry) {
  return unique(
    [...inquiry.matchAll(/\b([A-Z]{2})[\s.-]?([A-Z0-9]{8,12})\b/gi)]
      .map((match) => `${match[1].toUpperCase()}${match[2].replace(/[\s.-]/g, '').toUpperCase()}`)
      .filter((value) => /^[A-Z]{2}[A-Z0-9]{8,12}$/.test(value))
  );
}

export function extractDomainsForVerification(inquiry) {
  const emailDomains = extractEmailDomains(inquiry);
  const websiteDomains = extractWebsiteDomains(inquiry, emailDomains);
  return unique([...emailDomains, ...websiteDomains]);
}

export function findRiskSignals(inquiry, products = []) {
  const text = inquiry.toLowerCase();
  const risks = [];
  const emailDomains = extractEmailDomains(inquiry);
  const websiteDomains = extractWebsiteDomains(inquiry, emailDomains);
  const linkDomains = extractLinkDomains(inquiry);
  const fromDomain = extractHeaderDomain(inquiry, 'from');
  const replyToDomain = extractHeaderDomain(inquiry, 'reply-to');

  if (emailDomains.some((domain) => domain.startsWith('xn--') || domain.includes('.xn--'))) {
    addRisk(risks, 'punycode-email-domain', 'high', 'Email domain uses punycode/homograph notation; verify identity through an independent official channel.');
  }

  if (linkDomains.some((domain) => domain.startsWith('xn--') || domain.includes('.xn--'))) {
    addRisk(risks, 'punycode-link-domain', 'high', 'Message contains a punycode/homograph link domain; do not click until independently verified.');
  }

  if (hasUrlShortenerDomain(linkDomains)) {
    addRisk(risks, 'shortened-link', 'high', 'Message contains a shortened URL, which hides the destination domain; verify manually before clicking.');
  }

  if (fromDomain && replyToDomain && !domainsRelated(fromDomain, replyToDomain)) {
    addRisk(risks, 'reply-to-domain-mismatch', 'high', 'Reply-To domain differs from the From domain; this is a common business email compromise pattern.');
  }

  if (/\b(?:change|changed|updated|new)\s+(?:our\s+)?(?:bank|account|beneficiary|payment)\b|\bnew bank account\b|\bupdated beneficiary\b/i.test(inquiry)) {
    addRisk(risks, 'payment-instruction-change', 'critical', 'Message changes bank account, beneficiary, or payment instructions; verify by independent callback before any transaction.');
  }

  if (/\b(confidential|do not call|do not contact|secret|private matter)\b/i.test(inquiry) && /\b(payment|bank|transfer|invoice|portal|link)\b/i.test(inquiry)) {
    addRisk(risks, 'secrecy-pressure-payment', 'high', 'Message combines secrecy pressure with payment or link instructions, a known BEC/social-engineering pattern.');
  }

  if (/\b(urgent\w*|asap|immediately|today only|within 24 hours)\b/i.test(inquiry) && /\b(payment|bank|wire|portal|link|password|credential|verification)\b/i.test(inquiry)) {
    addRisk(risks, 'urgency-sensitive-action', 'high', 'Message creates urgency around payment, credentials, portal, or verification actions; require manual review.');
  }

  if (/\.(exe|scr|bat|cmd|js|jse|vbs|vbe|ps1|msi|iso|img|lnk|html?)\b/i.test(inquiry) && /\b(attached|attachment|download|open|review|purchase order|po|invoice)\b/i.test(inquiry)) {
    addRisk(risks, 'dangerous-attachment-lure', 'critical', 'Message references a risky executable/script/HTML attachment or download lure; do not open it.');
  }

  if (/\b(enable macros|enable content|protected view|download document|docsign|docusign|sharepoint|onedrive|google drive)\b/i.test(inquiry) && /\b(attached|invoice|purchase order|po|supplier|quotation)\b/i.test(inquiry)) {
    addRisk(risks, 'credential-or-macro-lure', 'high', 'Message uses document-sharing or macro/credential language around trade documents; verify before opening links or attachments.');
  }

  if (emailDomains.some((domain) => /-(de|uk|us|fr|it|es)\.com$/.test(domain))) {
    addRisk(risks, 'mixed-country-com-domain', 'medium', 'Email domain uses country-code wording with .com; verify company website and registration.');
  }

  if (hasFreeEmailDomain(emailDomains) && /edeka|aldi|lidl|globus|rewe|kaufland|metro|dm-drogerie|rossmann/i.test(inquiry)) {
    addRisk(risks, 'free-email-impersonates-known-buyer', 'high', 'Free email domain is used while claiming a well-known retail buyer or authorization; verify through the official company domain.');
  }

  if (/(?:we are|i am|buyer from|procurement at)\s+(?:rewe|edeka|aldi|lidl|kaufland|metro|dm|rossmann)\b/i.test(inquiry)) {
    const knownDomainClaimLooksOfficial = emailDomains.some((domain) => /(?:rewe|edeka|aldi|lidl|kaufland|metro|rossmann|dm)\./i.test(domain));
    if (!knownDomainClaimLooksOfficial) {
      addRisk(risks, 'known-retailer-direct-claim-domain-mismatch', 'high', 'Sender directly claims to be a known retailer buyer but the email domain does not match that retailer.');
    }
  }

  const hasDomainMatch =
    emailDomains.length > 0 &&
    websiteDomains.length > 0 &&
    emailDomains.some((emailDomain) => websiteDomains.some((websiteDomain) => domainsRelated(emailDomain, websiteDomain)));

  if (emailDomains.length && websiteDomains.length && !hasDomainMatch) {
    addRisk(risks, 'email-website-mismatch', 'medium', 'Email domain differs from the stated company website; ask for confirmation from the company domain.');
  }

  if (/private business email|personal email|company email.*migrat|email.*migrat|reply to this email/i.test(inquiry)) {
    addRisk(risks, 'temporary-private-email', 'medium', 'Buyer says company email is unavailable or uses a temporary/private business email; verify identity before sensitive steps.');
  }

  if (/website.*under construction|site.*under construction|still under construction|impressum.*online/i.test(inquiry)) {
    addRisk(risks, 'website-under-construction', 'low', 'Website is under construction; this is common for small businesses but needs basic verification.');
  }

  if (/website.*under maintenance|site.*under maintenance|currently under maintenance|company profile attached|profile attached/i.test(inquiry)) {
    addRisk(risks, 'website-maintenance-attachment', 'medium', 'Website maintenance or attachment-based profile can be legitimate but may also hide phishing or fake documents.');
  }

  if (!/https?:\/\/|www\.|website|homepage|vat|eori|registration|address|hrb|handelsregister|impressum/i.test(inquiry)) {
    addRisk(risks, 'missing-company-proof', 'medium', 'Inquiry lacks website, address, VAT/EORI, Impressum, or registration details.');
  }

  if (/\+\d{1,3}\s*\d{1,4}\s*1234567\b|\b1234567\b|\b000000\b|\b111111\b/.test(inquiry)) {
    addRisk(risks, 'placeholder-phone', 'medium', 'Phone number looks like a placeholder; verify independently.');
  }

  const paidFeePattern = /agent fee|customs documents fee|customs document fee|handling fee|clearance fee|certification fee|guarantee deposit|supplier validation fee|supplier verification fee|vendor validation fee|vendor verification fee|validation fee|verification fee|activation fee/i;
  const freePortalPattern = /registration is free|free registration|register.*free|free.*portal|only takes \d+ minutes|takes 5 minutes/i;

  if (paidFeePattern.test(inquiry)) {
    addRisk(risks, 'seller-paid-fee', 'critical', 'Buyer requests or implies a supplier/vendor validation, certification, activation, customs, or handling fee.');
  }

  if (/click here|secure link|payment portal|portal link/i.test(inquiry) && /password|credit card|card details|bank login|payment portal/i.test(inquiry)) {
    addRisk(risks, 'phishing-credential-link', 'critical', 'Message asks the seller to use a link involving passwords, card details, bank login, or a payment portal.');
  }

  if (/pay to|payment to|transfer to|send money to|sent to|send to/i.test(inquiry) && /third party|different company|personal account|private account|western union/i.test(inquiry)) {
    addRisk(risks, 'third-party-payment-account', 'critical', 'Payment is requested to a third party, different company, personal account, or Western Union-style channel.');
  }

  if (/refundable|deducted from your first invoice|one-time|standard procedure/i.test(inquiry) && /fee|payment|portal/i.test(inquiry)) {
    addRisk(risks, 'refundable-fee-script', 'critical', 'Refundable or deductible small fees are a common advance-fee scam pattern.');
  }

  if (/secure link|payment portal|partner portal|portal link|payment link/i.test(inquiry)) {
    addRisk(risks, 'payment-link-promised', 'critical', 'Buyer promises a payment portal or secure payment link; phishing or payment theft risk.');
  } else if (/send.*link|forward.*link/i.test(inquiry) && /portal|compliance|registration|lieferanten|supplier/i.test(inquiry)) {
    addRisk(risks, 'registration-link-promised', freePortalPattern.test(inquiry) ? 'medium' : 'high', 'Buyer will send a portal or registration link; verify domain and process before clicking.');
  }

  if (/register|registration/i.test(inquiry) && /platform|portal/i.test(inquiry) && !mentionsKnownSupplierPlatform(inquiry)) {
    addRisk(risks, 'unknown-supplier-platform', 'medium', 'Supplier registration is requested through an unknown portal or platform; verify legitimacy before submitting documents.');
  }

  if (freePortalPattern.test(inquiry) && /bank details|bank account|business license|license|verification/i.test(inquiry)) {
    addRisk(risks, 'free-portal-sensitive-data', 'high', 'Free supplier portal asks for business license or bank details; verify legitimacy before submitting sensitive data.');
  }

  if (/nominated forwarder|buyer.?s nominated forwarder|our forwarder/i.test(inquiry)) {
    addRisk(risks, 'buyer-nominated-forwarder', 'medium', 'Buyer-nominated forwarder requires logistics and pickup authorization verification.');
  } else if (/preferred forwarder|recommended .*logistics|friend recommended/i.test(inquiry)) {
    addRisk(risks, 'preferred-forwarder', 'low', 'Preferred or recommended forwarder is not automatically suspicious, but should be verified before release.');
  }

  if (/(nominated|preferred|recommended|work with|use)\s+(?:our\s+)?(?:[A-Z][A-Za-z&+.\-\s]{2,40})?(?:forwarder|logistics)/i.test(inquiry) && !mentionsKnownForwarder(inquiry)) {
    addRisk(risks, 'unverifiable-forwarder', 'medium', 'Buyer references a forwarder or logistics provider that is not recognized in the allow-list; verify before releasing goods.');
  }

  if (/70%.*after.*receive|70%.*after.*inspect|balance.*after.*goods|after we receive the goods|after quality check/i.test(inquiry)) {
    addRisk(risks, 'balance-after-receipt', 'high', 'Buyer asks to pay the balance after receiving or inspecting goods; this is risky for the seller.');
  }

  if (/paypal|credit card/i.test(inquiry) && /deposit|payment terms/i.test(inquiry)) {
    addRisk(risks, 'paypal-card-deposit', 'medium', 'PayPal or credit card deposit can create chargeback and payment risk for B2B export orders.');
  }

  if (/fob\s+hamburg/i.test(inquiry)) {
    addRisk(risks, 'incoterm-destination-mismatch', 'low', 'FOB Hamburg is likely an Incoterms mismatch for China export; clarify FOB Ningbo/Shanghai, CIF Hamburg, or DDP terms.');
  }

  if (/authorized distributor|retail chains|rewe|edeka/i.test(inquiry) && !/authorization letter|letter of authorization|loa|contract reference/i.test(inquiry)) {
    addRisk(risks, 'large-retailer-claim-unverified', 'medium', 'Claimed retail-chain authorization must be verified with authorization proof or a purchase order reference.');
  }

  if (/price is key|best price|very competitive market|target is around|target price/i.test(inquiry)) {
    addRisk(risks, 'price-pressure', 'low', 'Buyer strongly emphasizes target price; treat as negotiation risk, not fraud by itself.');
  }

  const targetPriceMatch = inquiry.match(/[€$]\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/);
  const productPriceText = products.map((item) => item.price || '').join(' ');
  const productPriceMatch = productPriceText.match(/usd\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/i);
  if (targetPriceMatch && productPriceMatch) {
    const targetHigh = Number(targetPriceMatch[2] || targetPriceMatch[1]);
    const productHigh = Number(productPriceMatch[2] || productPriceMatch[1]);
    if (targetHigh && productHigh && targetHigh <= productHigh * 1.2 && /ddp|delivered|port|shipping|packaging/i.test(inquiry)) {
      addRisk(risks, 'unrealistic-landed-price', 'medium', 'Target price may be too low for DDP, shipping, packaging, or tax-inclusive terms.');
    }
  }

  if (/30%\s*deposit.*70%.*before shipment|70%.*before shipment/i.test(text) && !/lc|letter of credit|bill of lading|b\/l|copy of b\/l/i.test(text)) {
    addRisk(risks, 'weak-before-shipment-terms', 'low', 'Payment terms need clarification, but they are not necessarily fraud.');
  }


  if (/bank details|bank account/i.test(inquiry)) {
    addRisk(risks, 'bank-details-verification-needed', 'medium', 'Bank details should only be exchanged after company-domain confirmation and account ownership verification.');
  }

  if (!/hrb\s*\d{3,}/i.test(inquiry) && /gmbh|handelsregister|amtsgericht|authorized distributor|retail chains|rewe|edeka/i.test(inquiry)) {
    addRisk(risks, 'missing-register-number', 'medium', 'German company or retail-chain claim appears without a clear HRB registration number; request official register details.');
  }

  if (!extractVatIds(inquiry).length && /germany|german|gmbh|handelsregister|amtsgericht|rewe|edka|edeka/i.test(inquiry) && /5,000|5000|retail chains|authorized distributor|confirmed order/i.test(inquiry)) {
    addRisk(risks, 'missing-vat-for-large-order', 'medium', 'Large German B2B order has no VAT ID; request VAT/EORI before high-trust processing.');
  }


  return risks;
}

function parseRdapDate(data) {
  const registrationEvent = data?.events?.find((event) =>
    ['registration', 'domain registration', 'created'].includes(String(event.eventAction || '').toLowerCase())
  );
  const fallbackEvent = data?.events?.find((event) => /registr/i.test(String(event.eventAction || '')));
  return registrationEvent?.eventDate || fallbackEvent?.eventDate || '';
}

export async function enrichRiskSignalsWithDomainAge(risks, inquiry, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const domains = extractDomainsForVerification(inquiry).slice(0, 4);
  const enriched = [...risks];

  for (const domain of domains) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 3500);
      const response = await fetchImpl(`https://rdap.org/domain/${domain}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const data = await response.json();
      const dateValue = parseRdapDate(data);
      if (!dateValue) continue;

      const ageDays = Math.floor((now.getTime() - new Date(dateValue).getTime()) / 86400000);
      if (Number.isFinite(ageDays) && ageDays >= 0 && ageDays < 90) {
        addRisk(enriched, `young-domain-${domain}`, 'high', `Domain ${domain} appears to be registered within ${ageDays} days; verify before quoting or sharing documents.`);
      }
    } catch {}
  }

  return enriched;
}

function parseViesResponse(xml) {
  const validMatch = xml.match(/<[^:>]*:?valid>\s*(true|false)\s*<\/[^:>]*:?valid>/i);
  const nameMatch = xml.match(/<[^:>]*:?name>\s*([^<]*)\s*<\/[^:>]*:?name>/i);
  const addressMatch = xml.match(/<[^:>]*:?address>\s*([^<]*)\s*<\/[^:>]*:?address>/i);
  return {
    valid: validMatch ? validMatch[1].toLowerCase() === 'true' : null,
    name: nameMatch?.[1]?.trim() || '',
    address: addressMatch?.[1]?.trim() || ''
  };
}

function companyTokens(inquiry) {
  const candidates = [
    inquiry.match(/([A-Z][A-Za-z&.\-\s]+(?:GmbH|UG|AG|KG|Ltd|Limited|Inc|LLC))/)?.[1],
    inquiry.match(/We are\s+([^,\n]+(?:GmbH|UG|AG|KG|Ltd|Limited|Inc|LLC))/i)?.[1]
  ].filter(Boolean);
  return unique(
    candidates
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !['gmbh', 'limited', 'company'].includes(token))
  );
}

export async function enrichRiskSignalsWithVat(risks, inquiry, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const vats = extractVatIds(inquiry).slice(0, 2);
  const enriched = [...risks];
  if (!vats.length) return enriched;

  for (const vat of vats) {
    const countryCode = vat.slice(0, 2);
    const vatNumber = vat.slice(2);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:checkVat>
      <urn:countryCode>${countryCode}</urn:countryCode>
      <urn:vatNumber>${vatNumber}</urn:vatNumber>
    </urn:checkVat>
  </soapenv:Body>
</soapenv:Envelope>`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 4500);
      const response = await fetchImpl('https://ec.europa.eu/taxation_customs/vies/services/checkVatService', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: ''
        },
        body,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        addRisk(enriched, `vat-check-unavailable-${vat}`, 'low', `VIES VAT check for ${vat} was unavailable; verify manually.`);
        continue;
      }

      const parsed = parseViesResponse(await response.text());
      if (parsed.valid === false) {
        addRisk(enriched, `vat-invalid-${vat}`, 'high', `VIES reports VAT ID ${vat} as invalid; verify buyer identity before quoting.`);
      } else if (parsed.valid === true && parsed.name) {
        const tokens = companyTokens(inquiry);
        const name = parsed.name.toLowerCase();
        if (tokens.length && !tokens.some((token) => name.includes(token))) {
          addRisk(enriched, `vat-name-mismatch-${vat}`, 'high', `VIES VAT owner name for ${vat} does not appear to match the buyer name in the inquiry.`);
        }
      }
    } catch {
      addRisk(enriched, `vat-check-unavailable-${vat}`, 'low', `VIES VAT check for ${vat} could not be completed automatically; verify manually.`);
    }
  }

  return enriched;
}

function verificationTasksFromRisks(risks) {
  const taskMap = new Map();
  const addTask = (id, label, method) => {
    if (!taskMap.has(id)) taskMap.set(id, { id, label, method, status: 'pending' });
  };

  for (const risk of risks) {
    if (risk.code.includes('young-domain') || risk.code.includes('domain-age') || risk.code === 'email-website-mismatch') {
      addTask('domain', 'Verify domain age and email/website consistency', 'RDAP/WHOIS plus public contact details on the official website');
    }
    if (risk.code.includes('hrb') || risk.code === 'missing-register-number' || risk.code === 'large-retailer-claim-unverified') {
      addTask('register', 'Verify German commercial registration and buying authority', 'Handelsregister.de / North Data / authorization letter or PO reference');
    }
    if (risk.code.includes('vat')) {
      addTask('vat', 'Verify VAT ID validity and company match', 'EU VIES official validation');
    }
    if (risk.code.includes('phone')) {
      addTask('phone', 'Call back the public landline manually', 'Use the phone number published on the official website or registry, not a temporary number in the email');
    }
    if (risk.code.includes('bank') || risk.code.includes('balance-after')) {
      addTask('bank', 'Verify bank account ownership and payment terms', 'Request account proof from the company email domain and keep safe first-order payment terms');
    }
  }

  return Array.from(taskMap.values());
}

function riskLevelValue(severity) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[severity] || 0;
}

function riskCategory(risk) {
  const code = String(risk.code || '');
  if (/link|credential|attachment|macro|punycode|reply-to|secrecy|urgency/.test(code)) return 'cyber';
  if (/payment|bank|fee|portal|third-party|balance|paypal|card|refundable/.test(code)) return 'payment';
  if (/domain|email|website|vat|hrb|register|retailer|company|phone|private-email|proof/.test(code)) return 'identity';
  if (/forwarder|logistics|incoterm|fob/.test(code)) return 'logistics';
  if (/price|landed|terms/.test(code)) return 'commercial';
  return 'general';
}

function categorySafety(risks, category, weights = { critical: 95, high: 42, medium: 16, low: 5 }) {
  const penalty = risks
    .filter((risk) => riskCategory(risk) === category)
    .reduce((sum, risk) => sum + (weights[risk.severity] || 0), 0);
  return clamp(100 - penalty);
}

function positiveSignalScore(inquiry) {
  const emailDomains = extractEmailDomains(inquiry);
  let score = 0;

  if (emailDomains.length && !hasFreeEmailDomain(emailDomains)) score += 15;
  if (/hrb\s*\d{3,}/i.test(inquiry)) score += 8;
  if (extractVatIds(inquiry).length) score += 5;

  const specKeywords = ['stainless steel', 'capacity', 'lid', 'color', 'colour', 'packaging', 'logo', 'sample'];
  const specCount = specKeywords.filter((keyword) => inquiry.toLowerCase().includes(keyword)).length;
  if (specCount >= 5) score += 10;
  else if (specCount >= 3) score += 5;

  const text = inquiry.toLowerCase();
  if (/30%\s*deposit/.test(text) && /(70%.*copy of b\/l|70%.*bill of lading|70%.*before shipment)/.test(text)) {
    score += 10;
  } else if (/\bl\/c\b|letter of credit/.test(text)) {
    score += 8;
  }

  if (/sample fee|sample cost/i.test(inquiry) && /pay|shipping|dhl|express|bank transfer|paypal/i.test(inquiry)) {
    score += 8;
  }

  if (/(geschäftsführer|geschaeftsfuehrer|manager|director|procurement|buyer|inhaber)/i.test(inquiry) && /tel:|phone:|email:|address|straße|strasse|germany/i.test(inquiry)) {
    score += 5;
  }

  return score;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractQuantityValue(inquiry) {
  const matches = [...inquiry.matchAll(/\b(\d{1,3}(?:[,.]\d{3})+|\d{3,6})\s*(?:pcs|pieces|units|bottles|sets)\b/gi)];
  return Math.max(0, ...matches.map((match) => Number(match[1].replace(/[,.]/g, '')) || 0));
}

function scoreRiskSafety(risks) {
  const penalty = risks.reduce((sum, risk) => {
    const value = { critical: 90, high: 35, medium: 14, low: 5 }[risk.severity] || 0;
    return sum + value;
  }, 0);
  return clamp(100 - penalty);
}

function marketScoreBreakdown(inquiry, risks, result = {}) {
  const text = inquiry.toLowerCase();
  const emailDomains = extractEmailDomains(inquiry);
  const quantity = extractQuantityValue(inquiry);
  const hasCorporateEmail = emailDomains.length && !hasFreeEmailDomain(emailDomains);
  const hasWebsite = /https?:\/\/|www\.|website|homepage|impressum/i.test(inquiry);
  const hasRegister = /hrb\s*\d{3,}|handelsregister|amtsgericht|company registration|commercial register/i.test(inquiry);
  const hasVat = extractVatIds(inquiry).length > 0 || /\bvat\b|ust-idnr|eori/i.test(inquiry);
  const hasAddress = /address|straße|strasse|allee|germany|gmbh|ltd|limited|inc|llc/i.test(inquiry);
  const hasRole = /(procurement|purchasing|buyer|sourcing|manager|director|geschäftsführer|geschaeftsfuehrer|inhaber)/i.test(inquiry);
  const specKeywords = ['capacity', 'material', 'stainless steel', '304', '18/8', 'lid', 'colour', 'color', 'ral', 'printing', 'logo', 'packaging', 'certification', 'lfgb', 'reach'];
  const specCount = specKeywords.filter((keyword) => text.includes(keyword)).length;
  const missingInfoCount = Array.isArray(result.missingInfo) ? result.missingInfo.length : 0;
  const hasQuoteItems = Array.isArray(result.quotationDraft?.items) && result.quotationDraft.items.length > 0;

  const buyerFit = clamp(
    (hasCorporateEmail ? 18 : 0) +
      (hasWebsite ? 15 : 0) +
      (hasRegister ? 15 : 0) +
      (hasVat ? 12 : 0) +
      (hasAddress ? 10 : 0) +
      (hasRole ? 10 : 0) +
      (/gmbh|ag|kg|ltd|limited|inc|llc|distributor|retailer|wholesale|brand/i.test(inquiry) ? 10 : 0) +
      (/germany|europe|eu|hamburg|berlin|munich|stuttgart|düsseldorf|duesseldorf/i.test(inquiry) ? 10 : 0)
  );

  const identityConfidence = buyerFit;

  const purchaseIntent = clamp(
    (hasAny(text, [/\brfq\b/, /request.*quotation/, /please quote/, /quotation request/, /send.*price/]) ? 18 : 0) +
      (specCount >= 8 ? 24 : specCount >= 5 ? 18 : specCount >= 3 ? 10 : 0) +
      (quantity >= 5000 ? 16 : quantity >= 1000 ? 11 : quantity >= 300 ? 6 : 0) +
      (/sample cost|sample fee|pay.*sample|dhl shipping|express shipping/i.test(inquiry) ? 10 : 0) +
      (/30%\s*deposit|copy of b\/l|bill of lading|before shipment|t\/t|letter of credit|\bl\/c\b/i.test(inquiry) ? 14 : 0) +
      (/lead time|delivery|within \d+\s*days|q[1-4]|immediately|ready to order|trial order/i.test(inquiry) ? 10 : 0) +
      (/repeat|reorder|quarterly|long-term|larger order|steady growth/i.test(inquiry) ? 8 : 0) +
      (/lfgb|reach|ce|fda|certification|certificate/i.test(inquiry) ? 6 : 0)
  );

  const commercialValue = clamp(
    (quantity >= 10000 ? 35 : quantity >= 5000 ? 28 : quantity >= 1000 ? 18 : quantity >= 500 ? 10 : 4) +
      (/private label|oem|odm|logo|laser|silkscreen|custom/i.test(inquiry) ? 18 : 0) +
      (/repeat|reorder|quarterly|10,000|10000|15,000|15000|long-term|retail chain|distributor/i.test(inquiry) ? 22 : 0) +
      (/lfgb|reach|food contact|certification/i.test(inquiry) ? 10 : 0) +
      (/target price|price is key|very competitive|cheapest/i.test(inquiry) ? -12 : 0) +
      (/ddp|after receive|after inspect|paypal|credit card/i.test(inquiry) ? -8 : 0) +
      25
  );

  const dealReadiness = clamp(
    (hasQuoteItems ? 14 : 0) +
      (/fob|exw|cif|ddp|incoterms/i.test(inquiry) ? 14 : 0) +
      (/30%\s*deposit|copy of b\/l|bill of lading|before shipment|t\/t|letter of credit|\bl\/c\b/i.test(inquiry) ? 18 : 0) +
      (/destination|hamburg|berlin|warehouse|port|ningbo|shanghai/i.test(inquiry) ? 10 : 0) +
      (/artwork|ai\/eps|logo|sample approval|pre-production sample/i.test(inquiry) ? 10 : 0) +
      (/lead time|delivery|within \d+\s*days/i.test(inquiry) ? 10 : 0) +
      (/ready to order|immediately|confirmed order|trial order/i.test(inquiry) ? 10 : 0) +
      (missingInfoCount === 0 ? 14 : missingInfoCount <= 2 ? 7 : 0)
  );

  const riskSafety = scoreRiskSafety(risks);
  const cyberSafety = categorySafety(risks, 'cyber');
  const paymentSafety = clamp(Math.min(categorySafety(risks, 'payment'), categorySafety(risks, 'logistics')));
  const identitySafety = categorySafety(risks, 'identity');
  const commercialSafety = categorySafety(risks, 'commercial', { critical: 70, high: 28, medium: 12, low: 4 });
  const urgency = clamp(
    (/urgent|immediately|asap|ready to order|confirmed order|q[1-4]|launch|within \d+\s*days/i.test(inquiry) ? 55 : 35) +
      (/sample|pre-production|artwork|deposit/i.test(inquiry) ? 25 : 0) +
      (quantity >= 5000 ? 15 : quantity >= 1000 ? 8 : 0) -
      (risks.some((risk) => risk.severity === 'high' || risk.severity === 'critical') ? 35 : 0)
  );

  const composite = clamp(
    identityConfidence * 0.18 +
      purchaseIntent * 0.2 +
      dealReadiness * 0.14 +
      commercialValue * 0.12 +
      cyberSafety * 0.14 +
      paymentSafety * 0.1 +
      identitySafety * 0.07 +
      commercialSafety * 0.05
  );

  const tier =
    composite >= 90 ? 'A1 Hot account' :
    composite >= 80 ? 'A2 Priority quote' :
    composite >= 65 ? 'B Nurture with verification' :
    composite >= 45 ? 'C Low priority/manual check' :
    'D Ignore or archive';

  return {
    model: 'global-b2b-risk-intent-v3',
    buyerFit,
    identityConfidence,
    purchaseIntent,
    dealReadiness,
    commercialValue,
    riskSafety,
    cyberSafety,
    paymentSafety,
    identitySafety,
    commercialSafety,
    urgency,
    automationConfidence: clamp(Math.min(composite, cyberSafety, paymentSafety, identitySafety)),
    composite,
    tier
  };
}

function normalizeReason(reason) {
  return String(reason || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|and|or|to|from|with|for|of|is|are|by|before|after)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const reasonTranslations = [
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

export function translateRiskReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return '';
  const normalized = normalizeReason(text);

  for (const [source, translated] of reasonTranslations) {
    const sourceNormalized = normalizeReason(source);
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

function compactReasons(reasons) {
  const result = [];
  const seen = [];

  for (const reason of reasons.filter(Boolean)) {
    const translated = translateRiskReason(reason);
    const normalized = normalizeReason(translated);
    if (!normalized) continue;

    const duplicate = seen.some((item) => normalized.includes(item) || item.includes(normalized));
    if (!duplicate) {
      seen.push(normalized);
      result.push(translated);
    }
  }

  return result.slice(0, 8);
}

export function applyRiskGuard(result, risks, context = {}) {
  const guarded = { ...result };
  const current = guarded.leadQuality || {};
  const inquiry = context.inquiry || guarded.inquiry || guarded.rawInquiry || '';
  const scoring = marketScoreBreakdown(inquiry, risks, guarded);
  const signalBoost = positiveSignalScore(inquiry);
  const baseScore = !risks.length && signalBoost >= 50
    ? 100
    : clamp(Math.max(Number(current.score || 75), scoring.composite) + signalBoost * 0.35);

  if (!risks.length) {
    guarded.leadQuality = {
      ...current,
      score: baseScore,
      scoreBreakdown: {
        ...scoring,
        composite: baseScore,
        tier:
          baseScore >= 90 ? 'A1 Hot account' :
          baseScore >= 80 ? 'A2 Priority quote' :
          baseScore >= 65 ? 'B Nurture with verification' :
          baseScore >= 45 ? 'C Low priority/manual check' :
          'D Ignore or archive'
      },
      verificationTasks: current.verificationTasks || []
    };
    return guarded;
  }

  const hasCritical = risks.some((risk) => risk.severity === 'critical');
  const hasHigh = risks.some((risk) => risk.severity === 'high');
  const hasCyberHigh = risks.some((risk) => risk.severity === 'high' && riskCategory(risk) === 'cyber');
  const hasPaymentHigh = risks.some((risk) => risk.severity === 'high' && riskCategory(risk) === 'payment');
  const hasIdentityHigh = risks.some((risk) => risk.severity === 'high' && riskCategory(risk) === 'identity');
  const mediumCategories = new Set(risks.filter((risk) => risk.severity === 'medium').map((risk) => riskCategory(risk)));
  const riskScore = risks.reduce((sum, risk) => sum + riskLevelValue(risk.severity), 0);

  let guardedType = current.type || 'qualified';
  let guardedMode = current.safeReplyMode || 'full_quote';
  let guardedScore = baseScore;
  let recommendedAction = current.recommendedAction || 'Proceed with normal follow-up.';

  if (hasCritical) {
    guardedType = 'scam';
    guardedMode = 'manual_review';
    guardedScore = Math.min(guardedScore, 25);
    recommendedAction = 'Do not click links or pay any fee. Verify the company, portal domain, procurement authority, and fee source before any quotation or document exchange.';
  } else if (hasCyberHigh || hasPaymentHigh) {
    guardedType = 'low_intent';
    guardedMode = 'manual_review';
    guardedScore = Math.min(guardedScore, 45);
    recommendedAction = 'Hold automation. Verify links, attachments, payment instructions, and sender authority through an independent official channel.';
  } else if (hasIdentityHigh || hasHigh || riskScore >= 7 || mediumCategories.size >= 3) {
    guardedType = 'low_intent';
    guardedMode = 'manual_review';
    guardedScore = Math.min(guardedScore, 55);
    recommendedAction = 'Treat as a cautious SME lead: verify identity, reject unsafe payment terms, and offer standard trade terms before sending a detailed quote.';
  } else if (riskScore >= 3 || mediumCategories.size >= 2) {
    guardedType = current.type === 'scam' ? 'low_intent' : current.type || 'low_intent';
    guardedMode = current.safeReplyMode === 'full_quote' ? 'ask_more' : current.safeReplyMode || 'ask_more';
    guardedScore = Math.min(guardedScore, 70);
    recommendedAction = current.recommendedAction || 'Ask for verification details and clarify terms before quoting.';
  }

  const reasons = compactReasons([...(current.reasons || []), ...risks.map((risk) => risk.text)]);

  guarded.leadQuality = {
    type: guardedType,
    score: guardedScore,
    scoreBreakdown: {
      ...scoring,
      composite: guardedScore,
      tier:
        guardedScore >= 90 ? 'A1 Hot account' :
        guardedScore >= 80 ? 'A2 Priority quote' :
        guardedScore >= 65 ? 'B Nurture with verification' :
        guardedScore >= 45 ? 'C Low priority/manual check' :
        'D Ignore or archive'
    },
    reasons,
    recommendedAction,
    safeReplyMode: guardedMode,
    verificationTasks: verificationTasksFromRisks(risks)
  };

  if (guardedMode === 'manual_review') {
    guarded.quotationDraft = {
      currency: '',
      items: [],
      terms: hasCritical
        ? 'Hold quotation until scam indicators are cleared.'
        : 'Hold detailed quotation until buyer identity and safer trade terms are confirmed.'
    };
  }

  if (hasCritical) {
    guarded.emailSubject = 'Re: Supplier verification and quotation process';
    guarded.emailReply = `Dear ${guarded.customer?.name || 'Sir/Madam'},

Thank you for your inquiry.

Before we proceed with a detailed quotation, please help us verify the purchasing process by providing your official company website, VAT/EORI number, business registration extract, and written confirmation from your company domain that no supplier validation, activation, portal, or third-party fee is required from us.

For security reasons, we do not click external payment links, pay refundable validation fees, or process supplier activation charges before an order is confirmed through standard trade documents.

Once the company and procurement process are verified, we will be happy to review the product requirements and provide a quotation.

Best regards,
Sales Team`;
    guarded.followUpPlan = [
      {
        day: 1,
        action: 'Verify company website, VAT/EORI, registration number, buyer email domain, portal domain, and fee source.'
      },
      {
        day: 3,
        action: 'If the buyer keeps requesting payment links, portal fees, or sensitive bank details through an unverified portal, mark as scam and stop follow-up.'
      }
    ];
  } else if (guardedMode === 'manual_review') {
    guarded.emailSubject = guarded.emailSubject || 'Re: RFQ - verification and trade terms';
    guarded.emailReply = `Dear ${guarded.customer?.name || 'Sir/Madam'},

Thank you for your detailed inquiry.

Your product requirements are clear, and we can review the quotation after confirming a few business and trade details. Please share your active company website or Impressum page, VAT/EORI number if available, and confirmation from your company email domain when the migration is completed.

For the first order, we can discuss standard export payment terms such as T/T deposit with balance before shipment or against copy of B/L. We cannot accept balance payment only after goods are received for a first cooperation.

If a supplier registration portal is required, please send the official public website first. We will only review it after confirming that registration is free and does not require payment links or unnecessary sensitive information.

Best regards,
Sales Team`;
  }

  return guarded;
}
