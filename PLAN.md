# Wire Team Bot — App and Delivery Plan

Updated: 2026-09-23. Staging runtime/image: `d59b444` (post-release PR review). Latest tested QA runtime: `d59b444`; `v1.0.0` remains pinned to its released image.

This is the single source of truth for the app, feature scope, architecture and delivery
progress. The app is a **proof of concept demonstrating the Wire JS SDK**. The next milestone is
QA acceptance of the existing bot, followed by a small real-world pilot with targeted
reliability fixes. Adam set **1.0.0** as the release target on 2026-09-21 and authorised publishing it on
2026-09-22. The release versions this proof-of-concept scope; it does not expand the feature plan.

[README.md](README.md) covers setup and operation. [AGENTS.md](AGENTS.md) covers contributor
rules. Update progress here; do not create another versioned plan or gap backlog.

### 1.0 release authorisation — 2026-09-22

Adam explicitly requested creating release **1.0** now. Publish **Wire Team Bot 1.0** with tag
`v1.0.0`, and align package/lockfile metadata at `1.0.0`. This supersedes the earlier requirement
to wait until after P3 before tagging the proof of concept. It does not mark unobserved manual
checks or the five-day pilot as passed. Human quality review, the final post-naming Wire UI
round trip, external app-profile branding and the P3 usefulness/noise decision remain recorded.

Application source, dependencies, schema and model settings are unchanged from tested runtime
`4a2f003`. Its recorded September 22 evidence is **394 unit/contract/isolated DB tests**,
**64/64 real-model scenarios**, **18 mandatory stored/state checks**, **20/20 stored facts with
zero duplicates**, and successful build/type-check/lint. These are the existing run results,
not new model-suite runs for a metadata-only release. See [validation](tests/acceptance/naming-validation.json).

Release packaging enables tag-triggered container publication for `1.0.0`, `1.0` and `1`, and
pins the default Compose file to `1.0.0`. The registry also retains `latest` and commit tags.
CI dependency installation now uses `--no-audit`, matching the container build's existing policy;
no dependency versions change. The [GitHub release](https://github.com/adamlow-wire/wire-team-bot/releases/tag/v1.0.0)
records the final tag, build evidence and published container digest; publication follows successful
packaging/CI verification. Staging remains pinned to its tested image and preserved volumes;
creating this release does not deploy to production.

### Post-release PR review — 2026-09-23

Adam authorised reviewing and merging the two open PRs with Mathias Staab credited.
[PR #10](https://github.com/adamlow-wire/wire-team-bot/pull/10) fixes the misleading
`Entities tracked: 0` status when explicit decisions, actions or reminders exist. Channel status
now gives qualified-conversation totals for open actions, pending reminders and active decisions,
then labels the separate graph-entity total. A two-member synthetic check exposed that `show
reminders` is requester-filtered while status is channel-wide. The reviewer recorded that finding
on the PR and changed the label to `Pending reminders in this channel` before merging.
Action/decision queries cap at 100 records and display a lower bound with `+` at the cap;
pending reminders are counted without a cap. This is a pilot-scale read, not a database count
endpoint or a claim of a latency improvement. The PR merged as `87acaef`.

[PR #11](https://github.com/adamlow-wire/wire-team-bot/pull/11) remembers a model that explicitly
rejects the `temperature` option, omits it from later requests to that model, and shares one
chat-client factory across production adapters. The first compatibility retry remains bounded;
other models retain the option. The PR merged as `2688e07`. No dependency, schema, record-ID or
supported-command change was needed.

Reviewed together on Node 22.23.2/trixie with isolated Postgres 16 + pgvector on port 55439:
build, type-check, lint and **403/403 unit/contract/isolated-DB tests** pass. The unchanged
judge fixture calibrated **12/12**. The [raw synthetic real-model report](tests/acceptance/postrelease-pr-review-e2e.json)
passed **64/64 scenarios**, including **18 post-exit stored/state checks** with zero failures.
That full model run preceded only the status-label clarification; after that wording edit, the
exact combined source again passed build/type-check/lint and all 403 tests, and a CLI run against
isolated storage returned one action, reminder and decision with zero graph entities and the
explicit channel-wide label. All six changed files on merged `main` match the reviewed combined
checkout byte-for-byte. GitHub's main-branch [PR #10 build](https://github.com/adamlow-wire/wire-team-bot/actions/runs/35843436559)
and [PR #11 build](https://github.com/adamlow-wire/wire-team-bot/actions/runs/35843665792)
both passed tests and container publication. The model result is not a fresh Wire UI or human pilot run.

The `v1.0.0` release remains pinned to its published source and container image. These merges
are post-release changes on `main`. Staging activation is recorded below; the new behavior still
needs a Wire UI round trip there. Production remains unchanged. The existing human quality review,
app-profile branding check and five-day pilot decision remain pending.

### Post-release staging activation — 2026-09-23

Adam requested the staging update. At **09:44:26 UTC**, only the staging bot container was
recreated from the verified `d59b444` registry image (`sha256:8522b9dabbfdb9a91e17e5151409f11c234fa108981aed9b9f0b9403d063d4ae`).
The image's OCI revision label matches the tested commit. The staging Postgres container and
both existing database/crypto volumes were retained. A stopped-bot PostgreSQL custom dump and
crypto archive passed restore-list/archive checks; the copied SDK SQLite store passed integrity
check. The bot's environment and volume attachments compare unchanged across recreation.
The private backup and pinned candidate/rollback overrides are in
`/home/sysop/wire/wire-team-bot-backups/pr-review-20260923-G7wLhl`.

Startup reported no pending migrations, hydrated three conversations and connected to Wire.
At 09:45 UTC the bot was running with zero restarts and zero application errors; the sole warning
was the expected embeddings-disabled setting. The staging database was healthy. No test message
was sent from this deployment check, so a fresh Wire UI reply and the PR-specific live behavior
are **pending**, as are human quality review and the five-day pilot. No production service was
touched. [Content-free activation evidence](tests/acceptance/postrelease-pr-staging-activation.json)
records the image, backup checks and startup observations.

To roll back only the bot image, keeping current database and crypto state, run:

```bash
docker compose -f docker-compose.staging.yml \
  -f /home/sysop/wire/wire-team-bot-backups/pr-review-20260923-G7wLhl/rollback.override.yml \
  up -d --no-deps --no-build --pull never wire-team-bot
```

## 1. What we are building

Wire Team Bot is a Wire participant that helps a team remember decisions, keep track of commitments,
and catch up on work without maintaining a separate record by hand.

| Team need | Useful outcome | Pilot boundary |
|---|---|---|
| Capture | Record a decision, action, owner or reminder from the conversation. | Explicit commands plus the existing passive extractor; tolerate conservative capture. |
| Recall | Answer what was decided, why, by whom and when, using the team's record. | Current channel only; say when the available record cannot answer. |
| Progress | See open/overdue work, mark it done, change an owner or deadline, receive reminders. | Existing action lists, updates, nudges and summaries; no new project-management system. |
| Control | Know when Wire Team Bot is listening and stop processing sensitive discussion. | ACTIVE / PAUSED / SECURE, with verified context isolation. |

The pilot should answer: **does this save the team work, with sufficiently few mistakes and
interruptions that they choose to keep using it?** A large feature count is not a success measure.

Product rules:

- Keep the common tasks easy to express. Add natural-language variants when observed usage
  fails; a new intent framework is not a prerequisite for testing.
- Confirm actual writes, owners and deadlines. Do not imply an action happened when it did not.
  Ask a short clarifying question when a consequential choice is ambiguous.
- Keep `DEC-`, `ACT-` and `REM-` references for reliable corrections during the pilot. Removing
  them requires a proven replacement, not a blanket presentation change.
- In groups, teach users to mention Wire Team Bot for questions and use the documented commands for
  changes. Existing unmentioned follow-ups are a heuristic, not a general conversation contract.
- Keep passive action capture quiet but visible: 📝 on the source message after an action and its
  audit are saved; ✅ on an unmentioned completion after the status and audit are saved. A reaction
  means at least one matching change succeeded; lists show details. No success reaction for skipped,
  duplicate, failed or cancelled work. Reaction delivery failure must not undo or repeat a saved write.
  Explain the meanings in the welcome message. Explicit commands retain their text confirmations.
- Use native Wire replies for direct responses so each confirmation or answer identifies its source.
  Keep only the SDK quote ID/hash during the handler; never persist source text for quoting.
  Scheduled notifications remain standalone. Wire disallows quoting self-deleting messages.
- Retain the existing Wire Team Bot voice: concise, no exclamation marks, “I'm afraid” rather than
  “Sorry”, “Shall I” for a supported offer. Accuracy matters more than persona polish.

## 2. Architecture and data contract

Keep the existing hexagonal architecture and repository layout.

| Layer | Location | Allowed dependencies |
|---|---|---|
| Domain | `src/domain/` | Domain only; entities and repository/service contracts |
| Application | `src/application/` | Domain and ports; use cases, no SDK/DB/LLM clients |
| Infrastructure | `src/infrastructure/` | Domain, application and external libraries |
| App | `src/app/` | All layers for configuration and composition; no business logic |

Runtime: TypeScript/Node, official `@wireapp/wire-apps-js-sdk`, Prisma, PostgreSQL + pgvector,
one bot process. Keep the in-memory processing queue and scheduler. No new service or
production dependency is required by this plan.

### Message processing and retrieval

- Ambient ACTIVE messages pass through classification, extraction and embedding. Explicit commands and Q&A do not also enter passive extraction; embeddings and contradiction checks are awaited as part of the cancellable job.
  `InMemoryProcessingQueue` allows five concurrent channels, serialises work within each channel, and holds 500 queued jobs; overflow drops
  the oldest queued job with a warning. Transient processing and buffers are lost on restart.
- Extraction uses a 30-message sliding window. Q&A uses a separate
  `ConversationMessageBuffer` (default 50, configured maximum 500). Both matter for privacy.
- Structured decisions/actions, entities/relationships, signals and summaries form the durable
  record. Tasks were consolidated into actions; `KnowledgeEntry` was retired.
- Questions go through query analysis, then structured, semantic, graph and summary retrieval.
  Paths run with `Promise.allSettled`; results merge using reciprocal rank fusion, a 1.5×
  multi-path boost, recency and confidence, within an approximate 7,000-token budget.
  Graph traversal is bounded to depth three. Temporal/institutional queries add summaries.
- Commands are currently pattern-based in `WireEventRouter`. The old foreground
  `OpenAIConversationIntelligenceAdapter` is absent. Configuration now reads `WIRE_TEAM_BOT_*`;
  the old `LLM_PASSIVE_*` / `LLM_CAPABLE_*` variables are not read by `config.ts` and do not
  power a second router. The compatibility `ConversationConfigRepository`
  still reads from `channel_config`.
- Reminders persist in Postgres and are rehydrated after Wire initialisation. Daily summaries
  run at 08:00 UTC, weekly summaries Monday 08:00 UTC, staleness checks every six hours.
  These are current schedules, not the old proposed per-channel-timezone schedules.

Code references: [composition](src/app/container.ts),
[pipeline](src/infrastructure/pipeline/ProcessingPipeline.ts),
[retrieval](src/infrastructure/retrieval/MultiPathRetrievalEngine.ts),
[schema](prisma/schema.prisma), [migrations](prisma/migrations).
Schema and configuration details belong in those files rather than a second SQL specification.

### Privacy and access requirements

These are requirements; the implementation gaps in §3 must be resolved before using sensitive
team conversations.

- **Extract-and-forget:** do not persist surrounding raw conversation text in records, signals,
  audit payloads or diagnostic logs. Store the requested decision/action/reminder content,
  structured extractions and source IDs/timestamps. Structured knowledge is still sensitive;
  this is not a claim that retained information cannot reveal a conversation.
- Wire Team Bot sees decrypted messages as a Wire participant. Model requests go to the configured
  providers. On-premises processing requires both chat and embedding endpoints to be local;
  Wire encryption does not keep content away from a configured external model provider.
- **ACTIVE:** normal processing. **PAUSED:** stop ambient processing; accept supported control
  commands. **SECURE:** also clear transient context. Messages received while paused/secure
  must not leak into later prompts. State transitions must account for both buffers and queued
  or in-flight work, and state persistence failures must not silently re-enable processing.
- Scope every retrieval and mutation to the qualified conversation ID, including direct ID
  lookups. `channel_id` is `{conversationId}@{domain}`; Wire domain supplies organisation ID.
  No cross-channel recall in the pilot. The router detects personal mode and passes `userId`,
  but current retrieval paths do not implement the old promised org-wide personal view.
- Treat LLM output as untrusted. Validate types, bounds, identities and allowed transitions
  before persistence. Audit domain changes through `AuditLogRepository`.

### Models and deployment decisions

Seven slots remain: `classify`, `extract`, `embed`, `summarise`, `queryAnalyse`, `respond`,
`complexSynthesis`. Six chat slots share an OpenAI-compatible endpoint; embeddings can use
a separate endpoint or be disabled. Use [config.ts](src/app/config.ts) for actual defaults and
[README configuration](README.md#environment-variables) for operations. Do not choose a new
provider framework for the pilot.

The current embedding column and default are **2560 dimensions**. The latest dimension
migration removed the HNSW index; current search is exact cosine search. Match the configured
model, fallback and database dimensions. Enabled configuration must use 2560 dimensions; primary and fallback responses must contain finite vectors of that size. This checks configuration/output, not a live startup model probe or schema migration. Vector features need a separate smoke test if enabled;
structured recall and summaries must remain useful with embeddings off.

The official SDK migration keeps CommonJS, the `node:22-trixie-slim` image and a persistent
`/app/storage` keystore. Its staging report is historical evidence, not production sign-off.
Preserve the existing crypto key and store across ordinary restarts. See the
[cutover runbook](README.md#official-sdk-cutover) for migration from the old fork.

### Canonical naming cleanup — 2026-09-22

Adam requested removal of all former product-name references from the current repository.
Use **Wire Team Bot** in prose, **wire-team-bot** for resource identifiers and
**WIRE_TEAM_BOT_** for model environment variables. This supersedes the earlier compatibility
alias policy; actual structured Wire mentions and supported text commands/record IDs remain.
Runtime model config types and the embedding adapter use generic descriptive names.

Tracked historical report branding is normalised with an explicit annotation; facts, source
IDs, assertions and recorded outcomes retain their original meaning and are not fresh results.
Unmodified evidence and the original baseline instrumentation patch remain recoverable from
Git snapshot `f0879c0`. The patch is retired from the current tree rather than altered into an
invalid historical diff. Git history is preserved; rewriting historical commits/tags requires separate explicit approval.

Code commit `4a2f003` has zero case-insensitive former-name matches in tracked contents or
paths. Fresh build, type-check, lint and **394 tests in 45 files** pass, including six isolated
DB tests and a new canonical-config test. Registration-script syntax, strict harness/test typing,
Compose candidate/rollback schemas, JSON parsing and local documentation links pass. The first
DB run failed because the isolated database was stopped; starting that existing container fixed
the infrastructure failure without resetting data. See [validation](tests/acceptance/naming-validation.json).

The first [evaluator calibration](tests/acceptance/naming-calibration-initial.json) was **11/12**:
one deliberately wrong answer produced malformed verdicts on both attempts. Strict validation
rejected them. The unchanged [recheck](tests/acceptance/naming-calibration-recheck.json) passed
**12/12**; both attempts are retained. The fresh [stored-record sample](tests/acceptance/naming-capture-report.json)
matched **20/20 facts** by source event after processing drained, including silent captures:
10 decisions, 10 actions, zero duplicates, precision/recall 100%, zero privacy-marker occurrences
in retained records or diagnostics. One malformed query-analysis result used its existing fallback;
embeddings remain disabled. Independent human quality review remains pending. This naming change
does not change classifier/extractor/pipeline logic or prompts; the multi-day simulation was not rerun.

Validation uses Node 22.23.2/trixie, isolated Postgres 16 + pgvector on port 55439, unchanged
staging model values under renamed keys, and `WIRE_TEAM_BOT_JUDGE_MODEL=claude-opus-5`.
Credentials and endpoints are excluded from reports. Existing installations must migrate all
model keys and copy stopped DB/crypto volumes before using the renamed Compose resources.
The [full real-model regression](tests/acceptance/naming-e2e-report.json) passes **64/64**, including
**18 mandatory post-exit stored/state checks**; no malformed judge attempts occurred in that run.
Never initialise an empty replacement Wire identity or reset shared databases.

[Staging activation](tests/acceptance/naming-staging-activation.json) completed at **09:21:24 UTC**:
`wire-team-bot:v3-rc-4a2f003`, image
`sha256:04538ecbf1d4e651207b10a90e0ecb6c118fbac81d0ac6e5eb55bcada7c0af69`.
All 12 durable table counts/fingerprints matched; copied DB/crypto file contents, ownership and
modes matched before startup. Logical and physical backups are validated. Wire credentials,
crypto key and model values are unchanged; `.env.staging` now uses canonical keys. Current
containers are `wire-team-bot-staging` and `wire-team-bot-staging-postgres`. Startup hydrated three
conversations, connected to Wire, and reported zero errors and one expected embeddings-disabled
warning. The previous stack is stopped and retained for recovery; do not run duplicate copies
of the same Wire identity. No production action occurred.

Private backups and overrides: `/home/sysop/wire/wire-team-bot-backups/name-cleanup-_5wehzhj`.
Reapply this tested image without rebuilding:

```bash
docker compose -f docker-compose.staging.yml \
  -f /home/sysop/wire/wire-team-bot-backups/name-cleanup-_5wehzhj/candidate.override.yml \
  up -d --no-deps --no-build --pull never wire-team-bot
```

Rollback only the bot image/configuration, keeping the **current renamed volumes**, including
any subsequent database writes and advanced MLS state:

```bash
docker compose -f docker-compose.staging.yml \
  -f /home/sysop/wire/wire-team-bot-backups/name-cleanup-_5wehzhj/rollback.override.yml \
  up -d --no-deps --no-build --pull never wire-team-bot
```

Do not restore pre-migration snapshots or restart the previous duplicate stack for an ordinary
image rollback. Earlier command snippets/overrides are historical and must not be combined with
the renamed Compose file; their originals are preserved at `f0879c0`.

The current tracked tree and local generated outputs/configuration have no former-name matches.
Git history, third-party dependencies and private rollback resources retain original bytes.
Registered Wire app display-name/description metadata is external to this repository: registration
defaults are corrected, but an administrator must check/update the existing app profile.
Final transport check on this renamed stack: mention the bot with `status` in **Wire Team Bot
Testing**, and verify its native reply. Startup connectivity is observed; a fresh UI round trip
and the remaining independent human quality/pilot review are not claimed here.

## 3. Current delivery state

**Implemented** means code is present, not that it is proven in a real team. **Reported** means
an earlier document records a run. **Pending** means this plan has no acceptance evidence.
The old v2 phases 1a, 1b, 2, 3 and 4 describe delivered components, not a completed pilot.

| Capability | State and evidence | Remaining acceptance |
|---|---|---|
| Wire connection, send/receive, persisted crypto | Implemented; staging success and restart reported on 2026-09-16 during SDK migration | Repeat on the pilot image; production cutover pending |
| Explicit decisions, actions and reminders | Implemented; use cases and contract/e2e scenarios present | Verify attribution, changes and reminder delivery on Wire |
| Passive capture and natural completion | Source replay guards, exact active-fact dedup, validated owners and completion updates implemented | Stored-record evaluation available; human quality review pending |
| Questions and channel summaries | Implemented; retrieval and summary tests present | Validate known-answer questions, empty results and provider degradation |
| Action lists, staleness nudges, scheduled summaries | Implemented | Judge usefulness/noise; verify restart and overdue behaviour |
| Pause, resume, secure and access scoping | Both buffers clear on pause/secure; queued jobs discarded, in-flight work cancelled/drained; qualified access checks and fail-closed state reads/writes tested | Synthetic DB/log and restart markers pass; designated Wire smoke required |
| Embeddings optional/separate provider | Implemented; embedding configuration tests present | Smoke test selected configuration and dimensions |
| Buttons and contradiction follow-through | Dead decision buttons removed; old clicks and contradiction notices give text commands; Q&A prompt explicitly read-only | Human/Wire review of actual interactions pending |
| Test harness and simulation | Event-framed CLI, post-drain DB inventory and fact/source scoring implemented; simulation now sends the fixture’s actual members | `golden.json` still has no human review; no human-approved quality claim |
| Product name | Canonical naming complete in current repository and active staging configuration/resources; zero former-name matches in tracked contents/paths | Administrator check/update of existing registered Wire app profile; final staging UI round trip; generic name configuration remains deferred |
| Documentation consolidation | Complete in this revision | Maintain this plan as work lands |

Historical validation: SDK migration notes reported 141 passing unit tests, clean lint, an
offline CLI smoke run, and then staging connectivity/restart success. Those notes also contain
an older “not exercised yet” entry, superseded by their staging update. Those historical results are separate from the fresh candidate evidence below.

### Consolidation findings and implemented remedies

| Finding | Remedy in the candidate | Validation boundary |
|---|---|---|
| Raw surrounding context persisted in signals/decisions and diagnostics | Decision context is empty; low-signal/failure signals contain generic activity metadata; model/output previews and HTTP error bodies are not logged. SDK messages/metadata (including nested decrypted events) are reduced to severity-only diagnostics; startup failures do not log exception bodies. Arbitrary extractor metadata is discarded. Channel purpose requires an explicit context command. | Synthetic marker checks; historical rows have not been altered or scrubbed. Start the pilot with approved data, not an assumed-clean legacy database. |
| Pause/secure leaked through buffers and background work | Both buffers clear; per-channel jobs cancel and drain before confirmation; events serialize; blocked-period messages are never buffered; hydration/resume failures stop processing locally. | In-flight requests already sent to a provider cannot be recalled. A failed durable state write is explicitly reported and must be retried before restart. |
| Explicit-ID access bypassed qualified scope | Structured and semantic source lookups verify ID **and domain**, as do affected mutations; deleted targets are rejected. | Unit negative tests and isolated Postgres retrieval tests. |
| Buttons and Q&A promised unsupported writes | Removed decision yes/no prompt; text alternatives for old buttons and contradictions; Q&A is explicitly instructed that it cannot write. | Model instructions cannot guarantee every generated answer; review remains required. |
| Malformed model results and provider compatibility | Root/type/confidence/length validation, bounded arrays, known-owner/known-action checks, finite embedding dimensions; bounded retry without temperature only on an explicit unsupported/deprecated-parameter rejection. | Model fallback and output-degradation events remain visible in reports. |
| Reminder could be lost on send failure | Fired state follows successful send; failure retains pending state and schedules a 60-second retry; restart rehydrates pending overdue records. Duplicate local callbacks are suppressed; long timers avoid Node overflow. | At-least-once delivery: a crash between send and durable acknowledgement can duplicate a reminder. Single process only. |
| Reply-ID simulation scores omitted silent captures | CLI acknowledges drained source events; evaluation queries all channel decisions/actions after exit, matches facts plus source/owner, and counts duplicates as errors. Simulation uses the same inventory and actual fixture senders. | Fixed sample and model judging assist review; neither replaces human capture/Q&A approval. |


## 4. Next version: bounded pilot work

A change enters this release only if it fixes a reproduced user problem, closes a privacy or
correctness gap, or supplies evidence needed to decide whether the bot is useful. Each change
needs a scenario, the smallest viable fix and an observable acceptance result. “The old branch
implemented it” is not evidence of value. Do not cherry-pick a subsystem without that test.

Start with a short baseline, then fix P1 before broader reliability tuning. P0 and P1 use
synthetic data; real team content waits for P1 to pass. Missing model access or human review
must not delay reproducible privacy/access fixes. Finish independent work and record the
remaining validation dependency explicitly.

| ID | Work and direct value | Acceptance evidence | Progress |
|---|---|---|---|
| P0 | Establish baseline using existing fixtures, isolated DB inspection and the intended model configuration. | Stable expected facts including missed/silent captures; reviewed precision/recall, duplicate count, ten known-answer questions, response times and failures. Record commit, configuration and date; do not rely on printed IDs alone. | Automated sample complete; human review pending |
| P1 | Close the concrete data-retention, state-isolation and access-scope gaps in §3. | DB/log inspection with synthetic marker text; pause/secure/resume tests for both buffers and queued work; cross-channel and cross-domain retrieval/mutation denial tests. Review audit coverage on affected writes. | Implemented and automated regressions pass; Wire acceptance pending |
| P2 | Make existing user journeys dependable. Verify names after restart, reminder downtime/send-failure recovery, corrections, model failures, and text alternatives to dead controls. | Required journeys in §5 pass on CLI and Wire. Fix duplicate or malformed-output failures locally when reproduced. No unsupported “Shall I…?” or inert required button. | Reactions/native replies Wire-confirmed; attribution, combined-command guidance and Friday date fixes implemented. Latest step-two validation is recorded below; final candidate Wire/human acceptance pending |
| P3 | Run one small team pilot and decide the next investment. | Five working days of use, short feedback log, counts against §5 and a keep/fix/stop decision. At most three evidence-backed follow-ups. | Pending |

Small fixes may touch validation, deduplication, prompts or command variants. They do not imply
a general intent executor, a new schema library, vector dedup across every write, or scheduler
replacement. If the existing baseline is adequate, proceed to the pilot without feature work.

### Development goal and finish line

**Build Wire Team Bot v3 as a tested release candidate for the small team pilot: close P1, complete
P0 and P2 acceptance, preserve the current architecture, and deliver reproducible evidence
that capture, recall, actions, reminders and privacy controls work on the chosen deployment.**

The development deliverable is:

1. Small, reviewable fixes with regression tests for the gaps above. No unrelated feature or
   dependency additions; a failed scenario determines the next fix.
2. A fixed synthetic evaluation sample, expected facts/questions, actual stored results and
   before/after counts. Use the existing fixtures where possible. Review expectations before
   tuning prompts; do not improve scores by weakening assertions or ignoring missed captures.
3. Passing build/type-check, lint, unit/contract and isolated DB integration checks; relevant
   e2e failures reproduced and fixed, then the full e2e suite rerun on the selected models.
   Record model names, embedding mode/dimensions, commit and commands without credentials.
4. A reproducible container build from the tested commit, updated operating instructions,
   current Wire send/receive/restart/reminder smoke evidence, and a concise handover in this
   plan with known limitations and the next pilot step. Building an image is part of the goal;
   production cutover is a separate operator action using the README runbook.

“Code complete” means the implementation and available automated checks are finished.
“Pilot ready” additionally requires P0/P1/P2 evidence, including the selected provider run,
human review of quality, and the real Wire smoke test. A missing endpoint, account or reviewer
is a named pending acceptance check, never a passing result. Finish all independent work
before handing back a blocked check.

P3 is the subsequent five-working-day trial and human usefulness decision. It is not something
an unattended coding run can declare successful. The pilot operator supplies the team/channels,
approved provider configuration and human review; the developer prepares and fixes the candidate.
These are operational inputs, not reasons to invent additional product features.

Stop adding scope when P0–P2 pass. Record at most three evidence-backed follow-ups from P3.

### Automated QA before final manual acceptance

Agreed direction (2026-09-18): freeze feature scope and finish automated QA before asking Adam
for one final manual acceptance session. The SDK proof of concept is the product framing;
this is not a production release. Existing manual screenshots remain evidence, but repeated
operator demos must not substitute for automated reproduction and stored-record inspection.

| Step | Work the developer runs autonomously | Completion evidence |
|---|---|---|
| QA-0 | Reconcile README with the actual SDK/configuration, keep only `main` active, explain archived work, and normalize repository commit attribution as requested. | README has the PoC statement and no former product-name references; repository inventory and history verification below. |
| QA-1 | Fix recorder-versus-decider attribution in retrieval/answers. Identify the recorder as such; report an actual decider only when the stored fact supports it. Reproduce TC-DEC-07 with Alice recording Carol/Dave's decision. | Mocked regression plus real-model answer and stored-source checks; no contradictory attribution even if the model judge says PASS. |
| QA-2 | Give deterministic, truthful guidance for multiple commands in one message. Keep one command per message for this PoC; do not invent a batch executor. | Two reminder requests receive a split-message explanation and create no partial/accidental records; separate messages each create one reminder. Include structured mentions and formatted commands. |
| QA-3 | Separate application failures from evaluator errors. Use explicit ownership for the positive dedup test and retain ambiguous ownerless wording as a negative case. Ground date checks in scenario time/timezone and actual persisted deadlines; check recorder identity against stored authors. | Preserve the original 57/60 report and explain each expectation change. Add positive and negative coverage rather than relaxing assertions; a judge PASS cannot override wrong stored facts. Dates and identities have deterministic assertions as well as answer review. |
| QA-4 | Run build, type-check, lint, unit/contract and isolated Postgres/pgvector tests. Exercise paused/secure buffers, queued/in-flight cancellation, process restart, scoped ID reads/writes, failed sends, overdue recovery, malformed outputs and timeouts. | All deterministic checks pass. Unique excluded markers absent from stored records/diagnostics and captured mock model requests. No shared DB resets; test data stays in isolated conversations/databases. |
| QA-5 | Run the full real-model e2e suite, the fixed 20-event/10-question sample, reaction lifecycle and simulation after extraction/pipeline changes. Inspect all stored records after drain, including silent captures. | Versioned inputs/outputs, fact/source/owner matches, precision and recall with counts, duplicates, latency, failures and unsolicited messages. Human quality approval remains pending; no unexplained runtime failures or hidden judge overrides. |
| QA-6 | Build one immutable candidate from the tested commit and run the full suite against that image. Back up staging DB/crypto state, activate that exact image, verify hydration/decryption readiness and collect a concise QA packet. | Image digest, configuration without secrets, test results, rollback steps and exact manual cases in this plan. Do not silently replace the candidate during manual QA. |
| QA-7 | Adam performs final Wire UI and usefulness acceptance using the prepared candidate. The developer handles coordinated restarts and post-process DB/audit inspection during the same session. | All manual cases below accepted; any defect returns to its automated reproduction/fix/regression step before a focused retest. |

Use the existing [README validation commands](README.md#release-candidate-acceptance), fixtures,
CLI and test runner; add bounded assertions or a small orchestration script only where an
existing gate is not reproducible. No new framework, model-provider migration, queue service
or feature subsystem. A provider outage is a recorded blocked check, never a silent pass.
Autonomous work stops at a concrete candidate and QA packet ready for Adam; it does not claim
manual acceptance, reset shared data or deploy to production.

Final manual QA packet, prepared after QA-1 through QA-6:

1. **Wire presentation:** real mentions, two quick requests with correct native reply targets,
   passive capture/completion reactions, member names and registered app branding.
2. **Core journeys:** decision correction/recall with correct recorder and decider, action
   assignment/reassignment/deadline/completion, reminder creation/cancel/snooze/downtime recovery.
3. **Privacy/access:** PAUSED and SECURE with unique markers before/after a coordinated restart,
   then scoped read/mutation denials from the second designated test channel. Developer verifies
   records/audits after processing; absence of a visible reply is not enough.
4. **Quality/usefulness:** approve at least 20 expected captures and ten known answers, plus an
   unknown-answer refusal and catch-up/open/overdue summaries. Apply §5 thresholds without
   inventing writes/owners; judge latency and noise from the supplied measurements.

Only after this single final acceptance stage passes does the five-day P3 pilot begin.
September 18 checkpoint (superseded by the September 21 case fix below): QA-0 through QA-3 are implemented. Adam authorised the second implementation
step on 2026-09-18. The final `ae618ff` image passes **63/63 strengthened real-model scenarios**,
all fifteen mandatory stored-record/state checks, and the unchanged **20/20 stored-fact sample**.
Build/type-check/lint and **370 unit/contract/isolated DB tests** pass. All earlier failed runs and
raw-review findings remain intact. QA-6 activation is complete: staging now runs that exact image,
with verified backups, unchanged durable records, member/reminder hydration and no startup errors.
Final Wire/human acceptance remains pending. The first candidate `status` smoke reply had the correct
native quote but took approximately 25 seconds. On September 21 Adam reported speed and reply
targeting accepted; numeric timings and a confirmed cause of the earlier reconnects remain unavailable.
This is code and automated QA completion, not pilot approval.

#### Case-insensitive record references — 2026-09-21

Adam reports manual tests 1–3 passed on `ae618ff`: reply speed/quote targets, post-revocation
recall and action ownership/deadline/completion. No numeric reply timings were supplied; this
is operator acceptance, not a measured transport latency benchmark or confirmed root-cause fix.
Scoped DB inspection of `ACT-0008` in Demo for Anna confirms done/version 4, owner Adam (Human),
deadline **2026-10-02 12:00 UTC**, original source ID and four audits: created for Adam Low,
reassigned to Adam (Human), deadline changed, completed. The visible lowercase `act-0008 done`
attempt failed; the uppercase retry succeeded. This additional usability defect is fixed in the replacement candidate, with Wire confirmation passed by Adam on September 21.

Root cause: command regexes already ignore case but passed lowercase captures unchanged to
case-sensitive repository lookups. Normalize only matched ID tokens before mutations and direct
structured retrieval. Accept lower/mixed-case ACT/DEC/REM prefixes; preserve the hyphen, digits,
leading zeroes, surrounding text, qualified scope and canonical uppercase replies. No storage
migration, changed IDs or new dependency. Malformed IDs remain malformed. The existing e2e
capture mechanism now exposes lowercase aliases for test inputs; output and stored-fact
assertions retain canonical IDs and original source events. Decision supersession/revocation
also gained mandatory post-exit stored-state checks; no assertions were relaxed.

Red baseline: **10 new lowercase command cases fail**, 119 router cases pass. After the fix:
build, `tsc --noEmit`, lint and **387 tests in 43 files** pass, including six isolated DB tests,
case-insensitive direct retrieval and qualified-scope denials. Validation uses Node 22/trixie
and the isolated pgvector database on port 55439. Fresh evaluator calibration is **12/12**;
full real-model regression is **63/63**, with **17 mandatory post-exit stored/state checks**.
An additional exact post-exit reminder inventory check confirms one correctly owned cancelled
reminder, its source fact and the snoozed deadline. Raw inputs, replies and inventories for
lowercase mutations and retrieval were reviewed; canonical replies and qualified scope remain intact.
See [validation](tests/acceptance/lowercase-id-validation.json),
[full results](tests/acceptance/lowercase-id-e2e-report.json),
[calibration](tests/acceptance/lowercase-id-calibration.json) and
[manual 1–3 evidence](tests/acceptance/manual-qa-steps-1-3.json).

At **10:07:02 UTC**, staging was updated to `wire-team-bot:v3-rc-8c0c89d`, image
`sha256:194eac6f1efb420b50ca5c54c6e6a816b83743c713868ccd0c91464310a79d93`.
[Activation evidence](tests/acceptance/lowercase-id-staging-activation.json) records verified
Postgres/crypto backups, identical environment and volumes, and unchanged fingerprints for all
12 durable tables. Prisma files match the previous candidate; no migration changes. Startup
hydrated three conversations and connected successfully, with zero errors and one expected
embeddings-disabled warning. These are startup observations, not a sustained latency benchmark.
Backups and image overrides are private under
`/home/sysop/wire/wire-team-bot-backups/case-ids-rn6r9wgz`.
To roll back only the bot, retaining current DB/crypto state:

The historical command is retained in Git snapshot `f0879c0`. For the renamed deployment,
use the [current rollback procedure](#canonical-naming-cleanup--2026-09-22).

**Wire follow-up — September 21:** Adam confirms the lowercase-ID retest worked on the
replacement candidate. This is operator confirmation; no new record ID or screenshot was
supplied and no additional DB inspection is claimed. Cases 1–3 retain their earlier pass.
**Case 4 follow-up — September 21:** Adam reports passive capture/completion passed in Wire.
Post-process verification of the exact source record, duplicate count and creation/completion
audits remains pending; no additional DB inspection is claimed from that report alone.
**Next:** cases 5–8, the remaining stored-record checks and human quality review.
Classifier/extractor/pipeline code is unchanged; no simulation rerun is required for this fix.
Container install/prune steps disable automatic npm audit uploads; the separately requested
audit remains unapproved and its existing findings remain recorded. No dependencies changed.

#### Work toward 1.0.0 — 2026-09-21

Adam authorised proceeding toward 1.0. Preserve the current feature scope and finish the existing
acceptance sequence: pinned candidate → final Wire/human acceptance → five-working-day pilot →
release decision against §5. Treat 1.0 as the version of this Wire JS SDK proof of concept, not
a production-readiness claim. At that checkpoint package/lockfile versions remained `0.1.0`
and no release tag existed. The [September 22 release authorisation](#10-release-authorisation--2026-09-22)
supersedes that sequencing: publish the proof-of-concept release now, preserve existing evidence
and pending manual checks, and verify the final versioned image without changing runtime behavior.
Any functional/dependency fix returns through its focused reproduction and required regression
checks before replacing the pinned candidate. Do not restart the whole implementation backlog.

Work completed while the operator runs the next manual checks:

- [Monday command/storage check](tests/acceptance/monday-command-storage-qa.json): existing
  `ae618ff` CLI in the pinned container, isolated Postgres/pgvector, fixed parser clock
  `2026-09-21T08:00:00Z`, UTC and Europe/London. **Six expected/six stored actions**, matched after
  CLI exit by source and fact, with exact qualified creator/owner, deadline, status and version.
  Sixteen command/list exchanges pass, including reassignment, deadline mutation, completion and
  removal from the owner's open list. **Twelve audits, zero extra decisions/reminders**. “This
  Friday” is **25 September**, “next Friday” is **2 October**, at local noon for date-only weekdays.
  Slowest synthetic command was **146 ms**; this excludes Wire transport and model calls.
- The first attempt failed before a reply because the isolated QA DB was stopped. Started that
  existing test container without resetting data, then reran the full focused check successfully.
  Staging was neither redeployed nor restarted. No new application code or dependencies.
- Through **07:45:43 UTC**, staging showed **zero SDK warnings and zero errors** since its
  **07:37:04 UTC** start (about 8 minutes 38 seconds). This is an observation, not proof of a
  permanent transport fix. Three timed, separated Wire `status` replies and the final revoked-
  decision recall answer have been requested from Adam, along with the actual conversation name.
- The known dependency issue was rechecked against its
  [public advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx): patched in `deepmerge-ts`
  **8.0.0**; the installed Prisma config dependency pins **7.1.5**. Local inspection still places
  it in the local config loader. No direct chat/model-input path was found. Do not treat a forced
  major transitive override as a verified compatible fix. The prior audit remains the only full
  recorded audit: automatic approval review rejected a fresh `npm audit --omit=dev --json` because
  it sends dependency names/versions to the npm registry. Adam has been asked whether to allow
  that transfer; no upload was attempted through another route and no audit pass is claimed.

Adam subsequently reported cases 1–3 passed; see the case-insensitive record entry above.
For a September 21 run, expect `this Friday` = September 25 and `next Friday` = October 2.
Next is a focused lowercase-ID retest, then cases 4–8 and human quality review. Friday's full test/e2e results remain their original runs; this new focused CLI check
does not replace them or the required real Wire acceptance.

#### Monday status check — 2026-09-21

Read-only checks at **07:38 UTC** confirm staging still runs the exact `ae618ff` image
(`sha256:4faa5df2a11d540e20659d89cb439755715060cb859f6db264a2c038bdb5abd0`).
The container reports a start at **07:37:04 UTC**, zero restarts, and no temporary Node options
or protocol probe mount. This status check did not restart or deploy anything. From that
start through **07:38:50 UTC** (about 106 seconds), there were **zero SDK warnings and zero
logged errors**. Friday's repeated reconnects were not observed in this short window;
this does **not** establish their cause, a durable fix, or acceptable user-visible latency.
Repeat timed real Wire `status` requests before closing that gate.

The previously pending synthetic `REM-0008`, scoped to Demo for Anna, is now **fired/version 2**.
Its original due time remains **06:00 UTC**; it was updated at **07:37:08.153 UTC**, shortly after
the reported container start, with one matching firing audit at **07:37:08.159 UTC**. This is
new durable evidence of overdue recovery; it is not on-time delivery or operator UI receipt
confirmation. The reason for the container's start time was not investigated in this status check.

Friday's **370 tests, 63/63 e2e cases, fifteen stored-state checks and 20/20 synthetic fact sample**
remain the latest automated results; no suite was rerun on Monday. Decision QA remains at the
recorded checkpoint below: correct attribution and audited supersession/revocation, with the
post-revocation Wire answer outstanding. Remaining final manual cases and human quality review
still gate the five-day pilot. The remote has only `main`, matching local `fae80ad` at inspection;
reachable commit authors/committers are Adam Low only. The working tree was clean before this
status-note update. The next focused step is timed `status` plus the outstanding decision question,
then assignment/deadlines, passive feedback, reminders, privacy/scope and usefulness checks.

#### Staging candidate activation — 2026-09-18

Adam authorised the staging upgrade. [Activation evidence](tests/acceptance/staging-qa6-activation.json)
records the exact image ID, backup checks and startup observations. Only the staging bot was
recreated; production and the staging database container were untouched.

- Activated `wire-team-bot:v3-rc-ae618ff` (the locally tested image), ID
  `sha256:4faa5df2a11d540e20659d89cb439755715060cb859f6db264a2c038bdb5abd0`.
  Previous image `wire-team-bot:v3-rc-4bc7e1f` remains available for rollback.
- Effective environment, credentials, Prisma schema and migration files match the previous
  service. Existing `wire-team-bot-staging_wire-team-bot-staging-crypto` and database volumes were retained.
  No tokens/keys were refreshed and no database was reset or restored.
- Old bot stopped cleanly at **16:19:38 UTC**. Private backups are in
  `/home/sysop/wire/wire-team-bot-backups/qa6-20260918-v3m1uubm/`, outside Git, with protected
  configuration, database archive and crypto archive. The entire database archive was decoded
  successfully without executing a restore; the crypto archive was extracted privately and its
  SQLite database passed `PRAGMA quick_check`. Verification copies were removed.
- New container started at **16:20:45 UTC** and reported connection/listening readiness at
  **16:20:47 UTC**. No pending migrations. Member cache hydrated **three conversations** and
  **one pending reminder**. Zero startup errors and zero restarts. Content-free SDK warnings
  remain visible; they do not establish a failed or successful client round trip.
- All **twelve table fingerprints are unchanged**: 4 decisions, 6 actions, 8 reminders,
  67 audit entries and 3 channel configurations among them. `REM-0008` remains pending,
  version 1, due **2026-09-21 06:00 UTC**, and was rehydrated. This verifies preservation and
  hydration; delivery after this restart has not yet occurred.
- Adam confirmed a real mentioned `status` request with the correct native quote on this
  candidate. Receive/decrypt/reply works, but his approximately **25-second delay fails latency
  acceptance**; see the investigation below. Earlier 370 tests/63 e2e cases remain their
  recorded runs; no runtime suite was rerun for this operational activation.

To reapply the candidate without rebuilding or changing volumes:

The historical command is retained in Git snapshot `f0879c0`. For the renamed deployment,
use the [current activation/rollback procedure](#canonical-naming-cleanup--2026-09-22).

Rollback the image while retaining current data and crypto state:

The historical command is retained in Git snapshot `f0879c0`. For the renamed deployment,
use the [current activation/rollback procedure](#canonical-naming-cleanup--2026-09-22).

Do not restore the pre-upgrade crypto snapshot for an ordinary image rollback: the live store
may have advanced. Database restoration is unnecessary because schema and migrations did not
change. The protected backup is a recovery resource, not an instruction to overwrite live data.
Keep this image pinned throughout manual QA; avoid a rebuilding `staging:up` during acceptance.

#### Staging latency investigation — 2026-09-18

**Unresolved release gate:** Adam's first `status` reply took approximately 25 seconds.
[Content-free evidence](tests/acceptance/staging-latency-investigation.json) records the
experiments, UTC timestamps and restoration checks. This command does not invoke a model.
The channel-state log at **16:58:10.168 UTC** was followed by outbound send at **16:58:10.174**
(6 ms for that section of the handler, not a measured end-to-end round trip).

The SDK reconnects roughly every **31.15 seconds**; replies were processed during reconnect
catch-up. Temporary protocol diagnostics confirmed a socket opens, receives a server ping at
15 seconds and closes remotely with code **1000** at 30 seconds. The SDK's existing `ws`
fallback behaved the same as Node's native WebSocket. Application pings every ten seconds
also failed to keep it open: automatic control pongs were sent, but no application pong was
received. Neither experiment is a fix. Both implementations passed a synthetic local
ping/binary-frame control in the exact candidate image.

The backend connection path needs investigation. In the inspected Wire server source, Cannon
registers presence with Gundeck before starting its receive loop, so a stuck registration is
one hypothesis consistent with these observations; **it is not an established root cause**.
Ask a staging backend operator to inspect **Cannon/Gundeck/nginz logs for 17:06–17:09 UTC on
2026-09-18**, correlate `/await`, `register-remote`/`registered`, `/i/presences` timeouts,
`PongTimeout` and close reasons, and identify the deployed backend revision. Never include
`access_token` query values in the handoff. Backend log access is not available in this
workspace; the operator has been asked for access/help. SDK/client compatibility remains an
alternative until the backend trace is available.

At **17:09:20 UTC** the original `ae618ff` image/configuration was restored; temporary Node
options and probe mount are absent. No runtime code/dependencies changed. Current database
counts remain **4 decisions, 6 actions, 8 reminders, 67 audits, 3 channel configurations**;
existing volumes were retained. Fresh private DB/crypto backups and diagnostic events are in
`/home/sysop/wire/wire-team-bot-backups/latency-05q9np8o/`. No database was reset or restored.
The reconnect cycle still occurs after restoration. No runtime regression suite was rerun
for these temporary diagnostic operations and documentation-only changes.

Adam requested continuing functional QA while the connection issue remains open. Proceed with
the manual cases below, recording delivery delay separately and waiting for each confirmation
before dependent commands. After correction, observe sustained connectivity and time several
mentioned `status` requests at different offsets in the former 30-second cycle. Correct content
and a native quote alone do not pass the latency gate or approve the pilot.

#### Final manual QA on the pinned staging candidate

Use **Demo for Anna** (`8791c80e-8209-4509-9c33-360e83b44c62@staging.zinfra.io`) as the primary
and **Wire Team Bot Testing** (`3c09c898-b840-4644-9bfc-1fc29d87b2cc@staging.zinfra.io`) for
scope-denial checks. Both were previously designated by Adam. Use actual Wire mentions of the
bot and people, selected in the client; the text below a mention is the command. Use the IDs
returned by this run in place of `DEC-A`, `DEC-B`, `ACT-A` and `REM-A`. Send one command per
message except the deliberately combined-command test. Case 1 has a correct quoted `status`
reply; Adam subsequently reports tests 1–3 passed, including reply targeting, final decision
recall and the action lifecycle (see the September 21 entry above). Lowercase ID input exposed
one additional defect fixed in the replacement candidate; Adam confirms the focused Wire retest passed on September 21. Case 4 is operator-confirmed passed, with its stored-record/audit verification pending.
Cases 5–8 remain **pending on the final candidate**.
The developer verifies persisted sources, qualified owners, status, deadlines and audits after
processing; the user checks Wire rendering and usefulness. Do not paste credentials or real
team transcripts into review artifacts.

**Case 2 evidence — 2026-09-18 18:35 UTC:** Adam supplied the quoted Wire replies through
revocation. [Scoped stored-record and audit checks](tests/acceptance/staging-decision-qa.json)
found exactly two matching synthetic facts: `DEC-0005` is superseded/version 2 and points to
`DEC-0006`; `DEC-0006` is revoked/version 2 and supersedes `DEC-0005`. There are exactly four
matching audit entries (two creations, supersession, revocation), with the qualified recorder
and actor matching Adam (Human), and distinct original message IDs. Neither record is active.
The explicit-command path stores the named maker and rationale in the summary; both `decidedBy`
arrays remain empty. The observed answer correctly uses that stored wording to identify Adam
Low as maker rather than treating the recorder as maker. No runtime changes or fresh automated
suite are claimed. These records are in `462a6490-fc3e-4c76-9f20-154c6b661336@staging.zinfra.io`,
not either previously designated room; the operator has been asked to confirm its display name.
Verification was limited to the reported synthetic facts and their audits. On September 21 Adam reported the final post-revocation question passed as part of cases 1–3.
That is operator confirmation; no new verbatim answer or numeric timing was supplied.

**Case 5 progress — September 21, 11:02 UTC:** screenshots confirm the expected combined-command
refusal, separate creation, cancellation and snoozed delivery. [Scoped stored evidence](tests/acceptance/manual-reminder-cancel-snooze.json)
finds exactly two matching facts with separate source IDs: `REM-0009` cancelled/version 2,
`REM-0010` fired/version 3, both owned by Adam (Human). The latter was snoozed at 10:59:09 UTC
until 11:01:09 UTC, then marked fired at 11:01:09.925 with one firing audit. This matches
12:01 UK summer time in the client. Cancelled non-delivery through its original 11:18 UTC
(12:18 UK) deadline and coordinated overdue recovery remain pending. Combined-event source ID
was not supplied; the inventory check finds no extra matching reminder fact.

**Case 5 recovery — September 21:** [Coordinated recovery evidence](tests/acceptance/manual-reminder-recovery-0921.json)
records `REM-0011`, due 11:07:41.733 UTC. Staging stopped at 11:06:28 UTC; a read at
11:07:46 UTC confirmed the overdue record remained pending/version 1 with only its creation
audit. The same container/image/crypto volume restarted at 11:07:47 UTC. At 11:07:49 UTC the
record became fired/version 2, with one firing audit and its original source, owner and deadline
preserved. Backend recovery passes; operator confirmation of one visible delivery is pending.
No runtime change or new model/test-suite run occurred. Cancelled REM-0009's original deadline
has not yet elapsed; its non-delivery observation remains pending.

**Case 6A checkpoint — September 21:** the operator screenshot shows pause acknowledgement
followed by `RC_PAUSED_BEFORE_0921`. [Read-only checks and restart evidence](tests/acceptance/manual-paused-restart-0921.json)
confirm durable PAUSED at 11:17:38 UTC; the marker occurs zero times across ten application
tables and container logs. At 11:19:32 UTC the same container/image/crypto volume restarted,
hydrated three conversations and connected with zero startup errors. The stored state remains
PAUSED with its original change timestamp. Post-restart marker, status, resume and subsequent
storage checks are pending. This checkpoint does not prove in-flight cancellation or absence
from provider request payloads; those were not observed. At 11:18:56 UTC, REM-0009 was still
cancelled/version 2 past its original deadline; visible non-delivery confirmation remains pending.

**Case 6A post-resume — September 21, 11:22 UTC:** the operator screenshot confirms the
post-restart marker, paused status response, successful resume and an empty personal open-action
list. Fresh checks confirm ACTIVE and zero occurrences of either `RC_PAUSED_BEFORE_0921` or
`RC_PAUSED_AFTER_0921` across the ten checked application tables and container logs. The
[updated evidence](tests/acceptance/manual-paused-restart-0921.json) passes the observed
PAUSED persistence, resume and no-marker-persistence journey. Live in-flight cancellation and
provider request payload exclusion were not demonstrated by this run; do not conflate the
storage/UI check with those stronger claims. SECURE repeat remains pending.

**Case 6B restart checkpoint — September 21:** [SECURE evidence](tests/acceptance/manual-secure-restart-0921.json)
confirms durable SECURE from 11:24:30 UTC and an open secure interval. The supplied synthetic
`RC_SECURE_BEFORE_0921` marker occurs zero times across ten application tables and container
logs. At 11:26:02 UTC the same staging container/image/crypto volume restarted successfully,
hydrated three conversations and connected with zero startup errors. SECURE and the original
open interval were preserved. Post-restart marker/status/resume checks and interval closure
remain pending; provider payload exclusion and live in-flight cancellation are not claimed.

**Case 6B post-resume — September 21, 11:28 UTC:** [Updated SECURE evidence](tests/acceptance/manual-secure-restart-0921.json)
confirms ACTIVE and the secure interval correctly closed at 11:27:59 UTC. Both secure-period
markers occur zero times across ten application tables and container logs. `ACT-0012` was
created at 11:24:20 UTC, about ten seconds before SECURE started; its presence after resume is
expected, not a secure-period capture. Operator screenshots confirm resume and personal recall.
The observed restart/resume/no-marker-persistence journey passes. No live provider payload
inspection or in-flight cancellation proof is claimed.

**Test-instruction correction:** SECURE ignores incoming `status` requests and responds only
to a qualified bot-mentioned `resume`; PAUSED instead gives a standing-by reply. The earlier
instruction to expect a SECURE status reply was incorrect. This silence was not an outage.

**Case 7 — September 21, 12:35 UTC:** Adam reports the lookup and lowercase completion
attempt in Wire Team Bot Testing were denied and ACT-0012 remained open in Demo for Anna.
[Scoped record/audit verification](tests/acceptance/manual-scope-denial-0921.json) confirms the
same original source, qualified owner, open status and version 1, with only its original creation
audit and no mutation audit. This real two-conversation denial journey passes. The test reused
ACT-0012 from the SECURE prelude instead of creating another synthetic action; it may now be
closed in its original conversation. Quality/usefulness review and the timezone display fix
remain outstanding, alongside explicitly pending evidence in the earlier checkpoints.

**Case 4 storage follow-up — September 21, 12:47 UTC:** [Post-process evidence](tests/acceptance/manual-passive-feedback-0921.json)
confirms exactly one matching handover action, ACT-0010, owned by Adam (Human), done/version 2.
Its creation and completion have exactly two audits, retaining their distinct original source
message IDs. This closes the pending fact/source/owner/duplicate/audit check for the operator's
passed passive-feedback journey.

**Case 8 update — September 21:** Adam reports test 8 worked. Live summary/list UI checks
are operator-confirmed; the explicit 20-capture/ten-answer review, useful-answer count and
speed/noise assessment have been requested before recording human quality approval. Reminder
receipt/non-delivery confirmation has also been requested; do not infer it from this answer.

Current acceptance checkpoint: the operator reports the eight Wire UI journeys worked; scoped
storage checks now cover passive completion, reminders, PAUSED/SECURE markers and cross-channel
mutation denial. Formal human fact/answer review and speed/noise approval remain pending. Adam subsequently
instructed accepting recovery receipt and cancelled non-delivery; see the follow-up below.
The new timezone UI retest passed below.
Live in-flight cancellation/provider payload exclusion was not observed in the manual privacy
runs; preserve that limitation alongside the automated queue/buffer tests. No pilot approval or
1.0 release is claimed. Timezone regression, staging replacement and focused UI retest are complete below; remaining
human confirmations are next.

README review — September 21: clarified the AI assistant purpose, model-backed capture/Q&A/
summaries, deterministic command paths, optional embeddings, deployment-owned model services,
prompt data and provider/privacy boundaries. Checked claims against routing, pipeline/adapters,
composition/configuration, package scripts, Docker/Compose and current acceptance evidence.
Corrected the clone example and explained model-server setup and container-local endpoints.
Local documentation links/anchors, npm script references and formatting were checked. This is
a documentation-only change; no fresh runtime tests, model evaluation or staging rollout.
At Adam’s request, removed the generic “working toward / not production-ready” README banner.
The opening retains the proof-of-concept purpose; detailed acceptance status remains here.
This editorial change does not mark pending acceptance checks or the 1.0 release complete.

#### Reminder timezone correction — 2026-09-21

The misleading display is fixed in runtime `2dbc0fd`: creation/list/snooze replies use the
configured conversation timezone and include its label. UTC is the default; Europe/London
renders BST in summer and GMT in winter. Demo for Anna remains configured UTC; no timezone
setting or stored deadline was changed. Wire client timezone is not inferred. No dependency,
schema, classifier, extractor or pipeline change; simulation was not rerun.

[Validation evidence](tests/acceptance/timezone-validation.json) records fresh build/type-check/lint,
**393 tests in 44 files**, six isolated DB tests, and strict checks of the harness/new tests.
Tests run with server timezone America/New_York to reject implicit host-local rendering.
Before the fix, zone/routing assertions failed; one initial test also had an unset parser stub.
A subsequent strict check caught a missing outbound mock method. Both fixture issues were
corrected without relaxing assertions; all final checks passed.
[Evaluator calibration](tests/acceptance/timezone-calibration.json) passed **12/12**.
[Full real-model e2e](tests/acceptance/timezone-e2e-report.json) passed **64/64**, with **18 mandatory
post-exit stored/state checks**. The new exact-output journey checks BST create/list/snooze,
cancellation and the unchanged UTC scheduling instant by source, fact and qualified owner.
[Focused results](tests/acceptance/timezone-focused-report.json) also passed. Environment is
Node 22.23.2/trixie, isolated Postgres16+pgvector on port55439, embeddings off, existing staging
application slots and the established evaluator override; credentials/endpoints are omitted.

[Staging activation](tests/acceptance/timezone-staging-activation.json) completed at **13:00 UTC**:
`wire-team-bot:v3-rc-2dbc0fd`, image
`sha256:b47ade6e94525c2b08d35c20bcd79114538e04b29ce76b57a0baf94603516bd6`.
Database/crypto archives were verified readable; all twelve durable table fingerprints,
environment and volumes remained unchanged. Startup hydrated three conversations and connected
with zero errors and the expected embeddings-disabled warning. No production action occurred.
Private backups and rollback override: `/home/sysop/wire/wire-team-bot-backups/timezone-ngs69pir`.
To restore the preceding bot image while retaining current DB/crypto state:

The historical command is retained in Git snapshot `f0879c0`. For the renamed deployment,
use the [current activation/rollback procedure](#canonical-naming-cleanup--2026-09-22).

**UI retest passed — September 21, 13:07 UTC:** the operator screenshot shows explicit UTC
labels on creation, listing and snooze, then cancellation. [Scoped stored evidence](tests/acceptance/manual-timezone-ui-0921.json)
confirms REM-0012 cancelled/version 3, original qualified owner/source preserved, with exactly
three audits: creation at 13:06 UTC for 13:26 UTC, snooze to 13:09:12 UTC, then cancellation.
The stored snoozed instant matches the displayed time. This closes the display defect on
`2dbc0fd`; prior Wire journey results remain evidence on `8c0c89d`. No runtime change or
fresh automated test run occurred during this evidence-only checkpoint.
**Reminder confirmation follow-up — September 21:** Adam instructed accepting confirmation
that REM-0011 arrived exactly once and cancelled REM-0009 never arrived. This closes the
operator receipt/non-delivery items at his direction; no additional screenshot or instrumented
receipt evidence is claimed. The earlier database/audit evidence remains unchanged. Formal
human fact/answer review and speed/noise approval remain pending before the five-day pilot
and subsequent 1.0 release decision; Adam plans additional manual testing.

1. **Round trip and reply targets.** Mention the bot with `status`, then send `my actions` and
   another `status` quickly as separate messages. Each reply must quote its own source. Check
   the current requester is addressed correctly. Confirm the registered app name and description
   use Wire Team Bot; the previous registry display was AI Team Bot (adamlow, staging), and
   registry branding needs an admin update if still unchanged.
2. **Decision attribution and corrections.** As @adamhuman, send `decision: use SQLite for the
   RC final ledger because setup is simple` and keep `DEC-A`. Ask `Who recorded DEC-A, and who
   made that decision?`: recorder must be Adam (Human), with maker unknown. Send `decision:
   Adam Low agreed to use Postgres for the RC final ledger because transactions are required
   supersedes DEC-A`; keep `DEC-B`. Ask for the current decision, rationale, recorder and maker:
   Postgres/transactions, Adam (Human) recorder, Adam Low maker. Send `revoke DEC-B RC final
   check finished` and ask again; neither decision should be active or automatically revived.
3. **Structured assignment and dates.** As @adamhuman, send `action: prepare the RC final
   checklist for @Adam Low by this Friday`, inserting an actual member mention. Keep `ACT-A`.
   For a September 21 run, `this Friday` is September 25 and `next Friday` is October 2.
   The earlier September 18 expectations remain specific to that date. As @adamlow_wire,
   ask `my actions` and `what am I responsible for?`; the owner must be Adam Low. Reassign with
   `ACT-A reassign to @Adam (Human)` using a real mention, set `ACT-A due next Friday`, then
   `ACT-A done`. Check the owner, next-week date, completion and removal from open lists.
4. **Passive feedback.** Without mentioning the bot, send `I'll send the RC final handover
   note tomorrow.` Wait for 📝 and inspect `my actions`. Send `I've sent the RC final handover
   note.` as the same owner; expect ✅ and removal from the open list. Verify exactly one action
   and the matching creation/completion audits, including the original qualified source.
5. **Combined commands and reminders.** In one message, send two bot-mentioned lines:
   `remind me in 20 minutes to check RC final cancellation` and `remind me in 20 minutes to
   check RC final snoozing`. Expect a split-message instruction and **zero** reminders from that
   source. Send the two lines separately; keep their IDs. Immediately cancel the first with
   `cancel REM-A`; snooze the second with `snooze REM-B 2 minutes`. Confirm the second arrives
   at its revised time and the first never fires. For recovery, create `remind me in 2 minutes
   to check RC final recovery` and tell the developer as soon as it is confirmed. The developer
   stops the bot until it is overdue, checks it remains pending, then restarts the same image
   and verifies receipt plus fired state. Do this coordinated interruption before more commands.
6. **PAUSED and SECURE.** Test each state separately. Send a synthetic ambient commitment and
   immediately mention `pause` (or `secure mode`); wait for confirmation. Send a unique marker
   such as `RC_PAUSED_BEFORE_0918`. The developer restarts the same image. Send
   `RC_PAUSED_AFTER_0918` while still blocked, then mention `resume`. Repeat with `RC_SECURE_...`
   markers. In SECURE, `status` is deliberately ignored; mention `resume` to exit. In PAUSED,
   `status` receives a standing-by reply. Markers must not reach later model requests, stored
   records, signals or audits.
   Capture logs/DB checks through the developer; silence alone is not proof. If the pre-pause job
   had already finished, do not claim that run demonstrated in-flight cancellation.
7. **Cross-channel denial.** In Demo for Anna create `action: keep the RC final scope marker`
   and retain its open ID. In Wire Team Bot Testing ask about that ID, then send `<ID> done`.
   Expect no record disclosure or mutation. The developer checks the original remains open with
   unchanged version and audit count; then close it in its original conversation.
8. **Quality and usefulness.** Review [the 20 source/record pairs and ten known answers](tests/acceptance/qa6-quality-review.md),
   including silent captures and the unknown-answer control. Record reviewer/date, corrections,
   useful answers out of ten, and whether the measured 7.7-second median/16.1-second slowest
   response and notification volume are acceptable. Try `catch me up`, `team actions` and
   `overdue actions` in the designated channel. Apply §5 thresholds; synthetic matching is not
   human approval. Existing multi-day simulation review remains unapproved.

After these checks pass, record the pilot team/channels, owner, start date and five working days
of feedback. Any privacy leak or wrong-target mutation blocks the pilot. Production deployment
remains outside this staging acceptance.

#### Second automated implementation step — 2026-09-18

The date discrepancy was a runtime bug as well as an evaluation problem. Chrono's forward-date
option promoted a date-only Friday to the following week once the implied noon passed. Parsing
now uses the conversation timezone, keeps today's date-only weekday on today (default noon),
and preserves explicit next-week requests. A future explicit time today stays today; past
explicit-time requests retain forward-date behaviour. Calendar target dates account for DST;
elapsed durations and explicit timezone expressions retain their specified instant. Existing
records are not migrated. Gap/fold disambiguation for ambiguous local times is not expanded.

The CLI can inject a parser reference instant and conversation timezone for synthetic framed
runs only; the Wire composition still uses the real clock. Network timers, processing queues,
and record creation timestamps remain real. The e2e report records each scenario's reference
instant/timezone and actual source events. Every scenario inventories stored decisions/actions/
reminders only after CLI exit and queue drain. Fifteen scenarios have mandatory exact fact/source/
qualified identity/status/date checks (including durable secure state); other inventories remain available for review without
being labelled checked. Generated IDs serve command substitutions, not stored-fact matching.

Expectation changes and their reasons:

- TC-PIPE-06 now explicitly says Alice will do the work, retaining the one-action dedup requirement
  and requiring the first source event. TC-PIPE-08 preserves both original ownerless messages
  and requires zero captures. No ownership guess is permitted to improve recall.
- TC-ID-03 asks who recorded the decision and, separately, who made it. Stored author must be
  `alice@cli.local`, with no invented maker. TC-DEC-07 now requires both Carol and Dave as makers,
  Alice as recorder, and the corresponding stored source/summary.
- TC-ACT-09/10/11 use fixed clocks and exact persisted deadlines. New TC-ACT-12/13 cover local
  Friday while UTC is Thursday, and explicit next Friday. Their assertions use concrete dates.
- A model judge still rejected correct Friday confirmations after an explicit policy clarification:
  [first run](tests/acceptance/step2-date-judge-before.json),
  [policy-clarified rerun](tests/acceptance/step2-date-judge-policy-report.json). Four deterministic
  command/list replies in TC-ACT-10/11 now require exact full text, plus exact stored facts,
  instead of asking a model to interpret fixed output. TC-DEC-06 and TC-STATE-03 subsequently
  received the same exact checks after the full run reproduced judge errors on their correct
  confirmations; stored names/source and durable secure state are also mandatory. Wrong date/owner, extra text or an extra
  record all fail. Natural-language answers remain model-judged; neither failed report is hidden.

Initial validation: 14/20 date cases failed before the parser fix; after it, **365 tests in 43
files passed**, including six isolated DB tests, plus build, production and e2e-harness strict
TypeScript checks, and lint. Environment remains Node 22.23.2/glibc 2.41 and isolated Postgres
16 + pgvector on port 55439. Focused real-model runs verify all affected stored facts; full
image regression followed, as recorded below.
[Focused checks](tests/acceptance/step2-focused-report.json) pass; the strengthened Friday test
[rejects the previous image](tests/acceptance/step2-old-image-regression.json) with its wrong
next-week stored date and confirmation. Original 57/60 and step-one 58/60
reports remain unchanged. No classifier/extractor change, new dependency or staging deployment.

The first full image run was **61/63** ([report](tests/acceptance/step2-e2e-report.json)); all nine
then-mandatory stored checks passed. The two failures were fixed-output judge errors in
TC-DEC-06 (explicit Alice/Bob agreement rejected as a recorder/maker confusion) and TC-STATE-03
(the existing acknowledgement rejected for not literally saying "secure mode").
[Focused reruns](tests/acceptance/step2-final-focused-report.json) pass with exact text plus
persisted facts/state. That stage retained the same runtime image for the next full run.
The fixed capture sample also completed: [report](tests/acceptance/step2-capture-report.json),
20 expected/20 stored/20 correct facts (10 decisions, 10 actions), zero duplicates and stored/log
privacy markers. Human approval remains pending.

Evaluator calibration follow-up:

- The next full run was **60/63** ([uncalibrated rerun](tests/acceptance/step2-final-e2e-report.json)).
  All eleven mandatory storage/state checks passed. Three correct natural answers were rejected:
  Redis/TTL rationale, the read-only reminder follow-up, and Bob's requester identity.
- A [12-case calibration fixture](tests/acceptance/judge-calibration-fixture.json) pairs six real
  correct answers with six deliberately wrong ones (wrong date, wrong owner, wrong makers,
  invented maker, missing rationale and fabricated reminder scheduling). The existing small
  judge scored [10/12](tests/acceptance/step2-judge-small-report.json). The existing response model
  scored [11/12 after strict protocol review](tests/acceptance/step2-judge-strong-initial-report.json):
  one malformed verdict was rejected, not counted as a successful negative.
- The judge now shares the runtime's bounded unsupported-temperature compatibility behaviour,
  requires one valid verdict line, fails closed, and retries malformed output only once. Valid
  FAILs are never retried to obtain a PASS. Every verdict and malformed attempt is retained in
  the e2e report. Network/format errors remain failures.
- With that protocol, the stronger configured model passes [12/12 calibration cases](tests/acceptance/step2-judge-strong-report.json),
  including all six negative controls. Acceptance runs explicitly set
  `WIRE_TEAM_BOT_JUDGE_MODEL=claude-opus-5`; application model slots and the default judge fallback remain
  unchanged. This is evaluator calibration using an existing model, not an application provider
  migration. Initial calibration encountered an explicit unsupported-temperature HTTP 400 before
  the compatibility fix; provider bodies/credentials were not logged.
- TC-QA-05's old assertion incorrectly allowed a read-only Q&A path to create a reminder. It now
  requires coherent text guidance without claiming a write, and zero stored captures. TC-ID-06
  now also checks both actual owners, source events and deadlines. No false ownership/write is
  accepted to improve a score. These additions bring mandatory storage/state checks to thirteen.
- Latest deterministic validation: **369 tests in 43 files**, six isolated DB tests, build,
  production/harness strict type checks and lint passed. The subsequent calibrated runs are
  recorded below; earlier failing reports remain intact.

The first calibrated full run was **62/63** ([report](tests/acceptance/step2-calibrated-e2e-report.json));
all thirteen mandatory stored-record/state checks passed. TC-ID-04 received two empty evaluator
responses; the actual reminder confirmation, persisted Alice/Bob ownership and caller-filtered
list were correct on inspection. TC-ACT-12 also had an empty first verdict, followed by a valid
PASS. These are retained evaluator failures/retries, not hidden application failures.
The 150-token evaluator allowance was increased to a bounded 512 tokens; provider finish reasons
are now retained for diagnosing truncation. The earlier response metadata was not retained, so
its precise cause is not claimed. The [focused reminder rerun](tests/acceptance/step2-budget-focused-report.json)
and [all twelve controls](tests/acceptance/step2-budget-calibration-report.json) pass. Fresh build,
production/harness type checks, lint and **370 tests in 43 files** pass, including six isolated
DB tests. The subsequent full run retained the same application image and assertions.

Raw review of the next [63/63 assertion pass](tests/acceptance/step2-acceptance-e2e-report.json)
found two uncovered answer errors: TC-PIPE-05 suggested December 31 for the current quarter on
September 18, and TC-PERSONA-01 said "you decided" when only the recorder was known.
[Both findings and original outputs are preserved](tests/acceptance/step2-raw-review-findings.json).
That green score was **not accepted as final**. The answer guidance now also prohibits invented
calendar dates in suggested commands and unsupported maker attribution in pronouns/introductory
prose. Both scenarios have stricter answer assertions and post-process stored-source/identity
checks (fifteen mandatory scenarios in total). [Both corrected journeys pass](tests/acceptance/step2-answer-focused-report.json),
and [both saved bad answers fail the new assertions](tests/acceptance/step2-answer-negative-controls.json).
Fresh build/type-check/lint and all **370 tests** pass. Runtime `ae618ff` was then built and
validated in the final runs below.

The release build reports [three high dependency audit entries](tests/acceptance/step2-dependency-audit.json)
for one recursive-object stack-exhaustion advisory propagated through `deepmerge-ts`,
`@prisma/config` and `prisma`. No dependency was changed. Inspection places `deepmerge-ts` in the local Prisma TypeScript/JavaScript
configuration loader; the application has no direct import of it or `@prisma/config`. No path
from Wire/model input to that loader was identified. This is a recorded dependency limitation,
not an observed message-input exploit or a claimed clean security audit.

**Final step-two evidence:** [validation summary](tests/acceptance/step2-validation.json).
Runtime/harness commit `ae618ff3c7b5cda642e603ed8a755076bdf1655d`, image
`wire-team-bot:v3-rc-ae618ff`, image ID
`sha256:4faa5df2a11d540e20659d89cb439755715060cb859f6db264a2c038bdb5abd0`.

- [Full immutable-image run](tests/acceptance/step2-final-runtime-e2e-report.json), `mu74v4ij`:
  **63/63**, all fifteen mandatory storage/state checks pass, no malformed judge attempts.
  Post-exit inventory contains 14 decisions, 26 actions and 8 reminders; all inventories were
  inspected. These inventory totals are not an extraction-quality score. Raw answer review
  confirms the corrected attribution, missing-deadline guidance, date boundaries, requester
  identity and read-only reminder follow-up. Original/failing reports remain unmodified.
- [Final unchanged capture sample](tests/acceptance/step2-final-capture-report.json):
  **20 correct / 20 stored / 20 expected**, separately **10/10/10 decisions** and **10/10/10 actions**;
  precision and recall **100% on this small synthetic fixture**, zero duplicates. Ten captures
  were silent. All records match expected source events/facts/owners after processing exits;
  no reply-ID scoring. Zero stored/diagnostic privacy markers, zero unsolicited text replies,
  five capture reactions. The ten known answers contain the expected facts and the unknown
  budget question is refused. Human correctness/usefulness approval remains pending.
- Eleven answer requests including the unknown question: median **7,698 ms**, p95/maximum
  **16,084 ms**, measured while the quality sample and isolated e2e suite shared the configured
  provider. One malformed query-analysis response used the existing safe fallback; embeddings
  were intentionally disabled. App model slots/dependencies are unchanged; only the evaluator
  uses the documented judge override. Simulation was not rerun: classifier/extractor/pipeline
  code did not change, and the existing simulation golden file still awaits human review.
- Build, production and harness strict type checks, lint, and **370 tests in 43 files** pass,
  including six real isolated Postgres/pgvector tests. No shared DB reset, historical-record
  migration, staging activation or production deployment was performed in this step.

**Next:** QA-7 Wire/UI and human-quality acceptance using the pinned staging candidate and
the exact manual packet below. QA-6 activation is now recorded below. Keep the candidate pinned during
manual QA; do not start P3 until those gates pass. Existing dates are not rewritten, date-only
weekday deadlines still default to noon, DST gap/fold ambiguity remains outside this fix,
and model instructions do not guarantee every future answer. Dependency limits are recorded
above. Production deployment is not part of this work.

Reproduce the calibrated full suite without starting a Wire client (the isolated test database
must already be running and migrated):

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" \
  --env-file .env.staging -e WIRE_TEAM_BOT_JUDGE_MODEL=claude-opus-5 \
  -e DATABASE_URL=postgresql://wirebot:synthetic-only@127.0.0.1:55439/wire_team_bot_test \
  -e WIRE_TEAM_BOT_EMBEDDINGS=off -e NODE_PATH=/validation/node_modules \
  -v "$PWD/tests":/app/tests:ro \
  -v "$PWD/node_modules":/validation/node_modules:ro \
  -v "$PWD/tsconfig.json":/validation/tsconfig.json:ro \
  --entrypoint node wire-team-bot:v3-rc-ae618ff \
  /validation/node_modules/ts-node/dist/bin.js --transpile-only \
  --project /validation/tsconfig.json /app/tests/e2e/runner.ts --json
```

Use the same container/environment and substitute `/app/tests/e2e/calibrateJudge.ts` for
`/app/tests/e2e/runner.ts --json` to repeat the twelve evaluator controls. Calibration checks the evaluator,
not the app; keep its result separate from the 63 application scenarios.

#### First automated implementation step — 2026-09-18

- Both structured and semantic decision retrieval expose the recorder separately. They never
  fall back from missing `decidedBy` to the author. The answer prompt names makers only from an
  explicit decider field or unambiguous named makers in the stored summary; unknown makers stay
  unknown. Existing records and IDs are preserved.
- ACTIVE routing rejects recognised combined explicit commands before buffering, model calls,
  state changes or domain writes, with a native reply asking for one command per message. The
  guard understands structured qualified mentions and inline-code commands, including formatting
  around only a record ID. It preserves the
  existing PAUSED/SECURE handling, single commands, multiline prose and fenced examples. This
  is bounded explicit-command recognition, not general natural-language batch execution.
- Red baseline: 14 new attribution/router cases failed; 107 existing router cases passed.
  After the fixes: build, `tsc --noEmit`, lint and **334 tests in 41 files passed**, including
  six real DB integration tests. Environment: Node 22.23.2 / Debian trixie container,
  isolated Postgres 16 + pgvector on port 55439, `INTEGRATION_TESTS=1`; no shared DB reset.
- The unchanged TC-DEC-07 now answers **Recorded by Alice; Decided by Carol and Dave**:
  [focused e2e output](tests/acceptance/step1-dec07-report.json). The
  [focused fixture](tests/acceptance/step1-fixture.json) and
  [real-model report](tests/acceptance/step1-report.json) also show an unknown decision maker
  explicitly distinguished from recorder Alice. Answers inspected directly, not accepted solely
  from the model judge. One malformed query-analysis output used the existing safe fallback;
  answer and stored-record checks still passed. Embeddings were off; semantic formatting was
  covered by mocked tests. Model slots/fallbacks are recorded without endpoints or credentials.
- [Post-drain storage inspection](tests/acceptance/step1-storage-check.json): 2 expected/2 stored
  decisions matched by fact and source, no actions, exactly 2 reminders from the separate source
  events, no combined-message writes, 4 matching creation audits. Recorder is `alice@cli.local`,
  both explicit decider arrays are empty, and decision context arrays are empty. This small
  regression sample is not the pilot's 20-event quality sample or human approval.

Final step-one runtime is `1ef4bf2d36d18cd230752a4001f90358374f2f19`, built as
`wire-team-bot:v3-rc-1ef4bf2`; image ID
`sha256:2788bfad05b9d2bc6af5dfff32853037561a9054a78ded248ba3aa78b06ba3d2`.
The [immutable-image focused report](tests/acceptance/step1-image-report.json) and
[post-drain image storage checks](tests/acceptance/step1-image-storage-check.json) repeat all
focused checks successfully on that compiled runtime. The initial report above records the
pre-commit working tree; its runtime was committed as `caa4dd1`, followed by the inline-ID guard
fix in `1ef4bf2`. No image was deployed, and no historical record was rewritten.

Full unchanged e2e run `mu70wa2r` against that image: **58/60**
([raw results](tests/acceptance/step1-e2e-report.json)).
[Post-run inventory](tests/acceptance/step1-e2e-storage-check.json) includes all 15 decisions,
23 actions and 8 reminders, including silent captures. These counts are an inventory, not an
extraction-quality score. Direct storage/answer review confirms:

- TC-DEC-07 correctly separates Alice as recorder from Carol/Dave as named makers.
- TC-PIPE-06 fails its existing positive dedup expectation: the ownerless statements produced
  no action. It needs an explicit-owner positive case plus the retained negative case in QA-3.
- TC-ID-03 fails the judge's conflated maker/recorder expectation. Alice is the stored recorder,
  with no explicit makers; the answer correctly says maker unknown.
- TC-ACT-11 passed the model judge, but the same-Friday storage check **failed**: the deck action
  belongs to Bob and is due **2026-09-25T12:00:00Z**, not **2026-09-18T12:00:00Z**. This run occurred
  after noon on Friday 18 September, unlike the earlier morning run. Relative-date semantics,
  scenario clock/timezone and parser behaviour must be reconciled in QA-3; do not count this as
  validated date correctness just because the judge passed. TC-ACT-10 also passed the judge.

The first partial full run was stopped after the inline-ID formatting edge case was found;
only the completed immutable-image run above is counted. Existing e2e scenarios, judge,
acceptance evaluator and scoring code were not changed. No full 20-event quality sample or
simulation was rerun in this bounded step; classifier/extractor/pipeline code is unchanged.
At the end of step one, QA-3 and subsequent acceptance work awaited Adam's confirmation.

Repeat the focused check with the existing acceptance runner in the isolated test container:
`EVALUATION_FIXTURE=tests/acceptance/step1-fixture.json EVALUATION_REPORT=/tmp/step1-report.json npm run test:acceptance`.
Inspect all stored sources after drain and the two attribution answers; then rerun the unchanged
full e2e suite. No evaluator expectation has been relaxed for this step.

Repository inventory (2026-09-18): `main` is the only active branch; PRs #8 and #9 are closed.
Issue #7 described obsolete composite-button confirmation UI, which the current text-command
PoC does not require. It is closed as not planned; there are no open issues or PRs. Its history
is retained, and it is not an unimplemented release feature. The following tags are recovery snapshots, not merge queues:

| Archive tag under `archive/2026-09-18/` | Preserved work | Why it is outside the active candidate |
|---|---|---|
| `docs-app-goals` | Separate goals document and earlier docs changes | Superseded by this single plan and current README. |
| `configurable-bot-name` | General configurable-name implementation | Deferred in the scope table; fixed product branding is sufficient for QA. |
| `v3.0` | Broader redesign including alternate model/queue stacks, seed loading and general intent execution | Conflicts with the current bounded PoC scope and dependency constraints. |

Commit author/committer identity is normalized to Adam Low <adam.low@wire.com>, with unwanted
assistant attribution/session links removed from messages. History rewrite changes commit IDs,
not application source trees. [The commit mapping](tests/acceptance/history-map.json) maps
original full IDs to their rewritten counterparts. Existing image tags and evidence reports
retain original IDs/configuration so historical measurements are not misrepresented as new runs.
All 159 rewritten commit trees were compared with their originals and are identical; all three
archive tags retain the same source snapshots. Invalidated signature headers were removed.
A verified private pre-rewrite Git bundle is retained outside the repository at
`/tmp/wire-team-bot-history-_kaz61by/before-rewrite.bundle`. This documentation-only operation
does not count as a fresh runtime, model or manual QA run. GitHub may cache contributor
statistics or retain old closed-PR commit snapshots independently of current branch/tag history.

**Attribution verification corrected — 2026-09-21:** the authenticated account is
`adamlow-wire`, and GitHub's repository contributors API lists only that account. Published
`main` and all three archive tags match the inspected local refs. All reachable commit authors,
committers and archive taggers are Adam Low <adam.low@wire.com>; no unwanted co-author trailers
or assistant/session attribution were found in commit messages. Repository-local Git name/email
are pinned to that identity. No additional history rewrite or branch/tag deletion was needed.

**The visible contributor cleanup is nevertheless incomplete.** Adam's screenshot shows three
contributors. A fresh unauthenticated read of GitHub's repository page and `/_sidebar` endpoint
on September 21 confirmed `contributorCount: 3`, including the two historical accounts, while
`/repos/adamlow-wire/wire-team-bot/contributors` returns only the owner. The previous completion
claim verified the API/history but failed to verify the separate repository sidebar. This is
not just an old screenshot. GitHub's
[official contributor troubleshooting](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors#contributor-data-is-stale-after-history-changes)
says contributor displays can remain stale for about 24 hours after a history rewrite and to
contact Support if incorrect data persists beyond that. The rewrite was September 18, so the
support escalation is applicable. A request with both endpoint results is prepared locally at
`/tmp/wire-team-bot-github-support.md`; it has **not** been submitted. No repository deletion,
default-branch switching, additional force-push or hiding of the widget was performed. Mark
this task complete only when the visible sidebar is also correct. Staging and app QA are unchanged.

### Disposition of the former V3 gaps

Old IDs are retained only to make the consolidation traceable. This table replaces that backlog;
“defer” is not a commitment for the following release.

| Former gap | Decision for this release | Revisit trigger |
|---|---|---|
| A1, D1 — natural-language commands/corrections | Test common variants; fix observed misses through existing use cases. Defer wholesale intent routing. | Repeated failed tasks caused by syntax, with examples |
| A2 — hide IDs | Keep references alongside readable summaries. | Users cannot complete corrections; a safer alternative has been demonstrated |
| A3 — ambiguity | Never guess a consequential owner/target; test duplicate names and unknown people in P2. | Add only the clarification needed by those cases |
| A4, A5 — voice/follow-ups | Measure misleading answers and misdirected replies; retain explicit group addressing as the taught path. | Repeated usability failures, not speculative conversational state |
| B1 — duplicate capture | Test explicit/mentioned commands, repeats and sliding-window overlap; add the smallest write/routing guard if failing. | Reproduced duplicates; no automatic adoption of Redis/hash/vector layers |
| B2 — malformed output | Exercise current validation/fallback; close unsafe writes or silent loss affecting the baseline. | Evidence that local validation fixes are inadequate before adding a framework |
| B3, B4 — attribution and implicit commitments | Verify names/restart and baseline extraction/completion. | Specific wrong owner, missed or invented completion |
| B5 — seed loader | Defer; use existing channel purpose and a few explicit starting decisions. | Pilot onboarding is materially blocked by missing context |
| B6 — attachments | Defer. | Important knowledge is repeatedly inaccessible because it exists only in files |
| C1 — retrieval replacement | Keep current paths; investigate failed known-answer questions. | Measured misses remain after small fixes; no LlamaIndex/reranker by default |
| C2 — explain empty results | Use honest wording for no result or a known failure; never invent a reason. | Add metadata only when required to distinguish an observed failure |
| C3 — embedding availability | Existing optional/separate endpoint is sufficient. | Chosen pilot requires vector features and their absence causes measured misses |
| D2, D3 — contradiction/acknowledgement/undo buttons | Repair or remove misleading existing prompts; use text corrections. Defer new workflow. | Users need frequent corrections that existing commands cannot support |
| D4 — durable jobs | Test existing Postgres reminder rehydration before redesigning. | Demonstrated missed/duplicate delivery not solved by a local fix |
| D5 — progress view | Try current open/overdue lists and summaries first. | Team cannot see what moved or is stuck; agree an example before building |
| D6 — quality/cost visibility | P0: annotate the baseline, count failures and time replies. Record provider usage if available. | Add per-slot counters only if needed; no dashboard/telemetry platform |
| E1, E2 — name/voice customisation | Not a pilot gate. | A real team is blocked by current naming/voice |
| E3 — footprint | Keep Prisma, pgvector, one process and no Redis. | Measured capacity or durability requirement |

Also deferred: mem0/second memory store, pgvecto.rs, ORM migration, general cross-channel
recall, org-wide personal recall, ESM conversion, horizontal scaling and unrelated cleanup.
No old-branch implementation is presumed approved for reuse.

## 5. Testing and release decision

Default pilot: one consenting team, one or two channels, five working days. Record the
operator, participating team, image/commit and chat/embedding configuration before starting.
Use synthetic data for acceptance first; do not copy real transcripts into the repository.

Required journeys:

1. Log and retrieve a decision, including why/when; revoke or supersede it using a supported command.
2. Capture an action for another named member; list, reassign, change its deadline and complete it.
3. Create/cancel/snooze a reminder; restart before it is due, test one becoming due during downtime,
   and simulate a failed send followed by recovery. Do not silently mark undelivered work successful.
4. Passively capture clear decisions/commitments without duplicating explicit commands or window context.
5. Answer ten questions whose answers are known from the record; an unknown question must not invent facts or writes.
6. Catch up on a channel and inspect open/overdue work; judge whether summaries/nudges help.
7. Pause/secure/resume across both buffers, queued work and restart; check no excluded text reaches prompts or storage.
8. Deny cross-channel and cross-domain access, including guessed record IDs and corrections.
9. Exercise malformed/truncated model output, timeouts and embeddings off; no invalid writes or crash.
10. Reconnect/restart on Wire; check decryption, member names and every interaction the pilot depends on.

Use `npm test`, `npx tsc --noEmit` and `npm run lint` for code checks. Run DB integration tests
with `INTEGRATION_TESTS=1` on an isolated Postgres instance. Build before the real-DB/LLM CLI,
e2e suite or simulation. These validate bot behaviour; a Wire-client smoke test is still needed
for SDK transport and client UI. Commands and harness details are in [README](README.md#development)
and [AGENTS](AGENTS.md#validation).

Provisional thresholds for this small pilot (not production SLAs):

- Privacy/access tests all pass; any leak or wrong-target mutation blocks entry/continuation.
- Required deterministic commands and restart/reminder checks all pass.
- Review at least 20 expected capture events: precision ≥80%, recall ≥70%; count duplicates
  as errors and keep the actual numerator/denominator. Match against stored records after the
  scenario drains, not only bot acknowledgements. Precision is correct unique captures / all
  captures; recall is expected events correctly captured / all expected events. Report actions
  and decisions separately as well as overall. Ambiguous cases are reported separately.
- At least 8/10 known-answer questions are judged correct and useful by a person; no invented
  writes or owners. LLM judging assists review and does not replace it.
- Measure typical and slowest reply times, model failures and unsolicited messages. Ask the team
  whether latency/noise is acceptable before inventing a performance or notification subsystem.
- At pilot end, the team identifies concrete saved effort and chooses continued use. Otherwise
  fix the most material problem or stop expanding scope.

### Earlier staging candidate disposition — 2026-09-18

This records the earlier staged runtime and its then-open defects. The later automated QA
section above supersedes its code, validation and staging status. These paragraphs retain the
earlier candidate's evidence and then-open defects.

**Packaged for staging; acceptance incomplete, not pilot ready.** Runtime `4bc7e1f` is available
as `wire-team-bot:v3-rc-4bc7e1f` and was active in staging at that point. No production deployment
was performed. Recorder/decider attribution, combined-command guidance, human review and remaining
Wire gates were still open for that earlier candidate.
[Release evidence](tests/acceptance/release-evidence.json) records configuration and boundaries.

- Fresh build, type-check and lint pass. **304 tests pass** in 39 files, including six isolated
  Postgres/pgvector tests, reaction mapping and native-reply concurrency/scope/lifecycle contracts.
- Immutable-image real-model e2e: **57/60**, original assertions unchanged. Full outputs and
  targeted rechecks are in [e2e-report.json](tests/acceptance/e2e-report.json).
  On `4bc7e1f`, `TC-PIPE-06` still expects ownership inferred from “we need”. `TC-ACT-11` stores
  the correct Bob owner and Friday September 18 12:00 UTC deadline; the judge insists “this Friday”
  means September 25. Calendar/DB inspection confirms Friday. `TC-ID-03` correctly says Alice
  recorded the decision, but the judge rejects “recorded” as “made”; stored author is Alice.
  Its unchanged targeted rerun passes. `TC-ACT-10` passes this full run. Preserve the original
  **57/60** score and failures for adjudication; no assertions, dates or full-run results replaced.
- Raw output inspection is still required: `TC-DEC-07` now receives a passing judge verdict
  while continuing to label recorder Alice “Decided by” alongside the named Carol/Dave decision.
  **The attribution bug remains open despite that verdict.** `TC-ID-06` and `TC-QA-05` pass
  this run; historical failures remain in Git.
- Reaction lifecycle passes with real models and an isolated DB: 📝 on the capture source,
  ✅ on its completion source, no reaction for explicit creation or ordinary chat. All stored
  records were inspected after drain: two expected actions, Bob's passive one done/version 2,
  Carol's explicit one open, and three action audits linked to the expected source events.
  See [reaction-report.json](tests/acceptance/reaction-report.json). The operator confirmed both emojis display correctly in Wire on September 18.
- Fresh fixed sample at `7384b39`: **20 correct / 20 total / 20 expected**, 10 decisions and 10
  actions, **100% precision / 100% recall**, zero duplicates or stored/log privacy markers.
  Baseline remains 10/10/20 (100%/50%). Five passive actions received 📝; unsolicited text replies
  remain zero. This is a small synthetic sample, **not human-approved quality**. All ten known
  answers and the unknown-answer refusal match their expected facts on assistant inspection.
  [reaction-quality-report.json](tests/acceptance/reaction-quality-report.json) preserves source
  events, records, replies and separate reactions. Built-checkout runtime was used for this
  sample; the full e2e above used the immutable image. Human correctness/usefulness review pending.
- Reply-event median **7.308 s**, known-question median **8.388 s**, slowest **9.516 s**. No model
  degradation observed in this sample; embeddings-off warning only. Times include queue drain.
- Chat configuration: classify/judge `claude-haiku-4-5`; extract, summarise, query analysis,
  respond and complex synthesis `claude-opus-5`, with the same per-slot fallback models.
  Embeddings **off**, configured dimension 2560. DB vector behaviour was exercised with synthetic
  vectors; enabling real-provider embeddings requires its own smoke check.
- Earlier `bde0d0a` image CLI checks verify decisions, named actions with deadlines, PAUSED and SECURE
  across process restarts, resume and list retrieval. Persisted inspection finds one decision,
  one correctly owned/dated action, a closed secure range and no excluded marker. Earlier
  candidate smoke also exercised queued cancellation and model-backed recall. These are
  CLI/DB checks, not Wire transport evidence.
- Fresh simulation at `7384b39` completed all 57 source events: six decisions, seven actions,
  one reminder, six 📝 reactions and one ✅ reaction. No privacy markers or model errors. The
  existing unsolicited-message heuristic counts one reply, inspected as the confirmation of an
  explicit reminder command. The stored inventory is local and unreviewed; `golden.json` is still
  an instruction placeholder. **No simulation precision/recall claim.**

Designated Wire test conversation: **Wire Team Bot Testing**,
`3c09c898-b840-4644-9bfc-1fc29d87b2cc@staging.zinfra.io`. The user supplied the name;
a read-only lookup in the running staging SDK conversation store resolved it uniquely.
Operator: **@adamhuman**, already signed in to the staging webapp. Second participant:
**@adamlow_wire**, reported by the user as already in this conversation. Both accounts belong
to the operator and can be used for assignment/attribution checks. This identifies the test
location and accounts; it is not a completed candidate smoke test. Human reviewer remains
to be identified.

Initial staging activation (2026-09-16 16:11 UTC): the `wire-team-bot-staging` container used
`wire-team-bot:v3-rc-bde0d0a` with the tested digest and existing identity/volumes. Only the
designated conversation was present and no reminders were pending before the switch. Models
match the accepted synthetic configuration; embeddings are off. Startup hydrated one conversation
and reported the Wire client listening, with one content-free SDK error still unexplained.
The operator's screenshot confirms a mentioned `status` request received a channel-status reply
showing ACTIVE: initial receive/decrypt/reply and mention routing pass. At that check the container
had zero restarts; SDK error count had not increased from startup. This does
not yet verify reminders or a subsequent reconnect. The next operator screenshot confirms
`DEC-0002` creation and correct model-backed recall of Postgres and its transactions rationale.
Scoped database inspection confirms Adam (Human) attribution, empty context and one audit entry. The registered
app display name is still **AI Team Bot (adamlow, staging)**; changing it to **Wire Team Bot**
remains an operational naming check.

Rollback snapshots (private, outside Git): `/tmp/wire-v3-staging-backup-kcqACp/database.dump`
and `crypto-store.tar.gz`; both were checked readable. The candidate override is in that same
directory as `candidate.override.yml`. The old `wire-team-bot:staging` image was retained.
For the renamed deployment, use the [current rollback procedure](#canonical-naming-cleanup--2026-09-22);
retain the current database and crypto volume. Do not reset or restore identity storage for an
ordinary image rollback.

Assignment fix and staging update (2026-09-16 16:42 UTC): `82fe04b` preserves explicit
`@handles` and punctuated display names, and caches Wire profile handles during restart/join/
refresh. Four contract cases reproduced the prior failure; six new tests now pass. Fresh build,
type-check, lint and 213 tests pass. Full unchanged real-model suite on the immutable new image
remains 53/55 with the same two documented discrepancies. The isolated
[owner smoke report](tests/acceptance/owner-smoke-report.json) verifies the stored Bob owner and
Friday deadline, model recall, and no write for an unknown handle. Pipeline/model prompts did not
change in that fix; its quality evidence was measured at `bde0d0a`. The current sample above
was rerun on `2ba7a1f` after the caller prompt changed.

That update activated `wire-team-bot:v3-rc-82fe04b`, with the same database and crypto volume. Fresh
snapshots and its override are in `/tmp/wire-v3-owner-backup-QFDF2p/`; backup readability passed.
Startup hydrated one conversation and logged no SDK errors. The subsequent operator screenshot
confirms a post-restart round trip and correct persisted assignment for `ACT-0002`: owner
@adamlow_wire, creator @adamhuman, deadline `2026-09-18T12:00:00.000Z`, one audit entry.
The `my actions` reply incorrectly addressed the previous speaker; caller-specific acceptance
failed and requires the repair below. To roll back this update to the previous candidate:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-staging-backup-kcqACp/candidate.override.yml up -d --no-deps --no-build wire-team-bot`.
Keep current volumes; no database or crypto reset is required.

Caller fix and staging update (2026-09-16 17:04 UTC): `2ba7a1f` routes a leading actual Wire
mention by qualified identity and its bounded UTF-16 span, independent of the registered display
name. Both model stages receive the current requester explicitly. Contract tests cover custom
labels, Unicode, qualified identity, invalid spans and privacy controls; the real-model caller
switch verifies Alice and Bob receive their own assignments in one conversation. Build/type-check/
lint and 222 tests pass; full image regression is 54/56 with the same two retained discrepancies.
The 20-event stored-record and 11-question evaluation was repeated on this image as reported above.

That update activated `wire-team-bot:v3-rc-2ba7a1f`; database and crypto volumes were preserved.
Fresh readable snapshots and override: `/tmp/wire-v3-caller-backup-tbxaea25/`. Startup connected,
hydrated the member cache and reported zero SDK errors and zero container restarts. The next
operator screenshot confirms both mentioned `my actions` and `What am I responsible for here?`
correctly return Adam Low’s two open actions, including `ACT-0002` with its September 18 deadline.
The Q&A identifies Adam Low as the current requester, with no incorrect Adam (Human) disclaimer.
Caller-specific list/Q&A and post-restart receive/decrypt/reply now pass on this image. This
does not yet verify reassignment, deadline changes, completion, reminders or privacy-state restart.
Rollback to the preceding image while keeping current volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-owner-backup-QFDF2p/candidate.override.yml up -d --no-deps --no-build wire-team-bot`.

Pasted-command fix and staging update (2026-09-16 18:27 UTC): `a51a7af` accepts a leading
single-line inline-code span around an ACT ID, command prefix or whole command, after stripping
the actual bot mention. Person mentions already route correctly without that formatting.
Action-status questions now use record retrieval; explicit `status` still returns channel status.
Build/type-check/lint and 233 tests passed; that image’s full e2e run was 55/57.
The [formatted-action report](tests/acceptance/formatted-action-report.json) retains initial
failures and a passing real-model journey. Post-process DB inspection confirms one action,
Bob ownership, tomorrow deadline, done status, version 4 and four creation/update audit entries.
No classifier/extractor/pipeline change was made; the earlier quality sample remains attributed.

That update activated `wire-team-bot:v3-rc-a51a7af`. Private readable snapshots and its override are
in `/tmp/wire-v3-format-backup-xy3x0138/`. Existing database/crypto volumes were preserved;
startup connected and hydrated one conversation with zero SDK errors. `ACT-0002` remained
unchanged before the update. The operator’s next screenshot confirms reassignment to Adam (Human).
Scoped DB inspection verifies the qualified @adamhuman owner, version 2, open status, unchanged
Friday deadline and exactly one reassignment audit event attributed to Adam Low. Pasted-command
reassignment and the post-restart round trip pass. On September 17 the operator screenshot
confirms deadline change and completion. Scoped DB inspection verifies owner @adamhuman,
deadline `2026-09-18T09:45:44.790Z`, status `done`, version 4 and four audit entries
(creation, reassignment, deadline, completion). The deadline and completion updates are
attributed to Adam Low. The core action journey now passes on Wire; unknown/ambiguous-owner
refusal and the remaining reminder/privacy/correction journeys still need Wire acceptance.
Rollback, retaining volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-caller-backup-tbxaea25/candidate.override.yml up -d --no-deps --no-build wire-team-bot`.

Reminder formatting fix and staging update (2026-09-17 10:03 UTC): `f3b2eed` removes the
ACT-only restriction on leading inline-code normalization. Existing text-command matching now
handles pasted reminders, decision corrections, lists and addressed privacy controls as well.
Twelve failing-before cases reproduced the gap; negative tests retain prose/fence/multiline
exclusions, and PAUSED/SECURE resume still requires a qualified actual mention. Build/type-check/
lint and 248 tests pass. Immutable-image full regression is 56/58, with the same ambiguity and
caller-judge discrepancies above. The [formatted-reminder report](tests/acceptance/formatted-reminder-report.json)
records a passing real-model create/list/snooze/cancel journey and post-process DB/audit inspection:
one reminder for Alice, snoozed trigger matching its audit entry, cancelled status, version 3,
three audit entries. This does not establish live reminder delivery.

That update activated `wire-team-bot:v3-rc-f3b2eed`, with the same database and crypto volumes.
Readable snapshots and override: `/tmp/wire-v3-reminder-format-backup-gjeyvsyr/`. No reminders
were pending before the switch; startup connected, hydrated one conversation and reported zero
SDK errors. The failed Wire reminder attempt created no record. The subsequent operator screenshot
confirms `REM-0001` creation and delivery two minutes later. Scoped DB inspection verifies
@adamhuman as author/target, trigger `2026-09-17T10:09:50.637Z`, fired status, version 2 and
creation/firing audit entries. The saved fired update followed the trigger by 118 ms. The
confirmation displays UTC (10:09); the webapp screenshot displays UK local time (11:09).
This retry shows a plain command; inline-code reminder routing remains verified automatically.
Cancellation, snooze and overdue-during-downtime recovery still need Wire acceptance;
restart recovery is covered below.
Rollback, retaining volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-format-backup-xy3x0138/candidate.override.yml up -d --no-deps --no-build wire-team-bot`.

Pending-reminder restart check (2026-09-17 11:36 UTC): the operator created `REM-0002`
using a code-formatted command, confirming the inline-code creation fix on Wire. Scoped DB
inspection found it pending for @adamlow_wire, due `2026-09-17T11:45:29.304Z`, version 1.
The same pinned container was restarted at `11:36:25.509Z`, preserving database and crypto
volumes. Fresh startup logs confirm one pending reminder rehydrated, one conversation hydrated
and the Wire client listening, with zero SDK errors. The only pending reminder in the test
conversation was `REM-0002` with its original due time and version. The subsequent operator
screenshot confirms delivery at 12:45 UK time. Scoped DB inspection verifies fired status,
version 2, unchanged trigger and exactly one firing audit entry (two entries including creation).
Fired state was saved at `11:45:29.433Z`, 129 ms after the trigger. **Restoration and delivery
after restart pass.** A reminder becoming overdue during downtime remains a separate pending check.

The operator also reproduced two explicit reminder requests in one message falling into Q&A,
which misleadingly described the message as a question. Current routing expects one command
per message. This combined-command failure is recorded for a bounded routing/guidance fix
after the active cancellation/snooze checks; no batch executor is implied. Separate messages
created `REM-0003` (cancellation) and `REM-0004` (snoozing), both pending for @adamlow_wire
at the scoped DB check on September 17, 14:30 UTC. The operator missed the mutation window;
a later scoped check found both fired at their original deadlines, version 2. Cancellation and
snooze remain untested and require fresh reminders.

Named-assignment fix and staging update (2026-09-17 15:05 UTC): `17b8e42` adds the bounded
bot-addressed `@member needs to <task> by <deadline>` variant to the existing audited action
use case. The demonstrated preceding project-deadline clause supplies no guessed owner or
second action; only the named assignment and its own deadline are persisted. Questions,
negation, hypothetical wording and multiple assignments do not use this new write route.
PAUSED/SECURE remain checked first. Unknown/ambiguous names use existing member resolution.
That build/type-check/lint and 260-test run passed; its immutable-image e2e was 56/59.
The [named-assignment report](tests/acceptance/named-assignment-report.json) verifies exactly
one stored Bob-owned slide-deck action, Friday deadline, Alice creator and one audit entry.
Classifier/extractor/pipeline and answer prompts are unchanged; the earlier quality sample
remains attributed to its measured image. This is not general natural-language intent execution.

At 15:05 UTC staging was updated to `wire-team-bot:v3-rc-17b8e42`, preserving database and crypto volumes.
Readable snapshots and override: `/tmp/wire-v3-assignment-backup-vcoikohf/`. No reminders were
pending before the switch. Startup connected, hydrated two conversations and reported zero
SDK errors. The subsequent operator replay exposed the structured-mention regression below.
The original rollback command is preserved in Git snapshot `f0879c0`; use the
[current procedure](#canonical-naming-cleanup--2026-09-22) with renamed resources.

Structured mention regression (2026-09-17): the next demo used `@member really needs to`.
Three before-fix contract cases fail: routing dropped the qualified mention ID, and the adverb
became part of the display-name lookup. SDK metadata confirms both designated accounts are
members of **Demo for Anna**, `8791c80e-8209-4509-9c33-360e83b44c62@staging.zinfra.io`.
Runtime `ad01b3a` binds validated UTF-16 person spans before command parsing and carries the qualified
identity through natural/explicit action creation and reassignment. The resolver verifies exact
membership in the qualified conversation without falling back to the label. Labels remain for
display; plain-text names retain existing ambiguity checks. The synthetic CLI now represents
roster @mentions as structured fields too. No classifier/extractor/pipeline changes.
Fresh build/type-check/lint and **278 tests** (including six isolated DB tests) pass. An initial
model invocation omitted provider settings and stopped at its configuration preflight; the
configured TC-ACT-11 run passes. Post-process DB inspection finds exactly one Bob-owned action,
Alice creator, Friday September 18 12:00 UTC deadline, version 1 and one creation audit. No
project-context clause or internal mention token is retained. The immutable-image run is 56/60 as detailed above. Staging activation preserves the existing
volumes; fresh backup/override: `/tmp/wire-v3-mention-backup-8fiicc11/`. Startup at 15:36:12 UTC
hydrated two conversations and connected with zero SDK errors. Operator replay passed on
September 18, with stored-record verification below. Rollback using `/tmp/wire-v3-assignment-backup-vcoikohf/candidate.override.yml` with
the README compose command. Detailed stored-record evidence is in the
[structured-mention report](tests/acceptance/structured-mention-report.json).

Wire smoke continuation (2026-09-18, same `ad01b3a` image): the operator reports tests 1–3
completed and has created the overdue-recovery reminder for test 4, in **Demo for Anna**.
Scoped DB inspection confirms `ACT-0004` is the deck action, owned by qualified @adamlow_wire,
created by @adamhuman, due September 18 12:00 UTC, open/version 1. Structured mention assignment
now has actual Wire evidence. `REM-0005` is cancelled/version 2 with creation/cancellation audit
entries; its original deadline is 06:31:04.849 UTC. `REM-0006` was initially pending/version 2, rescheduled
from 06:31:38.390 to 06:51:51.637 UTC with a matching snooze audit. Cancellation and snooze
mutations pass. Later inspection after both deadlines finds `REM-0005` still cancelled with no
firing audit; `REM-0006` sent at its revised deadline and was saved fired/version 3 at
06:51:51.843 UTC, 206 ms after the trigger, with one firing audit. Final Wire UI confirmation
of cancellation non-delivery and snoozed receipt remains pending.
`REM-0007` was initially pending/version 1, due 06:27:40.003 UTC. The staging bot was stopped cleanly at
06:23:12.610 UTC with existing volumes/image retained. At 06:27:50.149 UTC it was still stopped,
and the overdue reminder remained pending/version 1 with no firing audit. The same container
restarted at 06:27:50.197 UTC. Outbound send succeeded; the reminder was saved fired/version 2
at 06:27:51.812 UTC, with exactly one firing audit and its original trigger unchanged. Startup
rehydrated two reminders and two conversations, connected, and reported zero SDK errors.
**Overdue recovery, successful send and durable status pass; operator UI receipt confirmation
remains pending.**
No build or automated suite was rerun for this operational test.

Decision corrections on Wire (2026-09-18, `ad01b3a`): the operator screenshot confirms SQLite
`DEC-0003` was superseded by Postgres `DEC-0004`, with correct current-decision/rationale recall,
then `DEC-0004` was revoked. Follow-up correctly reports no active decision and does not revive
SQLite. Qualified Demo for Anna DB inspection confirms `DEC-0003` superseded/version 2 with
`supersededBy=DEC-0004`, `DEC-0004` revoked/version 2 with `supersedes=DEC-0003`, empty context
arrays, and four create/update audit events attributed to Adam Low. **Test 5 passes.** This does
not resolve the separate recorder/decider attribution bug; both roles coincide in this test.

Passive Wire capture (2026-09-18, `ad01b3a`, Demo for Anna): the unmentioned checklist
commitment was silently captured as `ACT-0005`. Post-processing DB inspection at 08:34 UTC
finds one matching open/version 1 action owned and authored by qualified Adam Low, due Friday
September 18 12:00 UTC. Its source event produced exactly one action and one creation audit;
the audit retains only the source ID. The operator screenshot shows the unmentioned source,
not a bot acknowledgement. **Capture passes; passive completion and subsequent list check
remain pending.** This is one live smoke event, not a fresh aggregate quality evaluation.

User-approved feedback change (2026-09-18): silent checklist capture left the operator unsure
whether anything happened. Add post-persistence 📝/✅ reactions for passive action capture/completion
through the existing outbound port, with mocked/contract coverage, real-model stored-record
checks, simulation replay and a live Wire reaction check. Implementation is present: 296 unit/
contract/isolated-DB tests, build/type-check/lint pass. The four-event real-model lifecycle passes:
📝 on capture, ✅ on completion, no reaction for explicit creation or noise. Post-process inventory
finds both expected actions, the passive one done/version 2, and all three source-linked action
audits. Initial tests found a stopped isolated DB (restarted without reset) and new assertions
that incorrectly counted signal audits as action audits (corrected to assert action audits).
Full immutable-image e2e is 57/60 and simulation is complete as detailed above. The operator confirmed both reactions work in the Wire webapp. Scoped post-processing DB
inspection finds the emoji smoke checklist as `ACT-0006`, done/version 2, source
`550e5ccf-e384-4535-8f2d-6a7a364474d9`, updated at 09:01:45.912 UTC. Reactions are best effort, with no durable retry or backfill; failed delivery
does not undo or repeat a persisted write. Both emojis share one reaction set for mixed outcomes.
Staging started the pinned image at 08:57:46.917 UTC, preserved existing volumes, hydrated two
conversations and connected with zero SDK errors. Fresh readable database/crypto backups and
override: `/tmp/wire-v3-reactions-backup-i3egzaxn/`. No reminders were pending before the switch.
Rollback with current volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-mention-backup-8fiicc11/candidate.override.yml up -d --no-deps --no-build wire-team-bot`.

Native reply request (2026-09-18): direct responses carried source IDs through the use cases,
but the outbound adapter ignored them. Runtime `4bc7e1f` uses the SDK's native quote ID and
integrity hash for the exact incoming message and qualified conversation, including prompt
text and error replies. Metadata exists only during the handler and contains no source body;
it is removed on success/failure. Missing metadata and unsupported self-deleting sources use
ordinary text. Scheduled reminders remain standalone. Eight regressions cover SDK hashes,
mentions, overlapping channels/queued commands, scope, cleanup, errors and unsupported sources.
Fresh build/type-check/lint and **304 tests**, including six isolated DB tests, pass. The pinned
image is built; full unchanged real-model regression finished **57/60**, with details above. Staging started at 09:15:08.035 UTC,
hydrated two conversations and connected with zero SDK errors. Existing volumes were retained,
with readable backups/override in `/tmp/wire-v3-replies-backup-_bfgw1o8/`. The operator screenshot
confirms the native quote of Adam Low’s “my actions please?” question, including correct source
text/author. The answer shows ACT-0005/4 and omits completed emoji-checklist ACT-0006. Native
reply display and open-list removal pass; live two-message correlation remains pending.
Rollback with existing volumes:
`docker compose -f docker-compose.staging.yml -f /tmp/wire-v3-reactions-backup-i3egzaxn/candidate.override.yml up -d --no-deps --no-build wire-team-bot`. No extractor/classifier/pipeline change; quality and simulation results
above remain attributed to `7384b39`, not reported as fresh runs for this transport-only change.

Remaining entry checks, in order:

1. A named reviewer reviews the fixed sample’s stored records/source events, all ten answers
   and unknown-answer output; record reviewed numerators and denominators here (thresholds above).
   Review simulation misses/false positives using `npm run simulate:review` as supporting evidence.
2. Fix the reproduced recorder/decider attribution error, then adjudicate the other three
   e2e failures above. Preserve raw results; changed behavior requires a regression run. Review latency and unsolicited output with the team.
3. Use @adamhuman and @adamlow_wire for assignment checks in the designated conversation. Run the
   [Wire smoke steps](README.md#designated-wire-smoke-test) on the pinned image, including names,
   decryption, correction commands, reminder downtime/failed-send recovery and both privacy states.
4. Record the approved team/provider configuration and completed gates here, then begin the
   five-working-day P3 pilot. Do not reset a shared database or assume legacy raw rows are clean.

Known limits: transient queued work is lost at restart; reminder delivery is at least once;
source/exact-fact dedup does not guarantee semantic dedup; already-dispatched provider requests
cannot be recalled; retrieval is channel-scoped; historical data was not scrubbed. SDK diagnostics
retain severity but intentionally omit free-form message/payload detail. Human usefulness and
the remaining Wire journeys/reconnect checks remain unverified for this candidate.

### Progress and evidence log

Update this table with dated evidence as work completes. A blocked test stays pending with its
reason; an implementation or historical passing count alone does not close a release gate.

| Date | Item | Result / evidence | Next action |
|---|---|---|---|
| 2026-09-16 | Consolidation | Root plans reviewed against `f034d2f`; conflicting claims replaced, V3 scope triaged | Run P0 and fix P1 |
| 2026-09-16 | Development-goal review | Separated release-candidate acceptance from P3; identified simulation scoring limits and reminder send-failure gap by source review | Complete P0–P2; do not claim runtime verification from this review |
| 2026-09-16 | P0 baseline | Commit `e35428b`: 151 unit/contract tests passed in `node:22-trixie-slim`; host contract suites blocked by glibc 2.38 requirement. Isolated pgvector 16 database created on loopback port 55439; 11 migrations applied. Configured `claude-haiku-4-5` responded to a synthetic probe. | Measure stored facts with fixed source events; human quality review pending |
| 2026-09-16 | P1 implementation | Qualified retrieval/mutation checks, raw-context removal, cancelled channel queue work, both-buffer clearing, fail-closed hydration/resume, and content-free model error diagnostics implemented. Container unit/contract run: 166 passed; lint passed. | Complete isolated DB marker inspection and model/Wire journeys before closing gate |
| 2026-09-16 | P2 implementation | Reminder sends commit fired state after delivery, retry after 60 seconds and recover overdue pending rows; concurrent callbacks suppressed. Owner resolution, source-event replay guards, bounded model parsing, read-only Q&A instructions, current product name and text controls implemented. Configured Opus rejected temperature (HTTP 400); bounded compatibility retry added. | Full model regression, stored-record rerun and release image underway; Wire smoke and human review pending |
| 2026-09-16 | Stored-record evaluation | `cb1304e`: 20/20 expected facts captured (decisions 10/10, actions 10/10), 20 total captures, zero duplicates; ten answer outputs plus unknown-answer case retained for human review. This is automated fact/source matching, not a human quality approval. | Rerun after final completion/deadline fixes and obtain human review |
| 2026-09-16 | Model regression diagnosis | Initial full run 52/55. NDA completion was classified as low-signal; routing updates to extraction makes the isolated lifecycle reproduction pass. Explicit deadline text now reaches persistence. TC-PIPE-06 expects ownership inferred from “we need”; this conflicts with the plan’s conservative ownership rule and remains visible. | Full final regression; resolve ownership expectation before marking acceptance passed |
| 2026-09-16 | Deadline regression | `2be6486`: end-of-month dates now resolve in the conversation timezone (UTC, leap-year and DST tests); both owner/deadline command orders work. The model judge still rejected the literal correct “end of month: 30 Sept 2026” confirmation against a stale March-oriented assertion. Stored date and deterministic tests pass; the raw judge result is retained. | Human adjudication; do not weaken the assertion or change a correct date to March |
| 2026-09-16 | SDK diagnostic privacy | SDK free-form messages and nested payloads were found to bypass model-log sanitisation. Severity-only bridge and content-free top-level failure diagnostics now have a marker regression. Fresh container run: 205 tests passed, including six isolated DB tests; build/type-check/lint passed. | Rebuild final image; application event IDs remain available, SDK message detail is intentionally suppressed |
| 2026-09-16 | Final release image and quality | `bde0d0a` image built; native SDK load and CLI pause/secure restart smoke passed. Final-image fixed sample: 20/20/20, zero duplicates/markers, 10 answer outputs and unknown response inspected, human review pending. Full e2e remains 53/55 with the two cases above retained. | Human review, two adjudications and designated Wire smoke; no production deployment |
| 2026-09-16 | Capture scoring order regression | Reproduced a duplicate returned before its valid source being omitted from the duplicate counter (precision already penalised it). Source-first matching and order-independent duplicate grouping fixed; two regression tests added. Fresh build/type-check/lint and 207 unit/contract/isolated DB tests pass. Re-scoring both saved inventories preserves baseline 10/10/20 and candidate 20/20/20, zero duplicates. Runtime image unchanged. | Complete unchanged e2e suite against the immutable image; human/Wire gates remain pending |
| 2026-09-16 | Immutable-image full regression | Unchanged real-model suite run against `wire-team-bot:v3-rc-bde0d0a`: 53/55, same TC-PIPE-06 ownership expectation and TC-ACT-07 judge false negative. Runtime/dependencies were taken from the image; harness mounted read-only. Raw results and exact README command committed. | Human quality review, two adjudications and designated Wire smoke remain pending |
| 2026-09-16 | Staging candidate activation | User requested continuation after naming the test conversation/accounts. Database and stopped crypto store backed up; existing volumes retained. Pinned image started at 16:11 UTC; one conversation hydrated and client startup completed. One SDK error remains unexplained; operator status round trip requested. | Verify actual Wire receive/decrypt/reply before marking transport passed |
| 2026-09-16 | Initial Wire round trip | Operator screenshot confirms actual bot mention + `status` produced an ACTIVE channel-status reply on the pinned candidate. Container has zero restarts; no additional SDK errors beyond startup. Screenshot shows registered name AI Team Bot (adamlow, staging). No surrounding channel text copied into evidence. | Test decision capture/recall next; rename registered app and finish remaining Wire journeys |
| 2026-09-16 | Wire decision capture/recall | Operator screenshot confirms DEC-0002 and correct Postgres/transactions answer with author attribution. Scoped DB inspection confirms active record, empty context and one audit entry. | Continue assignment and reminder smoke checks |
| 2026-09-16 | Real-member assignment parser gap | Before testing the supplied handle, four mocked contract cases reproduced dropped @handle/parenthesised-name assignees and missing handle hydration. Explicit target parsing now preserves these references and member profiles retain handles across restart/join/refresh; qualified resolution rejects unknown or ambiguous targets. | Validate, rebuild image and resume Wire assignment check |
| 2026-09-16 | Assignment fix validated and staged | `82fe04b`: 213 tests, build/type-check/lint pass; real-model owner smoke verifies persisted Bob attribution and unknown-owner refusal. Immutable-image full regression 53/55, same two retained failures. Staging updated with fresh backups and existing volumes; startup has zero SDK errors. | Operator handle assignment and post-restart Wire check |
| 2026-09-16 | Wire handle assignment and caller confusion | Operator screenshot confirms ACT-0002 was assigned to @adamlow_wire with Friday deadline; scoped DB confirms qualified Adam Low owner, Adam (Human) creator and one audit entry. Mentioned `my actions` incorrectly went through Q&A and addressed the prior speaker as you. Reproduced custom-display-name mention parsing failure in contract tests; repair uses bounded UTF-16 mention spans and explicitly passes the current caller to query analysis/answering. | Validate and stage the repair, then repeat caller-specific list and privacy controls on Wire |
| 2026-09-16 | Caller fix validated and staged | `2ba7a1f`: 222 tests and build/type-check/lint pass; immutable-image real-model regression 54/56, same two discrepancies; caller-switch answers inspected. Fresh stored-record evaluation 20/20/20, zero duplicates/markers, human review pending. Staging updated with readable backups and preserved volumes; connected without SDK errors. | Repeat caller-specific list and Q&A as @adamlow_wire, then continue remaining Wire journeys |
| 2026-09-16 | Wire caller repair confirmed | Operator screenshot on `2ba7a1f`: mentioned `my actions` and first-person responsibility Q&A both return Adam Low’s two open actions and correct ACT-0002 deadline. No prior-speaker confusion; post-restart round trip passes. Evidence is the live screenshot, not a fresh automated run. | Test ACT-0002 reassignment, deadline change and completion; remaining Wire and human acceptance stays pending |
| 2026-09-16 | Pasted reassignment formatting failure | Operator screenshot shows inline-code action prefix followed by a person mention and a misleading model explanation. Scoped DB inspection confirms ACT-0002 remains open, owned by Adam Low, version 1. Three formatted variants reproduce missed routing; plain text with person mention passes. Router now unwraps a leading single-line inline-code ACT command prefix; seven contract cases cover formatting and non-command boundaries. The new CLI journey also reproduced action-status questions being intercepted as channel status; channel status now requires an explicit command. The judge receives evaluation time for relative-date assertions; assertions are unchanged. | Real-model command journey and full release-image regression, then repeat Wire reassignment |
| 2026-09-16 | Formatted-action fix validated and staged | `a51a7af`: 233 tests, build/type-check/lint pass; real-model action journey and stored owner/deadline/status/audits pass. Immutable-image full regression 55/57: ambiguous-owner discrepancy and caller judge false negative; caller isolated rerun passes unchanged. Staging connected with preserved volumes and readable backups. | Repeat only ACT-0002 reassignment, inspect stored result, then continue deadline/completion and remaining Wire gates |
| 2026-09-16 | Wire formatted reassignment passed | Operator screenshot confirms ACT-0002 reassigned to Adam (Human) on `a51a7af`. Scoped DB inspection confirms qualified @adamhuman owner, version 2, open status, unchanged Friday deadline, and one reassignment audit event by Adam Low (two total events including creation). | Test deadline change and completion, then continue remaining Wire gates |
| 2026-09-17 | Wire deadline and completion passed | Operator screenshot confirms ACT-0002 deadline update and done acknowledgement. Scoped DB inspection verifies September 18 09:45:44.790 UTC, done status, version 4, retained @adamhuman owner and four audit events; both latest updates attributed to Adam Low. Core capture/list/reassign/deadline/complete action journey passes. Automated results above remain September 16 runs. | Test reminder creation and delivery next; unknown/ambiguous names and remaining Wire/human gates stay pending |
| 2026-09-17 | Reminder inline-code routing gap | Screenshot shows the pasted reminder command falling into Q&A; scoped DB query confirms no matching reminder exists. Earlier normalization covered ACT commands only. Twelve new routing/control cases fail before the fix; normalization now handles a leading single-line inline-code span before existing command matching, with prose/fence/multiline exclusions and real-mention privacy controls preserved. Build/type-check/lint and 248 tests pass; targeted real-model reminder create/list/snooze/cancel passes. | Inspect stored reminder/audits, run immutable-image full regression, update staging and repeat Wire creation/delivery |
| 2026-09-17 | Reminder formatting fix validated and staged | `f3b2eed`: 248 tests and build/type-check/lint pass; targeted stored reminder/audit inspection passes; immutable-image e2e 56/58 with the same two recorded discrepancies. Staging updated with readable backups and existing volumes; connected without SDK errors. | Repeat reminder creation and delivery on Wire; then cancellation, snooze and restart/downtime checks |
| 2026-09-17 | Wire reminder creation and delivery passed | Screenshot confirms REM-0001 delivered two minutes after creation on `f3b2eed`. Scoped DB verifies @adamhuman target, fired status, version 2, trigger 10:09:50.637 UTC and two audit entries; fired state saved at 10:09:50.755 UTC. Retry was plain text, so inline-code-specific Wire evidence is not claimed. | Test pending reminder recovery across restart, cancellation, snooze and overdue recovery |
| 2026-09-17 | Wire pending-reminder restart | Code-formatted creation of REM-0002 succeeds. Scoped DB shows pending, target @adamlow_wire, due 11:45:29.304 UTC. Same image restarted at 11:36:25.509 UTC with preserved volumes; startup rehydrated one reminder and reconnected without SDK errors. Record/due time unchanged after restart. | Confirm delivery and durable fired state after due time; overdue-during-downtime recovery remains separate |
| 2026-09-17 | Wire reminder delivery after restart passed | Operator screenshot confirms REM-0002 arrived at 12:45 UK time after the recorded restart. Scoped DB confirms fired status, version 2, original trigger, and two audit events including exactly one firing update; fired state saved 129 ms after due time. | Test cancellation, snooze and overdue-during-downtime recovery |
| 2026-09-17 | Cancellation/snooze prepared; combined-message gap observed | User screenshot shows two requests in one message falling into Q&A with misleading question guidance. Separate messages created REM-0003 and REM-0004; scoped DB confirms both pending, version 1, target @adamlow_wire, due 14:38:57.346 and 14:39:27.709 UTC. | Prioritise cancel/snooze as requested; return to bounded combined-command routing/guidance fix afterward |
| 2026-09-17 | Addressed assignment demo gap | Screenshot shows a named slide-deck assignment being treated as read-only Q&A; scoped DB confirms no slide/presentation action. Two routing cases reproduce the failure. A bounded @member-needs-to variant now calls the existing audited action use case, keeps the assignment deadline separate from preceding project context, and refuses questions/negation/hypotheticals/multiple assignments. Build/type-check/lint and 260 tests pass. REM-0003/4 had already fired; cancellation/snooze remain untested. | Validate stored assignment and full image regression, then retry the demo; keep combined-command and remaining Wire gates pending |
| 2026-09-17 | Named-assignment fix validated and staged | `17b8e42`: 260 tests, build/type-check/lint pass; targeted post-process inventory confirms one correctly owned/dated/audited action. Immutable-image e2e 56/59, new scenario passes; TC-ID-03 wording failure passes unchanged on single rerun and remains in full-run totals. Staging connected with preserved volumes, readable backups and zero SDK errors. | Retry the demo sentence; use fresh cancellation/snooze tests; combined-command and remaining acceptance gaps stay open |
| 2026-09-17 | Structured mention repair validated and staged | `ad01b3a`: 278 tests and build/type-check/lint pass. Immutable-image e2e 56/60; new demo and all action commands pass. Post-process DB confirms qualified owner, Friday deadline, one action/audit. Full run reveals a reproducible recorder/decider answer bug; preserved as an open gate. | Repeat the demo with the real person mention; fix attribution, review remaining failures and complete Wire/human gates |
| 2026-09-18 | Live mention, reminder mutations and overdue recovery | Operator reports tests 1–3 complete. Scoped records verify one correctly owned deck action and audited cancellation/snooze. REM-0007 remained pending past its deadline with the bot stopped, then sent successfully and became fired/version 2 with one firing audit after restart. Same image/volumes; zero startup SDK errors. | Confirm overdue reminder in Wire; observe cancelled reminder non-delivery and snoozed delivery at revised time; continue tests 5–8 and remaining code/human gates |
| 2026-09-18 | Wire decision correction lifecycle passed | Screenshot and qualified DB inspection verify supersede, current recall, revoke and no automatic revival; linked DEC-0003/4 states, versions and four audits match. Post-deadline reminder inspection also confirms cancelled REM-0005 has no firing audit and snoozed REM-0006 fired once at the revised time. | Continue passive capture/completion, channel isolation and privacy-state checks; confirm reminder UI receipt; retain separate attribution bug |
| 2026-09-18 | Silent Wire commitment captured | Post-processing DB/audit checks verify ACT-0005, qualified Adam Low owner/author, Friday deadline, exactly one action from the source and one creation audit. No acknowledgement was required or used as the score. | Test unmentioned completion as Adam Low and verify stored done status plus open-list removal |
| 2026-09-18 | Passive action reaction feedback implemented and staged | User-approved 📝/✅ post-write-and-audit reactions, combined outcomes, cancellation/dedup/failure tests and welcome explanation. `7384b39`: 296 tests/build/type-check/lint pass; real-model reaction lifecycle passes with stored-record/audit inspection. Fresh fixed sample 20/20/20, zero duplicates/markers, five capture reactions; simulation 57 events complete. Immutable-image e2e 57/60 with unchanged assertions; Friday judge discrepancies preserved, known attribution bug still visible despite passing verdict. Staging backed up and connected with zero SDK errors. | Verify 📝 and ✅ on new Wire messages; human review and other listed acceptance gates remain pending |
| 2026-09-18 | Wire reactions accepted; native replies implemented | Operator confirms 📝/✅; stored emoji checklist is done/version 2 with two audits. `4bc7e1f` quotes the exact source through SDK metadata and scopes/cleans it per handler; 304 tests/build/type-check/lint pass, immutable image built. | Staged with readable backups and zero SDK errors; operator screenshot verifies native quote and completed-action list removal. Full immutable-image regression 57/60, unchanged targeted author recheck passes; live two-message check pending |
| — | P3 pilot decision | Not started | Record usefulness, noise, latency and up to three next fixes |

## 6. Customer demo: Jira Service Management integration

This work lives on the `demo/jira` branch. It is a customer demo, not part of the pilot scope in §4, and merging it upstream is the owner's decision. The product is support requests: a team member raises a problem with the service desk from Wire and follows it from Wire. Actions stay internal to the bot. The dated subsections from "Jira replies in Wire" to "Second step: status and evidence" record the earlier build, which linked actions to tickets; its technical layer (adapter, replies, offers, sharing setting, guardrails) carries over, and the rework subsections below define the current product layer. The integration is off unless every required setting is present, so a deployment without Jira configuration behaves exactly as before.

### Demo story

A truck manufacturer offers the bot as premium support with its trucks. Drivers talk in an encrypted Wire channel; the bot turns their questions, fault reports and part orders into requests for the manufacturer's service desk, and nothing leaves Wire without a driver's yes. The demo runs with `WIRE_TEAM_BOT_JIRA_PASSIVE=on`, the request types mapped and the service scope set.

The presenter's script, with the exact lines to type, the Jira steps, talking points, limits and fallbacks, is [docs/DEMO-PLAYBOOK.md](docs/DEMO-PLAYBOOK.md). The demo shows what an app built with the Wire Apps SDK makes possible for this use case; it is not a product offer.

The message for security-minded customers: the conversation stays in Wire; only what a driver confirms is sent to the service desk. For defence customers, see the security note under "Truck premium support".

### Jira environment (verified 2026-09-25)

| Item | Value |
|---|---|
| Site | `wearezeta.atlassian.net`; REST base for scoped tokens `https://api.atlassian.com/ex/jira/3e94f30e-b591-4cbc-8802-f0362e732d38` |
| Project | DS "Demo Sandbox" (id `13383`), team-managed Jira Service Management, visible to all Wire Jira users, so demo data must be synthetic |
| Service desk / request type | service desk `184`; request type `11808` "Submit a request or incident" (issue type `11808`) |
| Required fields | summary, description; `duedate` added to the work type (date only, not on the customer request form) |
| Workflow | To Do, Start work (`81`), In progress, Resolved (`121`), Done (category `done`); In review leads to Pending; Reopened (`141`) leaves Done. A fresh ticket is two hops from Done |
| SLAs | Time to first response (4h) and Time to done (16h), business hours. Both stop on Done; recalculation lags the transition by a few seconds |
| Resolution | The Resolved transition sets no resolution value; accepted for the demo |
| Credential | service account `WireTeamBotDemo` with the Agent role in DS; scoped token with classic scopes `read:servicedesk-request`, `write:servicedesk-request`, `read:jira-work`, `write:jira-work`, `read:jira-user`; Bearer auth through the API gateway |
| Language | The account has no language preference; Node's default `Accept-Language: *` makes Jira answer in `zh_CN`. Requests send `Accept-Language: en-GB` |
| Probe ticket | DS-1, created and resolved to verify the workflow and SLA stop |

### Design

- **Port:** `src/application/ports/IssueTrackerPort.ts` (`createIssue`, `getIssue`, `resolveIssue`, `listCustomerReplies`, `addCustomerReply`, `projectKey`). Use cases never call Jira directly.
- **Adapter:** `src/infrastructure/jira/JiraServiceManagementAdapter.ts` using built-in `fetch`, no new dependency. It creates the request through `POST /rest/servicedeskapi/request` so it is a proper service request in the queues and SLAs, then sets the `wire-team-bot` label (and a due date, when one is given) with `PUT /rest/api/3/issue/{key}`, because the Service Management API only accepts fields on the customer form. A failed follow-up edit is reported, not hidden.
- **Resolving:** follow transitions by status category, never by name: prefer a `done` target, otherwise an in-progress one, at most three hops. Then poll the SLA endpoint briefly so the reply reports the stopped clock rather than a stale running one. If Done is not reached, report the actual state.
- **Records:** `SupportRequest` (`support_requests` table), keyed by the Jira key, with the qualified conversation and requester, the requester's display name, the summary and the last known status category. The description is sent to Jira and not stored. See "Rework contract" below.
- **Use cases:** `RaiseSupportRequest`, `ListSupportRequests`, `GetIssueStatus`, `ReplyToServiceDesk`, `ResolveSupportRequest` and `ConfirmOffer`, each resolving keys through `findSupportRequestInConversation`, so a key is accepted only for a support request raised in the same qualified conversation. Actions are never sent to Jira.
- **Concurrency:** an in-process guard per conversation and requester stops a double submit from creating two tickets (one bot process serves all conversations).
- **Commands:** `@Wire Team Bot support: <problem>`, `support requests`, `my support requests`, `status of DS-NN`, `@Wire Team Bot reply to DS-NN: <text>` and `@Wire Team Bot resolve DS-NN` (also `close DS-NN`). Writes need the bot to be addressed. Only keys of the configured project match, so other projects' keys and the bot's own record IDs keep their existing handling; the Jira forms, including the multi-command guard, apply only when the integration is configured.
- **Configuration:** `WIRE_TEAM_BOT_JIRA_BASE_URL`, `_SITE_URL`, `_API_TOKEN`, `_PROJECT_KEY`, `_SERVICE_DESK_ID`, `_REQUEST_TYPES` (request type per kind; `fault` required and used for unmapped kinds), optional `_EMAIL` (Basic auth with a classic token, for rehearsal only) and `_TIMEOUT_MS`. Partial configuration fails at startup.

### Guardrails

- Only an explicit, addressed command or a confirmed offer writes to Jira. Passive extraction and the read-only Q&A path never write to it.
- A new request carries the summary, the description the requester gave and `Requested by <display name> via Wire.`, never surrounding messages.
- A Jira key is accepted only if it belongs to the configured project and is a support request of the same qualified conversation, so one channel cannot read or change another channel's requests.
- Jira status names are never shown in Wire; replies use English labels derived from the status category.
- Response bodies, reply texts, descriptions and credentials are never logged. Failures are logged with the error name and status only, and the reply says what did and did not happen.
- Every write is audited through `AuditLogRepository` with the key and the actor, including a failed resolve attempt, since some transitions may already have been applied.

### Jira replies in Wire (on request)

Requested 2026-09-25: show service-desk replies from Jira in Wire. Decisions: replies appear only when asked, as part of `status of DS-NN` and `jira status of ACT-NNNN`; nothing polls Jira or posts unprompted. Only customer-facing replies are shown. Internal agent notes stay in Jira.

- **Why the filter must be client-side:** the service account is an agent, and the Service Management API returns internal notes as well as public replies to agents. The adapter requests public comments and still keeps only comments whose `public` flag is exactly `true`, so a missing or changed flag can never expose an internal note.
- **Port:** `listCustomerReplies(key, limit)` returns the newest replies, oldest first, with author display name, creation time and plain-text body. The adapter reads `GET /rest/servicedeskapi/request/{key}/comment` (scope `read:servicedesk-request`, already granted), follows a bounded number of pages, and sorts by creation time because the order is not documented.
- **Display:** the status reply adds up to three latest replies, each quoted with author and time in the conversation's timezone, and long bodies cut visibly. "No replies from the service desk yet." when there are none. A failed comment read leaves the status intact and says the replies could not be loaded.
- **Guardrails:** the existing project and conversation scoping applies unchanged. Reply text is shown in Wire only; it is never stored, logged or passed to a model.
- **Acceptance:** unit tests for the public filter (including a missing flag), paging, ordering, truncation and failure; a live check on a DS ticket carrying one customer reply and one internal note, where only the reply appears.

### Conversational Jira, first step

Found on 2026-09-25 in the Wire staging session: "whats the status of DS-4" and "whats the status of DS-4 in jira" fell through to Q&A, which said it had no record of DS-4 and could not query Jira; asked to put an action into Jira, it denied the integration and suggested logging a new action.

- **Natural status questions:** `matchIssueStatusRequest` keeps the exact commands and, only when the bot is addressed, also accepts natural phrasing that names exactly one key of the configured project (or one action ID with "jira" or "ticket") with a status word or a question mark. Change requests ("close", "mark", "reply to", "raise") are left to Q&A, so the read-only lookup never answers them.
- **Integration awareness:** when Jira is configured, the answer model's system prompt states the integration and its commands, forbids denying it, and forbids stating or guessing a ticket's status. Retrieved actions show their linked key as `Jira: DS-NN`. No ticket content, status or reply reaches the model; the answer path stays read-only.
- **Evidence:** 569 tests pass. Real-model CLI check: the natural question returned the live DS-2 status and replies; "can you put the questionnaire action into Jira?" answered that ACT-0005 is already linked to DS-2 and gave `status of DS-2`; asking by name found the link without guessing its status; "what can you do with Jira?" listed the commands.
- **Next options:** now being built, see the second step below. They were: give the answer model live ticket status and customer replies (decided below); confirmed conversational writes ("Shall I raise ACT-0010 in Jira?", then yes, running the existing audited use case after code validates the ID and scope); resolving names and "it" to records within the channel; and replying to the service desk from Wire.

### Decision: ticket content and the answer model (2026-09-25)

For the customer demo, the answer model may receive live ticket status, SLAs and customer-facing replies from linked tickets, so it can answer questions such as "what's the latest on the proposal?" itself. Internal agent notes remain excluded under every setting.

This is a demo decision, not a production one. With a remote model provider (the demo uses the Claude API), ticket content and customer replies leave the deployment and are processed by that provider. Service-desk replies can contain customer details, contract terms or security information, so for production this is probably not a good choice. The Wire encryption story also does not cover it: Wire protects the conversation, but the content is sent on to the model provider.

Requirements when this is built:

- Sharing ticket content with the model is a separate, explicit setting (for example `WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL`), off by default. Enabling the Jira integration alone never sends ticket content to a model; without the setting, the current behaviour (ticket key only) stays.
- README documents the setting next to the model configuration and states plainly that, with a remote provider, ticket status and customer replies are sent to that provider.
- For production, prefer a local model endpoint when the setting is on, or leave it off and keep the command-based lookups, which show ticket content in Wire without passing it to a model.
- Revisit this decision before any production or customer-hosted deployment, together with the provider's data-handling terms and the customer's own policy.

### Conversational Jira, second step

Requested 2026-09-25: build the recorded next options. Resolving names and "it" is covered by the offers below: the model proposes a record ID from the channel's records, code validates it, and a person confirms.

**A. Live ticket data for the answer model.** Only with `WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL=on` (default off; see the decision above). For actions in the retrieval results that are linked to a ticket in the configured project, and for ticket keys named in the question that are linked from this conversation, `AnswerQuestion` fetches status, SLAs and up to three customer replies and passes them as `jira_ticket` results under a "Linked Jira tickets" heading. Internal notes never appear, because the adapter excludes them. Without the setting, the model sees ticket keys only, as today. Ticket content is never stored or logged.

**B. Confirmed actions from plain language.** When the requester asks the bot to raise an action in Jira, close an action and its ticket, or send a reply to a linked ticket, the answer model may end its answer with one machine-readable line, `OFFER: {"kind":"raise","actionId":"ACT-0010"}` (kinds `raise`, `close`, `reply`). Code, not the model, then:
- parses and strips the line (`parseOfferMarker`), so a raw marker is never shown;
- validates it: the action exists in this qualified conversation and is not deleted; `raise` needs an open, unlinked action; `close` needs an action that is not done and is linked to a ticket in the project; `reply` needs a project key linked from this conversation and a non-empty body within the length limit. Anything invalid is dropped;
- writes the question itself from the validated data, for example `Shall I raise **ACT-0010** "Write the customer proposal" in Jira? Reply yes or no.`, and stores the offer for that requester in that conversation for ten minutes. The offer applies only to the requester's next message: anything other than yes or no drops it, so a later "yes" meant for a different question cannot confirm it.

A later `yes` from the same requester runs the existing audited use case (`PushActionToJira`, `UpdateActionStatus` to done, or `ReplyToServiceDesk`), which re-checks scope and state at that moment. `no` cancels. The router checks for a pending offer before its existing follow-up handling, which would otherwise send the `yes` to the read-only Q&A path. Offers are in memory, one per requester per conversation, and are cleared when the channel is paused or put in secure mode. The model never performs or claims a write.

**C. Replying to the service desk from Wire.** `reply to DS-NN: <text>` or `reply to ACT-NNNN: <text>` sends a customer-facing reply (a public comment through the Service Management API) to a ticket linked from this conversation, with the footer `Sent from Wire (ACT-NNNN).` and no requester name, and audits it. The same is available as a confirmed offer. In `status of`, replies sent by the bot's service account are labelled "Your team (via Wire)".

**Work split.** Main session: this contract (setting, port additions, offer types and marker parser, `jira_ticket` result type), then router integration (offer confirmation before follow-ups, the reply command, clearing offers on pause and secure, multi-command guard), wiring and docs. Three subagents in parallel worktrees: the answer side (A and offer creation in `AnswerQuestion` and the answer adapter), the action side (offer store, `ConfirmOffer`, `ReplyToServiceDesk`, reply labelling), and the adapter (`addCustomerReply`, identifying the bot's own replies). Then an independent review and live checks; writes to DS need operator approval.

**Acceptance.** Unit tests for each part, including: the setting off sends no ticket content; invalid, cross-conversation, deleted, already-linked or out-of-project offers are dropped; a `yes` from another member, an expired offer, or after pause does nothing; confirmation re-validates state; replies carry no requester name; the bot's own replies are labelled. Real-model CLI checks for offers and ticket-aware answers. A live DS check of one reply sent from Wire, with approval.

### Second step: status and evidence (2026-09-25)

Built by three parallel subagents (answer side, action side, adapter) on the main session's contract, integrated and reviewed. The independent review found ten issues and all are fixed. Refinements to the design above, as built:

- **Commands:** `reply to DS-NN: <text>` and `reply to ACT-NNNN: <text>` require the bot to be addressed, because they post customer-visible comments.
- **Offers:** accepted only when the requester's question itself asks for that change (so an offer injected through ticket text on an unrelated question is dropped), stored only after the question is sent, and phrased by code ending "(yes or no)?". The model's own lead-in is never sent with an offer. Reply offers are dropped if the body contains the requester's name, and offer questions carry no mentions. Close offers reject done and cancelled actions and are re-checked at confirmation.
- **Confirmations:** only explicit forms count (yes, yes please, yep, yeah, go ahead, do it, please do, confirm, confirmed; no, nope, cancel, don't, stop). A bare acknowledgement such as "ok thanks" does not confirm: the bot asks again and keeps the offer. Any other message from the requester drops the offer, including a rejected multi-command message. The requester's yes or no is recorded in the conversation memory so the model sees the offer as closed.
- **Replies:** a failure that may have reached Jira (timeout, network, 5xx) says the bot could not confirm delivery and asks the requester to check the ticket, to avoid a duplicate public reply; an audit failure after a successful send is logged, not reported as a failed send. Replies sent by the service account are labelled "Your team (via Wire)".
- **Ticket data for the model:** only for Jira-related questions; keys come from questions and retrieved records, and every key is confirmed with an exact link query for this conversation, so a key written into an action description cannot pull another channel's ticket. `/myself` is looked up once per process.
- **Marker parsing:** a marker spread over several lines is parsed and hidden; raw JSON is never shown.
- **Evidence:** 843 tests pass, type-check and lint clean. Real-model CLI checks with sharing off and on: raise and reply offers phrased correctly and cancelled with no; "ok thanks" re-asked without writing; an unrelated question answered without ticket lookups; ticket status answered from live data only with sharing on; audit log shows no Jira writes from these checks. Pending: live Wire check of one service-desk reply and one confirmed raise, with operator approval.

### Open items

- **Per-channel timezone: built 2026-09-26** (`@Wire Team Bot timezone <name>`, `WIRE_TEAM_BOT_DEFAULT_TIMEZONE`, zone labels on displayed times; see "Resolve with a closing comment, and the channel timezone").
- **Applied manually for the demo (2026-09-25):** the staging channel's `channel_config.timezone` was set to `Europe/Berlin` with a one-row SQL update and the bot restarted. The CLI test channel stays `UTC`. Revert with the same update to `'UTC'`.
- **Typing indicator while the model works: waiting for the SDK.** The operator wants the bot to show "typing" in the channel during model calls (useful with the slow local model). `@wireapp/wire-apps-js-sdk` 0.1.0, the latest release (checked 2026-09-27; `main` has no such change either), only receives typing events and has no call to send one; the backend endpoint is reachable only through the SDK's internal client, so it is not built. Build it once the SDK offers a send call, for addressed questions and support commands. A ⏳ reaction on the question while the bot works was offered as an interim alternative and deferred.
- **Files in Wire Cells conversations: waiting for the SDK.** SDK 0.1.0 cannot read multipart (Cells) file messages or download from Cells (checked 2026-09-28), so photos and documents are offered only in conversations without Cells. Raise with the SDK team together with the typing indicator.

### Out of scope for the demo

Choosing among several done-category transitions (the adapter takes the first; DS has only Resolved, but some workflows also offer a done-category Canceled), raising on behalf of the Wire user (mapping Wire users to Jira accounts by email), attachments, request types other than the configured one, Jira-to-Wire updates by webhook (polling is planned, see "Jira updates in Wire by polling"), and per-channel opt-in. Each is a production step, not needed for the four-beat story.

### Work breakdown and status

The first seven rows record the earlier action-linked build; the rework rows follow.

| Item | Owner | Status |
|---|---|---|
| Contract: port, link helpers, configuration and tests | main session | done |
| Jira adapter and tests with mocked responses modelled on the verified API shapes | subagent | done: 25 tests |
| Use cases and tests with mocked ports | subagent | done: 59 tests |
| Router commands, multi-command detection, container and CLI wiring, contract tests | main session | done: 15 routing tests; full suite 504 passed, type-check and lint clean |
| Independent review of the complete branch | subagent | done: 10 findings, all fixed (stale write-back and duplicate tickets on concurrent pushes, unconfigured-routing regressions, requester name in tickets, blocking `done` reply, unlogged close failures, capped link lookup, repeat-close claims, project check on the ACT path, duplicated helpers) |
| Live run, CLI stage (2026-09-25, macOS arm64, Node 26.8.2, service-account token) | main session | passed: `ACT-0005 to jira` created DS-2 in 3s; Jira shows reporter WireTeamBotDemo, description with only the action's fields and no requester name, due date 2026-09-25 and the `wire-team-bot` label; `status of DS-2` returned English labels and running SLAs; `status of DS-1` was refused as unlinked; `ACT-0005 done` confirmed first, then closed DS-2 with both SLAs met. Summary capitalisation and "under a minute" wording added afterwards |
| Live run, Wire stage (2026-09-25, staging bot on `34e580a`) | operator and main session | passed: in the staging channel ACT-0008 was raised as DS-3 and closed from Wire. Jira shows summary "Prepare the security questionnaire", reporter WireTeamBotDemo, due date 2026-09-29, the `wire-team-bot` label, Done, and both SLAs met in 41s. The audit log holds the ticket creation, the action link and the close. The Wire confirmation went out 6s before the Jira close follow-up. An unmentioned `status of WPB-1234` reached only the passive pipeline and got no reply. Zero errors in the bot log. Evidence is the database, Jira and log inspection; the Wire client display is the operator's observation |
| Rework contract: entity, repository, migration, offer kinds, scope helper (`976f1c5`) | main session | done |
| Rework persistence: Prisma repository, integration test | subagent | done; migration and 5 integration tests passed on a throwaway database (created by the local Postgres owner with `vector` pre-installed, since `wirebot` cannot create databases or the extension), then dropped; no drift for `support_requests` |
| Rework use cases: raise, list, status, reply, resolve, ConfirmOffer | subagent | done |
| Rework answer side: support-request context, offers, prompt | subagent | done |
| Rework router, removals, status line, wiring, docs | main session | done |
| Independent review of the rework | subagent | done: 1 high (hidden model-written description on a confirmed raise, loose raise intent), 4 medium (reopened requests read as resolved, create timeout reported as not raised, unaudited uncertain writes, stale plan), low items; all fixed. Full suite 908 passed, type-check and lint clean |
| Rework real-model CLI checks (2026-09-26, macOS arm64, CLI channel, sharing on and off) | main session | passed: plain-language raise offers show summary and full description and are declined with no; "ok thanks" re-asks; "any news on my ticket?" makes no offer; `support requests` and `my support requests` list; DS-2 and DS-3 are refused as not support requests of the channel; `ACT-0005 to jira` no longer routes; `status` shows "Open support requests". One direct `support:` line in a check script created **DS-6** without the operator's prior approval (synthetic text; reporter WireTeamBotDemo, label `wire-team-bot`, description ending "Requested by Alice via Wire.", stored with an `entity_created` audit entry). It confirms the live raise path; DS-6 is left for the operator to decide on. Plain-language reply and resolve are not yet checked |
| Rework live journey on Wire staging and DS (2026-09-26, staging bot on `aa70f59`, sharing on) | operator and main session | passed with UX findings: DS-7 raised by command and DS-8 by confirmed offer (description with the requester line), `support requests` and `my support requests` listed both, `status of DS-7` showed SLAs and later the desk's public reply, `status of DS-6` was refused as another channel's request, one reply by command and one by confirmed offer reached Jira, both requests resolved with SLAs met. Reopened check: DS-7 reopened in Jira (transition 141), `support requests` showed it again as In progress (refresh audited under the bot) and `resolve DS-7` resolved it again. Audit log complete; zero errors in the bot log. Findings, see "Passive service-desk help": the model claimed "Updated with that detail." and "Sending the comment first" when code had dropped its offer; correcting a pending offer's description dropped it and the following yes got no reply; closing with a comment needed two steps; unmentioned natural phrasing got silence; the mention rules were hard to predict |
| Passive help contract (`2146b78`), router mention rule and dropped-offer plumbing (`a055e54`), docs (`8983604`) | main session | done |
| Passive help step 1: never claim a dropped offer, amending, yes with nothing waiting | subagent | done |
| Passive help step 2: classifier option, triage adapter, `OfferSupportFromConversation`, pipeline hook | subagent | done |
| Passive help integration (`7020cd5`): wiring; a message that displaces a support or reply offer goes to the answer path, so a passive offer can be corrected | main session | done: 1018 tests pass, type-check and lint clean |
| Passive help simulation replay (2026-09-26, `npm run simulate`, `WIRE_TEAM_BOT_JIRA_PASSIVE=on`, real models, isolated evaluation channel) | main session | 57 synthetic planning messages: no passive offers and no unsolicited messages; 10 records captured, no duplicates, no errors. The fixture contains no service-desk problems, so it shows the absence of false offers in ordinary chat, not the rate of missed offers. No earlier report is tracked for comparison |
| Passive help real-model CLI check (2026-09-26, CLI channel, no confirmations) | main session | unmentioned "the projector in room 3 shows no signal…" and "my password expired and the reset link just gives an error page" got code-written offers with summary and full description; "has anyone heard back about the laptop battery problem?" got the live status of DS-6; "ship the release on Friday" got nothing; a repeat of the DS-6 problem got no offer (duplicate). The CLI reads all input at once, so the following "no" lines arrived before the offers were stored and got no reply; the Wire check covers answering |
| Independent review of passive help (two parallel reviews after a first attempt stalled) | subagents | done: no path to a Jira write without an explicit yes. Fixed: an offer stored after a pause during its send; the classifier prompt now says the service-desk categories come in addition to blocker, action and the others; unaddressed chat after an offer brought the offer back each time (such a message now gets no reply unless it truly revises the offer, and otherwise continues to capture); "nothing waiting for your yes" could answer a yes meant for a colleague (the memory is now forgotten after one answer or the requester's next other message); the prompt showed `status of` without the mention. Accepted as known: a dropped marker replaces the whole model answer, so an unrelated question that also drew an invalid offer loses its answer; the passive status path cannot stop a status reply once the Jira read has started. 1026 tests pass |
| Passive help capture comparison (2026-09-26, `npm run simulate` twice on `ca7296b`, real models) | main session | passive off: 13 records (8 actions, 5 decisions); passive on: 14 records (the same 8 actions, 6 decisions); 1 unsolicited message in both runs, none from passive help; no duplicates, no errors. No capture regression; the one extra decision is within run-to-run variance (an earlier run captured 10) |
| Passive help live check (2026-09-26, staging bot on `8a49147`, `WIRE_TEAM_BOT_JIRA_PASSIVE=on`) | operator and main session | mostly passed: an unmentioned Wi-Fi problem got an offer and yes raised DS-9 (then resolved with a mentioned `close DS-9`; the unmentioned form stayed silent); a repeat with a correction got a revised offer ("only on the 3rd floor") and yes raised DS-10; unmentioned lunch chat after the printer offer got no reply and the following yes got "nothing waiting"; "has anyone heard back about the Wi-Fi problem?" got DS-10's live status (DS-9 already done); two repeats of the Wi-Fi problem got no offer; unmentioned `support requests` stayed silent and the mentioned form listed DS-10. Audit log complete. Failure: right after the DS-10 confirmation, "the printer on floor 2 is out of toner" got "I haven't changed anything" because the answered offer question still counted as the bot's latest question (follow-up routing) and the model's support offer lacked raising wording. Fixed: a handled offer answer is recorded with a bot entry, and with passive help on a model support offer needs no raising wording (`9eac494`; the operator confirmed on staging that the printer message now gets an offer). A correction sent after the request was already raised ("it only happens on the 3rd floor" after DS-9) got no reply; see "Adding to an open request" |
| Adding to an open request: contract (`868bcd6`), build (subagent), integration (`d1f28cf`) | main session and subagent | done |
| Adding to an open request: real-model CLI check (2026-09-26, CLI channel, no confirmations) | main session | first run: unmentioned additions got no offer because the classifier labelled them `update` only; fixed (`1f3f1d8`): updates and blockers may add to an open request (never raise a new one), only when the channel has open requests. Rerun: "the laptop battery drain only happens on the new ThinkPads" and "…happens even when the lid is closed" got "Shall I add this to **DS-6** …?" with the detail; "the laptop battery still drains overnight" got an addition offer ("still occurring", by design); "we should order more coffee" got nothing; mentioned "add a comment on DS-6 that it started after the BIOS update" got the reply offer; "any update on DS-6?" and "did anyone update DS-6?" got the live status, not a reply offer |
| Independent review of adding to an open request | subagent | done: no path to a Jira write without the speaker's yes. Fixed (`7a9d80f`): an addition was discarded when the model left the summary empty (exactly the "it only happens on the 3rd floor" case); add/comment/note/update counted status questions ("did anyone update DS-6?") as reply intent, now only instructions at the start of the message count, including "leave a note" and "post a comment"; every recent request of the speaker was marked instead of the newest; test gaps. Accepted as known: the addition is lightly rephrased ("it" resolved to the problem) and always shown in full; an unmentioned correction to a passive offer goes to the answer model with the recent conversation; with passive help on, updates and blockers wait for the open-request read (and a triage call when requests are open) before extraction. 1076 tests pass |
| Adding to an open request: live check (2026-09-26, staging bot on `623a771`, passive help on) | operator and main session | passed: unmentioned "it only happens on the 3rd floor" (no subject, DS-10 raised by the speaker within the hour) got "Shall I add this to **DS-10** …? > It only happens on the 3rd floor."; yes sent it; "the wifi dropped again just now" got an addition offer and yes sent it; mentioned "leave a note on DS-10 that the 2nd floor is fine" got the reply offer and no declined it; mentioned "did anyone update DS-10" got the live status listing both replies as "Your team (via Wire)". Jira shows exactly the two public comments ending "Sent from Wire." by the service account; two audit entries; no errors in the bot log |
| Truck premium support: contract (`da9d8d6`), passive side and answer side (two subagents), wiring (`56f068c`, `c701554`), `kind` column applied to the local database | main session and subagents | done |
| Truck premium support: real-model CLI check (2026-09-26, CLI channel, request types and scope set) | main session | mentioned "we need a new left mirror for truck 7" got "To order it I need the quantity and the delivery location. What are they?", the answer filled the draft and the offer showed Vehicle, Part, Quantity and Deliver to; unmentioned brake warning light got "Shall I report this to the service desk?", "truck 17 is due for its 60,000 km service" now got a fault offer, the AdBlue question got "Shall I ask the service desk?", a trip report got nothing. A `yes` line in the check script confirmed the complete part order and created **DS-12** without the operator's prior approval (synthetic; request type Replacement part `11810`, description with the four detail lines, kind `part` stored and audited); it confirms the part path end to end and is left for the operator. The question's description read "The speaker asks …", fixed in the triage prompt |
| Independent review of truck premium support | subagent | done: no high findings; a yes never raises an incomplete part order and the classifier prompt with the option off is unchanged. Fixed: a numeric quantity from the answer model was discarded and asked for again; "order brake pads for truck 17" and "can you order it?" failed the support intent without passive help; the kind was matched case-sensitively; a revision could switch a part order to a fault; details given earlier were not merged across amendments; truck wording in the triage prompt without the scope setting; duplicate or malformed request-type entries were accepted; the integration test now round-trips `kind: part` (run on a throwaway database: 6 passed). Accepted as known: non-English order wording relies on passive help or an explicit mention with raising wording; essentials not being invented depends on the prompt and on the full text shown before the yes. 1168 tests pass |
| Truck premium support: live journey (2026-09-26, staging bot on `bd0dbed`, passive help, request types `question=11809,part=11810,fault=11808` and the truck scope set) | operator and main session | passed: unmentioned brake warning light → "Shall I report this to the service desk?", yes raised DS-13 (Submit a request or incident); "we need a new left mirror for truck 7" → the bot asked for quantity and delivery location, the answer completed the draft, yes raised DS-14 (Replacement part) with the four detail lines at the top of the description; the AdBlue question → "Shall I ask the service desk?", yes raised DS-15 (Ask a question) with the driver's own words; "it only happens when the trailer is attached" was added to DS-13 as a public comment. Kinds stored and audited (fault, part, question); no errors in the bot log |
| Resolve with a closing comment and the channel timezone: plan (`cdbc168`), contract (`2b0da3e`), two builders, router and wiring (`a9c0003`, `c967e65`) | main session and subagents | done: 1239 tests pass |
| Resolve with a comment and timezone: real-model CLI check (2026-09-26, CLI channel, no confirmations, script grepped for write lines) | main session | `timezone` showed UTC with the local time; `timezone europe/berlin` set Europe/Berlin ("currently 19:01 CEST"); `timezone Mars/Olympus` was refused; `status` listed the timezone; "please close DS-12 and add a comment that it was fitted at depot north" got "Shall I resolve **DS-12** … and add this comment? > The mirror was fitted today at depot north." and no declined it; the channel was set back to UTC. Both changes audited as `config_changed` with from and to; DS-12 untouched |
| Independent review of resolve with a comment and timezone | subagent | done: no high findings; nothing resolves after a failed comment and no comment reaches Jira without an addressed command or the right yes. Medium: the timezone save rewrote the whole channel config and could undo a concurrent pause or secure; an empty comment dropped a plain resolve offer; reply times reached the answer model in UTC without a zone. Low: action-list deadlines as UTC dates, mixed defaults for channels without a config row, lower-case abbreviations and fixed offsets accepted as zones, an audit failure swallowed the confirmation, few timezone phrasings, "already resolved" silent about the comment, no comment on a pending plain resolve offer, stale docs. All fixed (`049b436`): the timezone is saved with a column-only update (checked on a throwaway database: a secure channel kept its state, secure range and purpose), an empty comment counts as none, the answer model gets reply times and the channel timezone, action lists show deadline dates in the channel zone, the configured default applies wherever a channel has no row, abbreviations in any case, fixed offsets and `Etc/` zones are rejected, an audit failure no longer swallows the confirmation, more timezone phrasings are recognised (and "timezone differences?" is left to Q&A), "already resolved" says the comment was not added, and any pending resolve offer can take a comment. Catch-up periods are labelled UTC. 1279 tests pass |
| Resolve with a comment and timezone: live check (2026-09-26, staging bot on `78038fa`) | operator and main session | passed with one gap: `timezone` showed Europe/Berlin (19:42 CEST); "change the timezone to America/New_York" set it (13:48 GMT-4); `timezone: Europe/Berlin` set it back (both audited with from and to); `resolve DS-11: The laptop was replaced today.` added the comment at 19:48:59 and then resolved DS-11 (audit: comment 17:49:00, resolve 17:49:05); `status of DS-11` showed Done and the comment as "Your team (via Wire), 26 Sept, 19:48 CEST". Gap: "the mirror for truck 7 was delivered, please close DS-14 and add a comment that it arrived at depot north", sent without a mention, reached passive help, which can only raise or add: it offered only the addition (confirmed; the comment is on DS-14) and silently ignored "close". Unmentioned "close DS-14" and "please close DS-14 in Jira" stayed silent (mention rule); the mentioned `close DS-14` resolved it. No errors in the bot log |
| Passive resolve offers: plan and contract (`0c71b5f`), build (subagent), merge (`adc256c`) | main session and subagent | done |
| Passive resolve offers: real-model CLI check (2026-09-26, CLI channel, no confirmations, script grepped for write lines) | main session | "the new mirror for truck 7 was fitted today, you can close that one and note it went in at depot north" (no key named) got "Shall I resolve **DS-12** … and add this comment? > The new mirror was fitted today at depot north."; "the laptop battery problem is fixed now, please close DS-6" got the resolve offer without a comment; "good news, everything works again" got nothing; an `action:` command still created its action. Nothing written |
| Independent review of passive resolve offers | subagent | done: no high findings. Fixed: a close request for a request that is not open here (done, another channel, invented) could fall through to an offer to raise a new request, now no offer at all (adapter and use case); an over-long closing comment was dropped silently and a plain resolve offered, now no offer; stale test titles. Accepted as known: whether good news means one request is decided by the prompt (the yes is still required); action and decision messages cost a triage call in channels with open requests; "please close DS-14" may also be captured as an action item. 1313 tests pass |
| Passive resolve offers: live check (2026-09-26, staging bot on `e9d7b95`) | operator and main session | passed: unmentioned "the brake light on truck 12 is fine now, the workshop replaced a sensor, please close it" got "Shall I resolve **DS-13** … and add this comment? > The workshop replaced a sensor."; yes added the comment (20:03:21) and resolved DS-13; "good news, everything works again" (classified routine) got nothing; "close DS-14" (already resolved) got nothing and no new-request offer; "the AdBlue question is solved, I found it in the manual" got a resolve offer for DS-15 with the comment, which the operator confirmed. Jira shows both requests Done with their comments; audit complete; no errors in the bot log |
| Local model trial (2026-09-26, macOS, Ollama 0.34.4, Qwen3.5-4B Q4_K_M GGUF registered as `qwen3.5-4b` with a 16k context, all chat slots local, CLI channel, no confirmations) | operator and main session | Qwen 3.5 is a thinking model: through the OpenAI-compatible endpoint it spent the whole token budget on reasoning and returned empty content. Added `WIRE_TEAM_BOT_LLM_REASONING_EFFORT` (`602d6c9`, sent as `reasoning_effort`; unset leaves requests unchanged); with `none` the classifier answered in 13 tokens. Bot run fully local: the brake warning light got the fault offer, the AdBlue question the question offer, a trip report nothing, and a mentioned "what support requests are open?" a correct list of DS-12 and DS-6 with kind, status and SLAs; 41 s for four messages including passive triage; no warnings. Jira Cloud remains external; for a defence deployment the tracker would also need to be hosted by the customer |
| Part orders completed in code and no double capture: plan and contract (`64a7339`), router hook and wiring (`10194b2`), build (subagent), merge (`8f9b405`); corrections of complete part orders also in code (`cbafb4b`) | main session and subagent | done |
| Part completion and capture skip: CLI check on the local model (2026-09-26, `qwen3.5-4b`, no confirmations, scripts grepped for write lines) | main session | "@bot we need a new air filter for truck 3" → "To order it I need the delivery location"; "deliver to depot south" completed the draft in code and showed the full offer; "actually we need two of them" corrected the quantity to two in code; no declined. A passive fault offer ("the tyre pressure warning on truck 5 keeps coming on") left the action count unchanged (3 before and after). Model variance seen: in one run the local model answered a new part order with command advice instead of an offer, and passive help then matched the follow-up to the wrong request |
| Independent review of part completion and the capture skip | subagent | done: no high findings; nothing reaches Jira incomplete or without the full offer and a yes. Fixed: messages that address the bot (commands, questions) no longer go to the completion; a change to an earlier value while the order is still incomplete is shown ("So far:" lines); placeholder values ("unknown", "not stated", "N/A") are ignored; vehicle, part and delivery location must appear in the message; the extraction's token limit was raised; a bot entry is recorded after completion. A pause cannot land during the completion: the router handles a channel's messages one at a time (`onTextMessageReceived`), so the pause is processed after it. Accepted as known: a message that got a passive addition, resolve or status answer is not captured even if the offer is declined. 1365 tests pass |
| Independent review of Jira updates by polling | subagent | done: nothing posts to the wrong conversation, announces internal notes or logs reply text; every marker write is scoped to the message's conversation; the quote hash matches the SDK's computation. Fixed: one deleted or invisible key made Jira reject every change search (a rejected batch is now split and the key left out); a resolve from Wire could be announced as the desk's during the SLA re-reads (shared write guard, and every status change is confirmed with a live read); a pause, secure or the older secret-mode flag during the reads could still get a post (checked again before sending); changes that reached Jira's search late or fell into a clock difference were lost (two-minute overlap); the first check announced old status changes (status baselined too); a reply `status of` just showed could be repeated (record re-read); shutdown did not wait for a running check. Accepted as known: a quote may not verify when the backend's time falls in the next second; in a conversation with a self-deleting timer the stored reference cannot be quoted; a send that times out after delivery is repeated at the next check; at most 500 requests are watched. 1483 tests pass |
| Read-only change check against DS (2026-09-26, `20e4489`, bot's scoped token from `.env`, adapter `listChangedSince`) | main session | passed: DS-1 to DS-20 plus the unknown DS-9999 returned the 20 existing tickets with categories matching the handover state; with a three-hour bound only DS-19 and DS-20. The unknown key was left out without a 400, so `/search/jql` does not reject unknown keys; the batch split stays as a safeguard. No writes |
| Jira updates live check (2026-09-27, staging bot on `7669b22`, local model, `WIRE_TEAM_BOT_JIRA_WATCH_SECONDS=30`, operator as desk agent) | operator and main session | passed: migration `20260926200000_add_support_request_watch_markers` applied to `wire_team_bot`; the first check baselined all 16 watched requests silently. On DS-21: after `status of`, a public desk reply, In progress, resolve in Jira and reopen each arrived as one update, each a Wire reply quoting the previous bot message about DS-21 (quotes shown normally, not as unverifiable); an internal note was not announced. `resolve DS-20` from Wire got only its confirmation, audited once under the member, with no watch announcement. Audit log and markers consistent; no warnings or errors. Finding: every SLA line said "met in under a minute" because the DS SLAs ran on a working-hours calendar and the tickets lived outside it (Jira reported 0 ms, `withinCalendarHours: false`), and the bot words Jira's "0m" as "under a minute". The operator switched both DS SLAs to a 24/7 calendar; running cycles now show wall-clock times, completed cycles keep 0m, and open requests without a desk reply show first-response breaches |
| Attachment upload check against DS (2026-09-28, operator-approved write, `5c95589`, bot's scoped token) | main session | passed: `addCustomerAttachment` attached a synthetic 1x1 PNG to DS-24 through `attachTemporaryFile` and the request attachment call; the public reply is recognised as the bot's own (`fromThisBot`), so the watch does not echo it. Jira appends the attachment as `!test-photo.png|thumbnail!` after the comment text, so reply formatting must not show that markup |
| Independent review of photos and documents to the service desk | subagent | done: no path sends a file without the poster's yes, to another conversation's request, from a self-deleting message or in a paused or secure channel; the answer path can neither see nor amend an attach offer. Fixed: an upload event without the preview part would have read as an empty unknown file and never been offered (preview details merged in, with the preview's time for the quote); a second file stayed silent and a yes attached the first (a new file replaces the sender's file offer; a pending question is answered first); a passive offer stored while the file offer was sent could be overwritten (re-checked before storing); a hung download could hold the channel's queue (30 s timeout); a dropped or expired attach offer kept the download key material in memory (stripped when remembered, expired offers cleared on every access); uploads now allow 60 s; bidirectional and invisible characters are removed from file names, which are capped at 255 characters and shown as plain text; the comment ends with "Sent from Wire."; Jira's attachment markup reads as "(attachment: name)" in `status of`; a yes with attachments not wired gets a reply. Accepted as known: the posted size is the sender's claim and the SDK downloads the whole file before the size is checked; an offer stamps its request as the latest, so a wrong guess answered no stays the target for the next file; a failed first upload step is reported as unconfirmed although nothing was attached. 1648 tests pass |
| Part completion and capture skip: live check on the local model (2026-09-26, staging bot on `d5eab8a`, `qwen3.5-4b`) | operator and main session | passed: "we need a new air filter for truck 3" → "To order it I need the delivery location"; "deliver to depot south" completed the draft in code and showed the full offer; "actually we need two of them" corrected the quantity; yes raised DS-19 (Replacement part, Quantity: two, Deliver to: depot south). "the tyre pressure warning on truck 5 keeps coming on" got the fault offer and yes raised DS-20 (Submit a request or incident). No action was captured for either message (the only recent action is ACT-0035 from the earlier run); no errors in the bot log |

### Acceptance

- `npx tsc --noEmit`, `npm run lint` and `npm test` pass; new code has unit tests with mocked ports and HTTP, per AGENTS.md.
- The acceptance list under "Rework" below: removed commands no longer route, conversation scoping for every path, offers for all three kinds, migration on a throwaway database, real-model checks with sharing off and on, one live journey on Wire staging and DS.
- No token, response body, description, reply text or surrounding message text appears in logs; nothing from the surrounding conversation appears in Jira.

### Rework: support requests replace action tracking in Jira (planned 2026-09-25)

**Why.** The staging tour showed that escalating ACT actions into Jira is not the fitting use of a service desk. The real use case is filing support requests: a team member has a problem and raises it with the service desk from Wire, then follows the conversation with the desk from Wire. Actions stay purely internal again. The rework keeps the whole Jira technical layer (adapter, credentials, SLAs, replies, offers, sharing setting, guardrails) and replaces the action-linked product layer with a new record type.

**The new record: `SupportRequest`.** One record per service-desk request raised from Wire, identified by its Jira key (for example `DS-6`): the key is the record's ID, so there is no separate `SR-` numbering. Fields:
- `key` (primary key, a Jira key of the configured project);
- qualified `conversationId` and qualified `requesterId` (the member who raised it; it stays in the bot's database);
- `summary` (one line, what the requester said the problem is);
- `statusCategory` (last known `todo`, `in_progress` or `done`, refreshed whenever the bot reads the ticket; the live value always comes from Jira);
- `createdAt`, `updatedAt`, `deleted`, `version`.
The full problem description is sent to Jira and not stored; the summary is the extract kept for recall and listing, in line with extract-and-forget. New Prisma model and migration `support_requests`, domain entity `src/domain/entities/SupportRequest.ts`, repository contract `src/domain/repositories/SupportRequestRepository.ts` (`create`, `findByKey`, `listByConversation(conversationId, { openOnly })`, `updateStatusCategory`), Prisma implementation, audit on every write.

**User journeys.**
1. **Raise:** `@Wire Team Bot support: <problem>` (first line becomes the summary, the full text the description), or in plain language, "my VPN drops every ten minutes, can you raise it with the service desk?", which produces a code-written offer `Shall I raise this with the service desk? > <summary> (yes or no)?`. On yes: create the Jira request, store the `SupportRequest`, reply `Raised **DS-6** with the service desk: <link>`. Both SLA clocks start.
2. **Follow:** `status of DS-6` and natural questions ("any news on my VPN issue?") as today, now scoped to support requests of this conversation. With `WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL=on`, the answer model gets live status, SLAs and service-desk replies of this conversation's support requests.
3. **List:** `@Wire Team Bot support requests` (open ones in this channel, with key, summary and live status) and `@Wire Team Bot my support requests` (raised by the caller).
4. **Reply:** `@Wire Team Bot reply to DS-6: <text>` or a confirmed plain-language offer, as today, scoped to support requests of this conversation.
5. **Resolve:** `@Wire Team Bot resolve DS-6` or a confirmed plain-language offer ("the VPN works again, please close my request"): follow the workflow to done, refresh `statusCategory`, report the SLA outcome.

**Keep unchanged:** `JiraServiceManagementAdapter` and its tests, `IssueTrackerPort` (createIssue, getIssue, resolveIssue, listCustomerReplies, addCustomerReply), configuration and the sharing setting, `Accept-Language: en-GB`, category-based status handling, SLA polling, reply formatting and the "Your team (via Wire)" label, the offer mechanism (`offers.ts`, `PendingOfferPort`, `InMemoryPendingOfferStore`, `ConfirmOffer` flow, explicit yes forms, acknowledgement re-ask, next-message rule, clearing on pause and secure), `matchIssueStatusRequest` for DS keys, the addressing rule for writes, and every guardrail in this section.

**Remove or rework:**
- Remove `PushActionToJira`, the `ACT-NNNN to jira` / `raise|push|send ACT-NNNN in jira` commands, the Jira step in `UpdateActionStatus` (its optional tracker and logger parameters), `jira status of ACT-NNNN`, `reply to ACT-NNNN`, the `Jira: <KEY>` line on retrieved actions, `ActionQuery.linkedIdsHas` and its Prisma filter, and the `jira:` link helpers `toJiraLink` / `jiraKeyFromLinks` (keep `JIRA_KEY_PATTERN` and `isKeyInProject`).
- Offer kinds become `support` (`{ summary, description }`), `reply` (`{ issueKey, body }`) and `resolve` (`{ issueKey }`); `raise` and `close` go. The change-intent check, validation (support request exists in this conversation, not done for resolve, body limits, requester-name check) and code-written questions follow the new kinds.
- `GetIssueStatus`, `ReplyToServiceDesk` and the ticket context in `AnswerQuestion` resolve keys through `SupportRequestRepository` (this conversation, not deleted) instead of action links. Retrieval gains a `support_request` result type (key, summary, last known status) so Q&A can recall "the VPN request is DS-6" with sharing off.
- The answer model's integration prompt lists the new commands and offer kinds; the reply footer becomes `Sent from Wire.`; `StatusCommand` adds "Open support requests: N".
- README, `.env.example` and the demo story in this section are rewritten for support requests.

**Decisions to confirm with the operator before building:**
1. **Requester identity in the ticket.** The earlier guardrail kept the requester's name out of Jira because actions carried team work. A support request needs a person the desk can help. Recommendation: include `Requested by <Wire display name> via Wire` in the description, and later use Jira's "raise on behalf of" once Wire users can be mapped to Jira accounts by email. The alternative is to keep names out and let the desk reply through Wire only.
2. **Existing demo data.** Four actions carry `jira:` links (ACT-0005 → DS-2 in the CLI channel; ACT-0008 → DS-3, ACT-0010 → DS-4, ACT-0012 → DS-5 in the staging channel). Recommendation: leave them inert (nothing reads the links after the rework) and resolve or delete DS-1 to DS-5 in Jira; optionally a one-off script creates `SupportRequest` rows for them. The probe ticket DS-1 has no record.
3. **Who may resolve.** Recommendation: any member of the channel, by command or confirmed offer, audited with the actor.

**Work split.** The same pattern that worked for the second step: the main session writes the contract (entity, repository contract, Prisma model and migration, offer-kind types, retrieval type) and commits it; then parallel subagents in worktrees for (a) persistence (Prisma repository, migration check against a throwaway database, integration test), (b) use cases (`RaiseSupportRequest`, `ListSupportRequests`, rework of status, reply, resolve and `ConfirmOffer`), (c) the answer side (`AnswerQuestion` context and offers, prompt); the main session does removals, router, wiring and docs; then an independent review (`code-review` skill) and real-model CLI checks; finally a live Wire and DS check with operator approval for every Jira write.

**Acceptance.** Unit tests for each part; the removed commands no longer route (and `ACT-NNNN done` never touches Jira); support requests are scoped to their conversation (another channel's key is refused for status, reply, resolve and model context); offers for all three kinds validated, confirmed, re-asked and dropped as today; migration applied to a throwaway database; real-model checks for raising, following, replying and resolving in plain language with sharing off and on; one live journey on Wire staging and DS.

### Rework decisions (confirmed by the operator, 2026-09-25)

1. **Requester in the ticket:** the description ends with `Requested by <Wire display name> via Wire.` (or `Requested via Wire.` when no display name is resolved or the name is a raw user ID). The record keeps `requesterName` for listing. Because the desk now knows the requester, the earlier check that dropped reply offers naming the requester is removed. "Raise on behalf of" stays a later step.
2. **Existing demo data:** the four `jira:` links on ACT-0005, ACT-0008, ACT-0010 and ACT-0012 stay in the database, inert. DS-1 to DS-5 are resolved or deleted in Jira, each write with the operator's approval. No backfill.
3. **Who may resolve:** any member of the channel, by command or confirmed offer; the audit entry records the actor.

### Rework contract (2026-09-25)

Committed by the main session before the parallel build. Builders code against these files and signatures; a change to them goes through the main session.

- **Domain:** `src/domain/entities/SupportRequest.ts` (`SupportRequest`, `SupportRequestStatusCategory`, `SUPPORT_SUMMARY_MAX` 120, `SUPPORT_DESCRIPTION_MAX` 4000), `src/domain/repositories/SupportRequestRepository.ts` (`create`, `findByKey`, `listByConversation(conversationId, { openOnly, requesterId, limit })`, `updateStatusCategory(key, category, updatedAt)`).
- **Persistence:** Prisma model `SupportRequest` mapped to `support_requests`, migration `20260925120000_add_support_requests`.
- **Scope helper:** `findSupportRequestInConversation(requests, key, conversationId, projectKey)` in `src/application/usecases/jira/supportRequestScope.ts`; every key-based use case and the answer path use it, so another channel's key reads as unknown: `I'm afraid **DS-6** isn't a support request in this conversation.`
- **Offers:** `OfferCommand` is `support { summary, description }`, `reply { issueKey, body }` or `resolve { issueKey }`; `parseOfferMarker` validates shapes and bounds. A model-written description is capped at `OFFER_DESCRIPTION_MAX` (1000) and shown in full in the confirmation question, so the requester confirms exactly what is sent.
- **Retrieval:** `RetrievalResult.type` gains `support_request` (stored record only: key, summary, requester name, last known status), produced by `AnswerQuestion` for this conversation whenever Jira is configured, independent of the sharing setting.
- **Status refresh:** whenever a use case or the answer path reads a ticket and its category differs from the stored one, it calls `updateStatusCategory` and appends an `entity_updated` audit entry (`entityType: "SupportRequest"`, `details: { statusCategory }`). An unchanged category writes nothing.
- **Use cases** (all in `src/application/usecases/jira/`, each sending exactly one Wire reply unless stated):
  - `RaiseSupportRequest(requests, tracker, wireOutbound, auditLog, logger?)`, `execute({ summary, description, conversationId, requesterId, requesterName?, replyToMessageId? }): Promise<SupportRequest | null>`. Validates bounds; creates the issue with the capitalised summary, the description plus the requester line, label `wire-team-bot` and no due date; stores the record with `statusCategory: "todo"`; audits `entity_created` for `SupportRequest`; replies `Raised **DS-6** with the service desk: <url>`. An in-process guard per conversation and requester stops a double submit. A refused create (4xx) says nothing was raised; any other failure (timeout, network, 5xx) says the bot could not confirm it and asks to check the queue before raising again. Every failed create is audited (`create_refused`, `create_unconfirmed`). A created key outside the project is not stored and is audited as `unexpected_key`. If storing fails after the ticket exists, it says so with the link.
  - `ListSupportRequests(requests, tracker, wireOutbound, auditLog, logger?)`, `execute({ conversationId, requesterId?, replyToMessageId? })`. Reads the newest 10 requests live, whatever their stored category, so a request reopened in Jira reappears; shows those not done live with key, summary, requester name and status label, and refreshes changed categories; a failed read shows the last known status marked `(last known)` unless that is done. Empty: `There are no open support requests in this channel.` (or `You have no open support requests in this channel.`).
  - `GetIssueStatus(requests, tracker, wireOutbound, auditLog, logger?)`, `execute({ reference, conversationId, timezone?, replyToMessageId? })`: key only, scoped through the helper, output as today, with the status refresh.
  - `ReplyToServiceDesk(requests, tracker, wireOutbound, auditLog, logger?)`, `execute({ reference, body, conversationId, actorId, replyToMessageId? })`: key only, footer `Sent from Wire.`, audit details `{ supportRequest: key }`; an unconfirmed failure (not 4xx) is audited as `reply_unconfirmed`. `formatReplies` strips both the new footer and the old `Sent from Wire (ACT-NNNN).` one.
  - `ResolveSupportRequest(requests, tracker, wireOutbound, auditLog, logger?)`, `execute({ issueKey, conversationId, actorId, replyToMessageId? })`. When the stored category is done, it reads the ticket live first: done live gives `**DS-6** is already resolved.`; reopened goes on to resolve. Otherwise `tracker.resolveIssue`, the status refresh, an audit entry with the actor, and the `formatResolution` reply (worded for the service desk: `Resolved **DS-6** with the service desk.` plus SLA lines). A failure audits `resolve_failed` and asks to check the ticket.
  - `ConfirmOffer(offers, { raiseSupportRequest, replyToServiceDesk, resolveSupportRequest }, wireOutbound, now?)`; `ConfirmOfferInput` gains `requesterName?` for `support`. The `timezone` field goes. Re-asks follow the new kinds.
- **Answer side:** `AnswerQuestionJira` becomes `{ tracker, requests: SupportRequestRepository, offers, shareWithModel, now? }`. With sharing on, live data comes from this conversation's support requests (named keys first, then the newest open ones, at most 3) instead of action links. Offer validation per kind: `support` needs a raising verb followed by a service-desk target in the question ("raise it with the service desk", "open a ticket with support", "put this into Jira", or "raise it" / "report it"), so "any news on my ticket?" does not pass; `reply` needs reply intent and a request in this conversation; `resolve` needs close intent ("close", "resolve", "works again", "no longer needed") and a request in this conversation (the use case re-checks done live). Code-written questions: `Shall I raise this with the service desk?\n> **<summary>**\n> <description>\n\n(yes or no)?`, the reply quote as today, and `Shall I resolve **DS-6** "<summary>" with the service desk (yes or no)?`. The prompt in `OpenAIGeneralAnswerAdapter` lists the new commands and kinds and no ACT-to-Jira commands.
- **Router and wiring (main session):** `@bot support: <problem>` (addressed only; the first line is the summary, cut to the limit, and the full text is the description), `support requests` and `my support requests`, `@bot resolve DS-6` (addressed only), `status of DS-6`, `@bot reply to DS-6: <text>`; ACT forms of status and reply stop routing; `hasMultipleCommands` follows; `StatusCommand` adds `Open support requests: N` when Jira is configured; container and CLI build the new use cases.

**Build split.** (a) persistence: `PrismaSupportRequestRepository`, migration check against a throwaway database, integration test. (b) use cases: the five use cases above, `ConfirmOffer`, `formatIssue` changes and their unit tests; removes `PushActionToJira` and its tests. (c) answer side: `AnswerQuestion`, `offers.ts` tests, `OpenAIGeneralAnswerAdapter` prompt and their tests. The main session does the removals in `UpdateActionStatus`, retrieval, link helpers and `ActionQuery`, then the router, wiring, docs and integration.

### Passive service-desk help (planned 2026-09-26)

**Why.** The live journey showed that people talk to the bot as they would to a colleague: they correct a draft instead of answering yes or no, combine requests, and ask without mentioning the bot. The bot already listens to every message in an active channel and captures commitments and decisions quietly (📝, ✅). The same listening can notice problems and questions about open requests, and offer help. Nothing reaches the service desk without an explicit yes.

**Decisions (operator, 2026-09-26).**
1. Passive offers and passive status answers are off unless `WIRE_TEAM_BOT_JIRA_PASSIVE=on` (default `off`; ignored when Jira is not configured). The setting is the noise control: there is no first-person rule and no rate limit, because the demo channel is a support-facing channel where every problem mention is welcome.
2. One mention rule for the service desk: every support-request command needs the bot to be mentioned (`support:`, `support requests`, `my support requests`, `status of DS-N`, `reply to DS-N:`, `resolve DS-N`). The pilot's core commands (`action:`, `ACT-N done`, `my actions`, reminders) keep working without a mention; the demo always uses mentions. What users learn: "The bot listens and offers help; nothing reaches the service desk without your yes. Mention it to ask or command directly."
3. The conversational fixes below come first, because passive offers make those paths frequent.

**Step 1: conversational fixes.**
- **Never claim an unperformed write.** When the model's answer carried an offer marker and code dropped the offer, the model's text is not sent. Code sends instead: `I haven't changed anything with the service desk.` plus the matching command, for example `To raise it, send @Wire Team Bot support: <problem>.` Without a marker, the answer is sent as today.
- **Amending a pending offer.** While a `support` or `reply` offer is pending, a message from the requester that is not yes, no or an acknowledgement goes to the answer path with the pending offer as context. A revised offer of the same kind from the model replaces it without a fresh change-intent check (the requester's intent was established by the original offer), is validated as usual and shown again in full. Anything else drops the offer as today.
- **A yes with nothing to confirm.** If the requester's offer was dropped or expired in the last ten minutes, a bare yes gets `There's nothing waiting for your yes: I haven't raised or sent anything.` plus the last offer's command form. Otherwise a bare yes keeps its existing handling.

**Step 2: passive help (only with the setting on).**
- **Classifier:** `MessageCategory` gains `service_request` (someone describes a problem, fault or need a service desk could handle) and `request_status` (someone asks about the state of a problem or request). Neither triggers action extraction on its own.
- **Triage port:** `SupportTriagePort` (application port, LLM adapter in infrastructure) with `draftRequest(message, openRequests)` returning `{ summary, description, duplicateOf }` or null, and `matchStatusQuestion(message, openRequests)` returning a key or null. `openRequests` holds only key and summary of this conversation's open requests. The draft uses that single message only, never the surrounding conversation.
- **Use case:** `OfferSupportFromConversation` in `src/application/usecases/jira/`, called by the pipeline for unaddressed ACTIVE messages when the setting is on and the classifier reports one of the two categories with confidence of at least 0.8.
  - `service_request`: no offer when `duplicateOf` names an open request of this conversation; otherwise validate the draft (bounds as for model offers), send the code-written support question as a native reply to the source message, then store the offer for the speaker. The existing confirmation, re-ask, amending and next-message rules apply.
  - `request_status`: when the question maps to an open request of this conversation, reply to the source message with the output of `GetIssueStatus` (read-only, no model, independent of the sharing setting); otherwise stay silent.
  - Before sending, re-check that the channel is still ACTIVE and the job was not cancelled; pause and secure cancel in-flight jobs and clear offers as today.
- **Evidence required:** unit tests with mocked ports; the simulation replay (`npm run simulate`) with the setting on, reviewed for false and missed offers; real-model CLI checks (offers answered no); a live staging check with the operator's approval for each Jira write.

**Open, not in these steps:** resolving with a closing comment in one step (`resolve` offer and command with an optional comment; "add a comment" and "note" as reply wording).

**Contract (committed before the build).** `JiraConfig.passive` from `WIRE_TEAM_BOT_JIRA_PASSIVE`; `MessageCategory` values `service_request` and `request_status`, offered to the classifier model only when passive help is on, so classification is unchanged otherwise (`OpenAIClassifierAdapter` takes an option); `PendingOfferStore.drop` (remove and remember) and `recentlyDropped` with `RECENT_DROP_MS`; `AnswerQuestionInput.pendingOffer` carrying the offer the router just dropped for this message; `SupportTriagePort` in `src/application/ports/SupportTriagePort.ts`; `OfferSupportInput`, `OfferSupportFromConversationPort` and `PASSIVE_CONFIDENCE_MIN` (0.8) in `src/application/usecases/jira/OfferSupportFromConversation.ts`, where the class `OfferSupportFromConversation(requests, triage, getIssueStatus, offers, wireOutbound, logger?)` implements the port. The router replaces its drop via `take` with `drop` and passes the dropped command as `pendingOffer` to any `answerQuestion` call for the same message; `ConfirmOffer` uses `recentlyDropped` for a bare yes.

**Work split.** Main session: contract, router mention rule and `drop`/`pendingOffer` plumbing, wiring and docs. Subagents in parallel worktrees: (a) step 1 in `AnswerQuestion`, `ConfirmOffer` and the offer store; (b) step 2: classifier prompt, triage adapter, use case and pipeline hook. Then an independent review, simulation, real-model CLI checks and the live check.

### Adding to an open request (planned 2026-09-26)

**Why.** In the passive live check, "it only happens on the 3rd floor", sent after DS-9 was raised, got no reply, and "the wifi on the 3rd floor dropped again" was silently treated as a duplicate. Both are information the service desk wants on the existing request. Today the triage's `duplicateOf` suppresses the offer entirely; instead the bot should offer to add the new information as a reply to that request, confirmed with yes like every other write.

**Behaviour (only with `WIRE_TEAM_BOT_JIRA_PASSIVE=on`).**
- An unmentioned message that adds to a problem already raised in this channel (a new detail, a change, "it happened again", "now also on the 2nd floor") gets a native reply: `Shall I add this to **DS-10** "Wi-Fi in Berlin office disconnects every few minutes"?\n> <addition>\n\n(yes or no)?`. On yes, the existing `ReplyToServiceDesk` sends it (footer `Sent from Wire.`, audited). The existing rules apply: only the speaker can confirm, with their next message; a correction revises it; anything else drops it.
- Any channel member may add to a request, as any member may resolve.
- A message that only repeats the problem without anything new ("the Wi-Fi is still bad", said twice in a row) is not offered; "it happened again" counts as new, since it tells the desk the problem persists.
- A message without its own subject ("it only happens on the 3rd floor") may continue the request the speaker raised most recently in this channel; the triage gets that hint.
- The addition text comes from that single message only, in the speaker's words, never from the surrounding conversation, and is shown in full before the yes.
- Plain language when the bot is mentioned: "add to DS-10 that it's the 2nd floor too", "add a comment", "note on DS-10 …" count as reply wording, so the existing reply offer covers them.

**Design.**
- `SupportTriagePort.draftRequest` result gains `addition: string | null` (the new information to add to `duplicateOf`, from this message only); `OpenRequestRef` gains `raisedBySpeakerRecently?: boolean` (raised by this speaker within the last hour, newest first). The classifier's `service_request` description also covers "adds information to a problem already reported".
- `OfferSupportFromConversation`: when `duplicateOf` is an open request of this conversation and `addition` is present and within `REPLY_BODY_MAX`, send the code-written addition question and store a `reply` offer `{ issueKey, body: addition }` for the speaker; without an addition, stay silent as today.
- One reply question for all paths: a shared `formatReplyQuestion(key, summary, body)` in `offers.ts` producing the wording above, also used by `AnswerQuestion` for reply offers (replacing `Here is the reply for …`).
- `AnswerQuestion`'s reply intent also accepts "add", "comment", "note" and "update" with a service-desk target or a named key.

**Evidence required.** Unit tests with mocked ports; real-model CLI checks (offers answered no); a live staging check of one addition confirmed with yes (a Jira write, with the operator's approval) and one repeated message that gets no offer.

**Work split.** Main session: contract (port fields, formatter signature) and PLAN/README; one subagent in a worktree: adapter prompt, classifier line, use case, `AnswerQuestion` reply wording and intent, tests. Then an independent review, CLI checks and the live check.

### Truck premium support (planned 2026-09-26)

**Use case (operator, 2026-09-26).** The customer sells the bot as an add-on to the trucks they sell: premium support in Wire. The people in the channel are drivers of those trucks, possibly defence or military personnel. They ask questions about the vehicle, report faults and breakdowns, and order replacement parts. The service desk is the manufacturer's premium support. The demo must show exactly this, not office IT.

**Evidence that led here.** With the current generic wording, faults and damage already worked in a real-model check: brake warning light, tyre pressure sensor and damaged charging cable each got an offer. "truck 17 is due for its 60,000 km service next week" was classified as an update and got nothing, and the prompts mention "access they need" and similar IT examples.

**Decisions (operator, 2026-09-26).**
1. Separate request types, so desk agents get proper queues: questions go to "Ask a question" (`11809`), faults, breakdowns and service needs to "Submit a request or incident" (`11808`), and replacement parts to a new "Replacement part" request type the operator creates in DS.
2. For a part order the bot collects all essentials before offering: the vehicle (fleet number or chassis number/VIN), the part (name or number), the quantity and the delivery location. It asks for whatever is missing.
3. The bot understands drivers in any language, but its own texts (offers, questions, confirmations) stay in English for the demo. Tickets carry the driver's words.

**Behaviour.**
- **Kinds:** every request has a kind: `question`, `part` or `fault` (faults, breakdowns, damage, service and maintenance needs). The kind decides the Jira request type and the offer's wording: `Shall I ask the service desk?`, `Shall I order this part?`, `Shall I report this to the service desk?`, each followed by the full text that will be sent and "(yes or no)?".
- **Part orders:** the offer shows the essentials as lines (`Vehicle: …`, `Part: …`, `Quantity: …`, `Deliver to: …`) above the driver's description, and the same lines go into the ticket. When something is missing, the bot asks one short question naming what is missing ("To order it I need the vehicle (fleet or chassis number) and the delivery location. What are they?"). The driver's next message fills the draft through the existing amend path, and the bot asks again or makes the offer. A yes before the draft is complete gets "I still need …". Anything unrelated drops the draft as today.
- **Scope:** a setting `WIRE_TEAM_BOT_JIRA_SERVICE_SCOPE` describes what the desk handles (for the demo: "questions about the truck, faults, breakdowns, damage, service and maintenance, and replacement part orders"). It feeds the classifier, the triage prompt and the answer prompt; without it the current generic wording stays.
- **Where it applies:** passive offers (setting on) and the answer path when the bot is mentioned. The `support:` command keeps raising directly with the fault type, since it has no model step to classify or collect essentials.
- **Listing and status:** `support requests` shows the kind ("Part order DS-12 …").

**Design.**
- Configuration: `WIRE_TEAM_BOT_JIRA_REQUEST_TYPES` as `question=11809,part=11810,fault=11808` replaces the single request type ID. `fault` is required and is the general type, used by the `support:` command and for any kind without its own entry. `IssueTrackerPort.createIssue` takes an optional request type ID.
- `SupportRequest` gains `kind` (migration adding a column with default `fault`).
- The `support` offer command gains `requestKind` and, for parts, `part: { vehicle?, part?, quantity?, deliverTo? }`. A part draft with missing essentials is stored as a pending offer that cannot be confirmed, only amended.
- `SupportTriagePort.draftRequest` returns the kind and, for parts, the essentials found in the message (never invented).
- Classifier, triage and answer prompts use the scope text and name the three kinds.

**Security note for the customer (not built).** The demo sends every message in an active channel to the Claude API for classification, and tickets live in Jira Cloud. For defence or military customers that is likely unacceptable. Production would need a local model endpoint (the configuration already accepts OpenAI-compatible endpoints) and Jira Data Center or another tracker hosted by the customer. This belongs in the customer conversation, next to the Wire encryption story.

**Jira set-up (done 2026-09-26).** The operator created the "Replacement part" request type in DS: request type `11810`, its own work type `11810`, in the same portal group as the others, form with Summary (required) and Description, and the same statuses as the incident type (To Do, In Progress, Pending, Done), verified with the bot's token.

**Evidence required.** Unit tests; real-model CLI checks with truck messages (questions, faults, scheduled service, part orders with and without essentials), offers answered no; a live staging journey with one question, one fault and one part order confirmed with yes (Jira writes, with approval).

**Work split.** Main session: contract (configuration, kinds, port and entity changes, migration, offer shape) and the demo story rewrite. Two subagents in parallel worktrees: (a) passive side: classifier and triage prompts, part essentials, use case; (b) answer and action side: answer prompt and offer validation, `ConfirmOffer` for incomplete drafts, `RaiseSupportRequest` request-type selection and part lines, listing. Then an independent review, CLI checks and the live check.

### Resolve with a closing comment, and the channel timezone (planned 2026-09-26)

**Why.** In the first live journey the operator wanted to close DS-8 with a note and needed two steps; the bot even claimed a comment it had not sent. The channel timezone has been an open item since 2026-09-25: every channel gets `UTC` and only a hand-edited database row changed the staging channel to `Europe/Berlin`.

**Resolve with a closing comment.**
- Command: `@Wire Team Bot resolve DS-6: The mirror was fitted, thanks.` (also `close DS-6: …`). Without the colon part it works as today.
- Plain language when mentioned or as a confirmed offer: "the keyboard works again, please add a comment and close DS-8" produces `Shall I resolve **DS-8** "<summary>" with the service desk and add this comment?\n> <comment>\n\n(yes or no)?`. The resolve offer gains an optional `comment`; a correction revises it like any other offer.
- Order (decided by the main session): the comment is sent first as a customer-facing reply (footer `Sent from Wire.`, audited), then the request is resolved. If the comment is refused (4xx) or its delivery cannot be confirmed, the request is not resolved and the reply says so, so the desk never sees a closed request without the explanation.
- Bounds and wording as for replies (`REPLY_BODY_MAX`); the requester sees the full comment before the yes.

**Channel timezone.**
- `@Wire Team Bot timezone Europe/Berlin` sets the channel's timezone after validating the IANA name (`Intl.DateTimeFormat`), saves it to `channel_config.timezone`, audits `config_changed` with the old and new zone, and confirms `This channel's timezone is now **Europe/Berlin** (currently 18:40 CEST).`. `@Wire Team Bot timezone` shows the current one. An unknown name gets `I'm afraid I don't know the timezone "…". Please use a name such as Europe/Berlin or America/New_York.`
- Any channel member may change it (decided by the main session, matching who may resolve); the audit records who.
- `WIRE_TEAM_BOT_DEFAULT_TIMEZONE` (default `UTC`, validated at startup) replaces the hard-coded `UTC` for channels the bot newly joins. Existing channels keep their stored zone.
- Displayed times carry the zone abbreviation where the bot shows a time of day: reminder confirmations and lists, action deadlines, and service-desk reply times (for example `2 Oct, 15:00 CEST`).
- `status` shows the channel's timezone.
- Stored deadlines and reminder times are instants and do not move when the zone changes; only reading and display do.

**Work split.** Main session: contract (resolve command `comment`, `ResolveSupportRequest` input, `SetChannelTimezone` signature, default-timezone setting), router commands for both, wiring, `status` line and docs. Two subagents in parallel worktrees: (a) resolve with a comment: `ResolveSupportRequest`, offer parser, `AnswerQuestion` resolve offers and intent, `ConfirmOffer`, answer prompt; (b) timezone: `SetChannelTimezone` use case and the zone in displayed times. Then an independent review, real-model CLI checks (no confirmations, no direct write commands) and a live staging check with the operator's approval for Jira writes.

### Passive resolve offers (planned 2026-09-26)

**Why.** In the live check, "the mirror for truck 7 was delivered, please close DS-14 and add a comment that it arrived at depot north", sent without a mention, got only an addition offer: passive help can raise and add but not resolve, so "close" was silently ignored, and unmentioned "close DS-14" got no reply at all.

**Behaviour (only with `WIRE_TEAM_BOT_JIRA_PASSIVE=on`).**
- An unmentioned message that says an open request of this channel is solved or can be closed ("the brake light is fine now", "please close DS-14", "the mirror was delivered, close it and note that it arrived at depot north") gets a native reply with the resolve offer: `Shall I resolve **DS-14** "<summary>" with the service desk?` or, when the message carries a closing remark, `… and add this comment?\n> <comment>`, then `(yes or no)?`. On the speaker's yes, the existing resolve with its optional comment runs (comment first, then resolve).
- The closing comment comes from that single message only, in the speaker's words, and is shown in full; a correction revises it; anything else drops the offer, as for every offer.
- A message that only reports good news without naming or clearly meaning one open request gets no offer.
- The router's direct commands are unchanged: `@Wire Team Bot resolve DS-N` still resolves at once; unmentioned "close DS-14" now reaches passive help and gets the offer instead of silence.

**Design.**
- `SupportDraft` gains `resolves: string | null` (a listed open request the message says is solved or can be closed) and `closingComment: string | null` (only with `resolves`; the remark to add, from this message only). `resolves` takes precedence over `addition` and over a new request.
- The classifier's `service_request` line (with the option on) also covers a message saying a reported problem is solved or asking to close a request. Because the classifier often labels such messages `action`, `decision` or `update`, passive help also runs the triage for `action` and `decision` messages when the channel has open requests; those, like updates, may only lead to an addition or a resolve offer, never to a new request.
- The offer is a `resolve` command `{ issueKey, comment? }` stored for the speaker after the send; the question uses the existing `formatResolveQuestion`.

**Evidence required.** Unit tests; real-model CLI checks (offers answered no; the script grepped for write lines); a live staging check of one passive resolve with a comment confirmed with yes (a Jira write with the operator's approval) and one good-news message without a clear request that gets no offer.

**Work split.** Main session: contract and docs. One subagent: triage prompt and parser, classifier line, use case and pipeline gate, tests. Then an independent review, CLI checks and the live check.

### Part orders completed in code, and no double capture (planned 2026-09-26)

**Why.** In the demo run on the local model (Qwen3.5-4B), "deliver to depot north", sent after "To order it I need the delivery location", did not complete the order: the answer model returned no revised offer, the message fell through to passive help, and a fresh part draft asked for all four details again. In the same run, ordinary action capture handled the support messages too: the part order also created ACT-0035 "Acquire a new left mirror for Truck 7" (📝), and "the brake light … please close it" marked the unrelated ACT-0010 "Write the customer proposal" done (✅). The operator left both records as they are for now.

**Fix 1: completing a part order in code.**
- While the requester's pending offer is a part order with missing essentials, their next message (mentioned or not) goes to a new use case `CompletePartOrder` before the answer path.
- It asks the triage model a narrow question: which essentials (vehicle, part, quantity, delivery location) does this message state? Code merges them into the draft; a value in the message replaces an earlier one, so "actually three" corrects the quantity.
- Still missing: the bot asks for exactly what is missing and keeps the draft. Complete: the bot shows "Shall I order this part?" with the four lines, and the yes raises it as today.
- If the message states none of the essentials, the use case does nothing and the message continues as today (a yes still gets "I still need …", other messages drop the draft or reach the answer path).
- It does not depend on the answer model returning a revised marker, so it works with small local models.

**Fix 3: no action capture for messages passive help has handled.**
- `OfferSupportFromConversation.execute` reports whether it sent anything (an offer, a missing-details question or a status answer). When it did, the pipeline skips extraction for that message: no new actions or decisions, no completions and no 📝 or ✅ reactions. The message still counts as conversation context.
- Messages passive help did not answer are captured as today, so "I'll order the mirror tomorrow" still becomes an action.

**Contract.** `SupportTriagePort.extractPartDetails(message)` returns the essentials the message states (never invented, bounded); `CompletePartOrder(triage, offers, wireOutbound, logger?)` with `execute({ text, conversationId, requesterId, pending, replyToMessageId? }): Promise<boolean>` (true when it replied); `OfferSupportFromConversationPort.execute` returns `Promise<boolean>`.

**Work split.** Main session: contract, router hook (before the amend path), wiring, docs. One subagent: `CompletePartOrder`, the triage method and prompt, `OfferSupportFromConversation` returning whether it replied, the pipeline skip, tests. Then an independent review, CLI checks on the local model (offers answered no) and a live check.

### Jira updates in Wire by polling (planned 2026-09-26)

**Why.** For the demo, the channel should learn about changes the service desk makes in Jira without anyone asking: a new reply from the desk, work starting, the request being resolved or reopened. A Jira webhook is not possible for now (the bot runs behind no public endpoint), so the bot checks Jira periodically. This reverses the earlier out-of-scope item "posting Jira replies into Wire unprompted", at the operator's request.

**Behaviour.**
- Off unless `WIRE_TEAM_BOT_JIRA_WATCH_SECONDS` is set (for example `30` for the demo; at least 15). It watches the open support requests of every channel.
- On a change the bot posts one message in the request's channel, headed `**DS-16** Brake warning light on truck 12`: a status line when work started ("Now in progress."), the request was resolved in Jira ("Resolved by the service desk." plus the SLA outcome) or reopened ("Reopened by the service desk."), and any new public replies from the desk, quoted and shortened as in `status of` (author and time in the channel's timezone). Several changes to one request in one check become one message.
- Never announced: replies the bot sent from Wire, internal notes (the adapter only returns public comments), changes the bot made itself (a resolve from Wire already stores the new status), and status changes inside a category (Jira status names are localised, so only the category counts, as everywhere else).
- Paused or secure channels get nothing, and their changes stay pending; after `resume`, the next poll posts at most one catch-up message per request.
- Each update is posted as a native Wire reply to the bot's last message about that request (operator, 2026-09-26), so every ticket reads as a thread-like chain in the channel: the "Raised DS-16…" confirmation, "Sent your reply…", a `status of` answer, a resolve or an earlier update. Without a stored reference (older requests, a failed send) the update is posted standalone.
- Only the requests' keys and statuses are read in the regular check; replies are fetched only for requests Jira reports as changed.

**Design.**
- `IssueTrackerPort.listChangedSince(keys, since)` returns key, status category and last update time for the given keys updated since `since`, through one JQL search (`/rest/api/3/search/jql`, scope `read:jira-work`, already granted), in batches.
- `SupportRequest` gains `lastSeenReplyAt` (the creation time of the newest public reply already shown or announced; migration adding a nullable column). A request without it gets a baseline on the first check, so nothing old is announced when the feature is switched on.
- Use case `WatchSupportRequests` in `src/application/usecases/jira/`: lists open requests (plus those resolved in the last day, to catch a reopen), asks the tracker what changed since the last check, reads replies for the changed ones, compares with `lastSeenReplyAt` and the stored status category, posts, then stores the new status (the existing audited refresh) and the new `lastSeenReplyAt` (bookkeeping, not audited). It checks each channel's state before posting.
- A small interval runner in the composition root starts it; one check at a time, a failed check is logged by error name and retried at the next interval. The time of the last check lives in memory; after a restart the stored markers prevent repeats.
- `status of` and the answer path update `lastSeenReplyAt` when they show replies, so a reply someone has already looked at is not announced again.

**Quoting the last ticket message (design).**
- A Wire reply carries the quoted message's ID and an integrity hash the SDK computes from its content (`TextMessage.createReply` uses `MessageContentEncoder.encodeMessageContent(original).sha256Digest`). Today only the reply context of the message being handled holds these (`WireReplyContext`).
- `SupportRequest` gains `lastMessageId` and `lastMessageSha256` (nullable; the same migration as `lastSeenReplyAt`). They hold only the bot's own message ID and hash, never text. This changes the rule "keep only the SDK quote ID/hash during the handler" for support requests: the reference outlives the handler, still without any message content.
- `WireOutboundPort.sendPlainText` returns a reference `{ messageId, sha256 }` for the sent message (the SDK's `sendMessage` returns the ID; the adapter computes the hash from the message it built), and gains an option to quote a stored reference. The CLI outbound returns a synthetic reference.
- Every use case whose bot message names a request stores the reference after sending: `RaiseSupportRequest`, `ReplyToServiceDesk`, `GetIssueStatus`, `ResolveSupportRequest`, passive offers and the watch updates themselves. `WatchSupportRequests` quotes the stored reference and then stores the reference of its own update.
- Wire shows a reply to a deleted message as quoting "message deleted"; that is acceptable.

**Contract (2026-09-26).** Committed as code; builders must not change these signatures without the main session.
- Setting: `JiraConfig.watchSeconds` from `WIRE_TEAM_BOT_JIRA_WATCH_SECONDS` (whole seconds, at least 15; absent means no watching).
- `IssueTrackerPort.listChangedSince(keys, since?)` returns `IssueChange { key, statusCategory, updated }` for keys updated after `since`, or for all existing keys when `since` is absent. The adapter uses `POST /rest/api/3/search/jql` with `key in (...)` in batches of at most 50, fields `status` and `updated` only, and follows `nextPageToken`. JQL dates depend on the account's timezone, so the adapter filters with a relative bound (`updated >= "-Nm"`, N rounded up with a one-minute margin) and callers compare `updated` themselves. Keys outside the project are rejected before the request. Jira rejects a whole search (400) when one listed key no longer exists or is not visible, so a rejected batch is split and retried, and a key rejected on its own is left out (logged by key).
- `WireOutboundPort.sendPlainText` returns `SentMessageRef { messageId, sha256 }` (hex) or undefined; `OutboundTextOptions.quote` quotes a stored reference (ignored when `replyToMessageId` is set). The Wire adapter computes the hash from the message it built, using the local send time: the SDK does not return the backend's time and Wire clients check the hash against the send time rounded to the second, so a quote may occasionally not verify. The live check must confirm how Wire shows it. The CLI returns a synthetic reference.
- `SupportRequest` gains `lastSeenReplyAt?` and `lastMessage?` (migration `20260926200000_add_support_request_watch_markers`). `SupportRequestRepository` gains `listWatched(resolvedSince, limit?)`, `advanceLastSeenReplyAt(key, at)` (never moves back) and `setLastMessage(key, ref)`; both markers are bookkeeping, not audited, and leave `version` and `updatedAt` alone.
- `WatchSupportRequests` (`src/application/usecases/jira/WatchSupportRequests.ts`) is constructed with the repository, tracker, outbound, audit log, `ChannelConfigRepository`, logger, a clock and guards (`ConversationConfigRepository` for the older secret-mode flag, and `SupportRequestWrites`, shared with `ResolveSupportRequest`, which marks a key from the Jira transition until the new category is stored), and exposes `check(): Promise<{ announced, pending }>`. It keeps the time of the last check and a set of pending keys in memory. Each check:
  1. `listWatched(now - 24h)`; nothing to watch ends the check (the check time still advances).
  2. `listChangedSince(keys, lastCheck - 2 min)`, where the first check after a start passes no `since`; the overlap covers Jira's eventually consistent search and clock differences, and examining a request twice is harmless. The requests to examine are the changed ones (`updated` after that bound, or all on the first check) plus the pending keys still watched. The new check time is taken before the tracker call. A failed tracker call logs the error name and leaves the last check time unchanged.
  3. Per request, isolated (a failure logs the error name and the key and marks it pending): skip and mark pending while the key is in `SupportRequestWrites`; re-read the record (a resolve, `status of` or answer during the check may have moved its markers); skip and mark pending when the channel's state (`toChannelId`) is `paused` or `secure`, where a missing channel config counts as secure only with the older `secretMode` flag, as in the router. Read replies with `listCustomerReplies(key, 10)`. Without `lastSeenReplyAt` (first sight), set it to the newest reply's creation time (or the request's `createdAt` when there is none) and store the live status silently: nothing old is announced. New replies are those created after `lastSeenReplyAt` and not `fromThisBot`; show at most the 3 newest. A listed category that differs from the stored one is confirmed with `getIssue`, whose category counts (a failed read keeps the request pending).
  4. When there is something to announce, check the write guard and the channel state again, then send one message quoting `lastMessage` when stored, then `setLastMessage` with the returned reference. After a successful send (or when there was nothing to announce), store the status with `refreshStatusCategory` (actor `botActor`) and advance `lastSeenReplyAt` to the newest reply fetched, including the bot's own. A failed send leaves the markers and marks the request pending; after 10 failed attempts (a failed send or read, not a paused or secure channel) the update is given up with one warning, so a conversation the bot cannot post to is not retried for ever. Requests of the CLI's test conversations (domain `cli.local`) are not watched, as for reminder rehydration.
- Message format, one message per request and check: first line `**DS-16** <stored summary>`; then one status line when the category changed: to `in_progress` "Now in progress.", to `done` "Resolved by the service desk." followed by the SLA lines (`formatSla`, from the confirming `getIssue`), from `done` to another category "Reopened by the service desk.", from `in_progress` to `todo` "Moved back to To do."; then, when there are new replies, a blank line and the replies block as in `status of` with the heading "New reply from the service desk:" or "New replies from the service desk:" (reuse `formatReplies`, with the heading as a parameter), times in the channel's timezone (UTC when none).
- Existing use cases store the reference of every plain-text message that names a stored request (`setLastMessage`, failures logged by error name, never breaking the reply): `RaiseSupportRequest` (the "Raised" confirmation), `ReplyToServiceDesk`, `GetIssueStatus`, `ResolveSupportRequest`, passive offers and answers that name an existing request, and the confirmations after an accepted offer. `RaiseSupportRequest` creates new records with `lastSeenReplyAt` equal to `createdAt`. `GetIssueStatus` calls `advanceLastSeenReplyAt` with the newest reply it showed; the answer path does so only for live tickets its answer names, since the model may leave out replies it was given.
- Runner (composition root): started only when `watchSeconds` is set and Jira is configured; one check at a time (a tick while a check runs is skipped); failures logged by error name; shutdown stops it and waits for a check in progress before the database disconnects. Logs never contain reply text or summaries.

**Evidence required.** Unit tests with mocked ports; a check against DS with the bot's token (read-only) that the JQL search works with the scoped token; a live staging check where the operator, as the desk agent, adds a public reply, an internal note (must not appear), moves a request to In progress and resolves one in Jira, and watches the channel.

**Work split.** Main session: contract (port method, entity fields and migration, the outbound reference and quote option, setting, use-case signature), the runner and wiring, the Wire and CLI outbound adapters, docs. Subagents: (a) the Jira adapter method and `WatchSupportRequests` with tests; (b) storing the reference and `lastSeenReplyAt` in the existing use cases (`RaiseSupportRequest`, `ReplyToServiceDesk`, `GetIssueStatus`, `ResolveSupportRequest`, passive offers, the answer path) with tests. Then an independent review, the read-only JQL check and the live check.

### Photos and documents to the service desk (planned 2026-09-28)

**Why.** In the demo the desk asks the driver for a photo ("Please check the brake fluid level and send a photo"), and the natural answer is a photo in the Wire channel. Today the bot ignores images: `WireEventRouter` does not implement `onAssetMessageReceived`. The SDK already delivers images to apps (`onAssetMessageReceived` with name, MIME type, size and image metadata) and downloads and decrypts them (`WireApplicationManager.downloadAsset`), so this shows a further SDK capability: files in both directions between an encrypted Wire channel and a business system.

**Behaviour.**
- Only with passive help on (`WIRE_TEAM_BOT_JIRA_PASSIVE=on`): an image cannot carry a mention, so this is passive by nature.
- A driver posts a photo or a document in a channel with an open support request: images (JPEG, PNG, HEIC, WebP) or documents (PDF, plain text, CSV, Word `.docx`, Excel `.xlsx`), at most 10 MB, recognised by MIME type. The bot replies to the file: `Shall I add this photo to **DS-16** "Brake warning light on truck 12"?` ("this file" for a document, with its name) followed by "(yes or no)?". On yes from the same person as their next message, it downloads the file from Wire, attaches it to the request as a public reply "Photo from Wire, sent by <name>. Sent from Wire." ("File from Wire …" for a document), and replies `Added the photo to **DS-16** in Jira.` A no, or anything else, sends nothing, as for every offer.
- Which request: the channel's open request with the latest bot message about it (the one the desk last answered or the driver last followed), else the newest open one. The offer names the key and summary, so a wrong guess is visible and answered with no.
- A second file from the same person replaces their earlier file offer, so a yes attaches the file posted last. A file while they still have a question to answer (a support, reply or resolve offer) gets "Please answer my question above first (yes or no), then post the file again." and changes nothing.
- No offer: in a channel with no open request (a photo does not raise a new request), for self-deleting messages (Wire's timer must be respected; the file is never forwarded), for other file types or larger files, in paused or secure channels (the router's state checks apply as for text), and for files the bot itself sent.
- The file is held only in memory between the download and the upload and is never stored or logged; the file name goes to Jira as the attachment name only; the pending offer keeps only the SDK's download reference (asset ID, token, domain and key material, needed to fetch it) until it expires. Audit: the attach is audited as an update of the request with the MIME type and size, not the file name.
- The watch does not announce the bot's own attachment reply (`fromThisBot`), as for replies sent from Wire.

**Design.**
- Port `WireAssetPort` (application) with `download(ref): Promise<Uint8Array>`, implemented in the Wire adapter over `downloadAsset`; `ref` is an opaque `InboundAssetRef` built by the router from `AssetMessage.remoteData`.
- `IssueTrackerPort.addCustomerAttachment(key, file: { name, mimeType, data }, comment)`: the Jira Service Management API, `POST /rest/servicedeskapi/servicedesk/{id}/attachTemporaryFile` (multipart, `X-Atlassian-Token: no-check`, experimental opt-in header) then `POST /rest/servicedeskapi/request/{key}/attachment` with `public: true` and the comment. Scope `write:servicedesk-request`, already granted; whether the API gateway accepts the multipart upload with the scoped token is the first thing to verify.
- Offer kind `attach` (`issueKey`, the asset reference, MIME type, size) in the pending offer store; `ConfirmOffer` hands a yes to a new use case `AttachPhotoToRequest` (scope check, download, upload, audit, reply, `setLastMessage`). A failed download or upload is reported plainly ("I'm afraid I couldn't add the photo to **DS-16**.") and, as for replies, an unconfirmed upload does not invite a retry.
- Router: `onAssetMessageReceived` runs the same channel-state gate as text, ignores events without `remoteData` (the preview arrives before the upload, with the same message ID) and repeats of a message ID, then calls the use case that picks the request and makes the offer. The SDK takes a file's type, name and size only from the preview part, so the router remembers each preview (by sender and message) and completes the upload event with it, including its self-deleting timer and its time, which the offer's quote hash needs. The image is added to the conversation buffer as "(photo)" so the next text message has context.

**Decisions (operator, 2026-09-28).** (1) The target is the open request with the latest bot message about it, else the newest open one. (2) No offer without an open request. (3) Images and documents, with the types listed above.

**Contract (2026-09-28).** Committed as code; builders must not change these signatures without the main session.
- `OfferCommand` gains `{ kind: "attach"; issueKey; file: InboundFile }` (`PendingOfferPort.ts`); `InboundFile` holds an opaque `InboundAssetRef`, `fileKind` ("photo" or "file"), `name`, `mimeType` and `sizeInBytes`, never bytes. The answer model cannot propose it (`parseOfferMarker` accepts only support, reply and resolve), it is not amendable, and the command line after a dropped attach offer is "To add it, post the file again."
- `WireAssetPort.download(ref)` (`src/application/ports/WireAssetPort.ts`), implemented by the Wire adapter over the SDK's `downloadAsset`.
- `IssueTrackerPort.addCustomerAttachment(key, { name, mimeType, data }, comment)`.
- Rules in `src/application/services/attachments.ts`: `ATTACHMENT_MAX_BYTES` (10 MB), `attachableKind(mimeType)`, `describeFile`, `formatAttachQuestion`, `attachmentComment`.
- `SupportRequest.lastMessageAt` (migration `20260928090000_add_support_request_last_message_at`); `setLastMessage` stamps it.
- Use cases `OfferAttachment(requests, offers, wireOutbound, logger?, now?)` with `execute({ conversationId, senderId, messageId, file }): Promise<boolean>`, and `AttachFileToRequest(requests, tracker, assets, wireOutbound, auditLog, logger?)` with `execute({ issueKey, file, conversationId, actorId, senderName?, replyToMessageId? }): Promise<boolean>`; `ConfirmOffer` hands a yes on an attach offer to the latter (`ConfirmOfferHandlers.attachFileToRequest`).
- Router (main session): `onAssetMessageReceived` applies the channel-state gate, ignores events without upload data, repeats of a message ID, self-deleting messages, files the bot sent, unattachable types and files over the limit, then calls `OfferAttachment` with passive help on. The reply quotes the file (the reply context accepts asset messages).

**Evidence required.** Unit tests with mocked ports; contract tests for asset routing (preview without upload data, repeats, self-deleting, state gates); one approved write check that the gateway accepts the attachment upload on a DS test ticket; a live staging check: desk asks for a photo, the driver posts one, yes attaches it, the desk sees it in Jira, the watch does not echo it; one PDF attached the same way; a self-deleting image gets no offer.

**Work split.** Main session: contract (ports, offer kind, use case signature, router hook), wiring, docs, playbook step. Subagents: (a) the Jira adapter method with tests; (b) the use cases (offer and attach) with tests. Then an independent review, the approved upload check and the live check.

**Wire Cells (checked 2026-09-28).** In conversations with Wire Cells, clients send files as multipart messages referring to files stored in Cells. SDK 0.1.0 (latest; `main` unchanged) does not decode multipart messages (`ProtobufDeserializer.ts`: "TODO: add support for multipart"), has no Cells download client, and its message definitions lack the Cells parts, so such files never reach the bot. The feature works only in conversations without Cells, where files arrive as classic assets.

**Out of scope.** Reading the photo with an AI vision model (for example to describe damage); possible later with a vision-capable local model, not planned.

### Handover for the next session (2026-09-26, evening)

**Start here.** Read AGENTS.md, then this section 6. The next task is "Jira updates in Wire by polling", including quoting the last ticket message: the plan is confirmed by the operator and nothing of it is built yet. Follow the usual pattern: write and commit the contract, parallel subagents in worktrees, an independent review, CLI checks (scripts grepped for write lines, offers answered no), then a live staging check where the operator acts as the desk agent in Jira. Everything listed below the plan is built, reviewed and checked live on staging, most recently on the local Ollama model.

**State.**
- Branch `demo/jira`, working tree clean, not pushed. `main` equals upstream `adamlow-wire/wire-team-bot` at `3c2d786`. The fork `mastaab/wire-team-bot` is the `fork` remote; upstream merges are the owner's decision.
- 1365 tests pass; `npx tsc --noEmit` and `npm run lint` are clean.
- The local database `wire_team_bot` has the `support_requests` migration applied (2026-09-26). It also has the `kind` column (2026-09-26) and the watch markers (2026-09-27). On 2026-09-27 the operator closed all support requests in Jira; the accidental CLI requests DS-6 and DS-12 were soft-deleted in the database with audit entries (operator-approved), so no request is open. On 2026-09-27 the operator soft-deleted ACT-0035 (a duplicate of a part order), ACT-0010 (wrongly marked done) and the CLI test action ACT-0034, each with an audit entry. The old `jira:` links on ACT-0005, ACT-0008, ACT-0010 and ACT-0012 are inert.
- The `.env` points all chat slots at a local Ollama model (`qwen3.5-4b`, registered from a Qwen3.5-4B GGUF, `WIRE_TEAM_BOT_LLM_REASONING_EFFORT=none`); switch the LLM lines back to the Claude API for the stronger model.
- The staging bot runs from this checkout on macOS (`npm run build && npm start`, loading `.env` with Wire staging, the model settings above, all Jira keys and `WIRE_TEAM_BOT_JIRA_SHARE_WITH_MODEL=on`). It was started from a Claude Code session and stops when that session ends; start it again with `npm run build && npm start` (Ollama must be running for the local model). `.env` carries the truck demo settings (`WIRE_TEAM_BOT_JIRA_PASSIVE=on`, `WIRE_TEAM_BOT_JIRA_REQUEST_TYPES=question=11809,part=11810,fault=11808`, the truck `WIRE_TEAM_BOT_JIRA_SERVICE_SCOPE`), so `npm start` is enough. For e2e runs and the simulation, put `WIRE_TEAM_BOT_JIRA_PASSIVE=off` in front of the command, since passive offers would otherwise count as unsolicited replies. Restart it after a rebuild; it stops when the Claude Code session that started it ends.
- Postgres 17 with pgvector via `brew services`. The staging channel's timezone is `Europe/Berlin` (now settable with `@Wire Team Bot timezone <name>`); the CLI channel is `UTC`.
- Jira: DS-1 to DS-5 are test tickets from the action-linked build; DS-6 to DS-20 are synthetic support requests from CLI and staging checks. Request types: Ask a question `11809`, Submit a request or incident `11808`, Replacement part `11810` (created by the operator 2026-09-26).

**Next steps (each Jira write needs the operator's approval).**
1. "Jira updates in Wire by polling" with quoting is built, reviewed and checked live (2026-09-27). Open: SLA wording for working-hours calendars (Jira's "0m" reads "under a minute" even when a cycle spanned hours outside working time); the DS sandbox now uses a 24/7 calendar.
2. All DS support requests are closed (2026-09-27); DS-1 to DS-5 remain as closed test tickets from the action-linked build.
3. Planned and confirmed, not built: "Photos and documents to the service desk" (above). Open, not built: German (driver-language) bot texts; for defence customers, a customer-hosted tracker (the local model works: see "Local model trial").
4. Push to the fork on request; upstream merge is the owner's decision.

**How to validate.**
- Unit gate: `npx tsc --noEmit; echo $?`, `npm run lint >/dev/null 2>&1; echo $?`, `npm test > log 2>&1; echo $?`. Check exit codes; never pipe the checked command into `tail`.
- Real-model checks: `printf '%s\n' "<line>" ... | LOG_LEVEL=warn node -r dotenv/config dist/app/cli.js`. Offers live in memory, so an offer and its answer must run in the same process; answer offers with `no`. **Direct commands (`support:`, `reply to DS-N:`, `resolve DS-N`) and any `yes` after an offer write to Jira at once**: keep them out of check scripts unless the operator approved the write (DS-6 and DS-12 were created this way by mistake).
- Throwaway databases: `wirebot` cannot create databases or the `vector` extension; create one with the local owner role (`createdb -O wirebot <name>`, then `psql -d <name> -c 'CREATE EXTENSION vector'`), point `DATABASE_URL` at it, and drop it afterwards. Never use `wire_team_bot` for tests.

**Pitfalls learned.**
- Subagent worktrees start from `main`: brief every subagent to reset or fast-forward to the contract commit, symlink `node_modules`, and remove the symlink before finishing.
- A message sent while the bot restarts may never be processed: on 2026-09-27 a question sent in the seconds between stopping and reconnecting got no answer, and the SDK logged one (redacted) error on reconnect. Do not restart the bot during a demo.
- The answer model explains commands only as its prompt describes them; a command named without a description gets guessed (secure mode was once described as switching off encryption). Describe every command the prompt names.
- Jira localises status names from `Accept-Language`; match statuses by category only.
- The agent-level token receives internal notes; only comments flagged `public: true` may reach Wire or the model.
- SLA clocks stop a few seconds after the transition; poll the SLA endpoint only.
- Model output is untrusted: code validates every offer, shows the full text that will be sent, and acts only on an explicit yes from the same requester as their next message.
- Writing rules for all text: British English, no em-dashes, no hard-wrapped paragraphs, no Co-Authored-By or AI attribution in commits or PRs.

The former v1/v2 plans, SDK migration plan and V3 gap list are superseded by this document.
Their historical text remains in Git. SDK operational cutover steps are retained in README;
there is no second active roadmap.
