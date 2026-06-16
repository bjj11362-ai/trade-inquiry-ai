function pdfEscape(value = '') {
  return String(value)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r?\n/g, ' ');
}

function wrapText(text = '', max = 86) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!word) continue;
    const next = line ? `${line} ${word}` : word;
    if (next.length > max && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function moneyLine(item = {}) {
  const product = item.product || 'Product to be confirmed';
  const quantity = item.quantity || 'TBC';
  const unitPrice = item.unitPrice || 'TBC';
  const subtotal = item.subtotal || '';
  const remarks = item.remarks || '';
  return `${product} | Qty: ${quantity} | Unit price: ${unitPrice}${subtotal ? ` | Subtotal: ${subtotal}` : ''}${remarks ? ` | ${remarks}` : ''}`;
}

function buildPdfLines({ lead = {}, result = {}, companyProfile = '' }) {
  const customer = result.customer || {};
  const requirements = result.requirements || {};
  const quotation = result.quotationDraft || {};
  const items = Array.isArray(quotation.items) ? quotation.items : [];
  const lines = [
    { text: 'QUOTATION', size: 20, gap: 24 },
    { text: `Date: ${new Date().toLocaleDateString('en-CA')}`, size: 10 },
    { text: `Quotation No.: Q-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(lead.id || 'DRAFT').slice(0, 6)}`, size: 10, gap: 16 },
    { text: 'Supplier', size: 13, gap: 14 },
    ...wrapText(companyProfile || 'China-based manufacturer. OEM/ODM, samples, custom logo, and bulk production supported.', 90).map((text) => ({ text, size: 10 })),
    { text: 'Customer', size: 13, gap: 14 },
    { text: `Company: ${customer.company || lead.customer || 'To be confirmed'}`, size: 10 },
    { text: `Country: ${customer.country || lead.country || 'To be confirmed'}`, size: 10 },
    { text: `Contact: ${customer.contact || lead.contact || 'To be confirmed'}`, size: 10, gap: 16 },
    { text: 'Product Requirements', size: 13, gap: 14 },
    { text: `Quantity: ${requirements.quantity || 'To be confirmed'}`, size: 10 },
    { text: `Destination: ${requirements.destination || 'To be confirmed'}`, size: 10 },
    { text: `Lead time requested: ${requirements.leadTime || 'To be confirmed'}`, size: 10, gap: 16 },
    { text: 'Quotation Items', size: 13, gap: 14 }
  ];

  if (items.length) {
    items.forEach((item, index) => {
      wrapText(`${index + 1}. ${moneyLine(item)}`, 92).forEach((text) => lines.push({ text, size: 10 }));
      lines.push({ text: '', size: 10, gap: 4 });
    });
  } else {
    lines.push({ text: 'Detailed quotation is held until required product or buyer verification details are confirmed.', size: 10 });
  }

  lines.push(
    { text: 'Commercial Terms', size: 13, gap: 14 },
    { text: `Terms: ${quotation.terms || requirements.incoterms || requirements.shipping || 'To be confirmed'}`, size: 10 },
    { text: `Payment: 30% deposit, 70% before shipment unless otherwise agreed.`, size: 10 },
    { text: `Validity: 7 days from quotation date.`, size: 10 },
    { text: `Packaging: Standard export packaging unless otherwise specified.`, size: 10, gap: 16 },
    { text: 'Notes', size: 13, gap: 14 },
    ...wrapText('This quotation is for buyer review only. Final price may vary after artwork, packaging, shipping term, and sample confirmation.', 92).map((text) => ({ text, size: 10 }))
  );

  return lines;
}

export function createQuotationPdfBuffer({ lead = {}, result = {}, companyProfile = '' } = {}) {
  const content = [];
  let y = 790;
  const left = 52;
  const lines = buildPdfLines({ lead, result, companyProfile });
  for (const line of lines) {
    const gap = line.gap || 12;
    y -= gap;
    if (y < 60) break;
    content.push(`BT /F1 ${line.size || 10} Tf ${left} ${y} Td (${pdfEscape(line.text)}) Tj ET`);
  }

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const stream = content.join('\n');
  objects.push(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

