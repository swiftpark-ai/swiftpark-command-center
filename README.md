# SwiftPark Command Center

Discord command center bot for local SwiftPark agent workflows.

## Setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Create a local environment file:

   ```sh
   cp .env.example .env
   ```

3. Fill in `.env` with the Discord bot token, Discord application/guild IDs, allowed Discord user IDs, and local SwiftPark paths.

4. Start the bot:

   ```sh
   pnpm start
   ```

   The bot writes `runs/swiftpark-command-center.pid` while running. If another live bot process is already using the same token, startup stops with a clear message instead of letting two listeners race the same slash command.

5. In Discord, run:

   ```text
   /setup
   ```

`/setup` creates missing command-center channels in the `Stress Less` category without duplicating existing channels, posts a created/existing summary, refreshes the help channel, and refreshes `#echo-status`. A successful setup message starts with `Echo finished command-center setup.`

## Agents

- Orion: Project Manager / Orchestrator, powered by Codex / ChatGPT-style planning.
- Iris: Frontend & Visual Agent, powered by Claude Code.
- Atlas: Backend / Systems Agent, powered by Codex.
- Sentinel: QA / Visual Testing Agent, powered by Playwright + bot scripts.
- Scout: Research / YC / Reddit / Client Intel Agent, stubbed for now.
- Echo: Discord Comms / Status Reporter, powered by the bot.
- Pulse: Personal Check-in Agent for opt-in founder briefs, goal nudges, and gym check-ins.

Neo is reserved for the future SwiftPark user-facing assistant. Do not use Neo as the PM name.

## Channels

`/setup` manages these channels:

- `echo-command`
- `helppppppppppppppppppppppppppppppppppppp`
- `orion-planning`
- `echo-status`
- `echo-build-feed`
- `sentinel-qa`
- `echo-approvals`
- `iris-frontend`
- `atlas-backend`
- `scout-research`
- `scout-outreach`
- `pulse-checkins`
- `echo-manual-log`
- `echo-logs`

## Goal Flow

Create a goal:

```text
/goal description:<required> mode:<plan-only|execute-after-approval> primary_screen:<optional> agents:<atlas|iris|both|auto>
```

Defaults:

- `mode`: `plan-only`
- `agents`: `auto`

`/goal` creates `runs/goal-<id>/`, saves `goal.json`, `plan.md`, and `status.json`, writes a local GitHub issue body file for audit, creates a local worktree for agent isolation, asks Orion to plan, posts the complete plan to `#orion-planning` in multiple messages when needed, posts a summary to `#echo-build-feed`, and waits. Raw Codex CLI output is kept in the local job log; Discord and `plan.md` use only the extracted final Orion plan.

GitHub issue creation/editing is disabled unless `GITHUB_ISSUES_ENABLED=true` or `COMMAND_CENTER_GITHUB_ISSUES_ENABLED=true` is set. When disabled, the bot keeps the local `github-issue-body.md` file only.

`/status` skips `gh pr status` unless `GITHUB_STATUS_ENABLED=true` or GitHub issues are enabled.

During planning, `/goal` updates visible progress:

- goal received
- creating the local run record
- creating/checking the worktree
- running Orion planning
- Orion plan complete, or fallback plan generated
- posting the plan
- waiting for approval

For SwiftPark Phase 7/mobile-web goals, Orion automatically includes `context/SWIFTPARK_PHASE7_CONTEXT.md` when that file is present and the goal mentions Phase 7, mobile web, Brighton, OSU, Google Maps, Neo, operator dashboard, or the pilot loop.

Timeouts are configurable per agent:

- `ORION_PLANNING_TIMEOUT_MS`
- `IRIS_MAX_RUNTIME_MS`
- `ATLAS_MAX_RUNTIME_MS`
- `SENTINEL_MAX_RUNTIME_MS`
- fallback default: `AGENT_MAX_RUNTIME_MS`

Set a timeout to `0` for no hard kill. The bot still posts heartbeats and marks long-running work after `ORION_STALE_AFTER_MS` or `AGENT_STALE_AFTER_MS`. If Codex exits with an error, times out because a hard timeout was configured, or returns no plan, the bot writes and posts a `Fallback Orion Plan — Codex planning failed/timed out` so the workflow can continue safely.

Approve the plan:

```text
/approve target:plan-<goal_id>
```

Inside a goal thread, `/approve` can infer the current goal and choose the next relevant approval target.

In `plan-only` mode, approval is recorded and the goal waits for `/run-agent`. In `execute-after-approval` mode, Iris and/or Atlas run based on the selected assignment, then Sentinel runs visual QA.

## Run Agents

Run an agent manually:

```text
/run-agent agent:<orion|iris|atlas|sentinel|scout> goal_id:<optional> task:<optional>
```

- `orion` revises or expands the plan.
- `iris` runs `claude -p` in the goal worktree and posts to `#iris-frontend`.
- `atlas` runs `codex exec` in the goal worktree and posts to `#atlas-backend`.
- `sentinel` runs visual QA and posts selected screenshots to `#sentinel-qa`.
- `scout` is stubbed; it does not browse, scrape, access accounts, edit YC, or send messages.

Iris, Atlas, and Sentinel use their per-agent timeout settings, falling back to `AGENT_MAX_RUNTIME_MS`. `AGENT_MAX_RUNTIME_MS=0` lets long-running work continue while `#echo-status` heartbeats show elapsed time. `AGENT_STALE_AFTER_MS` only changes the visible status to long-running/stale; it does not kill the process.

Agent completion posts are phone-friendly:

- Iris summaries include concise result, files changed, visual impact, tests run, risks/follow-up, and next action.
- Atlas summaries include concise result, files changed, system impact, tests run, risks, and next action.
- Sentinel summaries include pass/fail, mode, selected screen(s), screenshots posted, local screenshot/report paths, warnings, and the approval or retry command.
- Failures include retry guidance and captured logs stay local unless a small redacted failure excerpt is useful.

Track agents:

```text
/agents
```

This shows each agent, role, tool, current status, current task, current step, elapsed time if running, last update, output channel, and current goal. The status board uses stable labels: 🟢 ready/idle, 🔵 running, 🟡 waiting approval, 🔴 failed, and ⚪ disabled/not configured.

Inspect or cancel goal runs:

```text
/plan goal_id:<optional> format:<summary|full>
/goal-status goal_id:<optional>
/runs limit:<optional>
/active-runs limit:<optional>
/cancel-goal goal_id:<optional> reason:<optional>
/cancel goal_id:<optional> reason:<optional>
/github-status
/jira-status
/log-change summary:<text> goal_id:<optional>
/decision summary:<text> rationale:<optional> goal_id:<optional>
```

`/plan`, `/goal-status`, `/cancel-goal`, `/cancel`, `/run-agent`, `/revise-goal`, `/approve`, and `/reject` infer the goal automatically when used inside a goal thread. Outside a thread, goal/target fields use Discord autocomplete for recent goals. `/plan` shows either a concise phone summary or the complete saved `plan.md` in clean Discord chunks. Orion's initial plan post uses the same full chunking path, so long plans should split across messages instead of dropping sections. `/goal-status` shows status, current step, agent, elapsed time, worktree path, whether `plan.md` exists, last error, and next expected action. `/runs` and `/active-runs` list recent, running, stale, failed, and approved goals. `/cancel-goal` and `/cancel` mark the goal canceled and stop tracked local subprocesses when possible. If an older subprocess survived a bot restart, stop it from the terminal and keep the run files for audit.

## Help And Revisions

Show onboarding and the command directory:

```text
/help
/commands
```

Ask Orion to revise a goal plan:

```text
/revise-goal feedback:<text> target:<general|plan|iris|atlas|sentinel> goal_id:<optional>
```

Revisions are conversational in Discord and saved as full Orion responses in the goal run folder. The saved `plan.md` remains the execution handoff for Iris, Atlas, and Sentinel. If `ORION_THREAD_REPLIES_ENABLED=true` and Discord's Message Content intent is enabled for the bot application, normal messages from allowed users inside a recognized goal thread are treated as Orion revision feedback. This is opt-in because enabling Message Content without the matching Discord developer-portal setting can prevent the bot from logging in.

## Notifications

Opt into completion and approval-needed notifications:

```text
/notify setting:on
/notify setting:off
/notify setting:status
```

Notifications mention opted-in users only. The bot does not use `@everyone` or `@here`.

## Pulse

Pulse is opt-in and posts in `#pulse-checkins`. It does not read normal chat messages.

```text
/pulse setting:on
/pulse setting:status
/pulse setting:gym-on
/pulse setting:gym-off
/pulse-checkin gym:yes
/pulse-checkin gym:not-yet
/daily-brief
```

When Pulse gym check-ins are on, it asks at `PULSE_GYM_PROMPT_HOUR:PULSE_GYM_PROMPT_MINUTE` in `PULSE_TIME_ZONE` whether you went to the gym. The default is noon in `America/Los_Angeles`. Pressing **Yes** or running `/pulse-checkin gym:yes` logs the day and returns `🍪`.

Pulse stores local state in `runs/pulse-state.json`, which is ignored by git.

## Approvals

Supported approval targets:

- `plan-<goal_id>`
- `agent-<goal_id>`
- `qa-<goal_id>`
- GitHub issue/PR/branch labels for human-readable approval tracking

No merge, deploy, push, PR creation, email sending, YC change, Jira action, or external account access is performed automatically.

## Future Integration Readiness

GitHub:

- `/github-status` shows current branch, origin/upstream remotes, fork/upstream hint, and optional `gh auth status`.
- `gh auth status` is skipped unless `GITHUB_STATUS_ENABLED=true` or GitHub issues are enabled.
- GitHub issue create/edit stays disabled unless `GITHUB_ISSUES_ENABLED=true` or `COMMAND_CENTER_GITHUB_ISSUES_ENABLED=true`.
- The bot does not push, create PRs, merge, deploy, or force-push.

Jira:

- `/jira-status` checks whether Jira env vars are present without contacting Jira and without printing token values.
- The bot runs without Jira env vars or token.
- `JIRA_ENABLED=true` only marks readiness; write commands still need future explicit approval gates.

Manual log:

- `/log-change` and `/decision` append Discord-first audit notes to `runs/manual-log.md` and post to `#echo-manual-log`.
- There is no external manual-log posting unless a future config-gated and approval-gated integration is added.

## QA Targeting

- `screen`: posts only mobile and desktop screenshots for the selected screen.
- `smoke`: posts the Brighton facility and Brighton spot-map core set.
- `full`: posts all available manual screenshots, capped by `QA_MAX_SCREENSHOT_UPLOADS`.

Standalone QA:

```text
/test mode:<smoke|screen|full> screen:<optional> label:<optional>
```

Default is `smoke`, not `full`.

## Safety

- Do not commit `.env`.
- Do not paste or print Discord tokens or API keys.
- `.env` files, tokens, cookies, private keys, and secret-looking values are redacted from captured logs before posting.
- Agents must not merge, deploy, push to GitHub, open PRs automatically, send emails, modify YC, or add Jira integration.
- Jira and manual change logs are intentionally deferred.

## pnpm Build Approval

This project allows the `esbuild` install build in `pnpm-workspace.yaml`. If pnpm reports `ERR_PNPM_IGNORED_BUILDS` for `esbuild`, verify that file contains:

```yaml
allowBuilds:
  esbuild: true
```

Then reinstall dependencies with `pnpm install`.
