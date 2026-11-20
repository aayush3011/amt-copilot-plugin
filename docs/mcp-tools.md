# Memory House MCP tools

These are the tools your agent can call through the remote Memory House MCP server. They are defined by that server, not by this plugin. Your app may show them with a prefix, for example `memory-house-search_memories`. The tools you see depend on what your Memory House deployment enables; if your app's tool list differs from this page, the app's list is authoritative.

They cover two areas:

- **Your personal memories:** finding, saving and deleting memories, summaries, and checking on background jobs.
- **[Shared memory](#shared-memory-hierarchies-and-spaces):** hierarchies of Spaces, memberships and roles, your Private Space, and promoting memories into shared Spaces.

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
| `add_memory` | Stores 1-50 conversation turns for extraction, or already-distilled facts, in your personal memory (up to 256 KiB). Saving is asynchronous. | `items`; `extract` (default `true`; `false` saves the items as facts); `thread_id` (required when extracting); `idempotency_key` |

Hooks capture your conversations automatically, so `add_memory` is only for an explicit "remember this."

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

Shared memory is organized as hierarchies of **Spaces**, for example an organization, its teams and their projects. You join a Space by accepting an invitation, record your own learnings in your **Private Space**, and promote the useful ones into a shared Space, where its reviewers approve them.

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
| `list_my_memberships` | Lists your Space memberships, including invitations waiting for you (state `proposed`). | optional `state`, `hierarchy_id`, `space_id`, `continuation_token` |
| `transition_membership` | Accepts or declines an invitation, or withdraws from a membership. A membership manager can also remove a member. | `membership_id`; `action` (`accept`, `decline`, `withdraw`, `remove`); `if_match` |
| `get_membership_history` | Reads a membership's events: your own, or one in a Space whose memberships you manage. | `membership_id` |
| `propose_membership` | Invites someone into a Space as `shared_reader` or `contributor`. They become a member only after accepting. | `space_id`, `identity_id`, `role`; optional `inheritance` (`local` by default, or `subtree` to include descendant Spaces) |
| `list_space_memberships` | Lists a Space's memberships, if you manage them. | `space_id`; optional `state`, `continuation_token` |
| `assign_space_role` | Assigns `space_administrator`, `promotion_reviewer` or `promotion_publisher` (configured services only) on a Space. Reader and contributor access comes only from accepted memberships. | `space_id`, `identity_id`, `role`; optional `inheritance` |
| `list_space_roles` | Lists a Space's role assignments, if you manage roles. | `space_id`; optional `continuation_token` |
| `revoke_space_role` | Revokes a role assignment. | `assignment_id`, `if_match` |

### Create and change hierarchies

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `register_hierarchy` | Creates a hierarchy of Spaces from one definition and makes you administrator of its root. Returns each new Space's ID by its key. | `definition`: a `name` and `spaces`, each with a unique `key`, a `name` and, except for the root, a `parent_key`; optional `idempotency_key` |
| `update_space` | Renames a Space, replaces its metadata, moves it (not the root) under another Space in the same hierarchy, or archives or restores it. Omitted fields stay unchanged. | `space_id`, `if_match`; optional `name`, `metadata`, `parent_id`, `status` (`archived`, `active`) |
| `update_space_policy` | Replaces a Space's whole promotion policy and guidance. Omitted fields take their defaults, so start from `get_space_policy`. | `space_id`, `policy`, `if_match`; optional `guidance` (omitting it clears it) |

### Your Private Space

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `provision_private_space` | Creates your Private Space, or returns it if you already have one. | none |
| `record_private_memory` | Records a memory in your Private Space, or in one delegated to you for writing. Returns its `memory_id` and `revision`. | `space_id`, `content` (up to 65,536 characters); optional `memory_type` (`fact` by default, `episodic`, `procedural`), `metadata`, `tags`, `evidence`, `idempotency_key` |
| `grant_private_delegation` | Lets someone else write to your Private Space, submit from it, or both, until a time you choose. | `space_id`, `identity_id`, `expires_at`; optional `permissions` (`write` by default, `submit`), `membership_id`, `idempotency_key` |
| `list_private_delegations` | Lists the delegations on your Private Space. | `space_id` |
| `revoke_private_delegation` | Revokes a delegation on your Private Space. | `delegation_id`, `if_match` |

### Promote memories into a shared Space

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `get_promotion_routes` | Lists the Spaces that memories in a source Space, such as your Private Space, can be promoted into. | `space_id` |
| `submit_promotion_from_source` | Submits a memory revision for promotion. The package reviewers see is built from the memory. | `source_space_id`, `source_memory_id`, `source_revision`, `destination_space_id`; `disclosure_policy_id` (required from a Private Space); optional `idempotency_key` |
| `submit_promotion_candidate` | Submits a memory revision with a package you write for reviewers: its content, its type (`fact` or `episodic`), and optional evidence and transformation. | `source_space_id`, `source_memory_id`, `source_revision`, `destination_space_id`, `package`; `disclosure_id` (from a Private Space); optional `idempotency_key` |
| `revise_promotion_candidate` | Replaces an unpublished candidate's package with a new revision. Only the person who submitted it can. | `candidate_id`, `source_space_id`, `source_memory_id`, `source_revision`, `package`, `if_match`; optional `disclosure_id` |
| `list_promotion_candidates` | Lists a Space's candidates that you submitted or may review. | `space_id`; optional `after` |
| `get_promotion_candidate` | Reads a candidate and one of its revisions, the current one by default. | `candidate_id`; optional `candidate_revision` |
| `review_promotion_candidate` | Approves or rejects a candidate's current revision, as a reviewer of its Space. The decision can't be changed. | `candidate_id`, `candidate_revision`, `decision` (`approve`, `reject`) |
| `get_publication_status` | Reads the publication state of a promoted memory. | `space_id`, `memory_id` |
| `get_publication_history` | Pages through the versions of a publication. | `space_id`, `memory_id`; optional `after` |
| `moderate_publication` | Quarantines a published memory (reviewers and administrators), or retires or restores it (administrators). History is kept. | `space_id`, `memory_id`, `action` (`quarantine`, `retire`, `restore`), `reason`, `if_match` |

Publishing an approved candidate isn't an MCP tool: the Space's configured publisher service does it.

### Disclose private memories to reviewers

A memory from your Private Space can be promoted only with your permission. A disclosure policy gives it in advance for the Spaces you name; a disclosure authorization covers one exact package.

| Tool | What it does | Main inputs |
| --- | --- | --- |
| `create_disclosure_policy` | Allows promotions from your Private Space into the Spaces you name, within content limits, until a time you choose. | `source_space_id`, `destination_space_ids` (Spaces where you're a member), `content_constraints` (`allowed_memory_types` is required), `expires_at`; optional `reviewers`, `publishers`, `requester_identity_ids`, `idempotency_key` |
| `get_disclosure_policy` | Reads a disclosure policy, as its owner or a named requester. | `policy_id` |
| `revoke_disclosure_policy` | Revokes a disclosure policy you own. | `policy_id`, `if_match` |
| `authorize_disclosure` | Lets the named reviewers and publishers see one exact candidate package of a private memory revision, until a time you choose. | `source_space_id`, `source_memory_id`, `source_revision`, `destination_space_id`, `candidate_digest`, `expires_at`; optional `reviewers`, `publishers` |
| `revoke_disclosure` | Revokes a disclosure authorization you own. | `authorization_id`, `if_match` |

### Common tasks

- **Join a Space you were invited to:** `list_my_memberships` with `state: "proposed"`, then `transition_membership` with `action: "accept"` and the membership's `version` as `if_match`.
- **Share a learning with a team:** `provision_private_space`, `record_private_memory`, `get_promotion_routes`, `create_disclosure_policy`, then `submit_promotion_from_source`. The Space's reviewers then use `review_promotion_candidate`.
- **Set up a hierarchy:** `register_hierarchy`, then `propose_membership` for each person and `assign_space_role` for reviewers.

### Changes, retries and paging

- **`if_match`:** tools that change an existing record take the `etag` from your last read, or the `version` a list item carries. If the record changed since, the call fails with `precondition_failed`; read it again and decide again. It isn't retried for you.
- **`idempotency_key`:** `register_hierarchy`, `record_private_memory`, both submit tools, `create_disclosure_policy` and `grant_private_delegation` return the key they used, and generate one if you don't pass it. Pass the same key to retry after an unknown outcome.
- **Paging:** pass the returned continuation token as `continuation_token`. Candidate lists and publication history take it as `after`.
- **Times:** `expires_at` and date filters are ISO 8601 timestamps with a timezone.
- **Destructive tools:** `update_space`, `update_space_policy`, `transition_membership`, `revoke_space_role`, `revise_promotion_candidate`, `moderate_publication`, `revoke_disclosure`, `revoke_disclosure_policy` and `revoke_private_delegation` change or remove existing records. The agent should run them only when you ask.
