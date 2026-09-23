---
name: skill-state
description: "Experimental long-horizon flow: short structured state plus an append-only log in a gitignored .skill-state/ directory, instead of replaying the whole chat. Load only when a task is procedural, spans ten or more tool calls, and its decisions must survive across turns. Skip for exploratory or creative work."
---

# SKILL.state — agent flow (experimental)

Long-horizon agent procedure based on *SKILL.state: Scalable Long-Horizon
Agent Skills* (Badhe, Tiwari, Chung; arXiv:2608.26263, EMNLP'26).

This skill is the **immutable procedure `P`** you (the agent) follow when
working on a task that runs through the `skill-state` flow. It
replaces the default "append full chat history to every prompt" pattern with
**short state, long log**: a small structured `state.json` plus an
append-only `transcript.jsonl` that stay outside the per-turn prompt.

Why JSON: schema-validatable, parseable in any language, diffable, no
section-parsing ambiguity. The CLI in `~/sync/code/skill-state/` validates
against an [ArkType](https://arktype.io) schema (same package, also gives
us TypeScript types).

## When to use

Use this flow when ALL of these hold:
- the task is procedural (schema-definable phases, not free exploration)
- it spans many turns / many tool calls (≥ ~10)
- decisions and findings need to survive across turns without re-derivation
- an audit trail of "what happened, when, by whom" matters

Do NOT use it for:
- discovery / brainstorming / first-pass research (no enumerable schema yet)
- creative work with shifting requirements (you'll lose useful history)
- single-step tasks (overhead exceeds benefit)

When in doubt, start without it. Adopt once the problem crystallizes.

## File layout (per skill run, inside the worktree)

```
.skill-state/                          # gitignored
├── state.json                         # active state Σ_t (editable, JSON object)
├── transcript.jsonl                   # append-only event log (one JSON object per line)
└── observations/
    └── obs-NNNN-<short-slug>.json     # raw observation per turn
```

`.skill-state/` MUST be in the worktree's `.gitignore`. The worktree root is
the only safe location — never in a harness config directory such as
`~/.claude/` or `~/.config/opencode/` (rendered from the dotfiles repo; state
left there leaks into other sessions).

## state.json schema

Single JSON object. Required fields (all enforced by the validator):

| field | type | notes |
|---|---|---|
| `schema_version` | `"1"` | literal; bump if format changes |
| `objective` | string ≥ 1 char | immutable after first prompt |
| `phase` | string ≥ 1 char | one of the procedure's allowed values |
| `phase_history` | array of `{phase, entered_at?, exited_at?}` | append-only |
| `inputs` | `Record<string, string>` | pr url, branch, worktree path, base |
| `findings` | `{peer_review?, qa?, security?}` arrays of Finding | append-only |
| `blockers` | array of Blocker | append-only; null = delete via patch |
| `decisions` | array of Decision | append-only |
| `sign_offs` | `{implementation?, peer_review?, qa?, security?, architect?}` `SignOff \| null` | null = pending |
| `architect_overrides` | array of `{from, to, reason}` | required to skip a phase |
| `next_action` | string, 1–200 chars | what the next turn does |
| `provenance` | `{last_observation_id, last_patch_id, validator_version?}` | every patch updates |

`Severity` enum: `"low" \| "med" \| "high" \| "blocker"` — same set for
findings and blockers.

### Example state.json

```json
{
  "schema_version": "1",
  "objective": "Add TOTP-based 2FA to the auth API. Target: 80% coverage on libs/auth/totp.ts.",
  "phase": "peer_review",
  "phase_history": [
    { "phase": "implementation", "entered_at": "2026-09-10T12:00:00Z", "exited_at": "2026-09-10T12:35:00Z" },
    { "phase": "peer_review", "entered_at": "2026-09-10T12:35:01Z" }
  ],
  "inputs": {
    "pr": "https://github.com/x/y/pull/482",
    "branch": "feat/add-2fa-totp",
    "worktree": "~/sync/code/worktrees/api/feat-add-2fa-totp",
    "base": "main"
  },
  "findings": {
    "peer_review": [
      {
        "id": "R-001",
        "severity": "high",
        "summary": "missing rate-limit on /verify",
        "pointer": "libs/auth/totp.ts:142",
        "created_at": "2026-09-10T12:40:00Z"
      }
    ],
    "qa": [],
    "security": []
  },
  "blockers": [
    {
      "id": "B-001",
      "raised_by": "reviewer",
      "severity": "blocker",
      "description": "no rate-limit on /verify allows brute-force of 6-digit codes",
      "pointer": "obs-0001",
      "created_at": "2026-09-10T12:40:00Z"
    }
  ],
  "decisions": [
    {
      "id": "D-001",
      "ts": "2026-09-10T12:00:30Z",
      "actor": "architect",
      "rationale": "window ±30s default, override via env TOTP_WINDOW for integration tests"
    }
  ],
  "sign_offs": {
    "implementation": {
      "by": "spy4x",
      "ts": "2026-09-10T12:35:00Z",
      "evidence": ["deno test coverage 81%", "playwright smoke pass"]
    },
    "peer_review": null,
    "qa": null,
    "security": null,
    "architect": null
  },
  "architect_overrides": [],
  "next_action": "address B-001 (rate-limit on /verify), then resubmit for peer_review",
  "provenance": {
    "last_observation_id": "obs-0001",
    "last_patch_id": "9b3c1f0a",
    "validator_version": "skill-state@0.1.0"
  }
}
```

### Hard rules for state.json

- **Deep-merge patches only.** To append one finding, the patch contains the
  full new `findings.peer_review` array (agent reads state first, copies,
  appends, emits). Arrays are replaced wholesale; the CLI does NOT do
  in-place appends.
- **`null` deletes the field.** Setting `{"foo": null}` in a patch removes
  `foo` from the result. Use this carefully — see "Append-only spirit"
  below.
- **Append-only spirit.** `findings`, `blockers`, `decisions`, `sign_offs`
  are not enforced append-only by the schema (you could replace an array).
  Self-discipline: never overwrite. To retract, add a new entry with
  `supersedes: ["R-001"]`. The transcript keeps the original for audit.
- **`objective` is immutable after the first prompt.** To change it, add a
  `decisions` entry with rationale and a new `objective` field in the patch;
  transcript makes the change auditable.
- **`phase` values come from the procedure document**, not invented.
  Default: `init → implementation → peer_review → qa → security → sign_off →
  done`. Custom skills may redefine.

## transcript.jsonl format

One JSON object per line. Append-only. NEVER edit past entries.

```jsonl
{"ts":"2026-09-10T12:00:30Z","actor":"architect","action":"init","patch":{"objective":"...","phase":"implementation","inputs":{...}},"observation":"bootstrap","validator":{"ok":true},"state_size_after":920}
{"ts":"2026-09-10T12:35:00Z","actor":"author","action":"submit_impl","patch":{"phase":"peer_review","sign_offs":{"implementation":{"by":"spy4x","ts":"2026-09-10T12:35:00Z"}}},"observation":"obs-0001","validator":{"ok":true},"state_size_after":1180}
{"ts":"2026-09-10T12:40:00Z","actor":"reviewer","action":"submit_review","patch":{"blockers":[...],"findings":{"peer_review":[...]}},"observation":"obs-0002","validator":{"ok":true},"state_size_after":1480}
```

Each line is one event. Append with the CLI (`append-event`) or hand-edit
using `jq -c '. + {ts: "..."}' >> transcript.jsonl`.

## observations/obs-NNNN-<slug>.json format

Single JSON object:

```json
{
  "id": "obs-0001",
  "captured": "2026-09-10T12:38:00Z",
  "from": "reviewer",
  "pointer": "feat/add-2fa-totp",
  "body": "Reviewed libs/auth/totp.ts (342 lines). ..."
}
```

Numbering is monotonically increasing per skill run. One file per turn.
`body` is the full raw observation, not summarized.

## Per-turn procedure

This is what `P` says. You, the agent, follow this every turn the user gives
you new work:

1. **Read** `.skill-state/state.json` (the only active-state source).
2. **Read** the latest `.skill-state/observations/obs-NNNN-*.json` (or the
   user's new message if there's no observation file yet — write one before
   patching).
3. **Check invariants** (see below). If any hard gate fails, your patch must
   fix the violation; do not silently let it pass.
4. **Plan the patch** mentally. Reason in scratch, but do NOT include
   reasoning in the response.
5. **Emit a patch** as a JSON object. The CLI deep-merges it onto state.json
   (object fields merge, scalars/arrays replace, `null` deletes).
6. **Validate** the new state by piping the patch through the CLI
   (`deno task apply state.json patch.json`) BEFORE writing it. If it
   reports errors, fix the patch; do not commit invalid state.
7. **Append a turn entry** to `transcript.jsonl` (one line, see format above).
8. **Update provenance**: `last_observation_id`, new `last_patch_id`,
   `state_size_chars`.
9. **Stop**. Do not narrate. Do not summarize what you did; the transcript
   is the record.

If the patch would invalidate state (bad enum, missing required field,
oversized), do not write it. Either fix the violation or surface the
problem to the user.

## Response contract

Your reply to the user must contain ONLY:

1. A JSON patch object (the one you validated in step 6 above) — wrapped in
   ```` ```json ```` for clarity OR emitted raw. No other prose around it.
2. OR the literal string `NO_OP: <reason>` if you decided no state change is
   needed.
3. Optional: a single-line confirmation (`applied` / `validation failed:
   <reason>`).

No prose summary. No "I did X, Y, Z." The transcript is the record. The user
reads state.json and transcript.jsonl to know what happened.

## Invariants (semantic gates — check BEFORE writing the patch)

These are the gaps a structural validator cannot catch. You must self-check:

1. **Phase order.** Phases advance forward. Skipping requires an
   `architect_overrides` entry with `from` / `to` / `reason`.
2. **Sign-off order.** You cannot sign `peer_review` without first signing
   `implementation`; cannot sign `qa` without `peer_review`; etc.
3. **No sign-off with open blockers of the same phase.** If
   `blockers[*].raised_by == <signing phase>`, that blocker must be resolved
   first (i.e., a superseding entry exists).
4. **Findings append-only.** Edits go in as new entries with `supersedes`.
5. **State size.** If `state.json` > ~30 KB, summarize the oldest half of
   `phase_history` into a `phase_history_archived` companion file and remove
   those entries before adding new turns.
6. **Provenance present.** Every patch updates `last_observation_id`,
   `last_patch_id`. The CLI also keeps `validator_version` matching.
7. **No silent overwrite of `objective`.** Adding `architect_overrides` or
   a `decisions` entry that changes scope is fine; editing `objective` text
   directly is not.

## Lifecycle

```
init  ──►  implementation  ──►  peer_review  ──►  qa  ──►  security  ──►  sign_off  ──►  done
                                                                              │
                                                                              ▼
                                                                           halted (unrecoverable failure)
```

- `init`: only the architect (you) sets `objective`, `phase=implementation`,
  `inputs`, and any initial `decisions`. One turn.
- `<phase>` work: actor for that phase works. They append to `findings`,
  `blockers`, `decisions`, set `sign_offs.<phase>` when complete, advance to
  next phase.
- `sign_off`: architect verifies all earlier sign-offs are present and
  signs. Transitions to `done`. Terminal action: tell the user "ready to
  merge" (or whatever the procedure calls for).
- `halted`: unrecoverable failure. Architect writes a `decisions` entry
  explaining why. No automatic recovery.

## Size limits and summarization

| Item | Soft limit | Hard limit | On overflow |
|---|---|---|---|
| `state.json` | 20 KB | 30 KB | archive oldest phase_history entries |
| `transcript.jsonl` | 1 MB | none | gzip + move to `transcript.archive/<date>.jsonl` |
| `observations/*.json` | 50 KB each | 200 KB each | split or summarize in next obs |

When `state.json` hits the soft limit, move the oldest half of
`phase_history` entries into `phase_history_archived.json` (one array of the
same shape), then drop them from `state.json`. Keep a pointer entry in
`phase_history` like `{ "phase": "_archive_pointer", "entered_at":
"<earliest archived ts>", "exited_at": "<latest archived ts>" }`.

## Optional CLI helpers

`~/sync/code/skill-state/` (github.com/spy4x/skill-state, private) ships a
small Deno CLI that catches the boring mistakes. Not required for the
flow — the agent can do everything by hand — but useful as a guard rail.

```bash
deno run -A ~/sync/code/skill-state/cli.ts validate .skill-state/state.json
deno run -A ~/sync/code/skill-state/cli.ts apply    .skill-state/state.json <patch>.json
deno run -A ~/sync/code/skill-state/cli.ts frame    .skill-state/state.json .skill-state/observations/obs-NNNN.json
deno run -A ~/sync/code/skill-state/cli.ts append-event .skill-state/transcript.jsonl <event>.json
```

- `validate` — ArkType schema check + size cap. Exits non-zero on failure.
- `apply` — deep-merges patch onto state, refuses to emit invalid state.
  Prints new state.json to stdout.
- `frame` — renders the per-turn execution frame (state + observation +
  response contract) so the agent sees a clean prompt without chat history.
- `append-event` — appends one JSON line to transcript.jsonl.

The CLI is a guard rail, not a runtime. The protocol in this file is the
source of truth.

## Reference

- Paper: arXiv:2608.26263 — *SKILL.state: Scalable Long-Horizon Agent
  Skills* (Badhe, Tiwari, Chung, EMNLP'26).
- Helpers: github.com/spy4x/skill-state (private). ArkType for validation.
- AlphaLab deep-dive (Chinese, with caveats): alphalab.site/skill-state-
  agent-memory.
