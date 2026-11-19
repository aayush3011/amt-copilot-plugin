// TODO(dogfood-feedback): Review this internal dogfooding UI before external customer
// release; it may be revised or removed independently of ordinary memory browsing.
import { FEEDBACK_VALUES } from '../feedback.mjs';

export const REVIEW_PANEL = `
<section id="reviewView" hidden aria-label="Recent recalls and privacy">
  <h2>Recent recalls and privacy</h2>
  <p>Internal dogfooding telemetry is on by default unless you opted out. New metadata
  and explicit feedback are retained for 60 days. Your prompts, answers and memory text
  are not copied into feedback telemetry.</p>
  <details><summary>Collection and retention notice</summary><p id="reviewNotice"></p></details>
  <p id="reviewStatus" role="status" aria-live="polite">Loading participation...</p>
  <button id="reviewPreference" type="button" disabled>Loading participation...</button>
  <button id="reviewRefresh" type="button">Refresh recalls</button>
  <label class="checkline"><input id="invitationPreference" type="checkbox" checked />
    Occasionally invite me to rate a recall on this installation</label>
  <p class="hint">Only while this canvas is open. At most once per 24 hours; dismissing pauses invitations for 7 days.
    This preference does not opt you out of telemetry.</p>
  <p id="reviewError" class="err" role="alert"></p>
  <div class="review-grid">
    <div><h3>Your recorded recalls</h3><div id="recallList"></div>
      <button id="recallMore" type="button" hidden>Load more</button></div>
    <div id="recallDetail" aria-live="polite">Select a recall to review it.</div>
  </div>
</section>`;

export const REVIEW_SCRIPT = `
  const review = { session: null, enrollment: null, cursor: null, items: [], detail: null,
    busy: false, pending: null, edits: new Map(), needsRefresh: false };
  const feedbackValues = ${JSON.stringify(FEEDBACK_VALUES)};
  const feedbackQuestions = {
    benefit: { title: 'Did this recall help with your task?', values: {
      helped: 'Helped', no_difference: 'No noticeable difference', harmed: 'Made things worse', unsure: 'Not sure' } },
    correctness: { title: 'Is this information still accurate?', values: {
      correct: 'Correct', outdated: 'Outdated', incorrect: 'Incorrect', unsure: 'Not sure' } },
    applicability: { title: 'Does it apply to this task or context?', values: {
      applies: 'Applies', partly_applies: 'Partly applies', does_not_apply: 'Does not apply', unsure: 'Not sure' } },
    relevance: { title: 'Was it relevant to what you were doing?', values: {
      relevant: 'Relevant', partly_relevant: 'Partly relevant', irrelevant: 'Irrelevant', unsure: 'Not sure' } },
  };
  const labelText = value => String(value ?? '').replaceAll('_', ' ');
  const reviewTime = value => new Date(value).toLocaleString();

  function reviewError(error) {
    $('reviewError').textContent = error?.message || String(error || '');
  }

  async function reviewGet(path) {
    const response = await fetch(path, { headers: HEADERS, cache: 'no-store' });
    if (!response.ok) throw new Error(await errorText(response));
    return response.json();
  }

  async function reviewPost(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.message || 'The review request failed.');
      error.status = response.status; error.code = data.error; throw error;
    }
    return data;
  }

  function participation() {
    const value = review.enrollment;
    $('reviewPreference').disabled = review.busy || !value || (!value.available && !value.enrolled);
    $('reviewPreference').textContent = value?.enrolled ? 'Opt out of new collection' : 'Re-enable collection';
    $('reviewStatus').textContent = !value ? 'Participation could not be loaded.'
      : value.local_collection_paused && value.enrolled
        ? 'Local collection is paused. Server opt-out is unconfirmed; retry Opt out.'
        : !value.available ? 'Collection is unavailable for this account.'
        : value.enrolled ? 'Collection is on. You can opt out below without disabling memories.'
        : 'Collection is off. Previously recorded metadata keeps its original expiry.';
  }

  async function reviewStatus() {
    const data = await reviewGet('/api/telemetry/status');
    if (review.session && (review.session !== data.session
      || review.enrollment?.epoch !== data.enrollment.epoch
      || !data.enrollment.enrolled || !data.enrollment.available || data.enrollment.local_collection_paused)) {
      clearInvitation();
      review.items = []; review.detail = null; review.pending = null; review.cursor = null;
      review.edits.clear();
      $('recallList').textContent = '';
      $('recallDetail').textContent = 'Sign-in or participation changed. Select a recall again.';
    }
    review.session = data.session;
    review.enrollment = data.enrollment;
    invitationSettings(data.invitations);
    $('reviewNotice').textContent = data.notice + '\\n\\n' + data.opt_out;
    participation();
  }

  function recallList() {
    $('recallList').innerHTML = review.items.length ? review.items.map(item =>
      '<button type="button" data-recall="' + esc(item.retrieval_id) + '">' +
      esc(reviewTime(item.recorded_at)) + '<br>' + esc(item.client?.trigger || 'Unknown source') +
      ' - ' + esc(item.count) + ' result(s)' + (item.feedback ? ' - rated' : '') + '</button>').join('')
      : '<p>No recorded recalls are available. Earlier unrecorded searches cannot be reconstructed.</p>';
    $('recallMore').hidden = !review.cursor;
  }

  async function loadRecallPage(more = false) {
    const data = await reviewPost('/api/telemetry/recalls', { session: review.session,
      ...(more && review.cursor ? { cursor: review.cursor } : {}) });
    const items = more ? [...review.items, ...data.items] : data.items;
    review.items = [...new Map(items.map(item => [item.retrieval_id, item])).values()];
    review.cursor = data.cursor;
    recallList();
  }

  function memoryText(memory) {
    for (const key of ['content', 'text', 'summary']) if (typeof memory?.[key] === 'string') {
      const conflicts = memory.conflicts_with;
      return memory[key] + (Array.isArray(conflicts) && conflicts.length
        ? '\\n\\nConflict notes:\\n' + JSON.stringify(conflicts, null, 2) : '');
    }
    return memory ? JSON.stringify(memory, null, 2) : '';
  }

  const answerKey = (target, dimension) => target + ':' + dimension;
  const questionId = (target, dimension) => 'question-' + target + '-' + dimension;
  function savedAnswer(target, dimension) {
    return review.detail?.feedback?.labels.find(label => label.target === target && label.dimension === dimension);
  }
  function selectedAnswer(target, dimension) {
    const edit = review.edits.get(answerKey(target, dimension));
    return edit ? edit.action === 'set' ? edit : null : savedAnswer(target, dimension);
  }
  function stageAnswer(label) {
    const saved = savedAnswer(label.target, label.dimension);
    const same = label.action === 'withdraw' ? !saved : saved?.value === label.value
      && JSON.stringify([...(saved.reasons || [])].sort()) === JSON.stringify([...(label.reasons || [])].sort());
    if (same) review.edits.delete(answerKey(label.target, label.dimension));
    else review.edits.set(answerKey(label.target, label.dimension), label);
  }
  function feedbackAllowed() {
    return review.detail?.feedback_allowed && review.enrollment?.enrolled && review.enrollment?.available
      && !review.enrollment.local_collection_paused && review.detail.epoch === review.enrollment.epoch;
  }
  function answerTools(target, dimension) {
    const saved = savedAnswer(target, dimension);
    const edit = review.edits.get(answerKey(target, dimension));
    const attrs = ' data-target="' + target + '" data-dimension="' + dimension + '"';
    return '<div class="answer-status">' +
      (edit ? '<span>' + (edit.action === 'withdraw' ? 'Will be withdrawn when you submit.' : 'Not submitted yet.') + '</span> ' +
        (saved ? '<button type="button" data-undo-answer="true"' + attrs + '>Undo change</button>' : '') :
        saved ? '<span>Saved answer</span> ' : '<span>Optional - leave unanswered to skip</span>') +
      (selectedAnswer(target, dimension) ? '<button type="button" data-clear-answer="true"' + attrs + '>' +
        (saved ? 'Withdraw saved rating' : 'Clear answer') + '</button>' : '') + '</div>';
  }
  function questionContents(target, dimension) {
    const answer = selectedAnswer(target, dimension);
    const id = questionId(target, dimension);
    const attrs = ' data-target="' + target + '" data-dimension="' + dimension + '"';
    return '<legend>' + feedbackQuestions[dimension].title + '</legend><div class="answer-choices">' +
      Object.entries(feedbackQuestions[dimension].values).map(([value, title]) =>
        '<label class="answer-choice"><input type="radio" data-answer="true"' + attrs +
        ' name="' + id + '" id="' + id + '-' + value + '" value="' + value + '"' +
        (answer?.value === value ? ' checked' : '') + ' /><span>' + title + '</span></label>').join('') + '</div>' +
      (answer && feedbackValues[dimension][answer.value].length
        ? '<div class="answer-reasons" role="group" aria-label="Optional reasons"><p>Why? Optional - choose up to 3.</p>' +
          feedbackValues[dimension][answer.value].map(reason => {
            const checked = answer.reasons?.includes(reason);
            const capped = !checked && answer.reasons?.length >= 3;
            return '<label><input type="checkbox" data-reason="true"' + attrs + ' id="' + id + '-' + reason +
              '" value="' + reason + '"' + (checked ? ' checked' : '') +
              (capped ? ' disabled data-limit-disabled="true"' : '') + ' />' + esc(labelText(reason)) + '</label>';
          }).join('') + '</div>' : '') + answerTools(target, dimension);
  }
  function question(target, dimension) {
    return '<fieldset class="feedback-question" id="' + questionId(target, dimension) + '">' +
      questionContents(target, dimension) + '</fieldset>';
  }
  function updateQuestion(target, dimension) {
    const focused = document.activeElement?.id;
    const node = $(questionId(target, dimension));
    if (node) node.innerHTML = questionContents(target, dimension);
    else {
      const tools = $('saved-tools-' + target + '-' + dimension);
      if (tools) tools.innerHTML = answerTools(target, dimension);
    }
    if (focused) $(focused)?.focus();
    feedbackBusy();
  }

  function renderRecall() {
    const detail = review.detail;
    if (!detail) return;
    const allowed = feedbackAllowed();
    const labels = detail.feedback?.labels || [];
    const states = {
      unchanged: 'Unchanged since this recall', changed: 'Changed since this recall',
      superseded: 'Superseded since this recall', unavailable: 'Unavailable',
    };
    $('recallDetail').innerHTML = '<h3>Recall from ' + esc(reviewTime(detail.recorded_at)) + '</h3>' +
      (allowed ? '<form id="feedbackForm"><div class="feedback-intro"><h3>A quick check, if you have a moment</h3>' +
        '<p>Answer as much or as little as you like. One answer is useful; every question is optional.</p></div>' +
        question('retrieval', 'benefit') +
        '<p id="feedbackHarmHint" class="hint" hidden>If you can, rate a memory below to help us understand what went wrong. This is optional.</p>' +
        '<div class="feedback-submit-bar"><p id="feedbackDraftStatus" role="status" aria-live="polite"></p>' +
        '<p id="feedbackMessage" role="status" aria-live="polite"></p>' +
        '<button id="feedbackSubmit" class="primary" type="submit" disabled>Submit feedback</button>' +
        '<button id="feedbackDiscard" type="button" hidden>Discard changes</button>' +
        '<button id="feedbackRetry" type="button" hidden>Retry the same submission</button></div>' :
        '<p>This recall is read-only: collection is off/unavailable, it belongs to an earlier epoch, it failed, or its revision limit was reached.</p>') +
      '<details><summary>Recall details and privacy</summary><p>Source (client-reported): ' + esc(detail.client?.name || 'Unknown') + ' / ' +
      esc(detail.client?.trigger || 'Unknown') + '. Outcome: ' + esc(detail.final_outcome || detail.status) +
      '. Expires: ' + esc(reviewTime(detail.expires_at)) + '.</p>' +
      '<p>Supplied means added to the conversation, not proof the agent used it. Review text is read with your current access; no historical copy is kept.</p></details>' +
      '<h3 class="feedback-memory-heading">' + (detail.items.length ? 'Your recalled memories' : 'No memories were returned') + '</h3>' +
      (allowed && detail.items.length ? '<p class="hint">Want to tell us more? Expand any memory to rate its accuracy, applicability and relevance.</p>' : '') +
      detail.items.map(item => '<article class="card"><h3>Memory ' + item.rank + ' - ' + esc(states[item.memory_state]) +
        '</h3><p>Position: ' + esc(item.position) + '. Delivery: ' +
        esc(item.supplied === null ? 'unknown (no delivery report)' : item.supplied) +
        (item.omit_reason ? ' (' + esc(labelText(item.omit_reason)) + ')' : '') + '.</p>' +
        (item.memory ? '<p><b>' + (item.memory_state === 'unchanged' ? 'Unchanged text' : 'Current text, NOT the recalled version') +
          '</b></p><pre>' + esc(memoryText(item.memory)) + '</pre>' : '') +
        (['changed', 'superseded'].includes(item.memory_state) && !item.memory
          ? '<button type="button" data-current="true">Show current text (not the recalled version)</button>' : '') +
        (item.successor_id ? '<p>A readable successor exists: ' + esc(item.successor_id) + '</p>' : '') +
        (item.memory_state !== 'unchanged' ? '<p>New result ratings are unavailable because the original text cannot be verified.</p>' : '') +
        (allowed && item.memory_state === 'unchanged' ? '<details class="memory-questions"' +
          (['correctness', 'applicability', 'relevance'].some(dimension => review.edits.has(answerKey(item.rank, dimension))) ? ' open' : '') +
          '><summary>Rate this memory <span class="hint">- accuracy, applicability &amp; relevance' +
          (labels.some(label => label.target === item.rank) ? ' (saved answers inside)' : '') + '</span></summary>' +
          ['correctness', 'applicability', 'relevance'].map(dimension => question(item.rank, dimension)).join('') + '</details>' : '') +
        '</article>').join('') +
      (labels.some(label => !allowed || (label.target !== 'retrieval'
        && detail.items.find(item => item.rank === label.target)?.memory_state !== 'unchanged')) ? '<h3>Previously saved ratings</h3>' : '') +
      labels.filter(label => !allowed || (label.target !== 'retrieval'
        && detail.items.find(item => item.rank === label.target)?.memory_state !== 'unchanged')).map(label => '<div><p>' +
        esc(label.target === 'retrieval' ? 'Whole recall' : 'Memory ' + label.target) +
        ': ' + esc(label.dimension) + ' - ' + esc(labelText(label.value)) +
        (label.reasons?.length ? ' (' + esc(label.reasons.map(labelText).join(', ')) + ')' : '') +
        '</p>' + (allowed ? '<div id="saved-tools-' + label.target + '-' + label.dimension + '">' +
          answerTools(label.target, label.dimension) + '</div>' : '') + '</div>').join('') +
      '<details><summary>How your feedback is handled</summary>' +
      '<p>Only answers you choose are submitted, as UI-attested feedback. Nothing changes your memories or their ranking. ' +
      'Leaving a question untouched keeps any saved rating; use Withdraw to remove one. Up to 20 revisions are retained.</p>' +
      (detail.feedback ? '<p>' + esc(detail.feedback.revisions_left) + ' revisions left. Feedback expires ' +
        esc(reviewTime(detail.feedback.expires_at)) + '. Withdrawal removes the active rating; previously exported versions remain until that expiry.</p>' :
        '<p>Feedback expires 60 days after your first submission. Changes do not restart expiry.</p>') + '</details>' +
      (allowed ? '</form>' : '') +
      (allowed ? '' : '<p id="feedbackMessage" role="status" aria-live="polite"></p>' +
        '<button id="feedbackRetry" type="button" hidden>Retry the same submission</button>');
    if (allowed) {
      $('feedbackForm').onsubmit = event => {
        event.preventDefault();
        submitFeedback();
      };
      $('feedbackDiscard').onclick = () => {
        if (review.busy || review.pending) return;
        review.edits.clear();
        renderRecall();
      };
    }
    $('feedbackRetry').onclick = () => sendFeedback();
    feedbackBusy();
  }

  function feedbackBusy() {
    for (const element of $('recallDetail').querySelectorAll('button, input, select')) {
      element.disabled = review.busy || Boolean(review.pending) || review.needsRefresh || element.dataset.limitDisabled === 'true';
    }
    if ($('feedbackRetry')) {
      $('feedbackRetry').hidden = !review.pending;
      $('feedbackRetry').disabled = review.busy;
    }
    const blocked = review.busy || Boolean(review.pending) || review.edits.size > 0;
    $('reviewRefresh').disabled = blocked;
    $('recallMore').disabled = blocked;
    for (const button of $('recallList').querySelectorAll('button')) button.disabled = blocked;
    if ($('feedbackSubmit')) $('feedbackSubmit').disabled = review.busy || Boolean(review.pending) || review.needsRefresh || !review.edits.size;
    if ($('feedbackDiscard')) $('feedbackDiscard').hidden = !review.edits.size || Boolean(review.pending);
    if ($('feedbackDraftStatus')) $('feedbackDraftStatus').textContent = review.pending ? 'Waiting for confirmation. Your selected answers are kept for retry.'
      : review.edits.size ? review.edits.size + (review.edits.size === 1 ? ' change ready to save.' : ' changes ready to save.')
        : 'Choose any answer. Nothing is sent until you submit.';
    if ($('feedbackHarmHint')) $('feedbackHarmHint').hidden = selectedAnswer('retrieval', 'benefit')?.value !== 'harmed';
  }

  async function openRecall(id, includeCurrent = false) {
    if (review.busy || review.pending) return;
    if (review.edits.size && id !== review.detail?.retrieval_id) {
      reviewError(new Error('Submit or discard your changes before opening another recall.'));
      return false;
    }
    const previous = review.detail;
    const previousSession = review.session;
    review.busy = true; feedbackBusy(); reviewError('');
    try {
      await reviewStatus();
      const detail = await reviewPost('/api/telemetry/recall', {
        session: review.session, retrieval_id: id, include_current: includeCurrent,
      });
      if (previous?.retrieval_id !== id || previousSession !== review.session || previous.epoch !== detail.epoch) review.edits.clear();
      else if (previous.feedback?.revision !== detail.feedback?.revision) {
        if (review.edits.size) reviewError(new Error('Saved ratings changed elsewhere. Your draft was cleared; review the updated answers.'));
        review.edits.clear();
      }
      review.detail = detail;
      if (!feedbackAllowed()) review.edits.clear();
      for (const [key, label] of review.edits) {
        if (label.action === 'set' && label.target !== 'retrieval'
          && detail.items.find(item => item.rank === label.target)?.memory_state !== 'unchanged') {
          review.edits.delete(key);
          reviewError(new Error('A memory changed or is unavailable. Its unsaved rating was cleared to avoid rating the wrong version.'));
        }
      }
      review.needsRefresh = false;
      renderRecall();
      return true;
    } catch (error) {
      review.detail = null;
      review.edits.clear();
      $('recallDetail').textContent = 'Recall could not be loaded.';
      reviewError(error);
      return false;
    } finally { review.busy = false; participation(); feedbackBusy(); }
  }

  function submitFeedback() {
    if (review.busy || review.pending || review.needsRefresh || !feedbackAllowed() || !review.edits.size) return;
    review.pending = { session: review.session, retrieval_id: review.detail.retrieval_id,
      event: { event_id: crypto.randomUUID(), epoch: review.detail.epoch, surface: 'review_canvas',
        attestation: 'client_ui', occurred_at: new Date().toISOString(), labels: [...review.edits.values()] } };
    return sendFeedback();
  }

  async function sendFeedback() {
    if (review.busy || !review.pending) return;
    review.busy = true; participation(); feedbackBusy(); reviewError('');
    $('feedbackMessage').textContent = 'Submitting...';
    const pending = review.pending;
    let saved = false;
    try {
      const ack = await reviewPost('/api/telemetry/feedback', pending);
      if (!['recorded', 'duplicate'].includes(ack.status) || ack.event_id !== pending.event.event_id) {
        throw new Error('The submission was not acknowledged. Retry the same submission.');
      }
      saved = true; review.pending = null; review.edits.clear(); review.needsRefresh = true;
      review.detail = await reviewPost('/api/telemetry/recall', {
        session: review.session, retrieval_id: pending.retrieval_id, include_current: false,
      });
      review.needsRefresh = false;
      renderRecall();
      $('feedbackMessage').textContent = 'Thank you! Your feedback is saved. Only your latest answers count.';
    } catch (error) {
      if (!saved && ([400, 401, 403, 404, 413, 422].includes(error.status)
        || (error.status === 409 && error.code !== 'retrieval_not_ready')
        || error.code === 'TELEMETRY_STATE_CHANGED')) {
        review.pending = null; review.edits.clear(); review.needsRefresh = true;
      }
      $('feedbackMessage').textContent = saved ? 'Saved, but the updated recall could not be loaded. Refresh to see it.'
        : review.pending ? 'Submission not confirmed. Retry uses the same event ID; no automatic retry is sent.'
          : 'Feedback was not accepted. Refresh before trying again.';
      reviewError(error);
    } finally { review.busy = false; participation(); feedbackBusy(); }
  }

  async function refreshReview() {
    if (review.busy || review.pending || review.edits.size) return;
    review.busy = true; participation(); reviewError('');
    try {
      await reviewStatus();
      review.detail = null;
      review.needsRefresh = false;
      $('recallDetail').textContent = 'Select a recall to review it.';
      await loadRecallPage();
    }
    catch (error) {
      review.enrollment = null; review.session = null; review.pending = null;
      review.edits.clear();
      review.detail = null; review.items = []; review.cursor = null;
      $('recallList').textContent = '';
      $('recallDetail').textContent = 'Refresh participation before reviewing recalls.';
      reviewError(error);
    } finally { review.busy = false; participation(); feedbackBusy(); }
  }

  $('recallList').addEventListener('click', event => {
    const button = event.target.closest('[data-recall]');
    if (button) openRecall(button.getAttribute('data-recall'));
  });
  $('recallDetail').addEventListener('click', event => {
    const current = event.target.closest('[data-current]');
    if (current && review.detail) { openRecall(review.detail.retrieval_id, true); return; }
    if (review.busy || review.pending || review.needsRefresh || !feedbackAllowed()) return;
    const control = event.target.closest('[data-clear-answer], [data-undo-answer]');
    if (control) {
      const target = control.dataset.target === 'retrieval' ? 'retrieval' : Number(control.dataset.target);
      const dimension = control.dataset.dimension;
      if (control.hasAttribute('data-undo-answer')) review.edits.delete(answerKey(target, dimension));
      else stageAnswer({ target, dimension, action: 'withdraw' });
      updateQuestion(target, dimension);
    }
  });
  $('recallDetail').addEventListener('change', event => {
    if (review.busy || review.pending || review.needsRefresh || !feedbackAllowed()) return;
    const control = event.target.closest('[data-answer], [data-reason]');
    if (!control) return;
    const target = control.dataset.target === 'retrieval' ? 'retrieval' : Number(control.dataset.target);
    const dimension = control.dataset.dimension;
    const current = selectedAnswer(target, dimension);
    if (control.hasAttribute('data-answer')) {
      stageAnswer({ target, dimension, action: 'set', value: control.value,
        reasons: current?.value === control.value ? [...(current.reasons || [])] : [] });
    } else {
      if (!current) return;
      const reasons = new Set(current.reasons || []);
      if (control.checked) reasons.add(control.value); else reasons.delete(control.value);
      if (reasons.size > 3) {
        control.checked = false;
        reviewError(new Error('Choose at most three reasons.'));
        return;
      }
      stageAnswer({ target, dimension, action: 'set', value: current.value, reasons: [...reasons] });
    }
    updateQuestion(target, dimension);
  });
  $('recallMore').addEventListener('click', async () => {
    if (review.busy || review.pending || review.edits.size || !review.cursor) return;
    review.busy = true; feedbackBusy(); reviewError('');
    try { await loadRecallPage(true); } catch (error) { reviewError(error); }
    finally { review.busy = false; participation(); feedbackBusy(); }
  });
  $('reviewRefresh').addEventListener('click', refreshReview);
  $('recalls').addEventListener('click', () => {
    $('memoryView').hidden = true;
    $('reviewView').hidden = false;
    refreshReview();
  });
  $('memories').addEventListener('click', () => {
    $('reviewView').hidden = true;
    $('memoryView').hidden = false;
  });
  $('reviewPreference').addEventListener('click', async () => {
    if (review.busy || !review.enrollment || !review.session) return;
    review.busy = true; participation(); reviewError('');
    try {
      const data = await reviewPost('/api/telemetry/preference', {
        session: review.session, action: review.enrollment.enrolled ? 'disable' : 'enable',
      });
      review.enrollment = data.enrollment;
      clearInvitation();
      review.pending = null;
      review.edits.clear();
      review.detail = null;
      $('recallDetail').textContent = 'Participation changed. Select a recall again.';
    } catch (error) {
      reviewError(error);
      review.pending = null;
      review.edits.clear();
      review.detail = null;
      $('recallDetail').textContent = 'Refresh participation before submitting feedback.';
    } finally { review.busy = false; participation(); feedbackBusy(); }
  });
`;
