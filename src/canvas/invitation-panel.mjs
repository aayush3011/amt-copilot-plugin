// TODO(dogfood-feedback): This canvas-only dogfooding invitation surface and
// interaction telemetry must be reviewed before external release; revise or remove.
export const INVITATION_PANEL = `
<section id="invitationBanner" class="notice" hidden aria-label="Optional recall feedback">
  <h2>Was this recall helpful?</h2>
  <p id="invitationSummary"></p>
  <p>Review this specific recall and choose whether to rate it. No rating is submitted automatically.</p>
  <p>As part of internal dogfooding, whether this invitation is shown, opened or dismissed is collected as metadata
    for 60 days. See the Feedback tab for the full notice and telemetry opt-out.</p>
  <button id="invitationReview" type="button" disabled>Review</button>
  <button id="invitationDismiss" type="button" disabled>Dismiss for 7 days</button>
  <button id="invitationStop" type="button">Stop asking on this installation</button>
</section>
<p id="invitationError" class="err" role="status" aria-live="polite"></p>`;

export const INVITATION_SCRIPT = `
  const invitation = { current: null, busy: false, lastCheck: 0, observer: null, timer: null, shown: false };

  function clearInvitation() {
    invitation.observer?.disconnect();
    clearTimeout(invitation.timer);
    invitation.current = null;
    invitation.shown = false;
    $('invitationBanner').hidden = true;
  }

  function invitationError(error) {
    $('invitationError').textContent = error?.message || String(error || '');
  }

  function invitationSettings(data) {
    $('invitationPreference').checked = data.enabled;
  }

  async function invitationEvent(action, current) {
    return reviewPost('/api/telemetry/invitation-event', {
      session: current.session, invitation_id: current.invitation_id, action,
    });
  }

  async function showInvitationWhenVisible(entries) {
    const current = invitation.current;
    if (!current || invitation.shown || invitation.busy || document.hidden
      || !entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return;
    invitation.busy = true;
    try {
      await invitationEvent('shown', current);
      if (invitation.current !== current) return;
      invitation.shown = true;
      invitation.observer.disconnect();
      $('invitationReview').disabled = false;
      $('invitationDismiss').disabled = false;
    } catch (error) {
      clearInvitation();
      invitationError(error);
    } finally { invitation.busy = false; }
  }

  async function checkInvitation() {
    if (document.hidden || invitation.busy || invitation.current || review.busy || review.pending || review.edits?.size
      || Date.now() - invitation.lastCheck < 60000) return;
    invitation.lastCheck = Date.now();
    invitation.busy = true;
    try {
      // Separate from reviewStatus: background invitations must never change an
      // in-progress review selection or pending rating.
      const status = await reviewGet('/api/telemetry/status');
      invitationSettings(status.invitations);
      const data = await reviewPost('/api/telemetry/invitation', { session: status.session });
      if (!data.invitation || document.hidden || review.busy || review.pending || review.edits?.size) return;
      const current = { ...data.invitation, session: status.session };
      invitation.current = current;
      invitation.shown = false;
      $('invitationSummary').textContent = reviewTime(current.recorded_at) + ' - ' + current.count + ' result(s).';
      $('invitationReview').disabled = true;
      $('invitationDismiss').disabled = true;
      $('invitationBanner').hidden = false;
      invitation.observer = new IntersectionObserver(showInvitationWhenVisible, { threshold: 0.5 });
      invitation.observer.observe($('invitationBanner'));
      invitation.timer = setTimeout(clearInvitation, Math.max(0, Date.parse(current.expires_at) - Date.now()));
    } catch (error) {
      clearInvitation();
      invitationError(error);
    } finally { invitation.busy = false; }
  }

  $('invitationReview').addEventListener('click', async () => {
    const current = invitation.current;
    if (!current || !invitation.shown || invitation.busy || review.busy || review.pending || review.edits?.size) return;
    invitation.busy = true;
    invitationError('');
    try {
      $('memoryView').hidden = true;
      $('reviewView').hidden = false;
      if (await openRecall(current.retrieval_id)) await invitationEvent('opened', current);
    } catch (error) { invitationError(error); }
    finally { clearInvitation(); invitation.busy = false; }
  });
  $('invitationDismiss').addEventListener('click', async () => {
    const current = invitation.current;
    if (!current || !invitation.shown || invitation.busy) return;
    invitation.busy = true;
    try { await invitationEvent('dismissed', current); }
    catch (error) { invitationError(error); }
    finally { clearInvitation(); invitation.busy = false; }
  });
  async function changeInvitationPreference(enabled) {
    if (invitation.busy) return;
    invitation.busy = true;
    $('invitationPreference').disabled = true;
    invitationError('');
    try {
      const status = await reviewGet('/api/telemetry/status');
      const data = await reviewPost('/api/telemetry/invitation-preference', { session: status.session, enabled });
      invitationSettings(data);
      if (data.warning) invitationError(data.warning);
      clearInvitation();
    } catch (error) {
      $('invitationPreference').checked = !enabled;
      invitationError(error);
    } finally { invitation.busy = false; $('invitationPreference').disabled = false; }
  }
  $('invitationStop').addEventListener('click', () => changeInvitationPreference(false));
  $('invitationPreference').addEventListener('change', () => changeInvitationPreference($('invitationPreference').checked));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearInvitation();
    else checkInvitation();
  });
  $('refresh').addEventListener('click', checkInvitation);
  checkInvitation();
`;
