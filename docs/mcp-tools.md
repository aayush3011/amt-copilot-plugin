# Memory House MCP tools

These are the tools your agent can call through the remote Memory House MCP server. They are defined by that server, not by this plugin. Your app may show them with a prefix, for example `memory-house-search_memories`. The tools you see depend on what your Memory House deployment enables; if your app's tool list differs from this page, the app's list is authoritative.

They cover two areas:

- **Your personal memories:** finding, saving and deleting memories, summaries, and checking on background jobs.
- **[Shared memory](#shared-memory-hierarchies-and-spaces):** hierarchies of Spaces, memberships, sharing and roles, your Private Space, and promoting memories into shared Spaces.

Your identity comes from your Microsoft sign-in. No tool takes a user, tenant or endpoint to act as.

## Find and read memories

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `search_memories` | Searches your memories. By default it returns the best-matching facts (one may be an insight), your best-matching preference and your best-matching procedure. | `query`; `top_k` (1-50, default 5); `memory_types` (`fact`, `procedural`, `episodic`); `thread_id` |
| `get_memories` | Lists your memories, newest first. | `page_size` (1-50, default 10); `cursor` for the next page; `memory_types` (`fact`, `procedural`, `episodic`, `insight`); `thread_id` |
| `get_memory` | Reads one memory by ID, from your personal memories or a shared Space you can read. | `memory_id`; `space` if the ID exists in more than one space you can read |
| `get_memory_history` | Pages through your memories, including superseded ones. | `page_size`, `cursor`, `memory_types`, `thread_id`, `created_after`, `created_before` (dates with a timezone) |

Use `search_memories` to find what is relevant and `get_memories` to browse. There is no separate episode search: pass `memory_types: ["episodic"]` to `search_memories`. To find text in one shared Space, use [`search_space_memories`](#read-space-memories).

## Save

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `add_memory` | Stores 1-50 conversation turns in your personal memory (up to 256 KiB). Memories are extracted from the turns in the background, so saving is asynchronous. | `thread_id`; `items` (each with `role` and `content`); `idempotency_key` |

Hooks capture your conversations automatically, so you do not need `add_memory` to remember something: say "remember this" in chat and the memory appears after background extraction.

## Delete

Both delete tools are destructive. The agent should use them only when you explicitly ask, after confirming what will be deleted.

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `delete_memory` | Deletes one of your memories and the records merged into it. Deleting a fact also deletes the insights that cite it. | `memory_id`; `idempotency_key` |
| `delete_all_memories` | Resets all of your own memories. It can't reset another user's. | `user_id` (your exact user object ID); `idempotency_key` |

## Summaries and upkeep

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `get_thread_summary` | Reads the saved summaries for one of your conversations. | `thread_id` |
| `generate_thread_summary` | Starts generating a conversation summary. | `thread_id`; `idempotency_key` |
| `get_user_summary` | Reads your saved user summary (`exists: false` means you don't have one yet). | none |
| `generate_user_summary` | Starts generating your user summary. | `idempotency_key` |
| `reconcile` | Starts a reconciliation pass over your personal memories. | `idempotency_key` |

## Check progress

Saves, deletes, resets, reconciliation and summaries run in the background. Each returns a `request_id`; use the matching status tool to follow it. A failed job is reported as status data, not as a failed call.

| Tool | Follows | Inputs |
| --- | --- | --- |
| `get_memory_write_status` | `add_memory` | `request_id` |
| `get_memory_delete_status` | `delete_memory` | `memory_id`, `request_id` |
| `get_memory_reset_status` | `delete_all_memories` | `request_id` |
| `get_reconcile_status` | `reconcile` | `request_id` |
| `get_thread_summary_status` | `generate_thread_summary` | `thread_id`, `request_id` |
| `get_user_summary_status` | `generate_user_summary` | `request_id` |

When retrying a write, pass the same `idempotency_key`, especially after an unknown outcome, so it isn't applied twice.

## Identity

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `whoami` | Shows who you're signed in as. It describes your identity only and doesn't grant any access. | none |

## Legacy

`enroll_hook_capture` mints a short-lived enrollment code for gateway redemption. This plugin signs in with Microsoft Entra instead and doesn't use it. You don't need it, and you shouldn't share the code it returns.

## Shared memory: hierarchies and Spaces

Shared memory is organized as hierarchies of **Spaces**, for example an organization, its teams and their projects. Your **Private Space** stands for your personal memory. You join a Space by accepting an invitation, and accepting a **contributor** invitation is also your consent to share: Memory House then shares suitable facts and episodes from your Private Space with that Space (see [Share your memories](#share-your-memories)). By default Memory House also approves and publishes them; a Space can require a reviewer to approve them instead.

These tools are always available. Seeing a tool grants nothing: the server checks your memberships and roles on every call, and most changes need a Space administrator or reviewer role.

IDs look like `hierarchy:<uuid>` for hierarchies, `node:<uuid>` for Spaces, `private:<uuid>` for your Private Space and `membership:<uuid>` for memberships. People and services are named as `user:<object-id>`, `agent:<app-id>` or `servicePrincipal:<object-id>`.

### Browse hierarchies and Spaces

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `list_hierarchies` | Lists the hierarchies you can see. | none |
| `get_hierarchy` | Reads a hierarchy and the Spaces in it you can see, each with its path and promotion policy. | `hierarchy_id` |
| `get_space` | Reads a Space: its path, status, promotion policy and guidance. | `space_id` |
| `get_space_policy` | Reads a Space's promotion policy and guidance. | `space_id` |
| `get_learning_space_access` | Lists the Spaces where you hold permissions, and your role assignments with whether each is in effect. | none |

### Read Space memories

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `list_space_memories` | Lists the memories you can read in a Space or your Private Space, newest first. | `space_id`; `page_size` (1-50, default 20); `continuation_token` |
| `search_space_memories` | Finds memories in one Space whose text contains your search terms, newest first. This is a case-insensitive text match, not semantic search. | `space_id`, `search_terms`; `page_size`; `continuation_token`; `filters` (for example `memory_types`, `tags_any`, `created_after`) |
| `get_space_memory` | Reads one memory in a Space, including the `revision` you need to promote it. | `space_id`, `memory_id` |

### Join Spaces and manage access

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `list_my_memberships` | Lists your Space memberships, including invitations waiting for you (state `proposed`). A contributor invitation shows the `sharing_terms` that accepting it agrees to. Contributor memberships also show `sharing_status` (`pending`, `active`, `stopped`, `needs_consent` or `inactive`), and `current_sharing_terms` when the terms to agree to now differ. | optional `state`, `hierarchy_id`, `space_id`, `continuation_token` |
| `transition_membership` | Accepts or declines an invitation, or withdraws from a membership. A membership manager can also remove a member. Accepting a contributor invitation is your consent to share your private memories, so the agent must show you its terms and accept only after you explicitly agree (see [Share your memories](#share-your-memories)). | `membership_id`; `action` (`accept`, `decline`, `withdraw`, `remove`); `if_match`; `sharing_terms_digest` (required to accept a contributor invitation that states sharing terms) |
| `set_membership_sharing` | Stops or resumes sharing your private memories with a Space you contribute to, without leaving it. Resuming after the Space moved is consent to its current terms, so the agent must show them and resume only after you explicitly agree. | `membership_id` (your accepted contributor membership); `sharing` (`false` stops, `true` resumes); `if_match`; `sharing_terms_digest` (required to resume after the Space moved) |
| `get_membership_history` | Reads a membership's events: your own, or one in a Space whose memberships you manage. | `membership_id` |
| `propose_membership` | Invites someone into a Space as `shared_reader` or `contributor`. They become a member only after accepting. A contributor invitation to a leaf Space states sharing terms, and accepting them is the invitee's consent to share. | `space_id`, `identity_id`, `role`; optional `inheritance` (`local` by default, or `subtree` to include descendant Spaces) |
| `list_space_memberships` | Lists a Space's memberships, if you manage them. | `space_id`; optional `state`, `continuation_token` |
| `assign_space_role` | Assigns `space_administrator` or `promotion_reviewer` on a Space. Reader and contributor access comes only from accepted memberships. | `space_id`, `identity_id`, `role`; optional `inheritance` |
| `list_space_roles` | Lists a Space's role assignments, if you manage roles. | `space_id`; optional `continuation_token` |
| `revoke_space_role` | Revokes a role assignment. | `assignment_id`, `if_match` |

### Create and change hierarchies

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `register_hierarchy` | Creates a hierarchy of Spaces from one definition and makes you administrator of its root. Returns each new Space's ID by its key. | `definition`: a `name` and `spaces`, each with a unique `key`, a `name` and, except for the root, a `parent_key`; optional `idempotency_key` |
| `update_space` | Renames a Space, replaces its metadata, moves it (not the root) under another Space in the same hierarchy, or archives or restores it. Omitted fields stay unchanged. | `space_id`, `if_match`; optional `name`, `metadata`, `parent_id`, `status` (`archived`, `active`) |
| `update_space_policy` | Replaces a Space's whole promotion policy and guidance. Omitted fields take their defaults, so start from `get_space_policy`. By default (`automatic_promotion` on, `require_human_approval` off) Memory House approves and publishes qualifying candidates itself. | `space_id`, `policy`, `if_match`; optional `guidance` (omitting it clears it) |

### Your Private Space

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `provision_private_space` | Creates your Private Space, or returns it if you already have one. It stands for your personal memory as a promotion source. Memories reach it only through extraction from your turns, so no tool writes to it directly. | none |

### Promote memories into a shared Space

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `get_promotion_routes` | Lists where memories in a source Space can be promoted now: from your Private Space, the Spaces you currently share with; from a shared Space, its parent. | `space_id` |
| `submit_promotion_from_source` | Copies one of your memories word for word to a Space you share with, or a shared memory to its Space's parent, as a promotion candidate. Memory House does this itself by default; this submits one now. Only facts and episodes are shared; procedures and insights are refused. | `source_space_id`, `source_memory_id`, `source_revision`, `destination_space_id`; optional `idempotency_key` |
| `list_promotion_candidates` | Lists a destination Space's candidates that you submitted or that copy your memories and, if you review there, those you could approve now. A private memory's candidate shows to reviewers only while it qualifies, its owner still shares and the memory is unchanged. Once published, it stays listed without the memory's text. | `space_id`; optional `after` |
| `get_promotion_candidate` | Reads a candidate and one of its revisions, the current one by default. | `candidate_id`; optional `candidate_revision` |
| `review_promotion_candidate` | Approves or rejects a candidate's current revision, as a reviewer of its Space. The decision can't be changed, and a rejection is final: the candidate is never published and that memory's text is never submitted to that Space again. | `candidate_id`, `candidate_revision`, `decision` (`approve`, `reject`) |
| `get_publication_status` | Reads the publication state of a promoted memory. | `space_id`, `memory_id` |
| `get_publication_history` | Pages through the versions of a publication. | `space_id`, `memory_id`; optional `after` |
| `moderate_publication` | Quarantines a published memory (reviewers and administrators), or retires or restores it (administrators). History is kept. | `space_id`, `memory_id`, `action` (`quarantine`, `retire`, `restore`), `reason`, `if_match` |

Publishing isn't an MCP tool: only Memory House's own worker publishes. By default (`automatic_promotion` on, `require_human_approval` off) it approves and publishes qualifying candidates itself. A Space can require a person to approve them instead (see `update_space_policy`).

### Share your memories

Your memories reach a shared Space through sharing, which you agree to by accepting a contributor invitation. Only a contributor invitation to a leaf Space states sharing terms; reader invitations and invitations to other Spaces share nothing.

- **Consent.** The agent must show you the terms text (`current_sharing_terms` if present, otherwise `sharing_terms`) and accept with `transition_membership` only after you explicitly agree, passing the terms' `digest` as `sharing_terms_digest`. Without it the call fails with 422 `sharing_terms_required`. If the terms changed in the meantime it fails with 409 `sharing_terms_changed`, and the agent shows you the new terms and asks again.
- **What is shared.** In the background, after its consolidation pass ("dreaming"), Memory House shares suitable facts and episodes from your Private Space with that Space, word for word, including memories you write later. Procedures and insights aren't shared, and a Space can narrow what it takes to facts or to episodes. By default Memory House also approves and publishes the copies, which may later move up to the Spaces above. A Space can require a person to approve them instead. `submit_promotion_from_source` shares one memory now.
- **Stopping and resuming.** `set_membership_sharing` with `sharing: false` stops all future sharing with that Space, candidates still waiting included, without leaving it. Copies already shared stay and may still move up. Stopping is a pause: resuming (`sharing: true`) also shares the memories you wrote while it was stopped.
- **When the Space moves.** `list_my_memberships` then shows `sharing_status` `needs_consent`, or `stopped` with `current_sharing_terms`. Resuming is consent to those terms: the agent shows you their text and resumes only after you explicitly agree, passing their `digest` as `sharing_terms_digest`.

**Strict mode.** A tenant can run in strict mode, which is off by default. There, sharing a private memory also needs your disclosure policy, created as the owner of your Private Space. These tools matter only in strict mode:

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `create_disclosure_policy` | Creates the strict-mode disclosure policy: the Spaces you contribute to, and optionally the memories, that sharing may reach until a time you choose. | `source_space_id` (your Private Space), `destination_space_ids` (1-100 Spaces where you hold an accepted contributor membership), `content_constraints` (`allowed_memory_types` is required, 1-2 types; optional `allowed_source_memory_ids`, 1-100 IDs), `expires_at`; optional `idempotency_key` |
| `get_disclosure_policy` | Reads one of your disclosure policies. | `policy_id` |
| `revoke_disclosure_policy` | Revokes a disclosure policy you own. | `policy_id`, `if_match` (the `etag` from `get_disclosure_policy`) |

### Common tasks

- **Join a Space you were invited to:** `list_my_memberships` with `state: "proposed"`, then `transition_membership` with `action: "accept"` and the membership's `version` as `if_match`. For a contributor invitation, the agent first shows you its sharing terms and accepts only after you agree, passing the terms' `digest` as `sharing_terms_digest`.
- **Share a learning with a team:** accept a contributor invitation to the team's Space, agreeing to its terms. Memory House then shares suitable facts and episodes from your Private Space after dreaming. `submit_promotion_from_source` shares one now, and `set_membership_sharing` stops or resumes sharing. Where the Space requires a person to approve, its reviewers use `review_promotion_candidate`.
- **Set up a hierarchy:** `register_hierarchy`, then `propose_membership` for each person and `assign_space_role` for reviewers.

### Changes, retries and paging

- **`if_match`:** tools that change an existing record take the `etag` from your last read, or the `version` a list item carries. If the record changed since, the call fails with `precondition_failed`; read it again and decide again. It isn't retried for you.
- **`idempotency_key`:** `register_hierarchy`, `submit_promotion_from_source` and `create_disclosure_policy` return the key they used, and generate one if you don't pass it. Pass the same key to retry after an unknown outcome.
- **Paging:** pass the returned continuation token as `continuation_token`. Candidate lists and publication history take it as `after`.
- **Times:** `expires_at` and date filters are ISO 8601 timestamps with a timezone.
- **Destructive tools:** `update_space`, `update_space_policy`, `transition_membership`, `set_membership_sharing`, `review_promotion_candidate`, `revoke_space_role`, `moderate_publication` and `revoke_disclosure_policy` change or remove existing records, and a rejection by `review_promotion_candidate` is final. The agent should run them only when you ask.
