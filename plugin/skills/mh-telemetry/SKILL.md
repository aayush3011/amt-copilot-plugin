---
name: mh-telemetry
description: Explain default-on internal dogfooding telemetry, check participation, or opt out or re-enable only at the user's explicit request.
---

<!-- TODO(dogfood-feedback): Review this internal dogfooding feedback participation
workflow before external customer release; it may be revised or removed. -->

Use `runtime/auth.mjs` in the installed plugin, two folders above this skill's folder.
These commands use the existing Memory House sign-in and print one JSON line.
Never read credentials, call Kusto directly, or invent an endpoint.

To check participation:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" telemetry-status
```

For onboarding or a request to explain the policy, obtain the notice:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" telemetry-notice
```

Show the returned notice verbatim inside a `<memory-house-telemetry>` block.
Internal dogfooding collection is on by default unless the account opted out; no
opt-in approval is required. Point out the opt-out command below and the canvas's
Feedback tab opt-out control. Never run enable just because the user signs in,
asks about telemetry or opens the canvas: that would override an existing opt-out.

Only for an explicit request to re-enable collection after opting out, run:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" telemetry-enable
```

Policy versions are informational, not a re-consent gate. Report an actual API
failure instead of inventing a version or claiming collection was re-enabled.

For an explicit request to opt out:

```bash
node "<folder containing this SKILL.md>/../../runtime/auth.mjs" telemetry-disable
```

Opt-out pauses this device's metadata queue before contacting the service. Report an
unconfirmed server opt-out as pending, not successful; the user can retry the same
command. Opt-out does not delete previously recorded metadata; it keeps its original
expiry (60 days for new records; older records keep their original expiry).
A deletion job from a separate reset may still appear in status;
`status: running` means that separate deletion is not completed.
Signing out alone is not server-side telemetry opt-out.

Keep notice, status and preference changes in `<memory-house-telemetry>` blocks so
the plugin does not extract them as memories. Human feedback is submitted explicitly
in the canvas, never fabricated or submitted by the agent. If discussing review
results in chat, wrap them in `<memory-house-review>` or `<memory-house-feedback>`
blocks to keep them out of capture. This skill does not submit memory-quality feedback.
