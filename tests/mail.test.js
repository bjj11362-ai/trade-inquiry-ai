import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendCustomerReply,
  attachFollowUps,
  canAutoReply,
  consolidateCustomerThreads,
  createFollowUps,
  explainAutoReplyDecision,
  followUpRiskReview,
  getMailAccounts,
  hasSentReplyForCustomerMessage,
  ensureThreadReplyStatuses,
  isNonBusinessNoiseMail,
  markSilentLeads
} from '../server/mailService.js';

function baseResult(overrides = {}) {
  const { leadQuality, ...rest } = overrides;
  return {
    emailReply: 'Dear Buyer, thank you for your inquiry.',
    leadQuality: {
      type: 'qualified',
      score: 90,
      safeReplyMode: 'full_quote',
      verificationTasks: [],
      ...leadQuality
    },
    ...rest
  };
}

test('high-score qualified inquiry can be auto-replied', () => {
  assert.equal(canAutoReply(baseResult()), true);
});

test('manual review or low score blocks auto reply', () => {
  assert.equal(canAutoReply(baseResult({ leadQuality: { safeReplyMode: 'manual_review' } })), false);
  assert.equal(canAutoReply(baseResult({ leadQuality: { score: 84 } })), false);
  const decision = explainAutoReplyDecision(baseResult({ leadQuality: { score: 84 } }));
  assert.equal(decision.allowed, false);
  assert.match(decision.blockers.join('; '), /评分低于 85/);
});

test('routine verification tasks do not block otherwise safe auto reply', () => {
  assert.equal(
    canAutoReply(
      baseResult({
        leadQuality: {
          verificationTasks: [
            { id: 'V1', label: 'Verify HRB and VAT', method: 'Public registry check', status: 'pending' },
            { id: 'V2', label: 'Check domain age and ownership', method: 'WHOIS lookup', status: 'pending' },
            { id: 'V3', label: 'Verify VAT ID', method: 'VIES VAT validation', status: 'pending' },
            { id: 'V4', label: 'Check website for Impressum and legitimacy', method: 'Manual review', status: 'pending' }
          ]
        }
      })
    ),
    true
  );
});

test('high-risk verification tasks block auto reply', () => {
  assert.equal(
    canAutoReply(
      baseResult({
        leadQuality: {
          verificationTasks: [{ id: 'domain', label: 'Verify domain mismatch and payment portal', method: 'Manual review', status: 'pending' }]
        }
      })
    ),
    false
  );
});

test('spam scam competitor and low-intent leads cannot be auto-replied', () => {
  for (const type of ['spam', 'scam', 'competitor', 'low_intent']) {
    assert.equal(canAutoReply(baseResult({ leadQuality: { type } })), false);
  }
});

test('sent replies create day 3 and day 7 follow-up tasks', () => {
  const followUps = createFollowUps('2026-06-10T00:00:00.000Z');
  assert.equal(followUps.length, 2);
  assert.equal(followUps[0].stage, 'day3');
  assert.equal(followUps[0].status, 'pending');
  assert.equal(followUps[1].stage, 'day7');

  const lead = attachFollowUps({ id: 'lead-1' }, { status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' });
  assert.equal(lead.followUps.length, 2);
});

test('day 7 follow-up without customer reply marks lead silent', () => {
  const state = {
    leads: [
      {
        id: 'lead-1',
        status: '待跟进',
        subject: 'RFQ bottles',
        result: {
          customer: { name: 'Michael' },
          requirements: { products: [{ name: 'insulated bottles' }], quantity: '1000 pcs' }
        },
        mail: { autoReply: { status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' } },
        followUps: [
          { id: 'f1', stage: 'day3', status: 'sent', sentAt: '2026-06-13T00:00:00.000Z' },
          { id: 'f2', stage: 'day7', status: 'sent', sentAt: '2026-06-17T00:00:00.000Z' }
        ],
        timeline: []
      }
    ]
  };

  assert.equal(markSilentLeads(state), 1);
  assert.equal(state.leads[0].status, '已沉默');
  assert.match(state.leads[0].takeoverSuggestion, /still an active project/);
  assert.equal(state.leads[0].timeline[0].type, 'silent');
});

test('same customer and same project are consolidated into one thread', () => {
  const state = {
    leads: [
      {
        id: 'lead-new',
        updatedAt: 200,
        customer: 'Touring Outdoor GmbH',
        contact: 'm.hoffmann@touring-outdoor.de',
        subject: 'RE: RFQ - 2500 pcs stainless steel insulated bottles 500ml',
        inquiry: 'Subject: RE: RFQ - 2500 pcs stainless steel insulated bottles 500ml\nFrom: Michael Hoffmann m.hoffmann@touring-outdoor.de',
        mail: { from: 'Test <sender@qq.com>', subject: 'RE: RFQ - 2500 pcs stainless steel insulated bottles 500ml', messageId: 'new' },
        timeline: []
      },
      {
        id: 'lead-old',
        updatedAt: 100,
        customer: 'Touring Outdoor GmbH',
        contact: 'm.hoffmann@touring-outdoor.de',
        subject: 'RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai',
        inquiry: 'Subject: RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai\nFrom: Michael Hoffmann m.hoffmann@touring-outdoor.de',
        mail: { from: 'Test <sender@qq.com>', subject: 'RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai', messageId: 'old' },
        timeline: []
      }
    ]
  };

  assert.equal(consolidateCustomerThreads(state), true);
  assert.equal(state.leads.length, 1);
  assert.equal(state.leads[0].customerReplies.length, 1);
  assert.equal(state.leads[0].mergedLeadIds.includes('lead-old'), true);
});

test('follow-up reply with payment portal risk freezes the thread', () => {
  const state = {
    leads: [
      {
        id: 'lead-1',
        status: '已自动回复',
        updatedAt: 100,
        customer: 'Touring Outdoor GmbH',
        contact: 'm.hoffmann@touring-outdoor.de',
        subject: 'RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai',
        inquiry: 'Subject: RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai\nFrom: Michael Hoffmann m.hoffmann@touring-outdoor.de',
        mail: {
          from: 'Tester <sender@qq.com>',
          subject: 'RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai',
          messageId: 'original',
          autoReply: { status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' },
          sentLog: [{ status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' }]
        },
        followUps: [{ id: 'f1', stage: 'day3', status: 'pending', dueAt: '2026-06-13T00:00:00.000Z' }],
        timeline: []
      }
    ]
  };
  const mail = {
    from: 'Tester <sender@qq.com>',
    fromAddress: 'sender@qq.com',
    subject: 'RE: RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai',
    date: '2026-06-10T01:00:00.000Z',
    messageId: 'reply-risk',
    text: 'Subject: RE: RFQ - 2,500 pcs stainless steel insulated bottles / 500ml / FOB Shanghai\nFrom: Michael Hoffmann m.hoffmann@touring-outdoor.de\nPlease use this secure payment portal link and enter bank login details.'
  };

  assert.equal(appendCustomerReply(state, mail), true);
  assert.equal(state.leads[0].status, '二次风险升级');
  assert.equal(state.leads[0].followUps[0].status, 'paused');
  assert.equal(state.leads[0].followUpRisk.blocked, true);
});

test('follow-up risk review allows normal buyer clarification', () => {
  const review = followUpRiskReview({
    subject: 'RE: RFQ bottles',
    from: 'Buyer <buyer@example.de>',
    text: 'Subject: RE: RFQ bottles\nPlease confirm sample lead time and carton size.'
  });
  assert.equal(review.blocked, false);
  assert.equal(review.status, '客户已回复');
});

test('same envelope sender stays in one thread even when claimed company changes', () => {
  const state = {
    leads: [
      {
        id: 'lead-envelope',
        status: 'sent',
        updatedAt: 100,
        customer: 'Alpine Outdoor GmbH',
        contact: 'buyer@alpine-outdoor.de',
        subject: 'RFQ - insulated bottles',
        inquiry: 'Subject: RFQ - insulated bottles\nFrom: Anna Klein buyer@alpine-outdoor.de',
        mail: {
          from: 'Tester <sender@qq.com>',
          fromAddress: 'sender@qq.com',
          subject: 'RFQ - insulated bottles',
          messageId: 'original',
          autoReply: { status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' },
          sentLog: [{ status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' }]
        },
        timeline: []
      }
    ]
  };
  const mail = {
    from: 'Tester <sender@qq.com>',
    fromAddress: 'sender@qq.com',
    subject: 'New company profile and vendor portal',
    date: '2026-06-10T02:00:00.000Z',
    messageId: 'changed-claim',
    text: 'Subject: New company profile and vendor portal\nFrom: Lukas Wagner l.wagner@different-company.de\nWe are Different Trading GmbH. Please use our secure payment portal link.'
  };

  assert.equal(appendCustomerReply(state, mail), true);
  assert.equal(state.leads.length, 1);
  assert.equal(state.leads[0].customerReplies.length, 1);
  assert.equal(state.leads[0].customerReplies[0].messageId, 'changed-claim');
  assert.equal(state.leads[0].followUpRisk.blocked, true);
});

test('same envelope sender consolidates leads with unrelated claimed companies', () => {
  const state = {
    leads: [
      {
        id: 'lead-new-claim',
        updatedAt: 200,
        customer: 'Different Trading GmbH',
        contact: 'buyer@different-company.de',
        subject: 'New product request',
        inquiry: 'Subject: New product request\nFrom: Lukas Wagner buyer@different-company.de',
        mail: { from: 'Tester <sender@qq.com>', fromAddress: 'sender@qq.com', subject: 'New product request', messageId: 'new' },
        timeline: []
      },
      {
        id: 'lead-old-claim',
        updatedAt: 100,
        customer: 'Alpine Outdoor GmbH',
        contact: 'buyer@alpine-outdoor.de',
        subject: 'RFQ - insulated bottles',
        inquiry: 'Subject: RFQ - insulated bottles\nFrom: Anna Klein buyer@alpine-outdoor.de',
        mail: { from: 'Tester <sender@qq.com>', fromAddress: 'sender@qq.com', subject: 'RFQ - insulated bottles', messageId: 'old' },
        timeline: []
      }
    ]
  };

  assert.equal(consolidateCustomerThreads(state), true);
  assert.equal(state.leads.length, 1);
  assert.equal(state.leads[0].mergedLeadIds.includes('lead-old-claim'), true);
});

test('manual customer replies are tracked per customer message id', () => {
  const lead = {
    mail: {
      autoReply: { status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' },
      sentLog: [
        {
          status: 'sent',
          stage: 'manual-reply',
          sentAt: '2026-06-10T02:00:00.000Z',
          replyId: '<reply-1>'
        },
        {
          status: 'sent',
          stage: 'initial',
          sentAt: '2026-06-10T00:00:00.000Z'
        }
      ]
    }
  };

  assert.equal(hasSentReplyForCustomerMessage(lead, { messageId: '<reply-1>', date: '2026-06-10T01:00:00.000Z' }), true);
  assert.equal(hasSentReplyForCustomerMessage(lead, { messageId: '<reply-2>', date: '2026-06-10T03:00:00.000Z' }), false);
});

test('answered latest customer reply leaves reply inbox status', () => {
  const state = {
    leads: [
      {
        id: 'lead-answered-reply',
        status: '客户已回复',
        customerReplies: [
          {
            messageId: '<reply-answered>',
            date: '2026-06-10T03:00:00.000Z',
            subject: 'RE: quotation'
          }
        ],
        mail: {
          autoReply: { status: 'sent', sentAt: '2026-06-10T00:00:00.000Z' },
          sentLog: [
            {
              status: 'sent',
              stage: 'manual-reply',
              replyId: '<reply-answered>',
              sentAt: '2026-06-10T03:05:00.000Z'
            }
          ]
        }
      }
    ]
  };

  assert.equal(ensureThreadReplyStatuses(state), true);
  assert.equal(state.leads[0].status, '待跟进');
});

test('multi-mailbox env config parses account list', () => {
  const previous = process.env.MAIL_ACCOUNTS_JSON;
  process.env.MAIL_ACCOUNTS_JSON = JSON.stringify([
    {
      id: 'qq-sales',
      label: 'QQ Sales',
      imap: { host: 'imap.qq.com', user: 'sales@qq.com', pass: 'secret' },
      smtp: { host: 'smtp.qq.com', user: 'sales@qq.com', pass: 'secret' }
    },
    {
      id: 'gmail-sales',
      label: 'Gmail Sales',
      imap: { host: 'imap.gmail.com', user: 'sales@gmail.com', pass: 'secret' },
      smtp: { host: 'smtp.gmail.com', user: 'sales@gmail.com', pass: 'secret' }
    }
  ]);
  const accounts = getMailAccounts();
  if (previous === undefined) delete process.env.MAIL_ACCOUNTS_JSON;
  else process.env.MAIL_ACCOUNTS_JSON = previous;

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, 'qq-sales');
  assert.equal(accounts[1].smtp.host, 'smtp.gmail.com');
});

test('non-business platform notifications are filtered before AI analysis', () => {
  assert.equal(isNonBusinessNoiseMail({
    from: '"Steam" <noreply@steampowered.com>',
    fromAddress: 'noreply@steampowered.com',
    subject: 'A trial version is now available on Steam',
    text: 'Promotional notification. Unsubscribe from these emails.'
  }), true);

  assert.equal(isNonBusinessNoiseMail({
    from: '"Google" <no-reply@accounts.google.com>',
    fromAddress: 'no-reply@accounts.google.com',
    subject: 'Security alert for your account',
    text: 'A sign-in was detected. This is an account security alert.'
  }), true);
});

test('trade inquiries are not filtered even when sender address looks automated', () => {
  assert.equal(isNonBusinessNoiseMail({
    from: '"Procurement" <notification@example-buyer.de>',
    fromAddress: 'notification@example-buyer.de',
    subject: 'RFQ - 5,000 pcs insulated bottles',
    text: 'Please quote FOB Ningbo, MOQ, lead time, logo cost, and payment terms.'
  }), false);
});
