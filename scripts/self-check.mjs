import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { agentDefinitions } from '../src/agents.ts';
import { requiredChannelDefinitions } from '../src/channels.ts';
import { extractOrionPlan, formatPlanForDiscord, validateOrionPlan } from '../src/plans.ts';

const root = process.cwd();

const expectedAgentOrder = ['orion', 'iris', 'atlas', 'sentinel', 'scout', 'echo', 'pulse'];
assert.deepEqual(agentDefinitions.map((agent) => agent.id), expectedAgentOrder, 'agent order changed');

const planningChannel = requiredChannelDefinitions.find((channel) => channel.id === 'pm-planning');
assert.equal(planningChannel?.displayName, 'orion-planning', 'planning channel should be named for Orion');
assert(planningChannel.aliases.includes('pm-planning'), 'old pm-planning name should remain an alias');
const helpChannel = requiredChannelDefinitions.find((channel) => channel.id === 'help');
assert.equal(helpChannel?.displayName, 'helppppppppppppppppppppppppppppppppppppp', 'joke help channel name should remain canonical');
assert(helpChannel.aliases.includes('help'), 'plain help channel name should remain an alias');

const expectedRequiredChannels = [
  'echo-command',
  'helppppppppppppppppppppppppppppppppppppp',
  'orion-planning',
  'echo-status',
  'echo-build-feed',
  'sentinel-qa',
  'echo-approvals',
  'iris-frontend',
  'atlas-backend',
  'scout-research',
  'scout-outreach',
  'pulse-checkins',
  'echo-manual-log',
  'echo-logs',
];
assert.deepEqual(
  requiredChannelDefinitions.map((channel) => channel.displayName),
  expectedRequiredChannels,
  'required channel display names changed unexpectedly'
);

const helpSource = await readFile(path.join(root, 'src', 'help.ts'), 'utf8');
for (const command of [
  '/goal',
  '/revise-goal',
  '/approve',
  '/run-agent',
  '/test',
  '/inspect-discord',
  '/plan',
  '/goal-status',
  '/runs',
  '/notify',
  '/pulse',
  '/pulse-checkin',
  '/daily-brief',
  '/cancel',
  '/clear-blocker',
  '/github-status',
  '/jira-status',
  '/log-change',
  '/decision',
]) {
  assert(helpSource.includes(command), `help source missing ${command}`);
}

assert(helpSource.includes('SwiftPark Command Center Guide'), 'help guide title missing');
assert(helpSource.includes('Example Workflow'), 'help guide example workflow missing');
assert(helpSource.includes('Approval Rules'), 'help guide approval rules missing');
assert(helpSource.includes('Notifications'), 'help guide notifications section missing');
assert(helpSource.includes('Future Integrations'), 'help guide integration readiness missing');

const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
assert(gitignore.split('\n').some((line) => line.trim() === '.env'), '.env must be ignored');

const fixturePlan = `
## User Story
- Validate the command center planning path.

## Intent / Why This Matters
- Prevent stuck planning states during overnight work.

## Affected Screens/Routes
- Discord command center only.

## Acceptance Criteria
- /goal shows progress.
- /plan retrieves saved plan content.
- /runs lists active and stale goals.
- /cancel marks disposable goals canceled.
- /agents remains phone-readable.

## Backend Tasks for Atlas
- No backend work expected unless a command handler bug appears.

## Frontend/Visual Tasks for Iris
- Not needed for this Discord-only validation.

## QA Plan for Sentinel
- Run command-center smoke checks.

## Visual Approval Checklist
- Not applicable for this Discord-only validation.

## Suggested Agent Assignment
- Orion plans.
- Atlas checks command handlers.
- Sentinel verifies command behavior.

## Risks / Constraints
- Do not touch secrets or external accounts.

## Human Approvals Needed
- Approve with /approve target:plan-<goal_id>.
`.trim();

assert(validateOrionPlan(fixturePlan), 'fixture plan should validate');
const summary = formatPlanForDiscord(fixturePlan, { mode: 'summary', maxLinesPerSection: 3 }).join('\n');
const full = formatPlanForDiscord(fixturePlan, { mode: 'full' }).join('\n');
assert(!summary.includes('more line(s)'), 'summary should not use collapsed line filler');
assert(!summary.includes('Backend Tasks for Atlas'), 'summary should hide unused backend section');
assert(!summary.includes('Frontend/Visual Tasks for Iris'), 'summary should hide unused frontend section');
assert(full.includes('Backend Tasks for Atlas'), 'full plan should keep backend section');
assert(full.includes('Frontend/Visual Tasks for Iris'), 'full plan should keep frontend section');

const longPlan = fixturePlan.replace(
  '- /agents remains phone-readable.',
  Array.from({ length: 35 }, (_, index) => `- Acceptance item ${index + 1}: keep this exact detail in Discord chunks.`).join('\n')
);
const fullChunks = formatPlanForDiscord(longPlan, { mode: 'full' });
assert(fullChunks.length > 1, 'long full plan should split across multiple Discord messages');
assert(fullChunks.every((chunk) => chunk.length <= 1800), 'full plan chunks should stay under Discord limits');
assert(fullChunks.join('\n').includes('Acceptance item 35'), 'full plan chunks should retain final details');
assert(!fullChunks.join('\n').includes('[truncated]'), 'full plan chunks should not use truncation marker');

const conversationalOrion = `
Yep, I would keep this as an Iris-only polish pass and leave backend out of scope.

## Execution Handoff
- Scope: Brighton selected spot state and mobile bottom sheet clarity.
- Iris: tighten selected-state visual hierarchy.
- Sentinel: run brighton-spot-map mobile and desktop only.
`.trim();
const conversationalExtract = extractOrionPlan(conversationalOrion);
assert(conversationalExtract.ok, 'conversational Orion responses should be accepted as valid saved plans');
assert(conversationalExtract.plan.includes('Iris-only polish pass'), 'conversational Orion content should be preserved');

for (const goalId of ['20260520051938-a1yc', '20260520055916-xinq']) {
  const runDir = path.join(root, 'runs', `goal-${goalId}`);
  for (const file of ['goal.json', 'status.json', 'state.json', 'plan.md']) {
    await access(path.join(runDir, file));
  }

  const status = JSON.parse(await readFile(path.join(runDir, 'status.json'), 'utf8'));
  assert(status.id === goalId, `status id mismatch for ${goalId}`);
  assert(status.currentStep, `missing currentStep for ${goalId}`);
  assert('elapsedMs' in status, `missing elapsedMs for ${goalId}`);
}

const registry = JSON.parse(await readFile(path.join(root, 'runs', 'agent-registry.json'), 'utf8'));
for (const agentId of expectedAgentOrder) {
  assert(registry[agentId], `agent registry missing ${agentId}`);
}

const botSource = await readFile(path.join(root, 'src', 'bot.ts'), 'utf8');
assert(botSource.includes('ORION_THREAD_REPLIES_ENABLED'), 'Orion thread reply env gate missing');
assert(botSource.includes("client.on('messageCreate'"), 'Orion thread message handler missing');
assert(botSource.includes('resolveGoalForInteraction'), 'goal thread inference helper missing');
assert(botSource.includes('classifyGoalThreadMessage'), 'goal thread message classifier missing');
assert(botSource.includes('greetingReply'), 'goal thread greeting response missing');
assert(botSource.includes('answerGoalThreadQuestion'), 'goal thread question answer path missing');
assert(botSource.includes('runOrionChat'), 'goal thread Codex chat reply path missing');
assert(botSource.includes('hasSuccessfulImplementationJob'), 'agent approval guard missing');
assert(botSource.includes('goalActionRows'), 'goal action buttons missing');
assert(botSource.includes('postGoalControls'), 'final goal controls helper missing');
assert(botSource.includes('goal:approve-run'), 'Approve + Run button missing');
assert(botSource.includes('goal:ask-orion'), 'Ask Orion button missing');
assert(botSource.includes('goal-modal:ask-orion'), 'Ask Orion modal missing');
assert(botSource.includes('TextInputStyle.Paragraph'), 'Ask Orion modal text input missing');
assert(botSource.includes('resolveExecutionDecision'), 'approve-and-run execution decision missing');
assert(botSource.includes('planHoldsAgent'), 'agent hold/not-needed decision guard missing');
assert(botSource.includes("'inspect-discord'"), 'read-only Discord inspection command missing');
assert(botSource.includes('discord-inspections'), 'Discord inspection local report path missing');
assert(botSource.includes("'execute-after-approval'"), 'execute-after-approval mode should be supported');
assert(botSource.includes('.setAutocomplete(true)'), 'goal autocomplete should be enabled for command options');
assert(botSource.includes('pulse:gym:yes'), 'Pulse gym yes button missing');
assert(botSource.includes('Pulse Gym Check'), 'Pulse gym prompt missing');
assert(botSource.includes('context/SWIFTPARK_PHASE7_CONTEXT.md'), 'Phase 7 context path should be surfaced in Pulse brief');
await access(path.join(root, 'context', 'SWIFTPARK_PHASE7_CONTEXT.md'));
for (const screen of [
  'brighton-facility',
  'brighton-spot-map',
  'brighton-spot-details',
  'brighton-navigation',
  'brighton-parked',
  'osu-facility',
  'osu-spot-map',
]) {
  assert(botSource.includes(`'${screen}'`), `QA screen missing ${screen}`);
}
assert(botSource.includes('selectedSet'), 'QA screenshot de-duplication guard missing');
assert(botSource.includes('QA result remains **${status}**'), 'QA upload warning should preserve PASS/FAIL status');
assert(botSource.includes('qaUnsupportedTargets'), 'unsupported QA target registry missing');
assert(botSource.includes('formatSentinelSkippedSummary'), 'Sentinel skipped-target summary missing');
assert(botSource.includes('resolveQaRoot'), 'Sentinel QA root resolver missing');
assert(botSource.includes('QA_ROOT'), 'Sentinel QA root override env support missing');
assert(botSource.includes('clearGoalBlocker'), 'stale blocker cleanup path missing');
assert(botSource.includes('postLongAgentText'), 'long Iris/Atlas output posting helper missing');
assert(!/console\.log\([^)]*process\.env/i.test(botSource), 'source must not log process.env');

console.log('self-check passed');
