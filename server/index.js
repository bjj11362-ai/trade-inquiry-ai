import 'dotenv/config';
import express from 'express';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeInquiry } from './analyzer.js';
import { deleteMailLead, getLeadQuotationPdf, getMailStatus, reprocessMailQueueItem, sendLeadReply, syncMailbox, testMailConnection, updateMailLeadStatus } from './mailService.js';
import { createQuotationPdfBuffer } from './pdf.js';
import { draftLeadReply } from './replyDraft.js';
import { getAISettings, getPublicSettings, saveSettingsPatch } from './settingsStore.js';
import { updateMailContext } from './mailStore.js';
import { translateCustomerText, translateReplyDraft } from './translator.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const mailWorkerState = {
  running: false,
  startedAt: '',
  lastEventAt: '',
  lastEvent: '',
  lastError: '',
  restarts: 0
};

function startMailWorker() {
  const worker = new Worker(new URL('./mailWorker.js', import.meta.url), {
    env: process.env
  });
  mailWorkerState.running = true;
  mailWorkerState.startedAt = new Date().toISOString();
  mailWorkerState.lastEventAt = mailWorkerState.startedAt;
  mailWorkerState.lastEvent = 'starting';
  mailWorkerState.lastError = '';

  worker.on('message', (message = {}) => {
    mailWorkerState.lastEventAt = new Date().toISOString();
    mailWorkerState.lastEvent = message.type || 'message';
    if (message.error) mailWorkerState.lastError = message.error;
    if (message.type === 'sync-complete' && !(message.errors || []).length) mailWorkerState.lastError = '';
  });

  worker.on('error', (error) => {
    mailWorkerState.running = false;
    mailWorkerState.lastEventAt = new Date().toISOString();
    mailWorkerState.lastEvent = 'worker-error';
    mailWorkerState.lastError = error.message || String(error);
  });

  worker.on('exit', (code) => {
    mailWorkerState.running = false;
    mailWorkerState.lastEventAt = new Date().toISOString();
    mailWorkerState.lastEvent = `worker-exit:${code}`;
    if (code !== 0) {
      mailWorkerState.restarts += 1;
      setTimeout(startMailWorker, 5000);
    }
  });

  return worker;
}

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  const aiSettings = getAISettings();
  res.json({
    ok: true,
    service: 'trade-inquiry-ai',
    hasKey: Boolean(aiSettings.apiKey),
    model: aiSettings.model,
    mailWorker: mailWorkerState
  });
});

app.get('/api/settings', (_req, res) => {
  res.json(getPublicSettings());
});

app.post('/api/settings', async (req, res) => {
  try {
    res.json(await saveSettingsPatch(req.body || {}));
  } catch (error) {
    res.status(500).json({ error: 'Settings save failed.', detail: error.message });
  }
});

app.post('/api/analyze-inquiry', async (req, res) => {
  const { inquiry, products, companyProfile } = req.body || {};
  try {
    await updateMailContext({ products, companyProfile });
    const result = await analyzeInquiry({ inquiry, products, companyProfile });
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || 'Analysis failed. Please try again later.',
      detail: error.detail || undefined
    });
  }
});

app.post('/api/translate/reply', async (req, res) => {
  try {
    res.json(await translateReplyDraft({
      customerText: req.body?.customerText || '',
      subject: req.body?.subject || '',
      body: req.body?.body || ''
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Translation failed.', detail: error.message });
  }
});

app.post('/api/translate/customer', async (req, res) => {
  try {
    res.json(await translateCustomerText({
      customerText: req.body?.customerText || ''
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Customer translation failed.', detail: error.message });
  }
});

app.post('/api/mail/leads/:id/draft-reply', async (req, res) => {
  try {
    const draft = await draftLeadReply(req.params.id);
    res.json({
      ...draft,
      status: await getMailStatus()
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: 'Follow-up draft failed.',
      detail: error.message,
      lead: error.lead
    });
  }
});

app.get('/api/mail/status', async (_req, res) => {
  try {
    res.json(await getMailStatus());
  } catch (error) {
    res.status(500).json({ error: 'Failed to read mail status.', detail: error.message });
  }
});

app.post('/api/mail/test', async (_req, res) => {
  try {
    res.json(await testMailConnection());
  } catch (error) {
    res.status(500).json({ error: 'Mail connection test failed.', detail: error.message });
  }
});

app.post('/api/mail/sync', async (req, res) => {
  try {
    const { products, companyProfile } = req.body || {};
    res.json(await syncMailbox({ analyzeInquiry, products, companyProfile }));
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Mail sync failed.', detail: error.message });
  }
});

app.post('/api/mail/leads/:id/send-reply', async (req, res) => {
  try {
    res.json(await sendLeadReply(req.params.id, {
      force: Boolean(req.body?.force),
      attachQuotationPdf: Boolean(req.body?.attachQuotationPdf),
      subject: req.body?.subject,
      body: req.body?.body
    }));
  } catch (error) {
    res.status(error.status || 500).json({
      error: 'Mail reply failed.',
      detail: error.message,
      blockers: error.blockers || undefined,
      lead: error.lead || undefined,
      status: error.lead ? await getMailStatus() : undefined
    });
  }
});

app.patch('/api/mail/leads/:id/status', async (req, res) => {
  try {
    res.json(await updateMailLeadStatus(req.params.id, req.body?.status));
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Lead status update failed.', detail: error.message, status: await getMailStatus() });
  }
});

app.get('/api/mail/leads/:id/quotation.pdf', async (req, res) => {
  try {
    const pdf = await getLeadQuotationPdf(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
    res.send(pdf.buffer);
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Quotation PDF failed.', detail: error.message });
  }
});

app.post('/api/quotation/pdf', async (req, res) => {
  try {
    const { lead, result, companyProfile } = req.body || {};
    const buffer = createQuotationPdfBuffer({ lead, result, companyProfile });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="quotation.pdf"');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: 'Quotation PDF failed.', detail: error.message });
  }
});

app.delete('/api/mail/leads/:id', async (req, res) => {
  try {
    res.json(await deleteMailLead(req.params.id));
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Lead delete failed.', detail: error.message });
  }
});

app.post('/api/mail/queue/:id/reprocess', async (req, res) => {
  try {
    res.json(await reprocessMailQueueItem(decodeURIComponent(req.params.id), {
      analyzeInquiry,
      forceNew: Boolean(req.body?.forceNew)
    }));
  } catch (error) {
    res.status(error.status || 500).json({ error: 'Queue reprocess failed.', detail: error.message });
  }
});

if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(port, () => {
  startMailWorker();
  console.log(`DeepSeek proxy listening on http://localhost:${port}`);
});
