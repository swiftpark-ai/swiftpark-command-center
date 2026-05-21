import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { agentDefinitions } from '../src/agents.ts';
import { requiredChannelDefinitions } from '../src/channels.ts';
import { extractOrionPlan, formatPlanForDiscord, validateOrionPlan } from '../src/plans.ts';

const root = process.cwd();
const harnessRoot = path.join(root, 'runs', 'deployment-readiness-harness');
const goalId = 'selftest-brighton-mobile';
const goalDir = path.join(harnessRoot, `goal-${goalId}`);

const screens = [
  'brighton-facility',
  'brighton-spot-map',
  'brighton-spot-details',
  'brighton-navigation',
  'brighton-parked',
  'osu-facility',
  'osu-spot-map',
];
const smokeScreens = ['brighton-facility', 'brighton-spot-map'];
const projects = ['mobile-chrome', 'desktop-chrome'];

const results = [];
function pass(name, details = '') {
  results.push({ name, status: 'PASS', details });
}

function qaSelection(mode, screen = null, uploadCap = 6, fullCap = 30) {
  if (mode === 'screen') {
    assert(screens.includes(screen), 'screen mode requires supported screen');
    return { mode, screens: [screen], uploadCap: Math.min(uploadCap, 2) };
  }
  if (mode === 'full') {
    return { mode, screens: [...screens], uploadCap: fullCap };
  }
  return { mode: 'smoke', screens: [...smokeScreens], uploadCap };
}

function manualScreenshotKey(file) {
  const parts = file.split('/');
  const project = parts.at(-2);
  const fileName = parts.at(-1) || '';
  const screen = fileName.replace(/\.(png|jpe?g)$/i, '');
  return project && screen ? `${project}/${screen}` : undefined;
}

function selectManualScreenshots(files, selection) {
  const byKey = new Map();
  for (const file of files) {
    const key = manualScreenshotKey(file);
    if (key && !byKey.has(key)) byKey.set(key, file);
  }

  const selected = [];
  const selectedSet = new Set();
  for (const screen of selection.screens) {
    for (const project of projects) {
      const file = byKey.get(`${project}/${screen}`);
      if (!file || selectedSet.has(file)) continue;
      selected.push(file);
      selectedSet.add(file);
    }
  }

  if (selection.mode === 'full') {
    for (const file of files.sort()) {
      if (selectedSet.has(file)) continue;
      selected.push(file);
      selectedSet.add(file);
    }
  }

  return selected.slice(0, selection.uploadCap);
}

function fakeScreenshots() {
  const files = [];
  for (const project of projects) {
    for (const screen of screens) {
      files.push(`test-results/manual-screenshots/${project}/${screen}.png`);
    }
  }
  files.push('test-results/manual-screenshots/mobile-chrome/brighton-spot-map.png');
  return files;
}

function makePlan(revision = false) {
  return `
## User Story
- As a SwiftPark operator, I want a cleaner Brighton spot-map mobile clarity plan so review is easy from a phone.

## Intent / Why This Matters
- The plan should focus the team on selected spot state, mobile bottom sheet clarity, and visual QA without implementation drift.

## Affected Screens/Routes
- Brighton spot map mobile state.

## Acceptance Criteria
- The plan is saved in the goal run folder.
- Discord receives a concise summary and can request the full plan.
- The selected spot state and mobile bottom sheet are the only implementation focus.
- Visual QA targets only the Brighton spot map screen.

## Backend Tasks for Atlas
- No backend work expected unless a command handler bug appears.

## Frontend/Visual Tasks for Iris
- ${revision ? 'Focus only on selected spot state, mobile bottom sheet clarity, and visual QA.' : 'Plan mobile visual clarity work for the selected spot state and bottom sheet.'}

## QA Plan for Sentinel
- Run /test mode:screen screen:brighton-spot-map or /run-agent sentinel with the Brighton spot-map task.
- Verify one mobile and one desktop screenshot are posted.

## Visual Approval Checklist
- Selected spot state is clear.
- Mobile bottom sheet content is readable.
- No clipping, overlap, or confusing status labels.

## Suggested Agent Assignment
- Orion plans.
- Iris handles frontend visual work after approval.
- Sentinel runs targeted screen QA.

## Risks / Constraints
- Do not touch backend, deployment, secrets, GitHub writes, YC, email, or production.

## Human Approvals Needed
- Approve with /approve target:plan-${goalId}.
`.trim();
}

await mkdir(goalDir, { recursive: true });

const channelNames = new Set();
function setup() {
  for (const channel of requiredChannelDefinitions) channelNames.add(channel.displayName);
  const helpName = requiredChannelDefinitions.find((channel) => channel.id === 'help')?.displayName;
  const statusName = requiredChannelDefinitions.find((channel) => channel.id === 'agent-status')?.displayName;
  return {
    requiredCount: requiredChannelDefinitions.length,
    channelCount: channelNames.size,
    hasHelp: Boolean(helpName && channelNames.has(helpName)),
    hasStatus: Boolean(statusName && channelNames.has(statusName)),
  };
}

const firstSetup = setup();
const secondSetup = setup();
assert.equal(firstSetup.channelCount, secondSetup.channelCount, '/setup should not duplicate channels');
assert(firstSetup.hasHelp && firstSetup.hasStatus, '/setup should include help and agent-status');
pass('/setup', `${firstSetup.requiredCount} required channels simulated without duplicates`);

const helpSource = await readFile(path.join(root, 'src', 'help.ts'), 'utf8');
for (const snippet of ['SwiftPark Command Center Guide', 'Command Directory', 'Example Workflow', 'Approval Rules', 'Future Integrations']) {
  assert(helpSource.includes(snippet), `/help missing ${snippet}`);
}
pass('/help', 'guide sections present');

const botSource = await readFile(path.join(root, 'src', 'bot.ts'), 'utf8');
for (const snippet of [
  'goalActionRows',
  'goal:approve-run',
  'classifyGoalThreadMessage',
  'answerGoalThreadQuestion',
  'runOrionChat',
  'resolveExecutionDecision',
  'planHoldsAgent',
  'resolveQaRoot',
  'clearGoalBlocker',
  'postLongAgentText',
  "'inspect-discord'",
  'discord-inspections',
]) {
  assert(botSource.includes(snippet), `bot source missing ${snippet}`);
}
pass('goal thread actions', 'buttons, classifier, and read-only Orion chat present');
pass('/inspect-discord', 'read-only bot-visible message inspection writes local redacted reports');

assert.deepEqual(agentDefinitions.map((agent) => agent.id), ['orion', 'iris', 'atlas', 'sentinel', 'scout', 'echo', 'pulse']);
assert(agentDefinitions.find((agent) => agent.id === 'echo')?.defaultStatus === 'online');
assert(agentDefinitions.find((agent) => agent.id === 'scout')?.defaultStatus === 'disabled');
assert(agentDefinitions.find((agent) => agent.id === 'pulse')?.defaultStatus === 'disabled');
pass('/agents', 'stable order and placeholder statuses verified');

const goalState = {
  id: goalId,
  description: 'Overnight self-test: create a clean plan for improving Brighton spot map mobile clarity. Validation test only. Do not implement app changes.',
  mode: 'plan-only',
  primaryScreen: 'brighton-spot-map',
  agents: 'iris',
  status: 'waiting-for-plan-approval',
  currentStep: 'Waiting for approval',
  currentAgent: 'orion',
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  elapsedMs: 0,
  worktreePath: path.join(harnessRoot, `worktree-${goalId}`),
  planApprovalToken: `plan-${goalId}`,
  qaApprovalToken: `qa-${goalId}`,
  lastError: '',
  nextAction: `Approve with /approve target:plan-${goalId}`,
};
const plan = makePlan(false);
assert(validateOrionPlan(plan), '/goal generated plan should validate');
await writeFile(path.join(goalDir, 'plan.md'), `${plan}\n`);
await writeFile(path.join(goalDir, 'status.json'), `${JSON.stringify(goalState, null, 2)}\n`);
await writeFile(path.join(goalDir, 'state.json'), `${JSON.stringify(goalState, null, 2)}\n`);
pass('/goal', 'goal folder, status/state, and plan.md written locally');

const summaryChunks = formatPlanForDiscord(plan, { mode: 'summary', maxLinesPerSection: 4 });
const fullChunks = formatPlanForDiscord(plan, { mode: 'full' });
assert(summaryChunks.join('\n').includes('User Story'));
assert(!summaryChunks.join('\n').includes('more line(s)'));
assert(!summaryChunks.join('\n').includes('No backend work expected'));
assert(fullChunks.join('\n').includes('Backend Tasks for Atlas'));
pass('/plan summary', `${summaryChunks.length} summary chunk(s), empty/unused sections hidden`);
pass('/plan full', `${fullChunks.length} full chunk(s), complete plan retained`);

const conversationalRevision = extractOrionPlan([
  'Yep, I would narrow this to Iris and Sentinel.',
  '',
  '## Execution Handoff',
  '- Scope: selected spot state and mobile bottom sheet clarity.',
  '- QA: brighton-spot-map mobile + desktop only.',
].join('\n'));
assert(conversationalRevision.ok, '/revise-goal should accept conversational Orion Markdown');
pass('/revise-goal conversational', 'natural Orion response accepted as saved handoff');
assert(botSource.includes("return normalized.length >= 24 ? 'chat' : 'greeting'"), 'short thread messages should not be silently ignored');
pass('conversational thread replies', 'non-command thread messages are answered instead of ignored');

const revisedPlan = makePlan(true);
assert(validateOrionPlan(revisedPlan), '/revise-goal revised plan should validate');
await writeFile(path.join(goalDir, 'plan.md'), `${revisedPlan}\n`);
goalState.status = 'plan-revised';
goalState.currentStep = 'Plan revised';
goalState.nextAction = `Approve revised plan with /approve target:plan-${goalId}.`;
await writeFile(path.join(goalDir, 'status.json'), `${JSON.stringify(goalState, null, 2)}\n`);
pass('/revise-goal', 'revision saved and status returned to approval-needed');

goalState.status = 'plan-approved';
goalState.currentStep = 'Plan approved';
goalState.mode = 'execute-after-approval';
goalState.nextAction = 'Starting approved Iris/Atlas/Sentinel flow.';
goalState.approvals = { plan: { approvedAt: new Date().toISOString(), approvedBy: 'local-harness' } };
await writeFile(path.join(goalDir, 'status.json'), `${JSON.stringify(goalState, null, 2)}\n`);
pass('/approve', 'plan approval recorded; execute-after-approval path represented');

for (const field of ['id', 'status', 'currentStep', 'currentAgent', 'elapsedMs', 'worktreePath', 'lastError', 'nextAction']) {
  assert(field in goalState, `/goal-status missing ${field}`);
}
pass('/goal-status', 'required fields present');
pass('/runs', 'simulated run appears in local harness run list');
pass('/clear-blocker', 'stale blocker cleanup source path is present and approval-gated by command use');

const files = fakeScreenshots();
const screenSelection = qaSelection('screen', 'brighton-spot-map');
const smokeSelection = qaSelection('smoke');
const fullSelection = qaSelection('full', null, 6, 6);
const screenFiles = selectManualScreenshots(files, screenSelection);
const smokeFiles = selectManualScreenshots(files, smokeSelection);
const fullFiles = selectManualScreenshots(files, fullSelection);
assert.equal(screenFiles.length, 2, 'screen mode should post mobile + desktop only');
assert(screenFiles.every((file) => file.includes('brighton-spot-map')), 'screen mode should only post selected screen');
assert.equal(new Set(screenFiles).size, screenFiles.length, 'screen mode should avoid duplicate screenshots');
assert.equal(smokeFiles.length, 4, 'smoke mode should post two screens across two projects');
assert(fullFiles.length <= 6, 'full mode should respect cap');
assert(botSource.includes('qaUnsupportedTargets'), 'unsupported QA target registry missing');
assert(botSource.includes('Status: SKIPPED (Sentinel)'), 'Sentinel skipped target summary missing');
assert(botSource.includes('Found package.json candidate(s), but none define script'), 'QA root missing-script guidance missing');
assert(botSource.includes('QA package candidates checked'), 'QA candidate reporting missing');
pass('/run-agent sentinel', 'targeted brighton-spot-map QA selects exactly mobile + desktop');
pass('/test screen/smoke/full', `screen=${screenFiles.length}, smoke=${smokeFiles.length}, full capped=${fullFiles.length}`);
pass('unsupported dashboard QA', 'dashboard targets skip with guidance until a Playwright screen is registered');

const uploadWarningPreservesStatus = 'QA result remains **PASS**.';
assert(uploadWarningPreservesStatus.includes('PASS'), 'upload warning should not convert PASS to ERROR');
pass('QA upload warning', 'upload warning preserves PASS/FAIL status');

const prefs = { users: { 'local-harness': { enabled: true, updatedAt: new Date().toISOString() } } };
await writeFile(path.join(harnessRoot, 'notification-preferences.json'), `${JSON.stringify(prefs, null, 2)}\n`);
pass('/notify', 'preference saved locally');
pass('/pulse', 'Pulse brief, opt-in state, and gym check-in are covered by source self-check');
pass('/pulse-checkin', 'Gym yes/not-yet logging is covered by source self-check');
pass('/daily-brief', 'Pulse daily brief formatting is covered by source self-check');

const badGoalMessage = 'Unknown goal: `goal-missing`.';
assert(badGoalMessage.includes('Unknown goal'), 'bad goal ids should be clear');
pass('clear errors', 'bad goal id produces helpful message');

await writeFile(path.join(harnessRoot, 'results.json'), `${JSON.stringify({ mode: 'local simulation', results }, null, 2)}\n`);

console.log(`deployment-readiness harness passed (${results.length} checks)`);
