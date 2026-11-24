import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import test from 'node:test';
import { INVITATION_SCRIPT } from '../src/canvas/invitation-panel.mjs';

function panel({ opens = true } = {}) {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; } });
    return nodes.get(id);
  };
  const calls = [];
  const document = { hidden: true, handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; } };
  let visible;
  const recall = { invitation_id: 'invitation', retrieval_id: 'exact-recall', recorded_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300000).toISOString(), count: 0 };
  const context = {
    $, document, review: {}, reviewTime: value => value, setTimeout: () => 1, clearTimeout() {},
    IntersectionObserver: class {
      constructor(callback) { visible = callback; }
      observe() {}
      disconnect() {}
    },
    reviewGet: async path => { calls.push({ path }); return { session: 'session', invitations: { enabled: true } }; },
    reviewPost: async (path, body) => {
      calls.push({ path, body });
      if (path.endsWith('/invitation')) return { invitation: recall };
      if (path.endsWith('/invitation-preference')) return { enabled: body.enabled };
      return { status: 'queued' };
    },
    openRecall: async id => { calls.push({ rendered: id, success: opens }); return opens; },
  };
  const api = new Script(INVITATION_SCRIPT + '\n({ checkInvitation, clearInvitation })').runInNewContext(context);
  return { $, calls, document, api, review: context.review,
    visible: ratio => visible([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]) };
}

test('hidden and offscreen invitations never send shown; Review reports opened only after exact detail renders', async () => {
  const p = panel();
  await p.api.checkInvitation();
  assert.equal(p.calls.length, 0);
  p.document.hidden = false;
  await p.api.checkInvitation();
  assert.equal(p.$('invitationBanner').hidden, false);
  assert.equal(p.calls.some(call => call.body?.action), false);
  await p.visible(0.49);
  assert.equal(p.calls.some(call => call.body?.action), false);
  await p.visible(0.5);
  assert.equal(p.$('invitationReview').disabled, false);
  assert.equal(p.calls.at(-1).body.action, 'shown');
  await p.$('invitationReview').handlers.click();
  assert.equal(p.calls.at(-2).rendered, 'exact-recall');
  assert.equal(p.calls.at(-1).body.action, 'opened');
  assert.equal(p.$('invitationBanner').hidden, true);
  assert.equal(p.calls.some(call => call.path?.endsWith('/feedback')), false);
});

test('failed detail rendering does not count as an opened invitation', async () => {
  const p = panel({ opens: false });
  p.document.hidden = false;
  await p.api.checkInvitation();
  await p.visible(1);
  await p.$('invitationReview').handlers.click();
  assert.equal(p.calls.some(call => call.body?.action === 'opened'), false);
});

test('Dismiss and Stop asking use separate explicit controls, never telemetry opt-out', async () => {
  const p = panel();
  p.document.hidden = false;
  await p.api.checkInvitation();
  await p.visible(1);
  await p.$('invitationDismiss').handlers.click();
  assert.equal(p.calls.at(-1).body.action, 'dismissed');
  await p.$('invitationStop').handlers.click();
  assert.equal(p.calls.at(-1).path, '/api/telemetry/invitation-preference');
  assert.equal(p.calls.at(-1).body.enabled, false);
  assert.equal(p.calls.some(call => call.path === '/api/telemetry/preference'), false);
});

test('a pending feedback submission prevents background invitation requests', async () => {
  const p = panel();
  p.document.hidden = false;
  p.review.pending = { event: 'pending' };
  await p.api.checkInvitation();
  assert.equal(p.calls.length, 0);
});

test('unsent guided-form answers also suppress background invitations', async () => {
  const p = panel();
  p.document.hidden = false;
  p.review.edits = new Map([['retrieval:benefit', { value: 'helped' }]]);
  await p.api.checkInvitation();
  assert.equal(p.calls.length, 0);
});

test('hiding the panel clears its invitation without inventing a dismissal', async () => {
  const p = panel();
  p.document.hidden = false;
  await p.api.checkInvitation();
  p.document.hidden = true;
  p.document.handlers.visibilitychange();
  assert.equal(p.$('invitationBanner').hidden, true);
  await p.visible(1);
  assert.equal(p.calls.some(call => call.body?.action === 'shown'), false);
});
