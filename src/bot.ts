import 'dotenv/config';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from 'discord.js';
import { execa } from 'execa';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentDefinitions, type AgentDefinition, type AgentId, type AgentStatus } from './agents.js';
import {
  channelDefinitions,
  requiredChannelDefinitions,
  type ChannelDefinition,
  type ChannelId,
} from './channels.js';
import { buildCommandDirectory, buildHelpGuideMessages } from './help.js';
import { extractOrionPlan, formatPlanForDiscord } from './plans.js';

const required = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'ALLOWED_DISCORD_USER_IDS',
  'SWIFTPARK_REPO_PATH',
  'WORKTREES_DIR',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

const token = process.env.DISCORD_BOT_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.DISCORD_GUILD_ID!;
const repoPath = path.resolve(process.env.SWIFTPARK_REPO_PATH!);
const worktreesDir = path.resolve(process.env.WORKTREES_DIR!);
const commandCenterRoot = process.cwd();
const runsDir = path.resolve(process.env.RUNS_DIR || path.join(commandCenterRoot, 'runs'));
const botLockPath = path.join(runsDir, 'swiftpark-command-center.pid');
const baseRef = process.env.DISPATCHER_BASE_REF || 'origin/main';
const allowedUsers = new Set(
  process.env.ALLOWED_DISCORD_USER_IDS!.split(',').map((x) => x.trim()).filter(Boolean)
);

const qaCommand = process.env.QA_COMMAND || 'npm run qa';
const commandTimeoutMs = envMs('COMMAND_TIMEOUT_MS', 0);
const maxScreenshotUploads = Number(process.env.QA_MAX_SCREENSHOT_UPLOADS || 30);
const defaultScreenshotUploadCap = Number(process.env.QA_DEFAULT_SCREENSHOT_UPLOAD_CAP || 6);
const maxAgentLogChunks = Number(process.env.AGENT_LOG_DISCORD_CHUNKS || 2);
const orionPlanningTimeoutMs = envMs('ORION_PLANNING_TIMEOUT_MS', envMs('AGENT_MAX_RUNTIME_MS', 0));
const defaultAgentMaxRuntimeMs = envMs('AGENT_MAX_RUNTIME_MS', 0);
const irisMaxRuntimeMs = envMs('IRIS_MAX_RUNTIME_MS', defaultAgentMaxRuntimeMs);
const atlasMaxRuntimeMs = envMs('ATLAS_MAX_RUNTIME_MS', defaultAgentMaxRuntimeMs);
const sentinelMaxRuntimeMs = envMs('SENTINEL_MAX_RUNTIME_MS', defaultAgentMaxRuntimeMs || commandTimeoutMs);
const orionStaleAfterMs = Math.max(60000, envMs('ORION_STALE_AFTER_MS', 300000));
const agentStaleAfterMs = Math.max(60000, envMs('AGENT_STALE_AFTER_MS', 600000));
const agentHeartbeatMs = Math.max(15000, envMs('AGENT_HEARTBEAT_MS', envMs('ORION_HEARTBEAT_MS', 45000)));
const githubIssuesEnabled = envFlag('GITHUB_ISSUES_ENABLED') || envFlag('COMMAND_CENTER_GITHUB_ISSUES_ENABLED');
const githubStatusEnabled = envFlag('GITHUB_STATUS_ENABLED') || githubIssuesEnabled;
const jiraEnabled = envFlag('JIRA_ENABLED');
const manualLogPath = path.join(runsDir, 'manual-log.md');
const logicalChannelNames = new Map(channelDefinitions.map((channel) => [channel.id, channel.displayName]));

type QaMode = 'smoke' | 'screen' | 'full';
type GoalMode = 'plan-only' | 'execute-after-approval';
type GoalAgentChoice = 'atlas' | 'iris' | 'both' | 'auto';
type RunnableAgentId = 'orion' | 'iris' | 'atlas' | 'sentinel' | 'scout';
type JobStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'timed-out' | 'canceled';
type GoalStatus =
  | 'created'
  | 'planning'
  | 'waiting-for-plan-approval'
  | 'plan-approved'
  | 'plan-revised'
  | 'revision-pending-approval'
  | 'running'
  | 'agent-approved'
  | 'ready-for-qa-approval'
  | 'qa-approved'
  | 'blocked'
  | 'timed-out'
  | 'canceled';

type ShellResult = {
  ok: boolean;
  output: string;
  timedOut?: boolean;
  killed?: boolean;
};

type QaRunSummary = {
  status: 'PASS' | 'FAIL';
  label: string;
  mode: QaMode;
  screens: string[];
  uploaded: number;
  selected: number;
  available: number;
  skipped: number;
  warnings: string[];
  localScreenshots: string;
  localReport: string;
  playwrightSummary: string;
};

type ShellOptions = {
  timeoutMs?: number;
  activeKey?: string;
  goalId?: string;
  agent?: AgentId;
};

type GoalProgressReporter = (
  goal: GoalState | undefined,
  step: string,
  nextAction: string,
  detail?: string
) => Promise<void>;

type OrionPlanningResult = {
  plan: string;
  job: JobRecord;
  usedFallback: boolean;
  fallbackReason?: string;
};

type ApprovalRecord = {
  approvedAt: string;
  approvedBy: string;
};

type JobRecord = {
  id: string;
  goalId: string;
  agent: AgentId;
  task: string;
  status: JobStatus;
  branchName?: string;
  worktreePath?: string;
  startedAt: string;
  endedAt?: string;
  outputPath?: string;
  summary?: string;
  error?: string;
};

type GoalState = {
  id: string;
  description: string;
  mode: GoalMode;
  primaryScreen?: string;
  agents: GoalAgentChoice;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  currentStep?: string;
  currentAgent?: AgentId;
  lastError?: string;
  nextAction?: string;
  lastHeartbeatAt?: string;
  createdBy: string;
  runDir: string;
  branchName: string;
  worktreePath: string;
  issueUrl?: string;
  issueNumber?: string;
  githubWarning?: string;
  worktreeWarning?: string;
  threadId?: string;
  threadName?: string;
  planApprovalToken: string;
  qaApprovalToken: string;
  agentApprovalToken: string;
  paths: {
    goalJson: string;
    statusJson: string;
    stateJson: string;
    planMd: string;
    revisionsMd: string;
    orionPromptMd: string;
    issueBodyMd: string;
  };
  approvals: {
    plan?: ApprovalRecord;
    qa?: ApprovalRecord;
    agent?: ApprovalRecord;
  };
  jobs: JobRecord[];
};

type ChangedFileSummary = {
  status: string;
  file: string;
};

type AgentRuntimeState = AgentDefinition & {
  status: AgentStatus;
  currentTask: string;
  currentStep?: string;
  currentGoalId?: string;
  currentWorktree?: string;
  currentBranch?: string;
  startedAt?: string;
  lastUpdateAt: string;
  lastOutputSummary?: string;
};

type ChannelSetupResult = {
  channels: Record<string, TextChannel>;
  created: string[];
  existing: string[];
  categoryCreated: boolean;
};

type NotificationPreferences = {
  users: Record<string, {
    enabled: boolean;
    updatedAt: string;
  }>;
};

type StoredMessageRef = {
  channelId: string;
  messageId: string;
  updatedAt: string;
};

type StoredMessageRefs = {
  channelId: string;
  messages: Array<{
    messageId: string;
    updatedAt: string;
  }>;
};

const qaScreenNames = [
  'brighton-facility',
  'brighton-spot-map',
  'brighton-spot-details',
  'brighton-navigation',
  'brighton-parked',
  'osu-facility',
  'osu-spot-map',
] as const;

const qaSmokeScreens = [
  'brighton-facility',
  'brighton-spot-map',
] as const;

const qaProjects = [
  'mobile-chrome',
  'desktop-chrome',
] as const;

const activeJobs = new Map<string, JobRecord>();
const activeProcesses = new Map<string, {
  goalId?: string;
  agent?: AgentId;
  startedAt: string;
  subprocess: any;
}>();

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() || '');
}

function redactSensitive(input = ''): string {
  let output = input;
  const secretKeyPattern =
    /(TOKEN|SECRET|PASSWORD|PRIVATE|WEBHOOK|CREDENTIAL|AUTH|API[_-]?KEY|ACCESS[_-]?KEY|SESSION|COOKIE)/i;

  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !secretKeyPattern.test(key)) continue;
    output = output.split(value).join('[redacted]');
  }

  output = output.replace(
    /((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE|WEBHOOK|CREDENTIAL|AUTH|API[_-]?KEY|ACCESS[_-]?KEY|SESSION|COOKIE)[A-Z0-9_]*)\s*[:=]\s*)(["']?)[^\s"'`]+/gi,
    '$1[redacted]'
  );
  output = output.replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted]');
  output = output.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  output = output.replace(/\b(?:[A-Za-z0-9_-]{20,}\.){2}[A-Za-z0-9_-]{20,}\b/g, '[redacted-jwt]');
  output = output.replace(/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[redacted]');
  output = output.replace(/https?:\/\/\S*(?:token|key|secret|auth)\S*/gi, '[redacted-url]');

  return output;
}

function truncate(input: string, max = 1800): string {
  const safeInput = redactSensitive(input);
  if (!safeInput) return '(no output)';
  return safeInput.length > max ? safeInput.slice(0, max) + '\n...[truncated]' : safeInput;
}

function stripAnsi(input = ''): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function chunkText(input: string, max = 1500): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < input.length; index += max) {
    chunks.push(input.slice(index, index + max));
  }

  return chunks.length ? chunks : ['(no output)'];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'goal';
}

function createGoalId(): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${suffix}`;
}

function normalizeGoalId(input: string): string {
  return input.trim().replace(/^goal-/i, '').replace(/^plan-/i, '').replace(/^qa-/i, '').replace(/^agent-/i, '');
}

function formatElapsed(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const seconds = Math.max(Math.floor((end - start) / 1000), 0);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function elapsedMs(startedAt?: string, endedAt?: string): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  return Math.max(end - start, 0);
}

function formatMs(ms: number): string {
  const seconds = Math.floor(Math.max(ms, 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function hardTimeoutLabel(timeoutMs: number): string {
  return timeoutMs > 0 ? `Hard timeout: ${formatMs(timeoutMs)}.` : 'No hard timeout is configured.';
}

function runningNextAction(agent: AgentId, elapsed: number, hardTimeoutMs: number): string {
  const staleAfter = agent === 'orion' ? orionStaleAfterMs : agentStaleAfterMs;
  const name = agentDefinitions.find((definition) => definition.id === agent)?.displayName || agent;

  if (elapsed >= staleAfter) {
    return `${name} is still running after ${formatMs(elapsed)}. This may be normal for larger work. ${hardTimeoutLabel(hardTimeoutMs)} Use /goal-status or /cancel-goal if needed.`;
  }

  return `${name} is still running. ${hardTimeoutLabel(hardTimeoutMs)}`;
}

function timeoutForAgent(agent: RunnableAgentId): number {
  if (agent === 'orion') return orionPlanningTimeoutMs;
  if (agent === 'iris') return irisMaxRuntimeMs;
  if (agent === 'atlas') return atlasMaxRuntimeMs;
  if (agent === 'sentinel') return sentinelMaxRuntimeMs;
  return defaultAgentMaxRuntimeMs;
}

function quoteForShell(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativeToCommandCenter(filePath: string): string {
  return path.relative(commandCenterRoot, filePath) || '.';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeEditReply(interaction: any, content: string): Promise<boolean> {
  try {
    await interaction.editReply(truncate(content, 1900));
    return true;
  } catch {
    return false;
  }
}

function discordErrorCode(err: any): number | string | undefined {
  return err?.code ?? err?.rawError?.code ?? err?.data?.code;
}

function isUnknownInteractionError(err: any): boolean {
  return discordErrorCode(err) === 10062 || /Unknown interaction/i.test(err?.message || String(err));
}

function isInteractionAlreadyAcknowledgedError(err: any): boolean {
  return discordErrorCode(err) === 40060 || /already acknowledged/i.test(err?.message || String(err));
}

function isInteractionAckFailure(err: any): boolean {
  return isUnknownInteractionError(err) || isInteractionAlreadyAcknowledgedError(err);
}

async function safeDeferReply(interaction: any): Promise<boolean> {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferReply();
    return true;
  } catch (err: any) {
    if (isInteractionAckFailure(err)) {
      console.warn(
        `Ignored stale or duplicate /${interaction.commandName} interaction while acknowledging: ${err?.message || String(err)}`
      );
      return false;
    }
    throw err;
  }
}

async function safeInitialReply(interaction: any, payload: any): Promise<boolean> {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.reply(payload);
    return true;
  } catch (err: any) {
    if (isInteractionAckFailure(err)) {
      console.warn(
        `Ignored stale or duplicate /${interaction.commandName} interaction while replying: ${err?.message || String(err)}`
      );
      return false;
    }
    throw err;
  }
}

function isQaMode(value: string | null): value is QaMode {
  return value === 'smoke' || value === 'screen' || value === 'full';
}

function isGoalMode(value: string | null): value is GoalMode {
  return value === 'plan-only' || value === 'execute-after-approval';
}

function isGoalAgentChoice(value: string | null): value is GoalAgentChoice {
  return value === 'atlas' || value === 'iris' || value === 'both' || value === 'auto';
}

function isRunnableAgent(value: string | null): value is RunnableAgentId {
  return value === 'orion' || value === 'iris' || value === 'atlas' || value === 'sentinel' || value === 'scout';
}

function isQaScreenName(value: string | null): value is typeof qaScreenNames[number] {
  return Boolean(value && qaScreenNames.includes(value as typeof qaScreenNames[number]));
}

function validScreenList(): string {
  return qaScreenNames.map((screen) => `- \`${screen}\``).join('\n');
}

function getQaSelection(mode: QaMode, screen: string | null) {
  if (mode === 'screen') {
    return {
      mode,
      screens: screen ? [screen] : [],
      uploadCap: Math.min(defaultScreenshotUploadCap, 2),
    };
  }

  if (mode === 'full') {
    return {
      mode,
      screens: [...qaScreenNames],
      uploadCap: maxScreenshotUploads,
    };
  }

  return {
    mode,
    screens: [...qaSmokeScreens],
    uploadCap: defaultScreenshotUploadCap,
  };
}

function parseQaTask(task: string, defaultScreen?: string) {
  const lowerTask = task.toLowerCase();

  if (lowerTask.includes('full')) {
    return { mode: 'full' as QaMode, screen: null };
  }

  const taskScreen =
    qaScreenNames.find((screen) => lowerTask.includes(screen.toLowerCase())) ||
    (isQaScreenName(defaultScreen || null) ? defaultScreen : null);

  if (lowerTask.includes('screen') || taskScreen) {
    return taskScreen
      ? { mode: 'screen' as QaMode, screen: taskScreen }
      : { mode: 'smoke' as QaMode, screen: null };
  }

  return { mode: 'smoke' as QaMode, screen: null };
}

function buildQaScript(selection: ReturnType<typeof getQaSelection>): string {
  if (selection.mode === 'full' || selection.screens.length === 0) {
    return qaCommand;
  }

  const grep = selection.screens.map(escapeRegExp).join('|');
  return `${qaCommand} -- --grep ${quoteForShell(grep)}`;
}

function summarizeQaOutput(output: string): string {
  const safeOutput = stripAnsi(redactSensitive(output));
  const summaryLine = safeOutput
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^\d+\s+(passed|failed|skipped|flaky)\b/.test(line));

  return summaryLine || 'Playwright finished. See captured output if QA failed.';
}

function summarizeAgentOutput(output: string): string {
  const safeOutput = stripAnsi(redactSensitive(output || '(no output)'));
  const lines = safeOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return truncate(lines.slice(-24).join('\n') || safeOutput, 1200);
}

function extractSection(output: string, names: string[]): string {
  const safeOutput = stripAnsi(redactSensitive(output || ''));
  const escaped = names.map(escapeRegExp).join('|');
  const match = safeOutput.match(new RegExp(`(?:^|\\n)#{0,3}\\s*(?:${escaped})\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n#{0,3}\\s*[A-Z][A-Za-z /-]{2,}\\s*:?\\s*\\n|$)`, 'i'));
  const value = match?.[1]?.trim();
  if (value) return truncate(value, 500);

  const lines = safeOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(\$|>|npm |pnpm |yarn |codex |claude )/.test(line));
  return truncate(lines.slice(-5).join('\n') || '(not reported)', 500);
}

function formatChangedFiles(files: ChangedFileSummary[]): string {
  if (files.length === 0) return '- none reported';
  return files.slice(0, 12).map((file) => `- ${file.status} \`${file.file}\``).join('\n');
}

function retryGuidance(agent: RunnableAgentId, goal: GoalState): string {
  if (agent === 'iris') {
    return `Fix the UI/frontend blocker or Claude auth issue, then rerun \`/run-agent goal_id:${goal.id} agent:iris\`.`;
  }
  if (agent === 'atlas') {
    return `Fix the system/backend blocker or Codex auth issue, then rerun \`/run-agent goal_id:${goal.id} agent:atlas\`.`;
  }
  if (agent === 'sentinel') {
    return `Fix the QA failure, then rerun \`/run-agent goal_id:${goal.id} agent:sentinel\`.`;
  }
  if (agent === 'orion') {
    return `Revise the goal or retry with \`/run-agent goal_id:${goal.id} agent:orion\`.`;
  }
  return `Review the output and rerun \`/run-agent goal_id:${goal.id} agent:${agent}\` if still needed.`;
}

function formatImplementationAgentSummary(
  agent: 'iris' | 'atlas',
  goal: GoalState,
  job: JobRecord,
  output: string,
  files: ChangedFileSummary[]
): string {
  const succeeded = job.status === 'succeeded';
  const label = agent === 'iris' ? 'Iris / Claude' : 'Atlas / Codex';
  const impactLabel = agent === 'iris' ? 'Visual impact' : 'System impact';
  const impactSection = agent === 'iris'
    ? ['Visual impact', 'UI impact', 'Impact']
    : ['System impact', 'Backend impact', 'Impact'];
  const risksLabel = agent === 'iris' ? 'Risks / follow-up' : 'Risks';
  const nextAction = succeeded
    ? agent === 'iris'
      ? `Review UI changes, then run Sentinel: \`/run-agent goal_id:${goal.id} agent:sentinel\`.`
      : `Review system changes, then run Sentinel or approve agent work: \`/approve target:${goal.agentApprovalToken}\`.`
    : retryGuidance(agent, goal);

  return [
    `Status: ${succeeded ? 'PASS' : 'FAIL'} (${label})`,
    `Goal: goal-${goal.id}`,
    `Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}`,
    '',
    `Summary: ${extractSection(output, ['Summary'])}`,
    '',
    'Files changed:',
    formatChangedFiles(files),
    '',
    `${impactLabel}: ${extractSection(output, impactSection)}`,
    '',
    `Tests run: ${extractSection(output, ['Tests run', 'Tests'])}`,
    '',
    `${risksLabel}: ${extractSection(output, ['Risks or follow-up', 'Risks', 'Follow-up'])}`,
    '',
    `Next action: ${nextAction}`,
  ].join('\n');
}

function formatGenericAgentSummary(
  agent: RunnableAgentId,
  goal: GoalState,
  job: JobRecord,
  output: string
): string {
  const succeeded = job.status === 'succeeded';
  return [
    `Status: ${succeeded ? 'PASS' : 'FAIL'} (${agent})`,
    `Goal: goal-${goal.id}`,
    `Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}`,
    '',
    `Summary: ${extractSection(output, ['Summary'])}`,
    '',
    `Next action: ${succeeded ? defaultNextAction(goal) : retryGuidance(agent, goal)}`,
  ].join('\n');
}

function isForbiddenTask(task: string): string | undefined {
  const lower = task.toLowerCase();

  if (/\b(gh\s+pr\s+(create|merge)|git\s+merge|merge\s+(to|into)\s+(main|master))\b/.test(lower)) {
    return 'merge and PR creation require separate human approval';
  }

  if (/\b(git\s+push|gh\s+repo|push\s+branch|push\s+to\s+github)\b/.test(lower)) {
    return 'pushing to GitHub is blocked';
  }

  if (/\b(deploy|deployment|release\s+production|push\s+to\s+prod)\b/.test(lower)) {
    return 'deploy requires separate human approval';
  }

  if (/\b(send|email|mail)\b.*\b(client|customer|user|outreach|prospect)\b/.test(lower)) {
    return 'email sending is blocked';
  }

  if (/\byc\b|\by\s*combinator\b/.test(lower)) {
    return 'YC changes are blocked';
  }

  if (/\bjira\b/.test(lower)) {
    return 'Jira integration is intentionally deferred';
  }

  if (/\b(print|cat|show|dump|read)\b.*\.env\b/.test(lower)) {
    return '.env printing is blocked';
  }

  return undefined;
}

async function shell(command: string, args: string[], cwd: string, options: ShellOptions = {}): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  let subprocess: any;

  try {
    subprocess = execa(command, args, {
      cwd,
      all: true,
      stdin: 'ignore',
      timeout: timeoutMs > 0 ? timeoutMs : 0,
      env: process.env,
      stripFinalNewline: false,
    });

    if (options.activeKey) {
      activeProcesses.set(options.activeKey, {
        goalId: options.goalId,
        agent: options.agent,
        startedAt: new Date().toISOString(),
        subprocess,
      });
    }

    const result = await subprocess;

    return {
      ok: true,
      output: stripAnsi(redactSensitive(result.all || result.stdout || '')),
    };
  } catch (err: any) {
    const timedOut = Boolean(err.timedOut);
    const killed = Boolean(err.killed);
    const rawOutput = err.all || err.stdout || err.stderr || err.message || String(err);
    const timeoutPrefix = timedOut && timeoutMs > 0 ? `Command timed out after ${formatMs(timeoutMs)}.\n` : '';

    return {
      ok: false,
      output: stripAnsi(redactSensitive(`${timeoutPrefix}${rawOutput}`)),
      timedOut,
      killed,
    };
  } finally {
    if (options.activeKey) {
      activeProcesses.delete(options.activeKey);
    }
  }
}

async function shellScript(script: string, cwd: string, options: ShellOptions = {}) {
  return shell('bash', ['-lc', script], cwd, options);
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Create or repair SwiftPark command-center channels'),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show SwiftPark repo and GitHub status'),

    new SlashCommandBuilder()
      .setName('github-status')
      .setDescription('Show safe local GitHub readiness and optional gh auth status'),

    new SlashCommandBuilder()
      .setName('jira-status')
      .setDescription('Show safe Jira readiness without contacting Jira'),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show the SwiftPark command-center guide'),

    new SlashCommandBuilder()
      .setName('commands')
      .setDescription('Show the SwiftPark command directory'),

    new SlashCommandBuilder()
      .setName('agents')
      .setDescription('Show Orion, Iris, Atlas, Sentinel, Scout, Echo, and Pulse status'),

    new SlashCommandBuilder()
      .setName('run-agent')
      .setDescription('Run one approved SwiftPark command-center agent')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('agent')
          .setDescription('Agent to run')
          .setRequired(true)
          .addChoices(
            { name: 'orion', value: 'orion' },
            { name: 'iris', value: 'iris' },
            { name: 'atlas', value: 'atlas' },
            { name: 'sentinel', value: 'sentinel' },
            { name: 'scout', value: 'scout' }
          )
      )
      .addStringOption((option) =>
        option
          .setName('task')
          .setDescription('Optional task for the agent')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('test')
      .setDescription('Run visual QA and post selected screenshots')
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Screenshot upload mode')
          .setRequired(false)
          .addChoices(
            { name: 'smoke', value: 'smoke' },
            { name: 'screen', value: 'screen' },
            { name: 'full', value: 'full' }
          )
      )
      .addStringOption((option) =>
        option
          .setName('screen')
          .setDescription('Screen to post when mode is screen')
          .setRequired(false)
          .addChoices(...qaScreenNames.map((screen) => ({ name: screen, value: screen })))
      )
      .addStringOption((option) =>
        option
          .setName('label')
          .setDescription('Optional label for this QA run')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('goal')
      .setDescription('Ask Orion to plan a SwiftPark goal and wait for approval')
      .addStringOption((option) =>
        option
          .setName('description')
          .setDescription('Feature or task goal')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('mode')
          .setDescription('Dispatcher execution mode')
          .setRequired(false)
          .addChoices(
            { name: 'plan-only', value: 'plan-only' },
            { name: 'execute-after-approval', value: 'execute-after-approval' }
          )
      )
      .addStringOption((option) =>
        option
          .setName('primary_screen')
          .setDescription('Optional QA target screen')
          .setRequired(false)
          .addChoices(...qaScreenNames.map((screen) => ({ name: screen, value: screen })))
      )
      .addStringOption((option) =>
        option
          .setName('agents')
          .setDescription('Agent assignment preference')
          .setRequired(false)
          .addChoices(
            { name: 'atlas', value: 'atlas' },
            { name: 'iris', value: 'iris' },
            { name: 'both', value: 'both' },
            { name: 'auto', value: 'auto' }
          )
      ),

    new SlashCommandBuilder()
      .setName('goal-status')
      .setDescription('Show status for a goal, or the latest active goal')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Optional goal id from /goal')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('plan')
      .setDescription('Show a saved Orion plan summary or the full saved plan')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('format')
          .setDescription('Plan display format')
          .setRequired(false)
          .addChoices(
            { name: 'summary', value: 'summary' },
            { name: 'full', value: 'full' }
          )
      ),

    new SlashCommandBuilder()
      .setName('runs')
      .setDescription('List recent, active, stale, failed, and approved goal runs')
      .addIntegerOption((option) =>
        option
          .setName('limit')
          .setDescription('How many runs to show')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(15)
      ),

    new SlashCommandBuilder()
      .setName('active-runs')
      .setDescription('List recent, active, stale, failed, and approved goal runs')
      .addIntegerOption((option) =>
        option
          .setName('limit')
          .setDescription('How many runs to show')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(15)
      ),

    new SlashCommandBuilder()
      .setName('cancel-goal')
      .setDescription('Cancel a goal and stop tracked local agent work when possible')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Optional cancellation reason')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancel a goal and stop tracked local agent work when possible')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Optional cancellation reason')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('revise-goal')
      .setDescription('Ask Orion to revise a goal plan from feedback')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('feedback')
          .setDescription('Feedback for Orion to apply')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('What the feedback targets')
          .setRequired(false)
          .addChoices(
            { name: 'general', value: 'general' },
            { name: 'plan', value: 'plan' },
            { name: 'iris', value: 'iris' },
            { name: 'atlas', value: 'atlas' },
            { name: 'sentinel', value: 'sentinel' }
          )
      ),

    new SlashCommandBuilder()
      .setName('approve')
      .setDescription('Record approval for a plan, agent run, QA, PR, or issue')
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('plan-<goal_id>, qa-<goal_id>, agent-<goal_id>, PR, issue, or branch')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('reject')
      .setDescription('Record rejection/change request for a goal, plan, QA, PR, or issue')
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('Plan token, QA token, PR number, issue number, or branch')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('What needs to change')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('notify')
      .setDescription('Manage completion and approval-needed notifications')
      .addStringOption((option) =>
        option
          .setName('setting')
          .setDescription('Notification preference')
          .setRequired(true)
          .addChoices(
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
            { name: 'status', value: 'status' }
          )
      ),

    new SlashCommandBuilder()
      .setName('log-change')
      .setDescription('Record a Discord-first manual change note')
      .addStringOption((option) =>
        option
          .setName('summary')
          .setDescription('What changed')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Optional related goal id')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('decision')
      .setDescription('Record a Discord-first manual decision')
      .addStringOption((option) =>
        option
          .setName('summary')
          .setDescription('Decision made')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('rationale')
          .setDescription('Optional reason or context')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Optional related goal id')
          .setRequired(false)
      ),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
}

async function ensureChannels(guild: any): Promise<ChannelSetupResult> {
  await guild.channels.fetch().catch(() => undefined);

  let category = guild.channels.cache.find(
    (c: any) => c.name === 'SwiftPark Agents' && c.type === ChannelType.GuildCategory
  );
  let categoryCreated = false;

  if (!category) {
    category = await guild.channels.create({
      name: 'SwiftPark Agents',
      type: ChannelType.GuildCategory,
    });
    categoryCreated = true;
  }

  const channels: Record<string, TextChannel> = {};
  const created: string[] = [];
  const existing: string[] = [];

  for (const definition of channelDefinitions) {
    let channel = findGuildTextChannel(guild, definition);

    if (!channel && definition.id === 'help') {
      channel = await findStoredHelpChannel(guild);
    }

    if (!channel && definition.required) {
      channel = await guild.channels.create({
        name: definition.displayName,
        type: ChannelType.GuildText,
        parent: category.id,
      });
      created.push(definition.displayName);
    } else if (channel) {
      if (definition.id === 'pm-planning' && channel.name !== definition.displayName) {
        const canonicalExists = guild.channels.cache.find(
          (candidate: any) =>
            candidate.type === ChannelType.GuildText
            && String(candidate.name).toLowerCase() === definition.displayName.toLowerCase()
        );

        if (!canonicalExists) {
          try {
            channel = await channel.setName(
              definition.displayName,
              'SwiftPark Command Center rename: Orion owns planning output.'
            );
          } catch {
            // Keep using the existing alias if Discord permissions prevent a rename.
          }
        }
      }

      existing.push(channel.name);
    }

    if (channel) {
      channels[definition.id] = channel as TextChannel;
    }
  }

  return { channels, created, existing, categoryCreated };
}

function findGuildTextChannel(guild: any, definition: ChannelDefinition): TextChannel | undefined {
  const canonicalName = definition.displayName.toLowerCase();
  const canonical = guild.channels.cache.find(
    (channel: any) => channel.type === ChannelType.GuildText && String(channel.name).toLowerCase() === canonicalName
  );
  if (canonical) return canonical as TextChannel;

  const acceptableNames = new Set(definition.aliases.map((name) => name.toLowerCase()));
  return guild.channels.cache.find(
    (channel: any) => channel.type === ChannelType.GuildText && acceptableNames.has(String(channel.name).toLowerCase())
  ) as TextChannel | undefined;
}

async function findStoredHelpChannel(guild: any): Promise<TextChannel | undefined> {
  const refs = await readStoredMessageRefs(helpGuideRefPath());
  if (!refs?.channelId) return undefined;

  const channel = guild.channels.cache.get(refs.channelId) || (await guild.channels.fetch(refs.channelId).catch(() => undefined));
  if (channel?.type === ChannelType.GuildText) {
    return channel as TextChannel;
  }

  return undefined;
}

async function refreshStoredHelpGuide(): Promise<void> {
  const guild = await client.guilds.fetch(guildId).catch(() => undefined);
  if (!guild) return;

  await guild.channels.fetch().catch(() => undefined);
  const helpChannel = await findStoredHelpChannel(guild);
  if (!helpChannel) return;

  await postOrUpdateStoredMessages(helpGuideRefPath(), helpChannel, buildHelpGuideMessages(requiredChannelDefinitions));
}

async function refreshStoredAgentStatusBoard(): Promise<void> {
  const guild = await client.guilds.fetch(guildId).catch(() => undefined);
  if (!guild) return;

  await guild.channels.fetch().catch(() => undefined);
  const ref = await readStoredMessageRef(statusBoardRefPath());
  if (!ref?.channelId) return;

  const channel = guild.channels.cache.get(ref.channelId) || (await guild.channels.fetch(ref.channelId).catch(() => undefined));
  if (channel?.type === ChannelType.GuildText) {
    await postOrUpdateStoredMessage(statusBoardRefPath(), channel as TextChannel, await formatAgentsStatus());
  }
}

function goalRunDir(goalId: string): string {
  return path.join(runsDir, `goal-${goalId}`);
}

function goalPaths(goalId: string) {
  const runDir = goalRunDir(goalId);
  return {
    goalJson: path.join(runDir, 'goal.json'),
    statusJson: path.join(runDir, 'status.json'),
    stateJson: path.join(runDir, 'state.json'),
    planMd: path.join(runDir, 'plan.md'),
    revisionsMd: path.join(runDir, 'revisions.md'),
    orionPromptMd: path.join(runDir, 'orion-prompt.md'),
    issueBodyMd: path.join(runDir, 'github-issue-body.md'),
  };
}

function agentRegistryPath(): string {
  return path.join(runsDir, 'agent-registry.json');
}

function notificationPreferencesPath(): string {
  return path.join(runsDir, 'notification-preferences.json');
}

function statusBoardRefPath(): string {
  return path.join(runsDir, 'agent-status-board.json');
}

function helpGuideRefPath(): string {
  return path.join(runsDir, 'help-guide-message.json');
}

function defaultAgentState(definition: AgentDefinition): AgentRuntimeState {
  return {
    ...definition,
    status: definition.defaultStatus,
    currentTask: definition.defaultStatus === 'online' ? 'Online' : '',
    lastUpdateAt: new Date().toISOString(),
  };
}

async function readAgentRegistry(): Promise<Record<AgentId, AgentRuntimeState>> {
  let existing: Partial<Record<AgentId, AgentRuntimeState>> = {};

  try {
    existing = JSON.parse(await fs.readFile(agentRegistryPath(), 'utf8'));
  } catch {
    existing = {};
  }

  const result = {} as Record<AgentId, AgentRuntimeState>;

  for (const definition of agentDefinitions) {
    result[definition.id] = {
      ...defaultAgentState(definition),
      ...(existing[definition.id] || {}),
      ...definition,
    };
  }

  return result;
}

async function writeAgentRegistry(registry: Record<AgentId, AgentRuntimeState>): Promise<void> {
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(agentRegistryPath(), JSON.stringify(registry, null, 2) + '\n');
}

async function updateAgent(
  agentId: AgentId,
  patch: Partial<AgentRuntimeState>
): Promise<AgentRuntimeState> {
  const registry = await readAgentRegistry();
  const current = registry[agentId];
  const updated: AgentRuntimeState = {
    ...current,
    ...patch,
    lastUpdateAt: new Date().toISOString(),
  };

  registry[agentId] = updated;
  await writeAgentRegistry(registry);
  return updated;
}

async function setAgentRunning(agentId: AgentId, goal: GoalState | undefined, task: string): Promise<void> {
  await updateAgent(agentId, {
    status: 'running',
    currentTask: redactSensitive(task),
    currentStep: redactSensitive(task),
    currentGoalId: goal?.id,
    currentWorktree: goal?.worktreePath,
    currentBranch: goal?.branchName,
    startedAt: new Date().toISOString(),
    lastOutputSummary: undefined,
  });
}

async function setAgentFinished(agentId: AgentId, ok: boolean, summary: string): Promise<void> {
  const definition = agentDefinitions.find((agent) => agent.id === agentId);
  const idleStatus = definition?.defaultStatus === 'online' ? 'online' : definition?.defaultStatus === 'disabled' ? 'disabled' : 'idle';

  await updateAgent(agentId, {
    status: ok ? idleStatus : 'failed',
    currentTask: ok ? '' : 'Last run failed',
    currentStep: undefined,
    currentGoalId: undefined,
    currentWorktree: undefined,
    currentBranch: undefined,
    startedAt: undefined,
    lastOutputSummary: summarizeAgentOutput(summary),
  });
}

async function readNotificationPreferences(): Promise<NotificationPreferences> {
  try {
    return JSON.parse(await fs.readFile(notificationPreferencesPath(), 'utf8')) as NotificationPreferences;
  } catch {
    return { users: {} };
  }
}

async function writeNotificationPreferences(preferences: NotificationPreferences): Promise<void> {
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(notificationPreferencesPath(), JSON.stringify(preferences, null, 2) + '\n');
}

async function setNotificationPreference(userId: string, enabled: boolean): Promise<void> {
  const preferences = await readNotificationPreferences();
  preferences.users[userId] = {
    enabled,
    updatedAt: new Date().toISOString(),
  };
  await writeNotificationPreferences(preferences);
}

async function notificationStatus(userId: string): Promise<boolean> {
  const preferences = await readNotificationPreferences();
  return Boolean(preferences.users[userId]?.enabled);
}

async function notifySubscribers(
  channels: Record<string, TextChannel>,
  message: string,
  options: { includeUserId?: string; channelId?: ChannelId } = {}
): Promise<void> {
  const preferences = await readNotificationPreferences();
  const users = new Set(
    Object.entries(preferences.users)
      .filter(([, preference]) => preference.enabled)
      .map(([userId]) => userId)
  );

  if (options.includeUserId) {
    users.add(options.includeUserId);
  }

  if (users.size === 0) return;

  const mentions = [...users].map((userId) => `<@${userId}>`).join(' ');
  const channel = channels[options.channelId || 'agent-status'] || channels['logs'];
  if (!channel) return;

  await channel.send({
    content: `${mentions}\n${redactSensitive(message)}`,
    allowedMentions: { users: [...users], roles: [], parse: [] },
  }).catch(() => undefined);
}

async function readStoredMessageRef(filePath: string): Promise<StoredMessageRef | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredMessageRef;
  } catch {
    return undefined;
  }
}

async function writeStoredMessageRef(filePath: string, ref: StoredMessageRef): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(ref, null, 2) + '\n');
}

async function readStoredMessageRefs(filePath: string): Promise<StoredMessageRefs | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as StoredMessageRefs | StoredMessageRef;

    if ('messages' in parsed && Array.isArray(parsed.messages)) {
      return parsed;
    }

    if ('messageId' in parsed) {
      return {
        channelId: parsed.channelId,
        messages: [
          {
            messageId: parsed.messageId,
            updatedAt: parsed.updatedAt,
          },
        ],
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

async function writeStoredMessageRefs(filePath: string, ref: StoredMessageRefs): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(ref, null, 2) + '\n');
}

async function postOrUpdateStoredMessage(
  filePath: string,
  channel: TextChannel,
  content: string
): Promise<void> {
  const safeContent = truncate(content, 1900);
  const existing = await readStoredMessageRef(filePath);

  if (existing?.channelId === channel.id) {
    try {
      const message = await channel.messages.fetch(existing.messageId);
      await message.edit(safeContent);
      await writeStoredMessageRef(filePath, {
        channelId: channel.id,
        messageId: message.id,
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch {
      // Fall through and post a fresh message.
    }
  }

  const message = await channel.send(safeContent);
  await writeStoredMessageRef(filePath, {
    channelId: channel.id,
    messageId: message.id,
    updatedAt: new Date().toISOString(),
  });
}

async function postOrUpdateStoredMessages(
  filePath: string,
  channel: TextChannel,
  contents: string[]
): Promise<void> {
  const existing = await readStoredMessageRefs(filePath);
  const messageRefs: StoredMessageRefs['messages'] = [];

  for (const [index, content] of contents.entries()) {
    const payload = storedMessagePayload(content, index);

    const existingMessage = existing?.channelId === channel.id ? existing.messages[index] : undefined;

    if (existingMessage) {
      try {
        const message = await channel.messages.fetch(existingMessage.messageId);
        await message.edit(payload);
        messageRefs.push({
          messageId: message.id,
          updatedAt: new Date().toISOString(),
        });
        continue;
      } catch {
        // Fall through and post a fresh message for this chunk.
      }
    }

    const message = await channel.send(payload);
    messageRefs.push({
      messageId: message.id,
      updatedAt: new Date().toISOString(),
    });
  }

  await writeStoredMessageRefs(filePath, {
    channelId: channel.id,
    messages: messageRefs,
  });
}

function storedMessagePayload(content: string, index: number) {
  if (content.length <= 4096) {
    return {
      content: '',
      embeds: [
        {
          description: content,
          color: 0x2f80ed,
        },
      ],
    };
  }

  throw new Error(`Stored message chunk ${index + 1} is ${content.length} characters; embed description limit is 4096.`);
}

async function readGoalState(goalId: string): Promise<GoalState | undefined> {
  const normalized = normalizeGoalId(goalId);
  const paths = goalPaths(normalized);

  for (const file of [paths.goalJson, paths.stateJson]) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as GoalState;
      parsed.paths = { ...paths, ...(parsed.paths || {}) };
      parsed.approvals ||= {};
      parsed.jobs ||= [];
      parsed.startedAt ||= parsed.createdAt;
      parsed.currentStep ||= parsed.status === 'planning' ? 'Running Orion planning' : parsed.status;
      parsed.nextAction ||= defaultNextAction(parsed);
      parsed.elapsedMs = elapsedMs(parsed.startedAt, parsed.endedAt);
      return parsed;
    } catch {
      // Try the next path.
    }
  }

  return undefined;
}

async function writeGoalState(goal: GoalState, plan?: string): Promise<GoalState> {
  goal.updatedAt = new Date().toISOString();
  goal.startedAt ||= goal.createdAt;
  goal.elapsedMs = elapsedMs(goal.startedAt, goal.endedAt);
  if (goal.lastError) goal.lastError = redactSensitive(goal.lastError);
  if (goal.nextAction) goal.nextAction = redactSensitive(goal.nextAction);
  await fs.mkdir(goal.runDir, { recursive: true });
  await fs.writeFile(goal.paths.goalJson, JSON.stringify(goal, null, 2) + '\n');
  await fs.writeFile(goal.paths.stateJson, JSON.stringify(goal, null, 2) + '\n');
  await fs.writeFile(
    goal.paths.statusJson,
    JSON.stringify(
      {
        id: goal.id,
        status: goal.status,
        mode: goal.mode,
        agents: goal.agents,
        primaryScreen: goal.primaryScreen,
        issueUrl: goal.issueUrl,
        branchName: goal.branchName,
        worktreePath: goal.worktreePath,
        threadId: goal.threadId,
        threadName: goal.threadName,
        startedAt: goal.startedAt,
        endedAt: goal.endedAt,
        elapsedMs: goal.elapsedMs,
        currentStep: goal.currentStep,
        currentAgent: goal.currentAgent,
        lastError: goal.lastError,
        nextAction: goal.nextAction,
        lastHeartbeatAt: goal.lastHeartbeatAt,
        approvals: goal.approvals,
        updatedAt: goal.updatedAt,
        jobs: goal.jobs.slice(-10),
      },
      null,
      2
    ) + '\n'
  );

  if (plan !== undefined) {
    await fs.writeFile(goal.paths.planMd, redactSensitive(plan) + '\n');
  }

  return goal;
}

function defaultNextAction(goal: GoalState): string {
  if (goal.status === 'waiting-for-plan-approval' || goal.status === 'plan-revised') {
    return `Approve with /approve target:${goal.planApprovalToken}`;
  }
  if (goal.status === 'plan-approved') return 'Run /run-agent or wait for execute-after-approval flow.';
  if (goal.status === 'ready-for-qa-approval') return `Approve QA with /approve target:${goal.qaApprovalToken}`;
  if (goal.status === 'planning') return 'Wait for Orion plan or timeout fallback.';
  if (goal.status === 'timed-out') return 'Review fallback plan or revise with /revise-goal.';
  if (goal.status === 'canceled') return 'Rerun /goal if this work is still needed.';
  if (goal.status === 'blocked') return 'Use /revise-goal or rerun /goal after resolving the issue.';
  return 'Check /goal-status for the latest state.';
}

async function updateGoalStep(
  goalId: string,
  currentStep: string,
  nextAction: string,
  patch: Partial<GoalState> = {}
): Promise<GoalState> {
  const updated = await updateGoalState(goalId, (current) => {
    Object.assign(current, patch);
    current.currentStep = redactSensitive(currentStep);
    current.nextAction = redactSensitive(nextAction);
    current.lastHeartbeatAt = new Date().toISOString();
  });

  if (updated.currentAgent) {
    await updateAgent(updated.currentAgent, {
      currentStep: updated.currentStep,
      currentTask: updated.currentStep || '',
      currentGoalId: updated.id,
      currentWorktree: updated.worktreePath,
      currentBranch: updated.branchName,
    }).catch(() => undefined);
  }

  return updated;
}

async function updateGoalState(
  goalId: string,
  updater: (goal: GoalState) => GoalState | void
): Promise<GoalState> {
  const goal = await readGoalState(goalId);
  if (!goal) {
    throw new Error(`Unknown goal: ${goalId}`);
  }

  const updated = updater(goal) || goal;
  return writeGoalState(updated);
}

async function listGoalStates(): Promise<GoalState[]> {
  try {
    const files = await fg('goal-*/goal.json', {
      cwd: runsDir,
      absolute: false,
      onlyFiles: true,
      dot: true,
    });

    const goals = await Promise.all(
      files.map(async (file) => {
        const goalId = normalizeGoalId(path.dirname(file));
        return readGoalState(goalId);
      })
    );

    return goals
      .filter((goal): goal is GoalState => Boolean(goal))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function upsertJob(goal: GoalState, job: JobRecord): void {
  const index = goal.jobs.findIndex((existing) => existing.id === job.id);
  if (index >= 0) {
    goal.jobs[index] = job;
  } else {
    goal.jobs.push(job);
  }
}

async function createIssueBody(goal: GoalState, plan?: string): Promise<string> {
  const safePlan = plan ? redactSensitive(plan) : '';

  return `
Created from Discord by <@${goal.createdBy}>.

## Goal
${goal.description}

## Command Center
- Goal id: \`${goal.id}\`
- Mode: \`${goal.mode}\`
- Agents: \`${goal.agents}\`
- Primary screen: ${goal.primaryScreen ? `\`${goal.primaryScreen}\`` : '(none)'}
- Branch: \`${goal.branchName}\`
- Worktree: \`${goal.worktreePath}\`
- Plan approval token: \`${goal.planApprovalToken}\`
- QA approval token: \`${goal.qaApprovalToken}\`
- Agent approval token: \`${goal.agentApprovalToken}\`
- Status: \`${goal.status}\`

## Agent Names
- Orion: PM / Orchestrator
- Iris: Frontend / Visual
- Atlas: Backend / Systems
- Sentinel: QA / Visual Testing
- Neo is reserved for the future SwiftPark user-facing assistant.

## Required Workflow
- Orion plans first; no code before \`/approve ${goal.planApprovalToken}\`.
- Atlas and Iris run only in local isolated worktrees.
- Sentinel posts visual screenshots before final approval.
- Do not merge without human approval.
- Do not deploy without human approval.
- Do not send emails.
- Do not make YC changes.
- Do not print .env files, tokens, cookies, or private keys.
- Do not push branches or open PRs automatically.

## Orion Plan
${safePlan || '_Pending Orion planning step._'}
`.trim();
}

async function writeIssueBody(goal: GoalState, plan?: string): Promise<void> {
  await fs.writeFile(goal.paths.issueBodyMd, (await createIssueBody(goal, plan)) + '\n');
}

async function createGithubIssue(goal: GoalState): Promise<{ issueUrl?: string; issueNumber?: string; warning?: string }> {
  await writeIssueBody(goal);

  if (!githubIssuesEnabled) {
    return { warning: 'GitHub issue tracking is disabled by config. Local issue body was saved only.' };
  }

  const issue = await shell(
    'gh',
    ['issue', 'create', '--title', `Goal ${goal.id}: ${goal.description.slice(0, 80)}`, '--body-file', goal.paths.issueBodyMd],
    repoPath
  );

  if (!issue.ok) {
    return { warning: issue.output };
  }

  const issueUrl = issue.output.match(/https?:\/\/\S+/)?.[0] || issue.output.trim();
  const issueNumber = issueUrl.match(/\/issues\/(\d+)/)?.[1] || goal.id;
  return { issueUrl, issueNumber };
}

async function updateGithubIssueWithPlan(goal: GoalState, plan: string): Promise<string | undefined> {
  if (!githubIssuesEnabled) {
    await writeIssueBody(goal, plan);
    return undefined;
  }

  if (!goal.issueNumber) {
    return undefined;
  }

  await writeIssueBody(goal, plan);

  const issue = await shell('gh', ['issue', 'edit', goal.issueNumber, '--body-file', goal.paths.issueBodyMd], repoPath);
  if (!issue.ok) {
    return issue.output;
  }

  return undefined;
}

function buildOrionPrompt(goal: GoalState, existingPlan?: string): string {
  return `
You are Orion, the SwiftPark Project Manager / Orchestrator powered by Codex. Create or revise a plan only. Do not modify files.

Important naming:
- You are Orion.
- Do not use Neo as the PM name. Neo is reserved for the future SwiftPark user-facing assistant.

Goal:
${goal.description}

Context:
- Repo: ${repoPath}
- GitHub issue: ${goal.issueUrl || '(not created yet)'}
- Goal id: ${goal.id}
- Mode: ${goal.mode}
- Agent preference: ${goal.agents}
- Primary screen: ${goal.primaryScreen || '(none)'}
${existingPlan ? `\nExisting plan to revise:\n${existingPlan}` : ''}

Required safety:
- Do not code yet.
- Do not browse the web or search GitHub. Use only the goal and context provided here.
- Do not merge.
- Do not deploy.
- Do not push to GitHub.
- Do not open PRs.
- Do not send emails.
- Do not make YC changes.
- Do not print .env files, tokens, cookies, or private keys.
- Preserve existing SwiftPark behavior unless the goal explicitly changes it.

Return only the final Markdown plan. Do not include terminal logs, session metadata, web-search notes, token counts, preambles, or code fences.
Keep each section concise: one short paragraph or 2-5 bullets is enough unless the goal genuinely needs more detail.
Do not leave any section empty. If a section does not apply, write one bullet saying it is not needed for this goal and why.
For command-center or Discord-only validation goals, do not invent SwiftPark app screens, mobile screenshots, desktop screenshots, visual baselines, or Iris frontend work unless the goal explicitly asks for UI changes.
Suggested Agent Assignment should be practical: use Sentinel for QA, Atlas only for command/backend reliability checks, Iris only for actual frontend/visual work, and Orion for planning/revision.

Return Markdown with exactly these sections:
## User Story
## Intent / Why This Matters
## Affected Screens/Routes
## Acceptance Criteria
## Backend Tasks for Atlas
## Frontend/Visual Tasks for Iris
## QA Plan for Sentinel
## Visual Approval Checklist
## Suggested Agent Assignment
## Risks / Constraints
## Human Approvals Needed
`.trim();
}

function buildFallbackOrionPlan(goal: GoalState, reason: string): string {
  const screen = goal.primaryScreen || 'the affected SwiftPark screen(s)';
  const backendNeeded = goal.agents === 'atlas' || goal.agents === 'both' || goal.agents === 'auto';
  const frontendNeeded = goal.agents === 'iris' || goal.agents === 'both' || goal.agents === 'auto';

  return `
# Fallback Orion Plan — Codex planning failed/timed out

## User Story
As a SwiftPark operator or user, I want ${goal.description} so the product experience is clearer and safer to validate.

## Intent / Why This Matters
This goal should improve the current SwiftPark workflow while preserving existing OSU and Brighton behavior. Orion used the deterministic fallback plan because Codex planning did not complete: ${redactSensitive(reason)}

## Affected Screens/Routes
- Primary screen: ${screen}
- Confirm exact affected routes before implementation.

## Acceptance Criteria
- The requested behavior is implemented without regressing existing SwiftPark flows.
- Mobile and desktop behavior are both reviewed when visual changes are involved.
- No secrets, .env values, tokens, emails, YC materials, deploys, merges, PRs, or pushes are touched.

## Backend Tasks for Atlas
${backendNeeded ? '- Inspect backend/API/data implications and implement only if the goal requires backend or systems changes.' : '- No backend work expected unless implementation reveals a contract issue.'}

## Frontend/Visual Tasks for Iris
${frontendNeeded ? `- Inspect ${screen} and implement UI, layout, responsive behavior, or visual polish needed for the goal.` : '- No frontend work expected unless the goal requires user-facing behavior.'}

## QA Plan for Sentinel
- Run smoke QA by default.
- If a primary screen is set, run screen QA for ${screen} and post mobile + desktop screenshots.
- Preserve all screenshots locally under Playwright test-results.

## Visual Approval Checklist
- Mobile screenshot posted.
- Desktop screenshot posted.
- No obvious clipping, overlap, unreadable text, or broken navigation.
- Existing Brighton and OSU core flows remain intact.

## Suggested Agent Assignment
- Orion: planning and coordination.
- Atlas: ${backendNeeded ? 'backend/systems tasks if needed.' : 'stand by.'}
- Iris: ${frontendNeeded ? 'frontend/visual tasks if needed.' : 'stand by.'}
- Sentinel: visual QA and screenshots after implementation.

## Risks / Constraints
- This fallback plan may need refinement before implementation.
- Work must remain local and approval-gated.

## Human Approvals Needed
- Approve plan with \`/approve ${goal.planApprovalToken}\`.
- Approve agent work with \`/approve ${goal.agentApprovalToken}\` if needed.
- Approve QA with \`/approve ${goal.qaApprovalToken}\` before merge/deploy decisions.
`.trim();
}

async function createGoalWorktree(goal: GoalState): Promise<string> {
  await fs.mkdir(worktreesDir, { recursive: true });

  if (baseRef === 'origin/main') {
    await shell('git', ['fetch', 'origin', 'main'], repoPath);
  }

  const worktree = await shell(
    'git',
    ['worktree', 'add', '-b', goal.branchName, goal.worktreePath, baseRef],
    repoPath
  );

  if (!worktree.ok) {
    throw new Error(`Failed to create worktree:\n${worktree.output}`);
  }

  return worktree.output;
}

async function runOrionPlanning(
  goal: GoalState,
  existingPlan?: string,
  progress?: GoalProgressReporter
): Promise<OrionPlanningResult> {
  const prompt = buildOrionPrompt(goal, existingPlan);
  await fs.writeFile(goal.paths.orionPromptMd, prompt + '\n');
  await setAgentRunning('orion', goal, existingPlan ? 'Revise SwiftPark goal plan' : 'Create SwiftPark goal plan');

  const job: JobRecord = {
    id: `orion-${Date.now()}`,
    goalId: goal.id,
    agent: 'orion',
    task: existingPlan ? 'Revise Orion plan' : 'Create Orion plan',
    status: 'running',
    branchName: goal.branchName,
    worktreePath: goal.worktreePath,
    startedAt: new Date().toISOString(),
  };

  activeJobs.set(job.id, job);
  const lastMessagePath = path.join(goal.runDir, `${job.id}-last-message.md`);
  let latest = await updateGoalStep(goal.id, 'Running Orion planning', 'Waiting for Orion plan output.', {
    status: 'planning',
    currentAgent: 'orion',
  });
  await updateGoalState(goal.id, (current) => {
    upsertJob(current, job);
  });
  await progress?.(latest, 'Running Orion planning', 'Waiting for Orion plan output.');

  const heartbeatStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    void (async () => {
      const heartbeatElapsed = Date.now() - heartbeatStartedAt;
      const nextAction = runningNextAction('orion', heartbeatElapsed, orionPlanningTimeoutMs);
      latest = await updateGoalStep(goal.id, 'Running Orion planning', nextAction, {
        status: 'planning',
        currentAgent: 'orion',
      });
      await progress?.(latest, 'Running Orion planning', nextAction, `Elapsed: ${formatMs(heartbeatElapsed)}`);
    })().catch(() => undefined);
  }, agentHeartbeatMs);
  heartbeat.unref?.();

  const result = await shell(
    'codex',
    ['exec', '--cd', repoPath, '--sandbox', 'read-only', '--color', 'never', '--output-last-message', lastMessagePath, prompt],
    repoPath,
    {
      timeoutMs: orionPlanningTimeoutMs,
      activeKey: job.id,
      goalId: goal.id,
      agent: 'orion',
    }
  );
  clearInterval(heartbeat);

  let planSource = result.output;
  try {
    const lastMessage = await fs.readFile(lastMessagePath, 'utf8');
    if (lastMessage.trim()) planSource = lastMessage;
  } catch {
    // Fall back to stdout extraction.
  }

  const extracted = extractOrionPlan(planSource);
  const fallbackReason = result.ok && extracted.ok
    ? undefined
    : result.output || extracted.reason || 'Codex planning failed or returned no usable plan.';
  const usedFallback = Boolean(fallbackReason);
  const plan = usedFallback ? buildFallbackOrionPlan(goal, fallbackReason || 'Codex planning failed.') : extracted.plan;

  job.endedAt = new Date().toISOString();
  job.status = usedFallback ? (result.timedOut ? 'timed-out' : 'skipped') : 'succeeded';
  job.summary = usedFallback
    ? 'Fallback Orion Plan — Codex planning failed/timed out. Deterministic Orion fallback plan was used.'
    : `Clean Orion plan extracted and saved to ${relativeToCommandCenter(goal.paths.planMd)}.`;
  job.error = fallbackReason ? redactSensitive(fallbackReason) : undefined;
  job.outputPath = path.join(goal.runDir, `${job.id}.log`);
  await fs.writeFile(
    job.outputPath,
    redactSensitive(
      [
        'Raw Orion/Codex output:',
        result.output || '(no stdout)',
        '',
        'Extracted plan:',
        plan,
      ].join('\n')
    ) + '\n'
  );

  activeJobs.delete(job.id);
  latest = await updateGoalStep(goal.id, usedFallback ? 'Fallback Orion plan generated' : 'Orion plan complete', 'Posting plan to #orion-planning.', {
    status: 'waiting-for-plan-approval',
    currentAgent: 'orion',
    lastError: usedFallback ? fallbackReason : undefined,
  });
  await updateGoalState(goal.id, (current) => {
    upsertJob(current, job);
  });
  await setAgentFinished('orion', true, job.summary || plan);
  await updateAgent('orion', {
    status: 'waiting-approval',
    currentTask: `Waiting for plan approval for goal-${goal.id}`,
    currentStep: 'Waiting for approval',
    currentGoalId: goal.id,
    currentWorktree: goal.worktreePath,
    currentBranch: goal.branchName,
    startedAt: undefined,
  }).catch(() => undefined);

  await fs.writeFile(goal.paths.planMd, redactSensitive(plan) + '\n');
  await progress?.(latest, usedFallback ? 'Fallback Orion plan generated' : 'Orion plan complete', 'Posting plan to #orion-planning.');
  return { plan, job, usedFallback, fallbackReason };
}

async function initializeGoal(
  description: string,
  mode: GoalMode,
  primaryScreen: string | undefined,
  agents: GoalAgentChoice,
  interactionUser: string,
  progress?: GoalProgressReporter
): Promise<{ goal: GoalState; plan: string; worktreeOutput: string; usedFallback: boolean; fallbackReason?: string }> {
  const id = createGoalId();
  const runDir = goalRunDir(id);
  const paths = goalPaths(id);
  const branchName = `feature/goal-${id}-${slugify(description)}`;
  const worktreePath = path.join(worktreesDir, `goal-${id}`);

  await fs.mkdir(runDir, { recursive: true });

  let goal: GoalState = {
    id,
    description,
    mode,
    primaryScreen,
    agents,
    status: 'created',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    currentStep: 'Goal received',
    currentAgent: 'orion',
    nextAction: 'Creating local run record.',
    createdBy: interactionUser,
    runDir,
    branchName,
    worktreePath,
    planApprovalToken: `plan-${id}`,
    qaApprovalToken: `qa-${id}`,
    agentApprovalToken: `agent-${id}`,
    paths,
    approvals: {},
    jobs: [],
  };

  await writeGoalState(goal);
  await progress?.(goal, 'Creating run record', 'Creating local goal files.');

  const github = await createGithubIssue(goal);
  goal.issueUrl = github.issueUrl;
  goal.issueNumber = github.issueNumber;
  goal.githubWarning = github.warning;
  await writeGoalState(goal);
  goal = await updateGoalStep(goal.id, 'Creating/checking worktree', 'Creating isolated local worktree.', {
    currentAgent: 'orion',
  });
  await progress?.(goal, 'Creating/checking worktree', 'Creating isolated local worktree.');

  const worktreeOutput = await createGoalWorktree(goal);
  goal = await updateGoalStep(goal.id, 'Running Orion planning', 'Waiting for Orion plan output.', {
    currentAgent: 'orion',
  });
  await progress?.(goal, 'Running Orion planning', 'Waiting for Orion plan output.');
  const { plan, usedFallback, fallbackReason } = await runOrionPlanning(goal, undefined, progress);

  const latest = await readGoalState(goal.id);
  goal = latest || goal;

  const issueUpdateWarning = await updateGithubIssueWithPlan(goal, plan);
  if (issueUpdateWarning) {
    goal.githubWarning = [goal.githubWarning, issueUpdateWarning].filter(Boolean).join('\n\n');
    await writeGoalState(goal, plan);
  }

  return { goal, plan, worktreeOutput, usedFallback, fallbackReason };
}

async function postPlan(channel: TextChannel, goal: GoalState, plan: string): Promise<void> {
  await channel.send(
    [
      `**Orion Plan Ready: goal-${goal.id}**`,
      goal.issueUrl ? `GitHub issue: ${goal.issueUrl}` : 'GitHub issue: not available; local run record was created.',
      `Mode: \`${goal.mode}\``,
      `Agents: \`${goal.agents}\``,
      `Primary screen: ${goal.primaryScreen ? `\`${goal.primaryScreen}\`` : '(none)'}`,
      `Branch: \`${goal.branchName}\``,
      `Worktree: \`${goal.worktreePath}\``,
      `Approval: run \`/approve target:${goal.planApprovalToken}\``,
      `Saved plan: \`${relativeToCommandCenter(goal.paths.planMd)}\``,
    ].join('\n')
  );

  await channel.send(
    `Complete Orion plan below. If Discord splits it, read the messages in order; the saved copy is unchanged.`
  );

  for (const chunk of formatPlanForDiscord(plan, { mode: 'full' })) {
    await channel.send(chunk);
  }

  if (goal.githubWarning) {
    await channel.send(
      ['GitHub tracking warning:', '```text', truncate(goal.githubWarning), '```'].join('\n')
    );
  }
}

async function createGoalThread(channel: TextChannel, goal: GoalState): Promise<GoalState> {
  if (goal.threadId) return goal;

  try {
    const thread = await channel.threads.create({
      name: `goal-${goal.id}-${slugify(goal.description).slice(0, 36)}`,
      autoArchiveDuration: 10080,
      reason: `SwiftPark goal ${goal.id}`,
    });

    return updateGoalState(goal.id, (current) => {
      current.threadId = thread.id;
      current.threadName = thread.name;
    });
  } catch {
    return goal;
  }
}

async function postToGoalThread(goal: GoalState, content: string): Promise<void> {
  if (!goal.threadId) return;

  try {
    const thread = await client.channels.fetch(goal.threadId) as any;
    if (thread?.send) {
      for (const chunk of chunkText(redactSensitive(content), 1800)) {
        await thread.send(chunk);
      }
    }
  } catch {
    // Thread posting is best-effort; slash commands remain authoritative.
  }
}

async function postPlanToGoalThread(goal: GoalState, title: string, plan: string): Promise<void> {
  if (!goal.threadId) return;

  try {
    const thread = await client.channels.fetch(goal.threadId) as any;
    if (!thread?.send) return;

    await thread.send(`**${title}: goal-${goal.id}**`);
    for (const chunk of formatPlanForDiscord(plan, { mode: 'full' })) {
      await thread.send(chunk);
    }
  } catch {
    // Thread posting is best-effort; slash commands remain authoritative.
  }
}

function assertSeparateWorktree(goal: GoalState): void {
  const resolvedWorktree = path.resolve(goal.worktreePath);
  const resolvedRoot = path.resolve(worktreesDir);
  const resolvedRepo = path.resolve(repoPath);

  if (resolvedWorktree === resolvedRepo || !resolvedWorktree.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to run agent outside configured worktrees dir: ${goal.worktreePath}`);
  }
}

async function readPlan(goal: GoalState): Promise<string> {
  try {
    return await fs.readFile(goal.paths.planMd, 'utf8');
  } catch {
    return '(Orion plan file is missing.)';
  }
}

function buildIrisPrompt(goal: GoalState, task: string, plan: string): string {
  return `
You are Iris, the SwiftPark Frontend & Visual Agent powered by Claude Code. Focus on UI, layout, responsive behavior, visual polish, and preserving SwiftPark's current brand. Do not touch secrets. Do not merge, deploy, or send external messages.

Goal id: ${goal.id}
GitHub issue: ${goal.issueUrl || '(local only; issue unavailable)'}
Branch: ${goal.branchName}
Worktree: ${goal.worktreePath}

Task:
${task}

Orion plan:
${plan}

Rules:
- Run only in this worktree.
- Do not print .env files, tokens, cookies, private keys, or secrets.
- Do not push to GitHub.
- Do not open PRs.
- Do not auto-commit.
- Do not deploy.
- Do not send emails.
- Do not make YC changes.
- Keep changes scoped and preserve existing OSU and Brighton behavior unless the goal explicitly changes it.
- Run relevant frontend checks or explain why they could not be run.

Final response required:
- Summary
- Files changed
- Tests run
- Risks or follow-up
`.trim();
}

function buildAtlasPrompt(goal: GoalState, task: string, plan: string): string {
  return `
You are Atlas, the SwiftPark Backend & Systems Agent powered by Codex. Focus on APIs, database logic, architecture, testability, and reliability. Do not touch secrets. Do not merge, deploy, or send external messages.

Goal id: ${goal.id}
GitHub issue: ${goal.issueUrl || '(local only; issue unavailable)'}
Branch: ${goal.branchName}
Worktree: ${goal.worktreePath}

Task:
${task}

Orion plan:
${plan}

Rules:
- Run only in this worktree.
- Do not print .env files, tokens, cookies, private keys, or secrets.
- Do not push to GitHub.
- Do not open PRs.
- Do not auto-commit.
- Do not deploy.
- Do not send emails.
- Do not make YC changes.
- Keep changes scoped and preserve existing OSU and Brighton behavior unless the goal explicitly changes it.
- Run relevant backend/system checks or explain why they could not be run.

Final response required:
- Summary
- Files changed
- Tests run
- Risks or follow-up
`.trim();
}

function defaultAgentTask(goal: GoalState, agent: RunnableAgentId): string {
  if (agent === 'orion') {
    return `Revise or expand the Orion plan for goal-${goal.id}.`;
  }

  if (agent === 'atlas') {
    return `Implement Atlas backend/systems tasks from the Orion plan for goal-${goal.id}.`;
  }

  if (agent === 'iris') {
    return `Implement Iris frontend/visual tasks from the Orion plan for goal-${goal.id}.`;
  }

  if (agent === 'sentinel') {
    return goal.primaryScreen
      ? `Run screen QA for ${goal.primaryScreen} and post mobile + desktop screenshots.`
      : 'Run smoke QA and post selected screenshots.';
  }

  return 'Scout is stubbed for now. Do not browse, scrape, or access external accounts.';
}

function resolveExecutionAgents(goal: GoalState, plan: string): RunnableAgentId[] {
  if (goal.agents === 'atlas') return ['atlas'];
  if (goal.agents === 'iris') return ['iris'];
  if (goal.agents === 'both') return ['atlas', 'iris'];

  const text = `${goal.description}\n${plan}`.toLowerCase();
  const wantsBackend = /\b(api|backend|server|database|schema|endpoint|supabase|auth|migration|yolo|occupancy)\b/.test(text);
  const wantsFrontend = /\b(frontend|ui|screen|route|page|component|layout|mobile|desktop|visual|button|card|map)\b/.test(text) || Boolean(goal.primaryScreen);

  if (wantsBackend && wantsFrontend) return ['atlas', 'iris'];
  if (wantsBackend) return ['atlas'];
  if (wantsFrontend) return ['iris'];
  return ['atlas', 'iris'];
}

async function runImplementationAgent(goal: GoalState, agent: 'iris' | 'atlas', task: string, jobId?: string): Promise<ShellResult> {
  assertSeparateWorktree(goal);
  const plan = await readPlan(goal);
  const prompt = agent === 'iris' ? buildIrisPrompt(goal, task, plan) : buildAtlasPrompt(goal, task, plan);

  if (agent === 'atlas') {
    return shell(
      'codex',
      ['exec', '--cd', goal.worktreePath, '--sandbox', 'workspace-write', '--color', 'never', prompt],
      goal.worktreePath,
      {
        timeoutMs: timeoutForAgent(agent),
        activeKey: jobId,
        goalId: goal.id,
        agent,
      }
    );
  }

  return shell(
    'claude',
    ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text', prompt],
    goal.worktreePath,
    {
      timeoutMs: timeoutForAgent(agent),
      activeKey: jobId,
      goalId: goal.id,
      agent,
    }
  );
}

async function cleanQaArtifacts(root: string) {
  await fs.rm(path.join(root, 'test-results'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'playwright-report'), { recursive: true, force: true });
}

function manualScreenshotKey(root: string, file: string) {
  const relative = path.relative(path.join(root, 'test-results', 'manual-screenshots'), file);
  const [project, fileName] = relative.split(path.sep);
  const screen = fileName?.replace(/\.(png|jpe?g)$/i, '');

  if (!project || !screen) return undefined;
  return `${project}/${screen}`;
}

function selectManualScreenshots(root: string, files: string[], selection: ReturnType<typeof getQaSelection>) {
  const byKey = new Map<string, string>();

  for (const file of files) {
    const key = manualScreenshotKey(root, file);
    if (key) byKey.set(key, file);
  }

  const selected: string[] = [];
  const selectedSet = new Set<string>();

  for (const screen of selection.screens) {
    for (const project of qaProjects) {
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

  return selected;
}

async function postQaScreenshots(
  channel: TextChannel,
  label: string,
  selection: ReturnType<typeof getQaSelection>,
  root: string
) {
  const options = {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: true,
  };

  const result = {
    available: 0,
    selected: 0,
    uploaded: 0,
    skipped: 0,
    warnings: [] as string[],
  };

  try {
    const manualScreenshots = await fg('test-results/manual-screenshots/**/*.{png,jpg,jpeg}', options);
    const files = selectManualScreenshots(root, manualScreenshots, selection);
    const selectedFiles = files.slice(0, selection.uploadCap);

    result.available = manualScreenshots.length;
    result.selected = selectedFiles.length;
    result.skipped = Math.max(files.length - selectedFiles.length, 0);

    if (manualScreenshots.length === 0) {
      result.warnings.push(`No QA screenshots found for **${label}**.`);
      return result;
    }

    if (selectedFiles.length === 0) {
      result.warnings.push(`No screenshots matched selected screen(s): ${selection.screens.join(', ') || '(none)'}.`);
      return result;
    }

    await channel.send(`Posting ${selectedFiles.length} selected screenshot(s) for **${label}**.`);

    for (const file of selectedFiles) {
      try {
        await channel.send({
          content: `Screenshot: \`${path.relative(root, file)}\``,
          files: [file],
        });
        result.uploaded += 1;
      } catch (err: any) {
        result.warnings.push(
          `Failed to upload \`${path.relative(root, file)}\`: ${redactSensitive(err?.message || String(err))}`
        );
        break;
      }
    }
  } catch (err: any) {
    result.warnings.push(`Could not collect QA screenshots: ${redactSensitive(err?.message || String(err))}`);
  }

  return result;
}

async function findQaDiagnostics(root: string) {
  return fg(
    [
      'test-results/**/error-context.md',
      'test-results/**/*.{webm,zip}',
      'playwright-report/**/*.md',
      'playwright-report/**/*.{webm,zip}',
    ],
    {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
    }
  );
}

async function postArtifactPaths(channel: TextChannel, title: string, files: string[], root: string) {
  const maxPaths = 40;
  const lines = files
    .sort()
    .slice(0, maxPaths)
    .map((file) => `- \`${path.relative(root, file)}\``);

  if (files.length > maxPaths) {
    lines.push(`- ...and ${files.length - maxPaths} more`);
  }

  for (const chunk of chunkText([`${title}:`, ...lines].join('\n'), 1800)) {
    await channel.send(chunk);
  }
}

async function postTerminalOutput(channel: TextChannel, title: string, output: string, maxChunks = 4) {
  const safeOutput = redactSensitive(output || '(no output)');
  const chunks = chunkText(safeOutput, 1500);

  for (const [index, chunk] of chunks.slice(0, maxChunks).entries()) {
    const suffix = chunks.length > 1 ? ` (${index + 1}/${Math.min(chunks.length, maxChunks)})` : '';
    await channel.send([`${title}${suffix}`, '```text', chunk, '```'].join('\n'));
  }

  if (chunks.length > maxChunks) {
    await channel.send(`Terminal output truncated after ${maxChunks} message(s).`);
  }
}

async function runQaFlow(
  root: string,
  channel: TextChannel,
  label: string,
  selection: ReturnType<typeof getQaSelection>,
  options: ShellOptions = {}
): Promise<ShellResult & { uploadSummary: string; qa: QaRunSummary }> {
  await cleanQaArtifacts(root);
  const script = buildQaScript(selection);
  const result = await shellScript(script, root, {
    timeoutMs: options.timeoutMs ?? sentinelMaxRuntimeMs,
    activeKey: options.activeKey,
    goalId: options.goalId,
    agent: options.agent,
  });
  const uploadResult = await postQaScreenshots(channel, label, selection, root);
  const status = result.ok ? 'PASS' : 'FAIL';

  await channel.send(
    [
      `# QA Result: ${status}`,
      `Label: **${label}**`,
      `Mode: \`${selection.mode}\``,
      `Screens selected: ${selection.screens.join(', ') || '(none)'}`,
      `Playwright: ${summarizeQaOutput(result.output)}`,
      `Screenshots uploaded: ${uploadResult.uploaded}/${uploadResult.selected}`,
      `Local screenshots: \`${path.relative(root, path.join(root, 'test-results/manual-screenshots'))}\``,
      `Local report: \`${path.relative(root, path.join(root, 'playwright-report/index.html'))}\``,
    ].join('\n')
  ).catch(() => {});

  if (uploadResult.warnings.length > 0) {
    await channel.send(
      [
        'Screenshot upload warning:',
        ...uploadResult.warnings.map((warning) => `- ${warning}`),
        `QA result remains **${status}**.`,
      ].join('\n')
    ).catch(() => {});
  }

  if (!result.ok) {
    await postTerminalOutput(channel, 'Terminal output', result.output).catch(() => {});

    const diagnostics = await findQaDiagnostics(root).catch(() => []);
    if (diagnostics.length > 0) {
      await postArtifactPaths(channel, 'QA video/error paths', diagnostics, root).catch(() => {});
    }
  }

  return {
    ...result,
    uploadSummary: `Screenshots uploaded: ${uploadResult.uploaded}/${uploadResult.selected}`,
    qa: {
      status,
      label,
      mode: selection.mode,
      screens: selection.screens,
      uploaded: uploadResult.uploaded,
      selected: uploadResult.selected,
      available: uploadResult.available,
      skipped: uploadResult.skipped,
      warnings: uploadResult.warnings,
      localScreenshots: path.relative(root, path.join(root, 'test-results/manual-screenshots')),
      localReport: path.relative(root, path.join(root, 'playwright-report/index.html')),
      playwrightSummary: summarizeQaOutput(result.output),
    },
  };
}

function formatSentinelSummary(goal: GoalState, qa: QaRunSummary): string {
  const approval = qa.status === 'PASS'
    ? `Approve QA with \`/approve target:${goal.qaApprovalToken}\` after reviewing screenshots.`
    : retryGuidance('sentinel', goal);

  return [
    `Status: ${qa.status} (Sentinel)`,
    `Goal: goal-${goal.id}`,
    `Mode: ${qa.mode}`,
    `Screen(s): ${qa.screens.join(', ') || '(none)'}`,
    `Playwright: ${qa.playwrightSummary}`,
    `Screenshots posted: ${qa.uploaded}/${qa.selected}`,
    `Screenshots available: ${qa.available}`,
    qa.skipped > 0 ? `Screenshots skipped by cap: ${qa.skipped}` : '',
    `Local screenshots: \`${qa.localScreenshots}\``,
    `Local report: \`${qa.localReport}\``,
    qa.warnings.length ? `Warnings:\n${qa.warnings.map((warning) => `- ${warning}`).join('\n')}` : '',
    `Next action: ${approval}`,
  ].filter(Boolean).join('\n');
}

async function runSentinelAgent(
  goal: GoalState,
  task: string,
  channels: Record<string, TextChannel>,
  jobId?: string
): Promise<ShellResult> {
  const parsed = parseQaTask(task, goal.primaryScreen);
  const selection = getQaSelection(parsed.mode, parsed.screen);
  const label = `goal-${goal.id} ${selection.mode}${parsed.screen ? ` ${parsed.screen}` : ''}`;
  const result = await runQaFlow(goal.worktreePath, channels['qa-visual'], label, selection, {
    timeoutMs: sentinelMaxRuntimeMs,
    activeKey: jobId,
    goalId: goal.id,
    agent: 'sentinel',
  });
  return {
    ok: result.ok,
    output: formatSentinelSummary(goal, result.qa),
  };
}

async function runOrionRevision(
  goal: GoalState,
  task: string,
  channels: Record<string, TextChannel>
): Promise<ShellResult> {
  const existingPlan = await readPlan(goal);
  const revised = await runOrionPlanning(goal, `${existingPlan}\n\nRequested revision task:\n${task}`);
  const latest = await readGoalState(goal.id);

  if (latest) {
    const issueUpdateWarning = await updateGithubIssueWithPlan(latest, revised.plan);
    if (issueUpdateWarning) {
      latest.githubWarning = [latest.githubWarning, issueUpdateWarning].filter(Boolean).join('\n\n');
      await writeGoalState(latest, revised.plan);
    }
  }

  await postPlan(channels['pm-planning'], latest || goal, revised.plan);
  if (latest) await postPlanToGoalThread(latest, 'Orion Revised Plan', revised.plan);
  return { ok: true, output: revised.plan };
}

async function reviseGoalPlan(
  goal: GoalState,
  feedback: string,
  target: string,
  channels: Record<string, TextChannel>,
  requestedBy: string
): Promise<GoalState> {
  const safeFeedback = redactSensitive(feedback);
  const revisionEntry = [
    `## ${new Date().toISOString()}`,
    `Requested by: ${requestedBy}`,
    `Target: ${target}`,
    '',
    safeFeedback,
    '',
  ].join('\n');

  await fs.appendFile(goal.paths.revisionsMd, revisionEntry);
  await updateGoalState(goal.id, (current) => {
    current.status = 'revision-pending-approval';
    current.currentStep = 'Revision requested';
    current.currentAgent = 'orion';
    current.lastError = undefined;
    current.nextAction = 'Orion is revising the saved plan.';
  });

  const existingPlan = await readPlan(goal);
  const revised = await runOrionPlanning(
    goal,
    [
      existingPlan,
      '',
      'Revision feedback:',
      `Target: ${target}`,
      safeFeedback,
    ].join('\n')
  );

  const latest = await updateGoalState(goal.id, (current) => {
    current.status = 'plan-revised';
    current.currentStep = 'Plan revised';
    current.currentAgent = 'orion';
    current.lastError = undefined;
    current.nextAction = `Approve revised plan with /approve target:${current.planApprovalToken}.`;
    current.approvals.plan = undefined;
  });

  const issueUpdateWarning = await updateGithubIssueWithPlan(latest, revised.plan);
  if (issueUpdateWarning) {
    latest.githubWarning = [latest.githubWarning, issueUpdateWarning].filter(Boolean).join('\n\n');
    await writeGoalState(latest, revised.plan);
  }

  await postPlan(channels['pm-planning'], latest, revised.plan);
  await postPlanToGoalThread(latest, 'Orion Revised Plan', revised.plan);
  return latest;
}

async function runScoutStub(goal: GoalState, task: string): Promise<ShellResult> {
  const output = [
    'Scout is stubbed for now.',
    `Goal: goal-${goal.id}`,
    `Task: ${redactSensitive(task)}`,
    'No browsing, scraping, account access, Jira, YC edits, emails, or external research was performed.',
  ].join('\n');

  return { ok: true, output };
}

async function runAgentJob(
  goalId: string,
  agent: RunnableAgentId,
  task: string,
  channels: Record<string, TextChannel>,
  requestedBy: string
): Promise<boolean> {
  const forbidden = isForbiddenTask(task);
  if (forbidden) {
    await channels['agent-status'].send(`Blocked ${agent} for goal-${normalizeGoalId(goalId)}: ${forbidden}.`);
    return false;
  }

  const goal = await readGoalState(goalId);
  if (!goal) {
    await channels['agent-status'].send(`Unknown goal: \`${goalId}\`.`);
    return false;
  }

  if (agent !== 'orion' && agent !== 'scout' && !goal.approvals.plan) {
    await channels['agent-status'].send(
      `Refusing to run ${agent} for goal-${goal.id}. Approve first with \`/approve target:${goal.planApprovalToken}\`.`
    );
    return false;
  }

  if (agent === 'iris' || agent === 'atlas' || agent === 'sentinel') {
    try {
      assertSeparateWorktree(goal);
      await fs.access(goal.worktreePath);
    } catch (err: any) {
      const errorOutput = `Worktree unavailable for goal-${goal.id}: ${err?.message || String(err)}`;
      await updateGoalState(goal.id, (current) => {
        current.status = 'blocked';
        current.currentStep = 'Worktree unavailable';
        current.currentAgent = agent;
        current.lastError = errorOutput;
        current.nextAction = 'Recreate the goal or restore the worktree, then rerun /run-agent.';
      }).catch(() => undefined);
      await postCommandCenterError(channels, `${agent} could not start`, errorOutput, goal.id).catch(() => undefined);
      await channels['agent-status'].send(
        `${agent} could not start for goal-${goal.id}: worktree unavailable. Check #logs.`
      ).catch(() => undefined);
      return false;
    }
  }

  const job: JobRecord = {
    id: `${agent}-${Date.now()}`,
    goalId: goal.id,
    agent,
    task,
    status: 'running',
    branchName: goal.branchName,
    worktreePath: goal.worktreePath,
    startedAt: new Date().toISOString(),
  };

  activeJobs.set(job.id, job);
  await setAgentRunning(agent, goal, task);
  await postAgentStatusBoard(channels).catch(() => undefined);
  await updateGoalState(goal.id, (current) => {
    current.status = 'running';
    current.currentStep = `${agent} running`;
    current.currentAgent = agent;
    current.lastError = undefined;
    current.nextAction = runningNextAction(agent, 0, timeoutForAgent(agent));
    upsertJob(current, job);
  });

  let agentProgressMessage: any;
  agentProgressMessage = await channels['agent-status'].send(
    [
      `# Agent Started: ${agent}`,
      `Goal: \`goal-${goal.id}\``,
      `Requested by: <@${requestedBy}>`,
      `Branch: \`${goal.branchName}\``,
      `Worktree: \`${goal.worktreePath}\``,
      `Task: ${redactSensitive(task)}`,
      `Runtime: ${hardTimeoutLabel(timeoutForAgent(agent))}`,
    ].join('\n')
  ).catch(() => undefined);

  let result: ShellResult = { ok: false, output: '' };
  let changedFiles: ChangedFileSummary[] = [];
  const hardTimeoutMs = timeoutForAgent(agent);
  const heartbeat = setInterval(() => {
    void (async () => {
      const heartbeatElapsed = elapsedMs(job.startedAt);
      const nextAction = runningNextAction(agent, heartbeatElapsed, hardTimeoutMs);
      await updateGoalStep(goal.id, `${agent} running`, nextAction, {
        status: 'running',
        currentAgent: agent,
      });
      await updateAgent(agent, {
        status: 'running',
        currentStep: `${agent} running for ${formatMs(heartbeatElapsed)}`,
        currentTask: redactSensitive(task),
        currentGoalId: goal.id,
        currentWorktree: goal.worktreePath,
        currentBranch: goal.branchName,
      });
      await postAgentStatusBoard(channels).catch(() => undefined);
      await agentProgressMessage?.edit(
        [
          `# Agent Running: ${agent}`,
          `Goal: \`goal-${goal.id}\``,
          `Elapsed: ${formatMs(heartbeatElapsed)}`,
          `Status: ${heartbeatElapsed >= (agent === 'orion' ? orionStaleAfterMs : agentStaleAfterMs) ? 'long-running' : 'running'}`,
          `Next: ${nextAction}`,
        ].join('\n')
      ).catch(() => undefined);
    })().catch(() => undefined);
  }, agentHeartbeatMs);
  heartbeat.unref?.();

  try {
    if (agent === 'orion') {
      result = await runOrionRevision(goal, task, channels);
    } else if (agent === 'iris' || agent === 'atlas') {
      result = await runImplementationAgent(goal, agent, task, job.id);
    } else if (agent === 'sentinel') {
      result = await runSentinelAgent(goal, task, channels, job.id);
    } else {
      result = await runScoutStub(goal, task);
    }

    job.status = result.ok ? 'succeeded' : 'failed';
    job.endedAt = new Date().toISOString();
    if (agent === 'iris' || agent === 'atlas') {
      changedFiles = await changedFilesForWorktree(goal.worktreePath).catch(() => []);
      job.summary = formatImplementationAgentSummary(agent, goal, job, result.output, changedFiles);
    } else {
      job.summary = agent === 'sentinel'
        ? result.output
        : formatGenericAgentSummary(agent, goal, job, result.output);
    }
  } catch (err: any) {
    result = { ok: false, output: err?.stack || err?.message || String(err) };
    job.status = 'failed';
    job.endedAt = new Date().toISOString();
    job.error = redactSensitive(result.output);
    if (agent === 'iris' || agent === 'atlas') {
      changedFiles = await changedFilesForWorktree(goal.worktreePath).catch(() => []);
      job.summary = formatImplementationAgentSummary(agent, goal, job, result.output, changedFiles);
    } else {
      job.summary = formatGenericAgentSummary(agent, goal, job, result.output);
    }
  } finally {
    clearInterval(heartbeat);
    job.endedAt ||= new Date().toISOString();
    job.outputPath = path.join(goal.runDir, `${job.id}.log`);
    await fs.writeFile(job.outputPath, redactSensitive(result.output || '(no output)') + '\n');
    activeJobs.delete(job.id);

    await updateGoalState(goal.id, (current) => {
      current.status = job.status === 'succeeded' && agent === 'sentinel'
        ? 'ready-for-qa-approval'
        : job.status === 'succeeded'
          ? 'plan-approved'
          : 'blocked';
      current.currentStep = job.status === 'succeeded' ? `${agent} complete` : `${agent} failed`;
      current.currentAgent = agent;
      current.lastError = job.status === 'succeeded' ? undefined : result.output;
      current.nextAction = job.status === 'succeeded'
        ? agent === 'sentinel'
          ? defaultNextAction(current)
          : `Review ${agent} output, then approve with /approve target:${current.agentApprovalToken} or run Sentinel with /run-agent.`
        : `Review ${agent} output in ${relativeToCommandCenter(job.outputPath || goal.runDir)}; revise or rerun after fixing the blocker.`;
      upsertJob(current, job);
    });

    await setAgentFinished(agent, job.status === 'succeeded', job.summary || result.output);
    await postAgentStatusBoard(channels).catch(() => undefined);
  }

  const targetChannel = agent === 'iris'
    ? channels['iris-frontend'] || channels['frontend']
    : agent === 'atlas'
      ? channels['atlas-backend'] || channels['backend']
      : agent === 'sentinel'
        ? channels['sentinel-qa'] || channels['qa-visual']
        : agent === 'scout'
          ? channels['yc-reddit']
          : channels['pm-planning'];

  await targetChannel.send(
    [
      `# ${agent} ${job.status === 'succeeded' ? 'Complete' : 'Failed'}`,
      `Goal: \`goal-${goal.id}\``,
      `Branch: \`${goal.branchName}\``,
      `Worktree: \`${goal.worktreePath}\``,
      `Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}`,
      `Output: \`${relativeToCommandCenter(job.outputPath)}\``,
      '',
      'Summary:',
      '```text',
      truncate(job.summary || '(no summary)', 1300),
      '```',
    ].join('\n')
  ).catch(() => {});

  if (agent !== 'sentinel' && maxAgentLogChunks > 0 && !result.ok) {
    await postTerminalOutput(targetChannel, 'Captured output', result.output, maxAgentLogChunks).catch(() => {});
  }

  await channels['agent-status'].send(
    `${agent} for goal-${goal.id} ${job.status}. Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}.`
  ).catch(() => {});

  if (job.status !== 'succeeded') {
    await postCommandCenterError(
      channels,
      `${agent} failed for goal-${goal.id}`,
      result.output || job.error || 'Agent failed without captured output.',
      goal.id
    ).catch(() => undefined);
  } else {
    await channels['build-feed']?.send(
      `${agent} finished for goal-${goal.id}. Next: ${(await readGoalState(goal.id))?.nextAction || defaultNextAction(goal)}`
    ).catch(() => undefined);
  }

  await notifySubscribers(
    channels,
    job.status === 'succeeded'
      ? `${agent} finished for goal-${goal.id}. Summary: ${truncate(job.summary || '(no summary)', 700)}`
      : `${agent} failed for goal-${goal.id}. Check #agent-status and the agent output channel.`
  ).catch(() => undefined);

  return job.status === 'succeeded';
}

async function startApprovedExecution(
  goalId: string,
  channels: Record<string, TextChannel>,
  approvedBy: string
): Promise<void> {
  const goal = await readGoalState(goalId);
  if (!goal) {
    await channels['agent-status'].send(`Cannot start execution. Unknown goal: \`${goalId}\`.`);
    return;
  }

  const plan = await readPlan(goal);
  const agents = resolveExecutionAgents(goal, plan);

  await channels['agent-status'].send(
    [
      `# Execution Started: goal-${goal.id}`,
      `Approved by: <@${approvedBy}>`,
      `Agents: ${agents.map((agent) => `\`${agent}\``).join(', ') || '(none)'}`,
      `Sentinel QA: \`${goal.primaryScreen ? `screen ${goal.primaryScreen}` : 'smoke'}\` after agent work`,
    ].join('\n')
  );

  for (const agent of agents) {
    const ok = await runAgentJob(goal.id, agent, defaultAgentTask(goal, agent), channels, approvedBy);
    if (!ok) {
      await channels['agent-status'].send(`Execution blocked for goal-${goal.id}; ${agent} did not complete successfully.`);
      return;
    }
  }

  const qaOk = await runAgentJob(goal.id, 'sentinel', defaultAgentTask(goal, 'sentinel'), channels, approvedBy);
  await updateGoalState(goal.id, (current) => {
    current.status = qaOk ? 'ready-for-qa-approval' : 'blocked';
    current.currentStep = qaOk ? 'Sentinel QA complete' : 'Sentinel QA failed';
    current.currentAgent = 'sentinel';
    current.nextAction = qaOk
      ? `Review screenshots, then approve QA with /approve target:${current.qaApprovalToken}.`
      : 'Review #qa-visual and rerun Sentinel after fixing the blocker.';
  });

  await channels['agent-status'].send(
    qaOk
      ? `goal-${goal.id} is waiting for QA approval. Run \`/approve target:${goal.qaApprovalToken}\` after reviewing screenshots.`
      : `goal-${goal.id} is blocked after Sentinel QA. Merge and deploy remain blocked.`
  );
  await notifySubscribers(
    channels,
    qaOk
      ? `Sentinel QA finished for goal-${goal.id}. Approval needed: /approve target:${goal.qaApprovalToken}`
      : `Sentinel QA failed for goal-${goal.id}. Check #qa-visual.`
  ).catch(() => undefined);
}

async function summarizeWorktreeStatus(worktreePath: string): Promise<string> {
  const status = await shell('git', ['status', '--short'], worktreePath);
  if (!status.ok) return 'git status unavailable';

  const changed = status.output.split('\n').filter((line) => line.trim()).length;
  return changed === 0 ? 'clean' : `${changed} changed`;
}

async function changedFilesForWorktree(worktreePath: string): Promise<ChangedFileSummary[]> {
  const status = await shell('git', ['status', '--short'], worktreePath);
  if (!status.ok) return [];

  return status.output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim() || '?',
      file: line.slice(3).trim() || line.trim(),
    }))
    .filter((file) => !/(^|\/)\.env($|[.\s])/.test(file.file));
}

function isActiveGoalStatus(status: GoalStatus): boolean {
  return [
    'created',
    'planning',
    'waiting-for-plan-approval',
    'plan-revised',
    'revision-pending-approval',
    'plan-approved',
    'running',
    'ready-for-qa-approval',
  ].includes(status);
}

async function latestGoalForStatus(goalId?: string): Promise<GoalState | undefined> {
  if (goalId) return readGoalState(goalId);

  const goals = await listGoalStates();
  return goals.find((goal) => isActiveGoalStatus(goal.status)) || goals[0];
}

async function formatGoalStatus(goal: GoalState): Promise<string> {
  const planExists = await fileExists(goal.paths.planMd);
  const runningJob = goal.jobs.find((job) => job.status === 'running');
  const elapsed = goal.startedAt ? formatMs(elapsedMs(goal.startedAt, goal.endedAt)) : formatElapsed(goal.createdAt, goal.endedAt);
  const stale = goal.status === 'planning' && elapsedMs(goal.startedAt || goal.updatedAt) > orionStaleAfterMs;

  return [
    `## Goal Status: goal-${goal.id}`,
    `Status: ${goal.status}${stale ? ' (stale; needs attention)' : ''}`,
    `Current step: ${goal.currentStep || '(unknown)'}`,
    `Agent: ${goal.currentAgent || runningJob?.agent || 'none'}`,
    `Elapsed: ${elapsed}`,
    `Worktree: \`${goal.worktreePath}\``,
    `Plan file exists: ${planExists ? 'yes' : 'no'}`,
    `Last error: ${goal.lastError ? truncate(goal.lastError, 700) : 'none'}`,
    `Next action: ${goal.nextAction || defaultNextAction(goal)}`,
  ].join('\n');
}

function isPlanDisplayFormat(value: string | null): value is 'summary' | 'full' {
  return value === 'summary' || value === 'full';
}

async function replyWithChunks(interaction: any, header: string, chunks: string[]): Promise<void> {
  const messages = [header, ...chunks].filter((chunk) => chunk.trim());
  const first = messages.shift() || '(no content)';
  await interaction.editReply(truncate(first, 1900));

  for (const message of messages) {
    await interaction.followUp(truncate(message, 1900)).catch(() => undefined);
  }
}

function isFailedGoal(goal: GoalState): boolean {
  return goal.status === 'blocked' || goal.status === 'timed-out' || Boolean(goal.lastError);
}

function isApprovedGoal(goal: GoalState): boolean {
  return Boolean(goal.approvals.plan || goal.approvals.agent || goal.approvals.qa)
    || goal.status === 'plan-approved'
    || goal.status === 'agent-approved'
    || goal.status === 'qa-approved'
    || goal.status === 'ready-for-qa-approval';
}

function isStaleGoal(goal: GoalState): boolean {
  const runningJob = goal.jobs.find((job) => job.status === 'running');
  const staleAfter = (goal.currentAgent || runningJob?.agent) === 'orion' ? orionStaleAfterMs : agentStaleAfterMs;
  return isActiveGoalStatus(goal.status) && elapsedMs(goal.startedAt || goal.updatedAt) > staleAfter;
}

function goalRunLabel(goal: GoalState): string {
  if (goal.status === 'canceled') return 'canceled';
  if (isFailedGoal(goal)) return 'failed';
  if (isStaleGoal(goal)) return 'stale';
  if (isActiveGoalStatus(goal.status)) return 'active';
  if (isApprovedGoal(goal)) return 'approved';
  return 'recent';
}

async function formatRunsList(limit: number): Promise<string> {
  const goals = (await listGoalStates()).slice(0, limit);

  if (goals.length === 0) {
    return 'No goal runs found yet.';
  }

  const lines = [
    '## SwiftPark Runs',
    'Recent, active, stale, failed, and approved goal records.',
    '',
  ];

  for (const goal of goals) {
    const planExists = await fileExists(goal.paths.planMd);
    const runningJob = goal.jobs.find((job) => job.status === 'running');
    const agent = goal.currentAgent || runningJob?.agent || 'none';
    const elapsed = formatMs(elapsedMs(goal.startedAt || goal.createdAt, goal.endedAt));

    lines.push(
      [
        `**goal-${goal.id}** [${goalRunLabel(goal)}]`,
        `Status: \`${goal.status}\` | Step: ${goal.currentStep || '(unknown)'}`,
        `Agent: ${agent} | Elapsed: ${elapsed} | Plan: ${planExists ? 'yes' : 'no'}`,
        `Worktree: \`${goal.worktreePath}\``,
        `Next: ${goal.nextAction || defaultNextAction(goal)}`,
      ].join('\n'),
      ''
    );
  }

  return lines.join('\n').trim();
}

function isAgentStale(agent: AgentRuntimeState): boolean {
  if (agent.status !== 'running') return false;
  const staleAfter = agent.id === 'orion' ? orionStaleAfterMs : agentStaleAfterMs;
  return elapsedMs(agent.startedAt) > staleAfter;
}

async function formatAgentsStatus(): Promise<string> {
  const registry = await readAgentRegistry();
  const lines: string[] = [
    '## SwiftPark Agents',
    'Status order: Orion, Iris, Atlas, Sentinel, Scout, Echo, Pulse.',
    '',
  ];

  for (const definition of agentDefinitions) {
    const agent = registry[definition.id];
    lines.push(formatAgentStatusBlock(agent), '');
  }

  const goals = (await listGoalStates()).slice(0, 3);
  if (goals.length > 0) {
    lines.push('## Recent Goals');
    const worktreeStatuses = await Promise.all(goals.map((goal) => summarizeWorktreeStatus(goal.worktreePath)));

    for (const [index, goal] of goals.entries()) {
      lines.push(
        `goal-${goal.id} | ${goal.status} | ${goal.agents} | git ${worktreeStatuses[index]} | ${formatElapsed(goal.createdAt)}`
      );
    }
  }

  return truncate(lines.join('\n').trim(), 1900);
}

function statusLabel(agent: AgentRuntimeState): string {
  if (isAgentStale(agent)) return '🔵 running (stale - check /goal-status)';
  if (agent.status === 'running') return '🔵 running';
  if (agent.status === 'waiting-approval' || agent.currentTask.toLowerCase().includes('waiting')) {
    return '🟡 waiting approval';
  }
  if (agent.status === 'failed') return '🔴 failed';
  if (agent.status === 'disabled') return '⚪ disabled/not configured';
  return '🟢 ready/idle';
}

function formatAgentStatusBlock(agent: AgentRuntimeState): string {
  const elapsed = agent.status === 'running' && agent.startedAt ? ` | ${formatElapsed(agent.startedAt)}` : '';
  const goal = agent.currentGoalId ? `goal-${agent.currentGoalId}` : 'none';
  const task = agent.currentTask || 'none';
  const step = agent.currentStep || 'none';
  const output = `#${logicalChannelNames.get(agent.outputChannelId as ChannelId) || agent.outputChannelId}`;

  return [
    `**${agent.displayName}** - ${statusLabel(agent)}${elapsed}`,
    `${agent.role} via ${agent.tool} | ${output}`,
    `Goal: ${goal} | Step: ${truncate(step, 120)}`,
    task === 'none' ? '' : `Task: ${truncate(task, 140)}`,
  ].filter(Boolean).join('\n');
}

async function postAgentStatusBoard(channels: Record<string, TextChannel>): Promise<void> {
  const channel = channels['agent-status'];
  if (!channel) return;
  await postOrUpdateStoredMessage(statusBoardRefPath(), channel, await formatAgentsStatus());
}

async function postCommandCenterError(
  channels: Record<string, TextChannel>,
  title: string,
  errorOutput: string,
  goalId?: string
): Promise<void> {
  const safeOutput = truncate(errorOutput, 1600);
  const prefix = goalId ? `goal-${goalId}: ` : '';

  await channels['logs']?.send([
    `# ${title}`,
    goalId ? `Goal: \`goal-${goalId}\`` : '',
    '```text',
    safeOutput,
    '```',
  ].filter(Boolean).join('\n')).catch(() => undefined);

  await channels['build-feed']?.send(`${prefix}${title}. See #logs for details.`).catch(() => undefined);
}

function sanitizeRemoteUrl(url: string): string {
  return redactSensitive(url.trim())
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^:/\s]+):([^/@\s]+)@/gi, '$1:[redacted]@');
}

async function safeGitOutput(args: string[]): Promise<string> {
  const result = await shell('git', args, repoPath);
  return result.ok ? sanitizeRemoteUrl(result.output.trim() || '(none)') : `unavailable (${truncate(result.output, 300)})`;
}

async function formatGithubReadiness(): Promise<string> {
  const branch = await safeGitOutput(['branch', '--show-current']);
  const origin = await safeGitOutput(['remote', 'get-url', 'origin']);
  const upstream = await safeGitOutput(['remote', 'get-url', 'upstream']);
  const remotes = await shell('git', ['remote'], repoPath);
  const hasOrigin = remotes.output.split('\n').map((line) => line.trim()).includes('origin');
  const hasUpstream = remotes.output.split('\n').map((line) => line.trim()).includes('upstream');
  const forkHint = hasOrigin && hasUpstream && origin !== upstream
    ? 'origin and upstream differ; this looks like a fork/upstream setup.'
    : hasOrigin
      ? 'origin is configured; upstream is not configured or matches origin.'
      : 'origin is not configured.';
  const ghStatus = githubStatusEnabled
    ? await shell('gh', ['auth', 'status'], repoPath)
    : { ok: true, output: 'Skipped. Set GITHUB_STATUS_ENABLED=true to allow read-only gh auth status.' };

  return [
    '## GitHub Readiness',
    `Repo: \`${repoPath}\``,
    `Current branch: \`${branch}\``,
    `Origin: \`${origin}\``,
    `Upstream: \`${upstream}\``,
    `Fork/upstream: ${forkHint}`,
    '',
    'gh auth status:',
    '```text',
    truncate(ghStatus.output || '(no output)', 1200),
    '```',
    '',
    'Safety: this command is read-only. It does not push, create PRs, merge, deploy, or force-push.',
  ].join('\n');
}

function formatJiraReadiness(): string {
  const keys = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY', 'JIRA_BOARD_ID'];
  const lines = keys.map((key) => {
    const required = key !== 'JIRA_BOARD_ID';
    const present = Boolean(process.env[key]?.trim());
    return `- ${key}: ${present ? 'configured' : required ? 'missing' : 'optional/missing'}`;
  });
  const coreConfigured = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY']
    .every((key) => Boolean(process.env[key]?.trim()));

  return [
    '## Jira Readiness',
    `Status: ${jiraEnabled && coreConfigured ? 'configured but API actions still approval-gated' : 'not configured yet'}`,
    `Jira API calls enabled: ${jiraEnabled ? 'yes' : 'no'}`,
    '',
    ...lines,
    '',
    'Safety: this command does not contact Jira and never prints token values.',
    jiraEnabled && coreConfigured
      ? 'Next manual step: define explicit approval-gated Jira actions before enabling any write command.'
      : 'Next manual step: fill placeholders in `.env`, then set `JIRA_ENABLED=true` only when ready.',
  ].join('\n');
}

async function recordManualLogEntry(options: {
  kind: 'change' | 'decision';
  summary: string;
  rationale?: string;
  goalId?: string;
  userId: string;
}): Promise<string> {
  const safeSummary = redactSensitive(options.summary);
  const safeRationale = options.rationale ? redactSensitive(options.rationale) : '';
  const goal = options.goalId ? normalizeGoalId(options.goalId) : '';
  const entry = [
    `## ${new Date().toISOString()} - ${options.kind}`,
    `By: ${options.userId}`,
    goal ? `Goal: goal-${goal}` : '',
    `Summary: ${safeSummary}`,
    safeRationale ? `Rationale: ${safeRationale}` : '',
    '',
  ].filter(Boolean).join('\n');

  await fs.mkdir(path.dirname(manualLogPath), { recursive: true });
  await fs.appendFile(manualLogPath, entry + '\n');
  return entry.trim();
}

function stopTrackedGoalProcesses(goalId: string): string[] {
  const stopped: string[] = [];

  for (const [key, runtime] of activeProcesses.entries()) {
    if (runtime.goalId !== goalId) continue;

    try {
      runtime.subprocess.kill('SIGTERM', {
        forceKillAfterDelay: 5000,
      });
    } catch {
      try {
        runtime.subprocess.kill('SIGTERM');
      } catch {
        // The status update below still records the cancellation.
      }
    }

    activeProcesses.delete(key);
    stopped.push(key);
  }

  return stopped;
}

function formatSetupSummary(result: ChannelSetupResult): string {
  return [
    '## Echo finished command-center setup.',
    result.categoryCreated ? 'Category created: `SwiftPark Agents`' : 'Category already existed: `SwiftPark Agents`',
    '',
    'Created channels:',
    result.created.length ? result.created.map((name) => `- #${name}`).join('\n') : '- none',
    '',
    'Already existed:',
    result.existing.length ? result.existing.map((name) => `- #${name}`).join('\n') : '- none',
    '',
    'Channel guide:',
    ...requiredChannelDefinitions.map((channel) => `- #${channel.displayName}: ${channel.purpose}`),
  ].join('\n');
}

let botLockAcquired = false;
let shuttingDown = false;

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== 'ESRCH';
  }
}

function parseLockPid(content: string): number | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  const pid = Number(firstLine);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function acquireBotProcessLock(): Promise<void> {
  await fs.mkdir(runsDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(botLockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' });
      botLockAcquired = true;
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const existing = await fs.readFile(botLockPath, 'utf8').catch(() => '');
    const existingPid = parseLockPid(existing);

    if (existingPid && existingPid !== process.pid && isPidRunning(existingPid)) {
      throw new Error(
        `Another SwiftPark Command Center bot appears to be running with PID ${existingPid}. Stop that process before starting a second bot.`
      );
    }

    await fs.unlink(botLockPath).catch(() => undefined);
  }

  throw new Error(`Could not acquire bot process lock at ${botLockPath}.`);
}

async function releaseBotProcessLock(): Promise<void> {
  if (!botLockAcquired) return;

  const existing = await fs.readFile(botLockPath, 'utf8').catch(() => '');
  if (parseLockPid(existing) === process.pid) {
    await fs.unlink(botLockPath).catch(() => undefined);
  }
  botLockAcquired = false;
}

async function shutdownBot(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    client.destroy();
  } catch {
    // Continue shutdown and release the process lock.
  }

  await releaseBotProcessLock();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

process.once('SIGINT', () => {
  void shutdownBot('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdownBot('SIGTERM');
});

client.once('clientReady', async () => {
  await fs.mkdir(runsDir, { recursive: true });
  await updateAgent('echo', {
    status: 'online',
    currentTask: 'Discord command center online',
    startedAt: new Date().toISOString(),
  }).catch(() => undefined);
  await refreshStoredHelpGuide().catch((err) => {
    console.warn(`Help guide refresh failed: ${err?.message || String(err)}`);
  });
  await refreshStoredAgentStatusBoard().catch((err) => {
    console.warn(`Agent status board refresh failed: ${err?.message || String(err)}`);
  });
  console.log(`SwiftPark Agent logged in as ${client.user?.tag}`);
});

async function handleInteractionError(interaction: any, err: any): Promise<void> {
  const errorOutput = err?.stack || err?.message || String(err);
  const friendly = 'Command failed safely. Check #logs for details, then retry or adjust the command.';

  if (isInteractionAckFailure(err)) {
    console.warn(
      `Ignored stale or duplicate /${interaction.commandName} interaction without posting a failure: ${err?.message || String(err)}`
    );
    return;
  }

  try {
    if (interaction.guild) {
      const setup = await ensureChannels(interaction.guild);
      await postCommandCenterError(setup.channels, `/${interaction.commandName} failed`, errorOutput).catch(() => undefined);
    }
  } catch {
    // If channel repair also fails, still try to answer the interaction below.
  }

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(friendly);
    } else {
      await interaction.reply({ content: friendly, ephemeral: true });
    }
  } catch {
    try {
      await interaction.followUp({ content: friendly, ephemeral: true });
    } catch {
      // Nothing else to do; the failure was already redacted above.
    }
  }
}

client.on('interactionCreate', async (interaction: any) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await handleChatInputCommand(interaction);
  } catch (err: any) {
    await handleInteractionError(interaction, err);
  }
});

async function handleChatInputCommand(interaction: any): Promise<void> {
  if (!allowedUsers.has(interaction.user.id)) {
    await safeInitialReply(interaction, {
      content: 'You are not authorized to command the SwiftPark Agent.',
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await safeInitialReply(interaction, {
      content: 'This command must be used in the SwiftPark Discord server.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'setup') {
    if (!(await safeDeferReply(interaction))) return;
    const setup = await ensureChannels(guild);
    await updateAgent('echo', {
      status: 'online',
      currentTask: 'Echo finished command-center setup.',
      lastOutputSummary: `Created: ${setup.created.length}; existing: ${setup.existing.length}`,
    });

    const summary = formatSetupSummary(setup);
    await postOrUpdateStoredMessages(helpGuideRefPath(), setup.channels['help'], buildHelpGuideMessages(requiredChannelDefinitions));
    await postAgentStatusBoard(setup.channels);
    await interaction.editReply(truncate(summary, 1900));
    await setup.channels['build-feed'].send(truncate(summary, 1900)).catch(() => {});
    return;
  }

  if (interaction.commandName === 'test') {
    const label = interaction.options.getString('label') || `QA run by ${interaction.user.username}`;
    const requestedMode = interaction.options.getString('mode');
    const mode = isQaMode(requestedMode) ? requestedMode : 'smoke';
    const requestedScreen = interaction.options.getString('screen');
    let qaVisual: TextChannel | undefined;

    if (mode === 'screen' && !isQaScreenName(requestedScreen)) {
      await safeInitialReply(
        interaction,
        [
          '`mode:screen` requires a valid `screen` option.',
          '',
          'Valid screens:',
          validScreenList(),
        ].join('\n')
      );
      return;
    }

    const selection = getQaSelection(mode, requestedScreen);
    const screensLabel = selection.screens.join(', ');

    if (
      !(await safeInitialReply(
        interaction,
        `Sentinel QA started: **${label}**. Mode: \`${mode}\`. Updates will be posted in #qa-visual.`
      ))
    ) {
      return;
    }

    try {
      const setup = await ensureChannels(guild);
      qaVisual = setup.channels['qa-visual'];
      await setAgentRunning('sentinel', undefined, `Standalone QA: ${label}`);

      await qaVisual.send(
        [
          `Sentinel QA started: **${label}**`,
          `Mode: \`${mode}\``,
          `Selected screen(s): ${screensLabel || '(none)'}`,
          `Command: \`${buildQaScript(selection)}\``,
        ].join('\n')
      );
    } catch (err: any) {
      const errorOutput = err?.stack || err?.message || String(err);
      await setAgentFinished('sentinel', false, errorOutput).catch(() => undefined);

      if (qaVisual) {
        await qaVisual.send(
          [
            '# Command-center error',
            `Label: **${label}**`,
          ].join('\n')
        );
        await postTerminalOutput(qaVisual, 'Command-center error', errorOutput);
      }

      await interaction.editReply('Visual QA errored before completion. Check #qa-visual for any posted artifacts.');
      return;
    }

    if (!qaVisual) {
      await setAgentFinished('sentinel', false, '#qa-visual unavailable').catch(() => undefined);
      await interaction.editReply('Visual QA errored before completion: #qa-visual was unavailable.');
      return;
    }

    const result = await runQaFlow(repoPath, qaVisual, label, selection, {
      timeoutMs: sentinelMaxRuntimeMs,
      agent: 'sentinel',
    });
    await setAgentFinished('sentinel', result.ok, result.output).catch(() => undefined);
    const status = result.ok ? 'PASS' : 'FAIL';
    const uploadSuffix = result.uploadSummary ? ` ${result.uploadSummary}.` : '';
    await interaction.editReply(`Visual QA complete: **${status}**. Mode: \`${mode}\`. See #qa-visual.${uploadSuffix}`);
    return;
  }

  if (!(await safeDeferReply(interaction))) return;

  const setup = await ensureChannels(guild);
  const channels = setup.channels;
  const buildFeed = channels['build-feed'];
  const approvals = channels['approvals'];
  const pmPlanning = channels['pm-planning'];
  const agentStatus = channels['agent-status'];

  if (interaction.commandName === 'help') {
    await postOrUpdateStoredMessages(helpGuideRefPath(), channels['help'], buildHelpGuideMessages(requiredChannelDefinitions));
    await interaction.editReply(
      [
        `Updated the command-center guide in <#${channels['help'].id}> as two messages.`,
        '',
        truncate(buildCommandDirectory(), 1700),
      ].join('\n')
    );
    return;
  }

  if (interaction.commandName === 'commands') {
    await interaction.editReply(buildCommandDirectory());
    return;
  }

  if (interaction.commandName === 'status') {
    const gitStatus = await shell('git', ['status', '--short'], repoPath);
    const branch = await shell('git', ['branch', '--show-current'], repoPath);
    const prStatus = githubStatusEnabled
      ? await shell('gh', ['pr', 'status'], repoPath)
      : { ok: true, output: 'GitHub PR status skipped. Set GITHUB_STATUS_ENABLED=true to allow this read.' };

    await interaction.editReply(
      [
        '## SwiftPark Status',
        `Branch: \`${truncate(branch.output.trim(), 100)}\``,
        '```',
        truncate(gitStatus.output || 'clean'),
        '```',
        '## GitHub PR Status',
        '```',
        truncate(prStatus.output),
        '```',
      ].join('\n')
    );
    return;
  }

  if (interaction.commandName === 'github-status') {
    await interaction.editReply(truncate(await formatGithubReadiness(), 1900));
    return;
  }

  if (interaction.commandName === 'jira-status') {
    await interaction.editReply(formatJiraReadiness());
    return;
  }

  if (interaction.commandName === 'agents') {
    const status = await formatAgentsStatus();
    await postAgentStatusBoard(channels).catch(() => undefined);
    await interaction.editReply(truncate(status, 1900));
    return;
  }

  if (interaction.commandName === 'notify') {
    const setting = interaction.options.getString('setting', true);

    if (setting === 'status') {
      const enabled = await notificationStatus(interaction.user.id);
      await interaction.editReply(enabled ? 'Notifications are on for you.' : 'Notifications are off for you.');
      return;
    }

    await setNotificationPreference(interaction.user.id, setting === 'on');
    await interaction.editReply(setting === 'on'
      ? 'Notifications are on. I will ping you for plan-ready, approval-needed, completion, and failure events.'
      : 'Notifications are off.');
    return;
  }

  if (interaction.commandName === 'log-change' || interaction.commandName === 'decision') {
    const summary = interaction.options.getString('summary', true);
    const goalId = interaction.options.getString('goal_id') || undefined;
    const rationale = interaction.commandName === 'decision'
      ? interaction.options.getString('rationale') || undefined
      : undefined;
    const entry = await recordManualLogEntry({
      kind: interaction.commandName === 'decision' ? 'decision' : 'change',
      summary,
      rationale,
      goalId,
      userId: interaction.user.id,
    });
    const channel = channels['manual-log'] || channels['logs'];

    await channel.send(
      [
        interaction.commandName === 'decision' ? '# Decision Logged' : '# Change Logged',
        goalId ? `Goal: \`goal-${normalizeGoalId(goalId)}\`` : '',
        `By: <@${interaction.user.id}>`,
        `Summary: ${redactSensitive(summary)}`,
        rationale ? `Rationale: ${redactSensitive(rationale)}` : '',
        `Local log: \`${relativeToCommandCenter(manualLogPath)}\``,
      ].filter(Boolean).join('\n')
    ).catch(() => undefined);

    await interaction.editReply(
      [
        interaction.commandName === 'decision' ? 'Decision logged.' : 'Change logged.',
        `Local log: \`${relativeToCommandCenter(manualLogPath)}\``,
        '',
        truncate(entry, 900),
      ].join('\n')
    );
    return;
  }

  if (interaction.commandName === 'goal-status') {
    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const goal = await latestGoalForStatus(requestedGoalId ? normalizeGoalId(requestedGoalId) : undefined);

    if (!goal) {
      await interaction.editReply('No goal records found yet.');
      return;
    }

    await interaction.editReply(await formatGoalStatus(goal));
    return;
  }

  if (interaction.commandName === 'plan') {
    const goalId = normalizeGoalId(interaction.options.getString('goal_id', true));
    const requestedFormat = interaction.options.getString('format');
    const format = isPlanDisplayFormat(requestedFormat) ? requestedFormat : 'summary';
    const goal = await readGoalState(goalId);

    if (!goal) {
      await interaction.editReply(`Unknown goal: \`goal-${goalId}\`.`);
      return;
    }

    const plan = await readPlan(goal);
    const planExists = await fileExists(goal.paths.planMd);

    if (!planExists) {
      await interaction.editReply(`No saved plan found yet for \`goal-${goal.id}\`. Current step: ${goal.currentStep || goal.status}.`);
      return;
    }

    const chunks = formatPlanForDiscord(plan, {
      mode: format,
      maxLinesPerSection: format === 'summary' ? 4 : undefined,
    });

    await replyWithChunks(
      interaction,
      [
        `## Orion Plan: goal-${goal.id}`,
        `Format: \`${format}\``,
        `Saved plan: \`${relativeToCommandCenter(goal.paths.planMd)}\``,
        format === 'summary' ? `Use \`/plan goal_id:${goal.id} format:full\` for the complete saved plan.` : '',
      ].filter(Boolean).join('\n'),
      chunks
    );
    return;
  }

  if (interaction.commandName === 'runs' || interaction.commandName === 'active-runs') {
    const limit = interaction.options.getInteger('limit') || 8;
    await interaction.editReply(truncate(await formatRunsList(limit), 1900));
    return;
  }

  if (interaction.commandName === 'cancel-goal' || interaction.commandName === 'cancel') {
    const goalId = normalizeGoalId(interaction.options.getString('goal_id', true));
    const reason = interaction.options.getString('reason') || 'Canceled by human request.';
    const goal = await readGoalState(goalId);

    if (!goal) {
      await interaction.editReply(`Unknown goal: \`goal-${goalId}\`.`);
      return;
    }

    const stopped = stopTrackedGoalProcesses(goal.id);
    const updated = await updateGoalState(goal.id, (current) => {
      current.status = 'canceled';
      current.endedAt = new Date().toISOString();
      current.currentStep = 'Canceled';
      current.lastError = reason;
      current.nextAction = 'Rerun /goal if this work is still needed.';
      for (const job of current.jobs) {
        if (job.status === 'running') {
          job.status = 'canceled';
          job.endedAt = new Date().toISOString();
          job.error = reason;
        }
      }
    });

    if (updated.currentAgent) {
      await updateAgent(updated.currentAgent, {
        status: updated.currentAgent === 'echo' ? 'online' : 'idle',
        currentTask: '',
        currentStep: undefined,
        currentGoalId: undefined,
        currentWorktree: undefined,
        currentBranch: undefined,
        startedAt: undefined,
        lastOutputSummary: `Canceled goal-${updated.id}: ${reason}`,
      }).catch(() => undefined);
    }

    await channels['logs'].send(
      [
        `Goal canceled: \`goal-${updated.id}\``,
        `Reason: ${redactSensitive(reason)}`,
        `Tracked subprocesses stopped: ${stopped.length ? stopped.join(', ') : 'none'}`,
      ].join('\n')
    ).catch(() => undefined);
    await buildFeed.send(`goal-${updated.id} canceled. Tracked subprocesses stopped: ${stopped.length}.`).catch(() => undefined);
    await postAgentStatusBoard(channels).catch(() => undefined);
    await interaction.editReply(
      [
        `Canceled goal-${updated.id}.`,
        stopped.length ? `Stopped tracked subprocesses: ${stopped.join(', ')}` : 'No tracked live subprocess was found. If an older process survived a bot restart, stop it from the terminal.',
      ].join('\n')
    );
    return;
  }

  if (interaction.commandName === 'revise-goal') {
    const goalId = normalizeGoalId(interaction.options.getString('goal_id', true));
    const feedback = interaction.options.getString('feedback', true);
    const target = interaction.options.getString('target') || 'general';
    const goal = await readGoalState(goalId);

    if (!goal) {
      await interaction.editReply(`Unknown goal: \`goal-${goalId}\`.`);
      return;
    }

    const forbidden = isForbiddenTask(feedback);
    if (forbidden) {
      await interaction.editReply(`Revision feedback blocked: ${forbidden}.`);
      return;
    }

    await interaction.editReply(`Orion is revising goal-${goal.id}. No implementation agents will run automatically.`);

    try {
      const revisedGoal = await reviseGoalPlan(goal, feedback, target, channels, interaction.user.id);
      await postAgentStatusBoard(channels).catch(() => undefined);
      await notifySubscribers(
        channels,
        `Orion revised goal-${revisedGoal.id}. Approval needed again: /approve target:${revisedGoal.planApprovalToken}`
      ).catch(() => undefined);
      await interaction.editReply(
        [
          `Orion revised goal-${revisedGoal.id}.`,
          `Plan posted to #orion-planning.`,
          revisedGoal.threadName ? `Thread: \`${revisedGoal.threadName}\`` : '',
          `Approve with \`/approve target:${revisedGoal.planApprovalToken}\`.`,
        ].filter(Boolean).join('\n')
      );
    } catch (err: any) {
      const errorOutput = err?.stack || err?.message || String(err);
      await setAgentFinished('orion', false, errorOutput).catch(() => undefined);
      await postCommandCenterError(channels, 'Goal revision failed', errorOutput, goal.id).catch(() => undefined);
      await agentStatus.send(
        ['# Goal Revision Failed', '```text', truncate(errorOutput), '```'].join('\n')
      ).catch(() => {});
      await interaction.editReply(`Goal revision failed. See #agent-status.`);
    }

    return;
  }

  if (interaction.commandName === 'goal') {
    const description = interaction.options.getString('description', true);
    const requestedMode = interaction.options.getString('mode');
    const requestedAgents = interaction.options.getString('agents');
    const primaryScreen = interaction.options.getString('primary_screen') || undefined;
    const mode = isGoalMode(requestedMode) ? requestedMode : 'plan-only';
    const agents = isGoalAgentChoice(requestedAgents) ? requestedAgents : 'auto';
    let progressMessage: any;
    let activeGoalId: string | undefined;

    const reportProgress: GoalProgressReporter = async (goal, step, nextAction, detail) => {
      if (goal) activeGoalId = goal.id;
      const content = [
        `# Orion Goal Progress${goal ? `: goal-${goal.id}` : ''}`,
        `Step: ${step}`,
        detail || '',
        goal ? `Status: \`${goal.status}\`` : '',
        goal ? `Elapsed: ${formatMs(elapsedMs(goal.startedAt || goal.createdAt, goal.endedAt))}` : '',
        `Next: ${nextAction}`,
      ].filter(Boolean).join('\n');

      await safeEditReply(interaction, content);

      if (progressMessage) {
        await progressMessage.edit(truncate(content, 1900)).catch(() => undefined);
      } else {
        progressMessage = await buildFeed.send(truncate(content, 1900)).catch(() => undefined);
      }
    };

    await safeEditReply(interaction, `Goal received. Orion is preparing a plan for: **${description}**`);
    await buildFeed.send(`New goal from <@${interaction.user.id}> for Orion: **${description}**`);
    await reportProgress(undefined, 'Goal received', 'Creating local run record.');

    try {
      const { goal, plan, worktreeOutput, usedFallback, fallbackReason } = await initializeGoal(
        description,
        mode,
        primaryScreen,
        agents,
        interaction.user.id,
        reportProgress
      );

      await reportProgress(goal, 'Posting plan', 'Posting to #orion-planning and waiting for approval.');
      const threadedGoal = await createGoalThread(pmPlanning, goal);
      await postPlan(pmPlanning, threadedGoal, plan);
      await postPlanToGoalThread(threadedGoal, 'Orion Plan', plan);
      const readyGoal = await updateGoalStep(threadedGoal.id, 'Waiting for approval', `Approve with /approve target:${threadedGoal.planApprovalToken}`, {
        status: 'waiting-for-plan-approval',
        currentAgent: 'orion',
      });

      await buildFeed.send(
        [
          usedFallback ? `# Fallback Orion Plan — Codex planning failed/timed out: goal-${threadedGoal.id}` : `# Goal Created: goal-${threadedGoal.id}`,
          threadedGoal.issueUrl ? `GitHub issue: ${threadedGoal.issueUrl}` : 'GitHub issue: unavailable; local run record created.',
          `Mode: \`${threadedGoal.mode}\``,
          `Agents: \`${threadedGoal.agents}\``,
          `Primary screen: ${threadedGoal.primaryScreen ? `\`${threadedGoal.primaryScreen}\`` : '(none)'}`,
          `Plan: \`${relativeToCommandCenter(threadedGoal.paths.planMd)}\``,
          threadedGoal.threadName ? `Thread: \`${threadedGoal.threadName}\`` : '',
          `Status: waiting for \`/approve target:${threadedGoal.planApprovalToken}\``,
        ].filter(Boolean).join('\n')
      );

      if (usedFallback) {
        await postCommandCenterError(
          channels,
          'Fallback Orion Plan — Codex planning failed/timed out',
          fallbackReason || 'Codex planning failed or timed out.',
          threadedGoal.id
        );
      }

      await agentStatus.send(
        [
          `goal-${threadedGoal.id} is waiting for plan approval.`,
          `Approve with \`/approve target:${threadedGoal.planApprovalToken}\`.`,
          `Worktree created: \`${threadedGoal.worktreePath}\``,
          worktreeOutput ? `Git output: \`${truncate(worktreeOutput, 500)}\`` : '',
        ].filter(Boolean).join('\n')
      );
      await postAgentStatusBoard(channels).catch(() => undefined);
      await notifySubscribers(
        channels,
        `Orion plan ready for goal-${threadedGoal.id}. Approval needed: /approve target:${threadedGoal.planApprovalToken}`
      ).catch(() => undefined);
      await reportProgress(readyGoal, 'Waiting for approval', `Approve with /approve target:${threadedGoal.planApprovalToken}`);

      await safeEditReply(
        interaction,
        [
          usedFallback ? `Fallback Orion Plan — Codex planning failed/timed out for goal-${threadedGoal.id}.` : `Orion plan ready for goal-${threadedGoal.id}.`,
          threadedGoal.issueUrl ? `GitHub issue: ${threadedGoal.issueUrl}` : 'GitHub issue unavailable; local run record created.',
          `Branch: \`${threadedGoal.branchName}\``,
          `Worktree: \`${threadedGoal.worktreePath}\``,
          threadedGoal.threadName ? `Thread: \`${threadedGoal.threadName}\`` : '',
          `Plan posted to #orion-planning.`,
          `Approve with \`/approve target:${threadedGoal.planApprovalToken}\`.`,
        ].filter(Boolean).join('\n')
      );
    } catch (err: any) {
      const errorOutput = err?.stack || err?.message || String(err);
      if (activeGoalId) {
        await updateGoalState(activeGoalId, (current) => {
          current.status = 'blocked';
          current.endedAt = new Date().toISOString();
          current.currentStep = 'Goal creation failed';
          current.lastError = errorOutput;
          current.nextAction = 'Check #logs, then rerun /goal or use /revise-goal if a plan exists.';
        }).catch(() => undefined);
      }
      await setAgentFinished('orion', false, errorOutput).catch(() => undefined);
      await postCommandCenterError(channels, 'Goal creation failed', errorOutput).catch(() => undefined);
      await agentStatus.send(
        ['# Goal Creation Failed', '```text', truncate(errorOutput), '```'].join('\n')
      ).catch(() => {});
      await safeEditReply(interaction, `Goal creation failed. See #agent-status.`);
    }

    return;
  }

  if (interaction.commandName === 'run-agent') {
    const goalId = normalizeGoalId(interaction.options.getString('goal_id', true));
    const requestedAgent = interaction.options.getString('agent', true);

    if (!isRunnableAgent(requestedAgent)) {
      await interaction.editReply(`Unsupported agent: \`${requestedAgent}\`.`);
      return;
    }

    const goal = await readGoalState(goalId);
    if (!goal) {
      await interaction.editReply(`Unknown goal: \`goal-${goalId}\`.`);
      return;
    }

    const task = interaction.options.getString('task') || defaultAgentTask(goal, requestedAgent);
    const forbidden = isForbiddenTask(task);

    if (forbidden) {
      await interaction.editReply(`Agent task blocked: ${forbidden}.`);
      return;
    }

    if (requestedAgent !== 'orion' && requestedAgent !== 'scout' && !goal.approvals.plan) {
      await interaction.editReply(`Plan not approved. Run \`/approve target:${goal.planApprovalToken}\` first.`);
      return;
    }

    await interaction.editReply(`Started ${requestedAgent} for goal-${goal.id}. Updates will post to #agent-status.`);
    void runAgentJob(goal.id, requestedAgent, task, channels, interaction.user.id).catch(async (err: any) => {
      const errorOutput = err?.stack || err?.message || String(err);
      await setAgentFinished(requestedAgent, false, errorOutput).catch(() => undefined);
      await postCommandCenterError(channels, `${requestedAgent} crashed for goal-${goal.id}`, errorOutput, goal.id).catch(() => undefined);
      await agentStatus.send(
        [`${requestedAgent} crashed for goal-${goal.id}.`, '```text', truncate(errorOutput), '```'].join('\n')
      ).catch(() => {});
    });
    return;
  }

  if (interaction.commandName === 'approve') {
    const target = interaction.options.getString('target', true);
    const lowerTarget = target.toLowerCase();

    if (lowerTarget.startsWith('plan-')) {
      const goalId = normalizeGoalId(target);
      const goal = await readGoalState(goalId);

      if (!goal) {
        await interaction.editReply(`Unknown plan target: \`${target}\`.`);
        return;
      }

      if (goal.approvals.plan) {
        await interaction.editReply(`Plan **${goal.planApprovalToken}** was already approved.`);
        return;
      }

      const updated = await updateGoalState(goal.id, (current) => {
        current.status = 'plan-approved';
        current.currentStep = 'Plan approved';
        current.currentAgent = undefined;
        current.lastError = undefined;
        current.nextAction = current.mode === 'execute-after-approval'
          ? 'Starting approved Iris/Atlas/Sentinel flow.'
          : 'Plan-only mode: run /run-agent when ready.';
        current.approvals.plan = {
          approvedAt: new Date().toISOString(),
          approvedBy: interaction.user.id,
        };
      });

      await setAgentFinished('orion', true, `Plan approved for goal-${updated.id}.`).catch(() => undefined);

      await approvals.send(`Approved Orion plan **${updated.planApprovalToken}** for goal-${updated.id} by <@${interaction.user.id}>.`);
      await pmPlanning.send(
        `Plan approved for goal-${updated.id}. ${updated.mode === 'execute-after-approval' ? 'Starting approved Iris/Atlas/Sentinel flow.' : 'Plan-only mode: waiting for /run-agent.'}`
      );
      await postToGoalThread(updated, `Plan approved by <@${interaction.user.id}>. ${updated.mode === 'execute-after-approval' ? 'Starting approved agent flow.' : 'Waiting for /run-agent.'}`);
      await postAgentStatusBoard(channels).catch(() => undefined);
      await notifySubscribers(
        channels,
        `Plan approved for goal-${updated.id}. ${updated.mode === 'execute-after-approval' ? 'Execution is starting.' : 'Waiting for /run-agent.'}`
      ).catch(() => undefined);
      await interaction.editReply(`Approval recorded for **${updated.planApprovalToken}**.`);

      if (updated.mode === 'execute-after-approval') {
        void startApprovedExecution(updated.id, channels, interaction.user.id).catch(async (err: any) => {
          const errorOutput = err?.stack || err?.message || String(err);
          await postCommandCenterError(channels, `Execution crashed for goal-${updated.id}`, errorOutput, updated.id).catch(() => undefined);
          await agentStatus.send(
            [`Execution crashed for goal-${updated.id}.`, '```text', truncate(errorOutput), '```'].join('\n')
          ).catch(() => {});
        });
      }

      return;
    }

    if (lowerTarget.startsWith('qa-') || lowerTarget.startsWith('agent-')) {
      const goalId = normalizeGoalId(target);
      const goal = await readGoalState(goalId);

      if (!goal) {
        await interaction.editReply(`Unknown approval target: \`${target}\`.`);
        return;
      }

      const approvalType = lowerTarget.startsWith('qa-') ? 'qa' : 'agent';
      const updated = await updateGoalState(goal.id, (current) => {
        current.status = approvalType === 'qa' ? 'qa-approved' : 'agent-approved';
        current.currentStep = approvalType === 'qa' ? 'QA approved' : 'Agent work approved';
        current.currentAgent = undefined;
        current.lastError = undefined;
        current.nextAction = approvalType === 'qa'
          ? 'Human may review local artifacts. Merge/deploy still require separate explicit approval.'
          : 'Run Sentinel QA with /run-agent before QA approval.';
        current.approvals[approvalType] = {
          approvedAt: new Date().toISOString(),
          approvedBy: interaction.user.id,
        };
      });

      await approvals.send(`Approved **${target}** for goal-${updated.id} by <@${interaction.user.id}>.`);
      await postToGoalThread(updated, `${target} approved by <@${interaction.user.id}>.`);
      await notifySubscribers(channels, `${target} approved for goal-${updated.id}.`).catch(() => undefined);
      await interaction.editReply(`Approval recorded for **${target}**.`);
      return;
    }

    await approvals.send(`Approved **${target}** by <@${interaction.user.id}>.`);
    await interaction.editReply(`Approval recorded for **${target}**.`);
    return;
  }

  if (interaction.commandName === 'reject') {
    const target = interaction.options.getString('target', true);
    const reason = interaction.options.getString('reason', true);

    if (target.toLowerCase().startsWith('plan-') || target.toLowerCase().startsWith('qa-') || target.toLowerCase().startsWith('agent-')) {
      const goalId = normalizeGoalId(target);
      const goal = await readGoalState(goalId);

      if (goal) {
        await updateGoalState(goal.id, (current) => {
          current.status = 'blocked';
          current.currentStep = 'Rejected / change requested';
          current.lastError = reason;
          current.nextAction = 'Use /revise-goal with the requested change before continuing.';
        });
      }
    }

    await approvals.send(`Rejected **${target}** by <@${interaction.user.id}>.\nReason: ${redactSensitive(reason)}`);
    await notifySubscribers(channels, `${target} was rejected. Reason: ${redactSensitive(reason)}`).catch(() => undefined);
    await interaction.editReply(`Rejection recorded for **${target}**.`);
    return;
  }

  await interaction.editReply('Unknown command.');
}

await acquireBotProcessLock();

try {
  await registerCommands();
  await client.login(token);
} catch (err) {
  await releaseBotProcessLock();
  throw err;
}
