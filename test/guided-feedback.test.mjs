import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import test from 'node:test';
import { REVIEW_SCRIPT } from '../src/canvas/review-panel.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const nodes = new Map();
  const dynamic = new Set();
  const makeNode = id => {
    let html = '';
    const node = { id, dataset: {}, handlers: {}, textContent: '', hidden: false, disabled: false,
      addEventListener(event, handler) { this.handlers[event] = handler; },
      querySelectorAll() { return []; }, focus() {},
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        if (id === 'recallDetail') {
          for (const key of dynamic) nodes.delete(key);
          dynamic.clear();
        }
        for (const match of value.matchAll(/\bid="([^"]+)"/g)) {
          if (!nodes.has(match[1])) nodes.set(match[1], makeNode(match[1]));
          dynamic.add(match[1]);
        }
      },
    };
    return node;
  };
  for (const id of ['recallDetail', 'recallList', 'recallMore', 'reviewRefresh', 'recalls', 'memories',
    'reviewPreference', 'reviewError', 'reviewNotice', 'reviewStatus', 'memoryView', 'reviewView']) {
    nodes.set(id, makeNode(id));
  }
  const $ = id => nodes.get(id);
  const now = new Date().toISOString();
  const state = {
    session: 'session', enrolled: true, failOnce: false, saved: new Map(), calls: [],
    detail: { retrieval_id: 'ret_01JC3K00000000000000000001', epoch: 1, feedback_allowed: true,
      recorded_at: now, expires_at: now, status: 'ok', client: null, count: 2, final_outcome: null, feedback: null,
      items: [1, 2].map(rank => ({ rank, position: 'ranked', supplied: null, omit_reason: null,
        memory_state: 'unchanged', memory: { content: 'Synthetic memory ' + rank } })) },
  };
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  const fetch = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path, body });
    if (path.endsWith('/status')) return response({ session: state.session,
      enrollment: { enrolled: state.enrolled, available: true, epoch: 1 }, notice: 'notice', opt_out: 'opt out', invitations: { enabled: true } });
    if (path.endsWith('/recall')) return response(state.detail);
    if (path.endsWith('/recalls')) return response({ items: [], cursor: null });
    if (path.endsWith('/feedback')) {
      const duplicate = state.saved.has(body.event.event_id);
      if (!duplicate) {
        const current = state.detail.feedback?.labels || [];
        const labels = new Map(current.map(label => [label.target + ':' + label.dimension, label]));
        for (const label of body.event.labels) {
          const key = label.target + ':' + label.dimension;
          if (label.action === 'withdraw') labels.delete(key);
          else labels.set(key, { target: label.target, dimension: label.dimension, value: label.value, reasons: label.reasons, updated_at: now });
        }
        state.detail.feedback = { labels: [...labels.values()], revision: (state.detail.feedback?.revision || 0) + 1,
          revisions_left: 19, expires_at: now };
        state.saved.set(body.event.event_id, true);
      }
      if (state.failOnce) { state.failOnce = false; return response({ message: 'Acknowledgement lost' }, 502); }
      return response({ status: duplicate ? 'duplicate' : 'recorded', event_id: body.event.event_id, revision: state.detail.feedback.revision });
    }
    throw new Error('Unexpected endpoint ' + path);
  };
  const api = new Script(REVIEW_SCRIPT + '\n({ review, renderRecall, submitFeedback, sendFeedback, openRecall, refreshReview, stageAnswer })')
    .runInNewContext({ $, fetch, HEADERS: {}, crypto: { randomUUID }, document: { activeElement: null },
      esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
      clearInvitation() {}, invitationSettings() {}, errorText: async () => 'Request failed' });
  api.review.session = state.session;
  api.review.enrollment = { enrolled: true, available: true, epoch: 1 };
  api.review.detail = structuredClone(state.detail);
  const change = (target, dimension, value, kind = 'answer', checked = true) => {
    const control = { value, checked, dataset: { target: String(target), dimension },
      closest() { return this; }, hasAttribute(name) { return name === 'data-' + kind; } };
    $('recallDetail').handlers.change({ target: control });
    return control;
  };
  const clickAnswerTool = (target, dimension, action) => {
    const control = { dataset: { target: String(target), dimension },
      closest(selector) { return selector === '[data-current]' ? null : this; },
      hasAttribute(name) { return name === 'data-' + action + '-answer'; } };
    $('recallDetail').handlers.click({ target: control });
  };
  return { $, state, api, change, clickAnswerTool, render: () => api.renderRecall(),
    submissions: () => state.calls.filter(call => call.path.endsWith('/feedback')) };
}

test('guided form presents benefit first, expandable memory questions and no default new answers', () => {
  const f = fixture();
  f.render();
  const html = f.$('recallDetail').innerHTML;
  assert.match(html, /Did this recall help with your task/);
  assert.match(html, /Is this information still accurate/);
  assert.match(html, /Does it apply to this task or context/);
  assert.match(html, /Was it relevant to what you were doing/);
  assert.match(html, /<details class="memory-questions"><summary>Rate this memory/);
  assert.doesNotMatch(html, /\bchecked|\brequired|feedbackTarget|feedbackDimension|<select/);
  assert.ok(html.indexOf('id="feedbackSubmit"') < html.indexOf('Synthetic memory 1'));
  assert.equal(f.$('feedbackSubmit').disabled, true);
  assert.equal(f.submissions().length, 0);
});

test('all four buckets submit together once, while skipped questions are omitted', async () => {
  const f = fixture();
  f.render();
  f.change('retrieval', 'benefit', 'helped');
  f.change(1, 'correctness', 'correct');
  f.change(1, 'applicability', 'applies');
  f.change(1, 'relevance', 'unsure');
  assert.equal(f.submissions().length, 0);
  await f.api.submitFeedback();
  const labels = f.submissions()[0].body.event.labels;
  assert.equal(labels.length, 4);
  assert.equal(labels.some(label => label.target === 2), false);
  assert.equal(labels.find(label => label.dimension === 'relevance').value, 'unsure');
  assert.equal(f.state.detail.feedback.revision, 1);
  assert.equal(f.api.review.edits.size, 0);
  assert.match(f.$('feedbackMessage').textContent, /Thank you/);
});

test('an empty recall still accepts benefit without inventing per-memory answers', async () => {
  const f = fixture();
  Object.assign(f.state.detail, { count: 0, items: [], status: 'empty' });
  f.api.review.detail = structuredClone(f.state.detail);
  f.render();
  assert.match(f.$('recallDetail').innerHTML, /No memories were returned/);
  assert.doesNotMatch(f.$('recallDetail').innerHTML, /class="memory-questions"/);
  f.change('retrieval', 'benefit', 'no_difference');
  await f.api.submitFeedback();
  assert.equal(f.submissions()[0].body.event.labels.length, 1);
});

test('saved answers are prefilled, unchanged answers omitted, and withdrawal is explicit and staged', async () => {
  const f = fixture();
  const labels = [{ target: 'retrieval', dimension: 'benefit', value: 'helped', reasons: ['saved_time'] },
    { target: 1, dimension: 'correctness', value: 'outdated', reasons: ['changed_since'] }];
  f.state.detail.feedback = { labels, revision: 1, revisions_left: 19, expires_at: new Date().toISOString() };
  f.api.review.detail = structuredClone(f.state.detail);
  f.render();
  assert.match(f.$('recallDetail').innerHTML, /value="helped" checked/);
  assert.equal(f.api.review.edits.size, 0);
  f.change('retrieval', 'benefit', 'helped');
  assert.equal(f.api.review.edits.size, 0);
  f.clickAnswerTool(1, 'correctness', 'clear');
  assert.equal(f.submissions().length, 0);
  assert.match(f.$('question-1-correctness').innerHTML, /Will be withdrawn/);
  f.clickAnswerTool(1, 'correctness', 'undo');
  assert.equal(f.api.review.edits.size, 0);
  f.clickAnswerTool(1, 'correctness', 'clear');
  await f.api.submitFeedback();
  assert.deepEqual(f.submissions()[0].body.event.labels, [{ target: 1, dimension: 'correctness', action: 'withdraw' }]);
  assert.equal(f.state.detail.feedback.labels[0].value, 'helped');
  assert.equal(f.state.detail.feedback.labels.length, 1);
});

test('clear and undo distinguish unanswered from unsure; reason choices cap at three and reset on value change', () => {
  const f = fixture();
  f.render();
  f.change('retrieval', 'benefit', 'unsure');
  assert.equal(f.api.review.edits.size, 1);
  f.clickAnswerTool('retrieval', 'benefit', 'clear');
  assert.equal(f.api.review.edits.size, 0);
  f.change('retrieval', 'benefit', 'helped');
  for (const value of ['saved_time', 'right_context', 'recalled_decision']) f.change('retrieval', 'benefit', value, 'reason');
  assert.match(f.$('question-retrieval-benefit').innerHTML, /value="avoided_repeating_myself" disabled data-limit-disabled/);
  const fourth = f.change('retrieval', 'benefit', 'avoided_repeating_myself', 'reason');
  assert.equal(fourth.checked, false);
  f.change('retrieval', 'benefit', 'harmed');
  assert.deepEqual(plain(f.api.review.edits.get('retrieval:benefit').reasons), []);
  assert.equal(f.$('feedbackHarmHint').hidden, false);
  f.clickAnswerTool('retrieval', 'benefit', 'clear');
  assert.equal(f.api.review.edits.size, 0);
});

test('uncertain multi-label save retries the exact event and creates no extra revision', async () => {
  const f = fixture();
  f.render();
  f.change('retrieval', 'benefit', 'helped');
  f.change(1, 'relevance', 'relevant');
  f.state.failOnce = true;
  await f.api.submitFeedback();
  assert.ok(f.api.review.pending);
  assert.equal(f.$('feedbackSubmit').disabled, true);
  f.change(1, 'relevance', 'irrelevant');
  assert.equal(f.api.review.edits.get('1:relevance').value, 'relevant');
  await f.api.sendFeedback();
  assert.deepEqual(f.submissions()[0].body, f.submissions()[1].body);
  assert.equal(f.state.detail.feedback.revision, 1);
  assert.equal(f.api.review.pending, null);
});

test('drafts survive viewing current text, block accidental navigation, and can be discarded', async () => {
  const f = fixture();
  f.state.detail.items[1].memory_state = 'changed';
  f.api.review.detail = structuredClone(f.state.detail);
  f.render();
  f.change('retrieval', 'benefit', 'helped');
  await f.api.openRecall('another-recall');
  assert.equal(f.state.calls.length, 0);
  await f.api.openRecall(f.state.detail.retrieval_id, true);
  assert.equal(f.api.review.edits.get('retrieval:benefit').value, 'helped');
  f.$('feedbackDiscard').onclick();
  assert.equal(f.api.review.edits.size, 0);
  assert.equal(f.submissions().length, 0);
});

test('changed memories have no new rating choices, but saved ratings can be withdrawn', async () => {
  const f = fixture();
  f.state.detail.items[0].memory_state = 'changed';
  f.state.detail.feedback = { labels: [{ target: 1, dimension: 'correctness', value: 'correct', reasons: [] }],
    revision: 1, revisions_left: 19, expires_at: new Date().toISOString() };
  f.api.review.detail = structuredClone(f.state.detail);
  f.render();
  assert.doesNotMatch(f.$('recallDetail').innerHTML, /id="question-1-correctness"/);
  assert.match(f.$('recallDetail').innerHTML, /Withdraw saved rating/);
  f.clickAnswerTool(1, 'correctness', 'clear');
  await f.api.submitFeedback();
  assert.equal(f.submissions()[0].body.event.labels[0].action, 'withdraw');
});

test('account changes discard drafts, and rereading changed ratings does not overwrite newer answers', async () => {
  const f = fixture();
  f.render();
  f.change('retrieval', 'benefit', 'helped');
  f.state.session = 'new-account-session';
  await f.api.openRecall(f.state.detail.retrieval_id);
  assert.equal(f.api.review.edits.size, 0);
  f.change('retrieval', 'benefit', 'helped');
  f.state.detail.feedback = { labels: [], revision: 1, revisions_left: 19, expires_at: new Date().toISOString() };
  await f.api.openRecall(f.state.detail.retrieval_id);
  assert.equal(f.api.review.edits.size, 0);
  assert.match(f.$('reviewError').textContent, /changed elsewhere/);
});
