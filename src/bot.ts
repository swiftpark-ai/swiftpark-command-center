import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
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
const qaDashboardCommand = process.env.QA_DASHBOARD_COMMAND || 'npm run qa:dashboard';
const qaRootOverride = process.env.QA_ROOT || process.env.QA_WORKDIR || '';
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
const commandCenterCategoryName = 'Stress Less';
const logicalChannelNames = new Map(channelDefinitions.map((channel) => [channel.id, channel.displayName]));
const phase7ContextPath = path.join(commandCenterRoot, 'context', 'SWIFTPARK_PHASE7_CONTEXT.md');
const pulseStatePath = path.join(runsDir, 'pulse-state.json');
const pulseTimeZone = process.env.PULSE_TIME_ZONE || 'America/Los_Angeles';
const pulseGymPromptHour = Math.min(Math.max(Number(process.env.PULSE_GYM_PROMPT_HOUR || 12), 0), 23);
const pulseGymPromptMinute = Math.min(Math.max(Number(process.env.PULSE_GYM_PROMPT_MINUTE || 0), 0), 59);
const orionThreadRepliesEnabled = envFlag('ORION_THREAD_REPLIES_ENABLED');

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
  finalOutput?: string;
  finalOutputPath?: string;
  timedOut?: boolean;
  killed?: boolean;
  skipped?: boolean;
};

type QaRunSummary = {
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  label: string;
  mode: QaMode;
  screens: string[];
  qaRoot: string;
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

type GoalThreadMessageIntent = 'ignore' | 'greeting' | 'question' | 'approval-intent' | 'revision' | 'chat';

type GoalThreadHistoryEntry = {
  at: string;
  role: 'human' | 'orion' | 'system';
  author: string;
  source: string;
  content: string;
};

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
  finalOutputPath?: string;
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
  lastOrionResponsePath?: string;
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

type QaUnsupportedTarget = {
  id: string;
  aliases: string[];
  reason: string;
  nextAction: string;
};

type QaTaskParseResult = {
  mode: QaMode;
  screen: typeof qaScreenNames[number] | null;
  unsupportedTarget?: QaUnsupportedTarget;
};

type QaRootResolution = {
  ok: boolean;
  root: string;
  reason?: string;
  candidates: string[];
  requiredScript?: string;
};

type ImplementationAgentId = 'iris' | 'atlas';

type ExecutionDecision = {
  agents: ImplementationAgentId[];
  runSentinel: boolean;
  sentinelTask: string;
  sentinelReason: string;
  reasons: string[];
  skipped: string[];
};

type InspectDiscordSource =
  | 'current-thread'
  | 'orion-planning'
  | 'iris-frontend'
  | 'atlas-backend'
  | 'sentinel-qa'
  | 'echo-status'
  | 'echo-logs'
  | 'build-feed';

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

type PulsePreference = {
  enabled: boolean;
  gymCheckIn: boolean;
  updatedAt: string;
};

type PulseGymLog = {
  status: 'yes' | 'not-yet';
  updatedAt: string;
};

type PulseState = {
  users: Record<string, PulsePreference>;
  gym: Record<string, Record<string, PulseGymLog>>;
  lastGymPromptDate?: string;
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

const qaDriverScreenNames = [
  'brighton-facility',
  'brighton-spot-map',
  'brighton-spot-details',
  'brighton-navigation',
  'brighton-parked',
  'osu-facility',
  'osu-spot-map',
] as const;

const qaDashboardScreenNames = [
  'dashboard-overview',
  'dashboard-cameras',
] as const;

const qaScreenNames = [
  ...qaDriverScreenNames,
  ...qaDashboardScreenNames,
] as const;

const qaSmokeScreens = [
  'brighton-facility',
  'brighton-spot-map',
] as const;

const qaProjects = [
  'mobile-chrome',
  'desktop-chrome',
] as const;

const qaUnsupportedTargets: QaUnsupportedTarget[] = [];

const inspectDiscordSources: Array<{ name: string; value: InspectDiscordSource }> = [
  { name: 'current-thread', value: 'current-thread' },
  { name: 'orion-planning', value: 'orion-planning' },
  { name: 'iris-frontend', value: 'iris-frontend' },
  { name: 'atlas-backend', value: 'atlas-backend' },
  { name: 'sentinel-qa', value: 'sentinel-qa' },
  { name: 'echo-status', value: 'echo-status' },
  { name: 'echo-logs', value: 'echo-logs' },
  { name: 'build-feed', value: 'build-feed' },
];

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

function localDateParts(date = new Date()): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: pulseTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || '00';

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: Number(value('hour')),
    minute: Number(value('minute')),
  };
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

function isDashboardQaScreen(value: string | null): value is typeof qaDashboardScreenNames[number] {
  return Boolean(value && qaDashboardScreenNames.includes(value as typeof qaDashboardScreenNames[number]));
}

function isInspectDiscordSource(value: string | null): value is InspectDiscordSource {
  return Boolean(value && inspectDiscordSources.some((source) => source.value === value));
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

function dashboardScreenForText(text: string): typeof qaDashboardScreenNames[number] | null {
  if (!/\b(dashboard|operator|admin)\b/.test(text)) return null;
  if (/\b(camera|cameras|yolo|detection|live feed|health)\b/.test(text)) {
    return 'dashboard-cameras';
  }
  return 'dashboard-overview';
}

function qaScreenForText(text: string, defaultScreen?: string): typeof qaScreenNames[number] | null {
  const defaultQaScreen = isQaScreenName(defaultScreen || null)
    ? defaultScreen as typeof qaScreenNames[number]
    : null;

  return qaScreenNames.find((screen) => text.includes(screen.toLowerCase()))
    || dashboardScreenForText(text)
    || defaultQaScreen;
}

function qaUnsupportedTargetForText(text: string): QaUnsupportedTarget | undefined {
  const lower = text.toLowerCase();
  return qaUnsupportedTargets.find((target) =>
    target.aliases.some((alias) => lower.includes(alias.toLowerCase()))
  );
}

function parseQaTask(task: string, defaultScreen?: string): QaTaskParseResult {
  const lowerTask = task.toLowerCase();
  const unsupportedTarget = qaUnsupportedTargetForText(lowerTask);

  if (lowerTask.includes('full')) {
    return { mode: 'full' as QaMode, screen: null, unsupportedTarget };
  }

  const taskScreen = qaScreenForText(lowerTask, defaultScreen);

  if (lowerTask.includes('screen') || taskScreen) {
    return taskScreen
      ? { mode: 'screen' as QaMode, screen: taskScreen, unsupportedTarget }
      : { mode: 'smoke' as QaMode, screen: null, unsupportedTarget };
  }

  return { mode: 'smoke' as QaMode, screen: null, unsupportedTarget };
}

function buildQaScript(selection: ReturnType<typeof getQaSelection>): string {
  if (selection.mode === 'full' || selection.screens.length === 0) {
    return `${qaCommand} && ${qaDashboardCommand}`;
  }

  const grep = selection.screens.map(escapeRegExp).join('|');
  const command = selection.screens.some((screen) => isDashboardQaScreen(screen))
    ? qaDashboardCommand
    : qaCommand;
  return `${command} -- --grep ${quoteForShell(grep)}`;
}

function selectionIncludesDashboard(selection: ReturnType<typeof getQaSelection>): boolean {
  return selection.mode === 'full' || selection.screens.some((screen) => isDashboardQaScreen(screen));
}

function selectionIncludesDriver(selection: ReturnType<typeof getQaSelection>): boolean {
  return selection.mode === 'full' || selection.screens.some((screen) => !isDashboardQaScreen(screen));
}

function localQaReportLabel(root: string, selection: ReturnType<typeof getQaSelection>): string {
  const reports: string[] = [];
  if (selectionIncludesDriver(selection)) {
    reports.push(path.relative(root, path.join(root, 'playwright-report/index.html')));
  }
  if (selectionIncludesDashboard(selection)) {
    reports.push(path.relative(root, path.join(root, 'playwright-report-dashboard/index.html')));
  }
  return reports.join(', ') || path.relative(root, path.join(root, 'playwright-report/index.html'));
}

function requiredPackageScriptForQaCommand(script: string): string | undefined {
  const match = script.match(/\b(?:npm|pnpm|bun)\s+run\s+([A-Za-z0-9:_-]+)/)
    || script.match(/\byarn\s+run\s+([A-Za-z0-9:_-]+)/);
  if (match?.[1]) return match[1];

  const yarnShortcut = script.match(/^\s*yarn\s+([A-Za-z0-9:_-]+)\b/);
  if (yarnShortcut?.[1] && !['add', 'install', 'remove', 'upgrade', 'dlx'].includes(yarnShortcut[1])) {
    return yarnShortcut[1];
  }

  return undefined;
}

async function packageJsonSupportsQa(packageJsonPath: string, requiredScript?: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    if (!requiredScript) return true;
    return Boolean(parsed.scripts?.[requiredScript]);
  } catch {
    return false;
  }
}

async function resolveQaRoot(root: string, script = qaCommand): Promise<QaRootResolution> {
  const requiredScript = requiredPackageScriptForQaCommand(script);
  const candidates: string[] = [];

  const evaluatePackage = async (packageJsonPath: string): Promise<string | undefined> => {
    const directory = path.dirname(packageJsonPath);
    try {
      await fs.access(packageJsonPath);
    } catch {
      return undefined;
    }
    candidates.push(directory);
    return (await packageJsonSupportsQa(packageJsonPath, requiredScript)) ? directory : undefined;
  };

  if (qaRootOverride.trim()) {
    const configuredRoot = path.isAbsolute(qaRootOverride)
      ? qaRootOverride
      : path.join(root, qaRootOverride);
    const configuredPackage = path.join(configuredRoot, 'package.json');
    candidates.push(configuredRoot);

    if (await packageJsonSupportsQa(configuredPackage, requiredScript)) {
      return { ok: true, root: configuredRoot, candidates, requiredScript };
    }

    return {
      ok: false,
      root: configuredRoot,
      requiredScript,
      candidates,
      reason: requiredScript
        ? `Configured QA root \`${configuredRoot}\` does not contain package.json with script \`${requiredScript}\`.`
        : `Configured QA root \`${configuredRoot}\` does not contain a readable package.json.`,
    };
  }

  const rootPackage = await evaluatePackage(path.join(root, 'package.json'));
  if (rootPackage) return { ok: true, root: rootPackage, candidates, requiredScript };

  const packageJsons = await fg(
    ['package.json', '*/package.json', '*/*/package.json', '*/*/*/package.json'],
    {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: false,
      ignore: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/playwright-report/**',
        '**/test-results/**',
      ],
    }
  ).catch(() => []);

  for (const packageJsonPath of packageJsons.sort()) {
    if (path.resolve(packageJsonPath) === path.resolve(root, 'package.json')) continue;
    const supported = await evaluatePackage(packageJsonPath);
    if (supported) return { ok: true, root: supported, candidates, requiredScript };
  }

  const uniqueCandidates = [...new Set(candidates)];
  return {
    ok: false,
    root,
    candidates: uniqueCandidates,
    requiredScript,
    reason: uniqueCandidates.length === 0
      ? `No package.json found under \`${root}\`, so Sentinel cannot run \`${script}\`.`
      : requiredScript
        ? `Found package.json candidate(s), but none define script \`${requiredScript}\` required by \`${script}\`.`
        : `Found package.json candidate(s), but Sentinel could not choose a safe QA root for \`${script}\`.`,
  };
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

function cleanAgentFinalOutput(output: string): string {
  const safeOutput = stripAnsi(redactSensitive(output || '')).trim();
  if (!safeOutput) return '(no final response captured)';

  return safeOutput
    .split('\n')
    .filter((line) => !/^\s*tokens used\s*$/i.test(line))
    .filter((line) => !/^\s*\d{1,3}(?:,\d{3})*\s*$/.test(line))
    .join('\n')
    .trim() || '(no final response captured)';
}

function extractSection(output: string, names: string[], maxLength = 1200): string {
  const safeOutput = stripAnsi(redactSensitive(output || ''));
  const escaped = names.map(escapeRegExp).join('|');
  const match = safeOutput.match(new RegExp(`(?:^|\\n)#{0,3}\\s*(?:${escaped})\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n#{0,3}\\s*[A-Z][A-Za-z /-]{2,}\\s*:?\\s*\\n|$)`, 'i'));
  const value = match?.[1]?.trim();
  if (value) return truncate(value, maxLength);

  const lines = safeOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(\$|>|npm |pnpm |yarn |codex |claude )/.test(line));
  return truncate(lines.slice(-8).join('\n') || '(not reported)', maxLength);
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
  files: ChangedFileSummary[]
): string {
  const succeeded = job.status === 'succeeded';
  const skipped = job.status === 'skipped';
  const label = agent === 'iris' ? 'Iris / Claude' : 'Atlas / Codex';
  const nextAction = succeeded
    ? agent === 'iris'
      ? `Review UI changes, then run Sentinel: \`/run-agent goal_id:${goal.id} agent:sentinel\`.`
      : `Review system changes, then run Sentinel or approve agent work: \`/approve target:${goal.agentApprovalToken}\`.`
    : skipped
      ? `Review the skip reason, then revise the goal or rerun \`/run-agent goal_id:${goal.id} agent:${agent}\` when the task is ready.`
      : retryGuidance(agent, goal);

  return [
    `Status: ${succeeded ? 'PASS' : skipped ? 'SKIPPED' : 'FAIL'} (${label})`,
    `Goal: goal-${goal.id}`,
    `Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}`,
    job.finalOutputPath ? `Final answer: \`${relativeToCommandCenter(job.finalOutputPath)}\`` : '',
    job.outputPath ? `Raw log: \`${relativeToCommandCenter(job.outputPath)}\`` : '',
    'Files changed:',
    formatChangedFiles(files),
    `Next action: ${nextAction}`,
  ].filter(Boolean).join('\n');
}

function formatGenericAgentSummary(
  agent: RunnableAgentId,
  goal: GoalState,
  job: JobRecord,
  output: string
): string {
  const succeeded = job.status === 'succeeded';
  const skipped = job.status === 'skipped';
  return [
    `Status: ${succeeded ? 'PASS' : skipped ? 'SKIPPED' : 'FAIL'} (${agent})`,
    `Goal: goal-${goal.id}`,
    `Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}`,
    '',
    `Summary: ${extractSection(output, ['Summary'])}`,
    '',
    `Next action: ${succeeded ? defaultNextAction(goal) : skipped ? 'Review the skip reason, then rerun only when the prerequisite is ready.' : retryGuidance(agent, goal)}`,
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
      .setName('inspect-discord')
      .setDescription('Read recent bot-visible Discord messages into a local redacted report')
      .addStringOption((option) =>
        option
          .setName('source')
          .setDescription('Channel or current goal thread to inspect')
          .setRequired(true)
          .addChoices(...inspectDiscordSources)
      )
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Optional goal id when inspecting a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addIntegerOption((option) =>
        option
          .setName('limit')
          .setDescription('Messages to fetch')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50)
      ),

    new SlashCommandBuilder()
      .setName('run-agent')
      .setDescription('Run one approved SwiftPark command-center agent')
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
          .setName('goal_id')
          .setDescription('Goal id from /goal; optional inside a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
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
            { name: 'execute-after-approval', value: 'execute-after-approval' },
            { name: 'plan-only', value: 'plan-only' }
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
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName('plan')
      .setDescription('Show a saved Orion plan summary or the full saved plan')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal; optional inside a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
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
          .setDescription('Goal id from /goal; optional inside a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
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
          .setDescription('Goal id from /goal; optional inside a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Optional cancellation reason')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('clear-blocker')
      .setDescription('Clear a stale non-running goal blocker after human review')
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal; optional inside a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why the blocker is safe to clear')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('revise-goal')
      .setDescription('Ask Orion to revise a goal plan from feedback')
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
      )
      .addStringOption((option) =>
        option
          .setName('goal_id')
          .setDescription('Goal id from /goal; optional inside a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName('approve')
      .setDescription('Record approval for a plan, agent run, QA, PR, or issue')
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('plan-<goal_id>, qa-<goal_id>, agent-<goal_id>, PR, issue, or branch; optional in a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName('reject')
      .setDescription('Record rejection/change request for a goal, plan, QA, PR, or issue')
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('What needs to change')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('Plan token, QA token, PR number, issue number, or branch; optional in a goal thread')
          .setRequired(false)
          .setAutocomplete(true)
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
      .setName('pulse')
      .setDescription('Manage Pulse check-ins and show a founder brief')
      .addStringOption((option) =>
        option
          .setName('setting')
          .setDescription('Pulse action')
          .setRequired(false)
          .addChoices(
            { name: 'brief', value: 'brief' },
            { name: 'status', value: 'status' },
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
            { name: 'gym-on', value: 'gym-on' },
            { name: 'gym-off', value: 'gym-off' }
          )
      ),

    new SlashCommandBuilder()
      .setName('pulse-checkin')
      .setDescription('Log a Pulse personal check-in')
      .addStringOption((option) =>
        option
          .setName('gym')
          .setDescription('Gym check-in for today')
          .setRequired(false)
          .addChoices(
            { name: 'yes', value: 'yes' },
            { name: 'not-yet', value: 'not-yet' },
            { name: 'status', value: 'status' }
          )
      ),

    new SlashCommandBuilder()
      .setName('daily-brief')
      .setDescription('Show the Pulse daily command-center brief'),

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
    (c: any) => c.name === commandCenterCategoryName && c.type === ChannelType.GuildCategory
  );
  let categoryCreated = false;

  if (!category) {
    category = await guild.channels.create({
      name: commandCenterCategoryName,
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
      if (definition.required && channel.name !== definition.displayName) {
        const canonicalExists = guild.channels.cache.find(
          (candidate: any) =>
            candidate.type === ChannelType.GuildText
            && String(candidate.name).toLowerCase() === definition.displayName.toLowerCase()
        );

        if (!canonicalExists) {
          try {
            channel = await channel.setName(
              definition.displayName,
              `SwiftPark Command Center canonical channel name: ${definition.displayName}.`
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

function needsStartupGoalRecovery(goal: GoalState): boolean {
  return ['created', 'planning', 'revision-pending-approval', 'running'].includes(goal.status)
    || goal.jobs.some((job) => job.status === 'running');
}

async function reconcileStartupState(): Promise<{ goals: number; agents: number }> {
  let recoveredGoals = 0;
  let recoveredAgents = 0;
  const now = new Date().toISOString();
  const recoveryMessage = 'Recovered after bot restart; no live subprocess is tracked for this run.';
  const goals = await listGoalStates();

  for (const goal of goals) {
    if (!needsStartupGoalRecovery(goal)) continue;

    await updateGoalState(goal.id, (current) => {
      current.status = 'blocked';
      current.currentStep = 'Recovered after bot restart';
      current.currentAgent = undefined;
      current.lastError = recoveryMessage;
      current.nextAction = `Review goal-${current.id}, then use the thread buttons, /clear-blocker, or rerun the needed agent.`;
      for (const job of current.jobs) {
        if (job.status === 'running') {
          job.status = 'failed';
          job.endedAt = now;
          job.error = recoveryMessage;
        }
      }
    }).catch(() => undefined);
    recoveredGoals += 1;
  }

  const registry = await readAgentRegistry();
  let registryChanged = false;
  for (const definition of agentDefinitions) {
    const agent = registry[definition.id];
    if (agent.status !== 'running') continue;

    const idleStatus = definition.defaultStatus === 'online'
      ? 'online'
      : definition.defaultStatus === 'disabled'
        ? 'disabled'
        : 'idle';
    registry[definition.id] = {
      ...agent,
      status: idleStatus,
      currentTask: '',
      currentStep: 'Recovered after bot restart',
      currentGoalId: undefined,
      currentWorktree: undefined,
      currentBranch: undefined,
      startedAt: undefined,
      lastUpdateAt: now,
      lastOutputSummary: recoveryMessage,
    };
    registryChanged = true;
    recoveredAgents += 1;
  }

  if (registryChanged) {
    await writeAgentRegistry(registry);
  }

  return { goals: recoveredGoals, agents: recoveredAgents };
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

async function readPulseState(): Promise<PulseState> {
  try {
    const parsed = JSON.parse(await fs.readFile(pulseStatePath, 'utf8')) as Partial<PulseState>;
    return {
      users: parsed.users || {},
      gym: parsed.gym || {},
      lastGymPromptDate: parsed.lastGymPromptDate,
    };
  } catch {
    return { users: {}, gym: {} };
  }
}

async function writePulseState(state: PulseState): Promise<void> {
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(pulseStatePath, JSON.stringify(state, null, 2) + '\n');
}

async function setPulsePreference(
  userId: string,
  patch: Partial<Pick<PulsePreference, 'enabled' | 'gymCheckIn'>>
): Promise<PulsePreference> {
  const state = await readPulseState();
  const current = state.users[userId] || { enabled: false, gymCheckIn: false, updatedAt: new Date().toISOString() };
  const updated = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  state.users[userId] = updated;
  await writePulseState(state);
  await refreshPulseAgentStatus(state).catch(() => undefined);
  return updated;
}

async function refreshPulseAgentStatus(state?: PulseState): Promise<void> {
  state ||= await readPulseState();
  const enabledCount = Object.values(state.users).filter((user) => user.enabled).length;
  const gymCount = Object.values(state.users).filter((user) => user.enabled && user.gymCheckIn).length;

  await updateAgent('pulse', {
    status: enabledCount > 0 ? 'online' : 'disabled',
    currentTask: enabledCount > 0
      ? `Pulse enabled for ${enabledCount} user(s); gym check-ins for ${gymCount}.`
      : '',
    currentStep: enabledCount > 0 ? 'Standing by for /pulse, /daily-brief, and noon gym check-ins.' : undefined,
    lastOutputSummary: enabledCount > 0
      ? `Pulse is opt-in. Gym prompt: ${String(pulseGymPromptHour).padStart(2, '0')}:${String(pulseGymPromptMinute).padStart(2, '0')} ${pulseTimeZone}.`
      : undefined,
  });
}

async function recordPulseGymCheckin(userId: string, status: 'yes' | 'not-yet', date = localDateParts().date): Promise<string> {
  const state = await readPulseState();
  state.gym[date] ||= {};
  state.gym[date][userId] = {
    status,
    updatedAt: new Date().toISOString(),
  };
  await writePulseState(state);
  await refreshPulseAgentStatus(state).catch(() => undefined);

  return status === 'yes'
    ? `Gym logged for ${date}. Cookie earned: 🍪`
    : `Gym check-in logged for ${date}: not yet. The cookie remains dramatically nearby.`;
}

async function readPhase7ContextForGoal(text: string): Promise<string> {
  if (!/(phase\s*7|mobile[-\s]?web|brighton|osu|google maps|neo|operator dashboard|pilot loop)/i.test(text)) {
    return '';
  }

  try {
    const context = await fs.readFile(phase7ContextPath, 'utf8');
    return truncate(context, 14000);
  } catch {
    return '';
  }
}

async function formatPulseBrief(userId?: string): Promise<string> {
  const state = await readPulseState();
  const goals = await listGoalStates();
  const active = goals.filter((goal) => isActiveGoalStatus(goal.status));
  const waiting = active.filter((goal) =>
    goal.status === 'waiting-for-plan-approval'
    || goal.status === 'plan-revised'
    || goal.status === 'ready-for-qa-approval'
  );
  const blocked = goals.filter((goal) => goal.status === 'blocked' || goal.status === 'timed-out');
  const today = localDateParts().date;
  const gymStatus = userId ? state.gym[today]?.[userId]?.status : undefined;
  const phase7ContextExists = await fileExists(phase7ContextPath);
  const recent = goals.slice(0, 3);

  return [
    '## Pulse Brief',
    `Date: ${today} (${pulseTimeZone})`,
    `Phase 7 context: ${phase7ContextExists ? '`context/SWIFTPARK_PHASE7_CONTEXT.md` is available.' : 'not imported yet.'}`,
    userId ? `Gym today: ${gymStatus === 'yes' ? 'yes 🍪' : gymStatus === 'not-yet' ? 'not yet' : 'not logged'}` : '',
    '',
    `Active goals: ${active.length}`,
    `Waiting approvals/review: ${waiting.length}`,
    `Blocked/timed-out goals: ${blocked.length}`,
    '',
    'Recent goals:',
    ...(recent.length
      ? recent.map((goal) => `- goal-${goal.id}: ${goal.status}; next: ${truncate(goal.nextAction || defaultNextAction(goal), 160)}`)
      : ['- none']),
    '',
    'Suggested next command:',
    waiting[0]
      ? `- Review goal-${waiting[0].id}, then approve/revise: \`/goal-status goal_id:${waiting[0].id}\``
      : active[0]
        ? `- Check active work: \`/goal-status goal_id:${active[0].id}\``
        : '- Start Phase 7B plan-only with the imported context when ready.',
  ].filter(Boolean).join('\n');
}

function pulseGymButtons(date: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`pulse:gym:yes:${date}`)
      .setLabel('Yes')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`pulse:gym:not-yet:${date}`)
      .setLabel('Not yet')
      .setStyle(ButtonStyle.Secondary)
  );
}

async function sendPulseGymPromptIfDue(): Promise<void> {
  const now = localDateParts();
  if (now.hour !== pulseGymPromptHour || now.minute !== pulseGymPromptMinute) return;

  const state = await readPulseState();
  if (state.lastGymPromptDate === now.date) return;

  const userIds = Object.entries(state.users)
    .filter(([userId, preference]) => allowedUsers.has(userId) && preference.enabled && preference.gymCheckIn)
    .map(([userId]) => userId);

  state.lastGymPromptDate = now.date;
  await writePulseState(state);
  if (userIds.length === 0) return;

  const guild = await client.guilds.fetch(guildId).catch(() => undefined);
  if (!guild) return;

  const setup = await ensureChannels(guild);
  const pulseChannel = setup.channels['personal-checkins'] || setup.channels['agent-status'];
  if (!pulseChannel) return;

  await pulseChannel.send({
    content: [
      `${userIds.map((userId) => `<@${userId}>`).join(' ')}`,
      '',
      '## Pulse Gym Check',
      'Did you go to the gym this morning?',
      'Tap **Yes** for your cookie.',
    ].join('\n'),
    components: [pulseGymButtons(now.date)],
    allowedMentions: { users: userIds, roles: [], parse: [] },
  }).catch(() => undefined);
}

function startPulseScheduler(): NodeJS.Timeout {
  const interval = setInterval(() => {
    void sendPulseGymPromptIfDue().catch((err) => {
      console.warn(`Pulse scheduler failed: ${err?.message || String(err)}`);
    });
  }, 60000);
  interval.unref?.();
  void sendPulseGymPromptIfDue().catch(() => undefined);
  return interval;
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
        lastOrionResponsePath: goal.lastOrionResponsePath,
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
  if (goal.status === 'plan-approved') return 'Use the goal action buttons, or wait for the execute-after-approval flow.';
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

function goalDisplayLabel(goal: GoalState): string {
  const label = [
    `goal-${goal.id}`,
    goal.description.replace(/\s+/g, ' ').slice(0, 48),
    goal.status,
  ].filter(Boolean).join(' | ');

  return label.length > 100 ? `${label.slice(0, 97)}...` : label;
}

async function goalForThreadId(channelId?: string): Promise<GoalState | undefined> {
  if (!channelId) return undefined;
  const goals = await listGoalStates();
  return goals.find((goal) => goal.threadId === channelId);
}

async function resolveGoalForInteraction(
  interaction: any,
  rawGoalId?: string | null,
  options: { allowLatest?: boolean } = {}
): Promise<{ goal?: GoalState; source: 'explicit' | 'thread' | 'latest' | 'missing'; message?: string }> {
  if (rawGoalId?.trim()) {
    const goal = await readGoalState(normalizeGoalId(rawGoalId));
    return goal
      ? { goal, source: 'explicit' }
      : { source: 'missing', message: `Unknown goal: \`goal-${normalizeGoalId(rawGoalId)}\`.` };
  }

  const threadGoal = await goalForThreadId(interaction.channelId);
  if (threadGoal) return { goal: threadGoal, source: 'thread' };

  if (options.allowLatest) {
    const latest = await latestGoalForStatus();
    if (latest) return { goal: latest, source: 'latest' };
  }

  return {
    source: 'missing',
    message: 'No goal id was provided, and this command was not used inside a recognized goal thread.',
  };
}

function defaultApprovalTargetForGoal(goal: GoalState): string {
  if (goal.status === 'ready-for-qa-approval') return goal.qaApprovalToken;
  if (!goal.approvals.plan || goal.status === 'waiting-for-plan-approval' || goal.status === 'plan-revised') return goal.planApprovalToken;
  if (!goal.approvals.agent && hasSuccessfulImplementationJob(goal)) return goal.agentApprovalToken;
  return goal.planApprovalToken;
}

function hasSuccessfulImplementationJob(goal: GoalState): boolean {
  return goal.jobs.some((job) =>
    (job.agent === 'iris' || job.agent === 'atlas') && job.status === 'succeeded'
  );
}

async function resolveApprovalTargetForInteraction(interaction: any, rawTarget?: string | null): Promise<string | undefined> {
  if (rawTarget?.trim()) return rawTarget.trim();
  const threadGoal = await goalForThreadId(interaction.channelId);
  return threadGoal ? defaultApprovalTargetForGoal(threadGoal) : undefined;
}

function chunkMarkdownForDiscord(input: string, max = 1800): string[] {
  let remaining = redactSensitive(input).trim();
  const chunks: string[] = [];

  while (remaining.length > max) {
    const splitAt = Math.max(
      remaining.lastIndexOf('\n\n', max),
      remaining.lastIndexOf('\n', max),
      Math.floor(max * 0.8)
    );
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ['(no response)'];
}

async function postOrionConversation(channel: TextChannel | any, goal: GoalState, title: string, response: string): Promise<void> {
  await channel.send(`**${title}: goal-${goal.id}**`);
  for (const chunk of chunkMarkdownForDiscord(response)) {
    await channel.send(chunk);
  }
  await postGoalControls(channel, goal);
}

async function replyToGoalThreadMessage(message: any, goal: GoalState, response: string): Promise<void> {
  const chunks = chunkMarkdownForDiscord(response);
  const first = chunks.shift() || '(no response)';
  await message.channel?.send(first).catch(() => undefined);

  for (const chunk of chunks) {
    await message.channel?.send(chunk).catch(() => undefined);
  }
  await postGoalControls(message.channel, goal).catch(() => undefined);
}

function orionResponsePath(goal: GoalState, jobId: string): string {
  return path.join(goal.runDir, `${jobId}-response.md`);
}

function goalThreadHistoryPath(goal: GoalState): string {
  return path.join(goal.runDir, 'thread-history.jsonl');
}

async function appendGoalThreadHistory(goal: GoalState, entry: Omit<GoalThreadHistoryEntry, 'at'>): Promise<void> {
  const record: GoalThreadHistoryEntry = {
    ...entry,
    at: new Date().toISOString(),
    content: truncate(redactSensitive(entry.content), 6000),
  };
  await fs.appendFile(goalThreadHistoryPath(goal), JSON.stringify(record) + '\n').catch(() => undefined);
}

async function readGoalThreadHistory(goal: GoalState, limit = 12): Promise<GoalThreadHistoryEntry[]> {
  try {
    const raw = await fs.readFile(goalThreadHistoryPath(goal), 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as GoalThreadHistoryEntry);
  } catch {
    return [];
  }
}

function formatGoalThreadHistoryForPrompt(history: GoalThreadHistoryEntry[]): string {
  if (history.length === 0) return '(no previous thread messages captured)';
  return history
    .map((entry) => {
      const speaker = entry.role === 'orion' ? 'Orion' : entry.role === 'human' ? `Human ${entry.author}` : 'System';
      return [
        `### ${speaker} (${entry.source}, ${entry.at})`,
        truncate(entry.content, 1200),
      ].join('\n');
    })
    .join('\n\n');
}

async function postGoalControls(channel: TextChannel | any, goal: GoalState, label = 'Goal controls'): Promise<void> {
  if (!channel?.send) return;
  await channel.send({
    content: `**${label}: goal-${goal.id}**`,
    components: goalActionRows(goal),
  });
}

function goalActionRows(goal: GoalState): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`goal:approve-run:${goal.id}`)
        .setLabel('Approve + Run')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`goal:approve-plan:${goal.id}`)
        .setLabel('Plan Only')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`goal:ask-orion:${goal.id}`)
        .setLabel('Ask Orion')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`goal:revise-plan:${goal.id}`)
        .setLabel('Revise Plan')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`goal:plan-summary:${goal.id}`)
        .setLabel('Summary')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`goal:plan-full:${goal.id}`)
        .setLabel('Full Plan')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`goal:run-iris:${goal.id}`)
        .setLabel('Run Iris')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`goal:run-atlas:${goal.id}`)
        .setLabel('Run Atlas')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`goal:run-sentinel:${goal.id}`)
        .setLabel('Run Sentinel')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`goal:cancel:${goal.id}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
    ),
  ];
}

function classifyGoalThreadMessage(content: string): GoalThreadMessageIntent {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return 'ignore';

  if (/^(hi+|hello|hey|yo)[.!? ]*$/i.test(normalized)) {
    return 'greeting';
  }

  if (/^(thanks|thank you|ok|okay|cool|nice|lol|lmao|got it|sounds good)[.!? ]*$/i.test(normalized)) {
    return 'greeting';
  }

  if (/\b(idiot|stupid|dumb)\b/i.test(normalized) && normalized.split(/\s+/).length <= 6) {
    return 'greeting';
  }

  if (/[?]$/.test(normalized) || /^(what|where|which|who|why|how|can|could|should|would|does|do|did|is|are|am|will)\b/i.test(normalized)) {
    return 'question';
  }

  if (/\b(approve|approved|approval|proceed|go ahead|looks good|lgtm|ship it|start|run it|continue|yes run|yes proceed)\b/i.test(normalized)) {
    return 'approval-intent';
  }

  if (/\b(revise|change|update|make|focus|keep|remove|add|ignore|instead|only|don't|do not|dont|should|need|needs|scope|narrow|expand)\b/i.test(normalized)) {
    return 'revision';
  }

  return normalized.length >= 24 ? 'chat' : 'greeting';
}

function hasLocalGoalThreadAnswer(content: string): boolean {
  const lower = content.toLowerCase();
  return /\b(repo|repository|workspace|path|folder|directory|working in|worktree)\b/.test(lower)
    || /\b(status|state|where are we|next|what now|what's next|whats next)\b/.test(lower)
    || /\b(approve|approval|run|agent|iris|atlas|sentinel)\b/.test(lower);
}

async function answerGoalThreadQuestion(goal: GoalState, content: string): Promise<string> {
  const lower = content.toLowerCase();
  if (/\b(repo|repository|workspace|path|folder|directory|working in|worktree)\b/.test(lower)) {
    return [
      `For this goal, Orion is tracking goal-${goal.id}.`,
      '',
      `Configured product repo: \`${repoPath}\``,
      `Command center repo: \`${commandCenterRoot}\``,
      `Goal worktree: \`${goal.worktreePath}\``,
      `Goal branch: \`${goal.branchName}\``,
      '',
      'If Phase 7 belongs somewhere else, revise the goal with the correct repo/path before running agents.',
    ].join('\n');
  }

  if (/\b(status|state|where are we|next|what now|what's next|whats next)\b/.test(lower)) {
    return formatGoalStatus(goal);
  }

  if (/\b(approve|approval|run|agent|iris|atlas|sentinel)\b/.test(lower)) {
    const planApproved = goal.approvals.plan ? 'yes' : 'no';
    return [
      `Current goal: goal-${goal.id}`,
      `Status: \`${goal.status}\``,
      `Plan approved: ${planApproved}`,
      '',
      goal.approvals.plan
        ? 'Use the buttons in this thread to run Iris, Atlas, or Sentinel. If the goal is `execute-after-approval`, approval starts the recommended flow.'
        : 'Click **Approve + Run** to approve the plan and let Orion start the recommended flow, or **Plan Only** to approve without running agents.',
    ].join('\n');
  }

  return [
    `I'm tracking goal-${goal.id}: ${goal.description}`,
    `Status: \`${goal.status}\``,
    `Next: ${goal.nextAction || defaultNextAction(goal)}`,
    '',
    'Ask a direct question, or tell Orion what to change in the plan.',
  ].join('\n');
}

function approvalIntentReply(goal: GoalState): string {
  return [
    `I read that as approval intent for goal-${goal.id}.`,
    '',
    'Use **Approve + Run** to let Orion start the recommended agents, or **Plan Only** if you only want to accept the plan without running agents.',
  ].join('\n');
}

function greetingReply(goal: GoalState, content = ''): string {
  const normalized = content.trim().toLowerCase();
  const opener = /\b(idiot|stupid|dumb)\b/.test(normalized)
    ? "I hear the frustration. I'm still here and tracking the goal."
    : /^(thanks|thank you|ok|okay|cool|nice|lol|lmao|got it|sounds good)[.!? ]*$/i.test(normalized)
      ? 'Got it.'
      : `Hey, I'm here on goal-${goal.id}.`;

  return [
    opener,
    `Status: \`${goal.status}\``,
    `Next: ${goal.nextAction || defaultNextAction(goal)}`,
    '',
    'Ask me a question, tell me what to change, or use the buttons below.',
  ].join('\n');
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

async function buildOrionPrompt(
  goal: GoalState,
  existingPlan?: string,
  options: { style?: 'structured' | 'conversational'; feedback?: string; target?: string; source?: string } = {}
): Promise<string> {
  const phase7Context = await readPhase7ContextForGoal(`${goal.description}\n${existingPlan || ''}`);
  const conversational = options.style === 'conversational';

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
${options.feedback ? `\nHuman feedback${options.target ? ` (${options.target})` : ''}${options.source ? ` from ${options.source}` : ''}:\n${options.feedback}` : ''}
${phase7Context ? `\nImported Phase 7 context from ${relativeToCommandCenter(phase7ContextPath)}:\n${phase7Context}` : ''}

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

${conversational ? `
Respond like a concise planning partner in Discord. Start with the direct answer to the human, explain what changed or what you recommend, and keep the tone natural.
Do not repeat the full planning template unless the human specifically asks for the full plan.
If the saved plan still stands, say that plainly and list only the practical delta.
If this feedback changes what agents should do, include a compact "Execution Handoff" section with only changed scope, acceptance criteria, agent assignment, QA target, risks, and next action.
If the feedback is conversational rather than a real plan change, answer conversationally and avoid creating template clutter.
` : `
Return only the final Markdown plan. Do not include terminal logs, session metadata, web-search notes, token counts, preambles, or code fences.
Use clear headings and enough detail for Iris, Atlas, and Sentinel to execute after approval.
The outline below is preferred for new goals, but do not pad empty sections or force irrelevant work into the plan.
Keep each section concise: one short paragraph or 2-5 bullets is enough unless the goal genuinely needs more detail.
For command-center or Discord-only validation goals, do not invent SwiftPark app screens, mobile screenshots, desktop screenshots, visual baselines, or Iris frontend work unless the goal explicitly asks for UI changes.
Suggested Agent Assignment should be practical: use Sentinel for QA, Atlas only for command/backend reliability checks, Iris only for actual frontend/visual work, and Orion for planning/revision.

Preferred Markdown outline:
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
`}
`.trim();
}

async function buildOrionChatPrompt(
  goal: GoalState,
  message: string,
  existingPlan: string,
  threadHistory: GoalThreadHistoryEntry[] = []
): Promise<string> {
  const phase7Context = await readPhase7ContextForGoal(`${goal.description}\n${existingPlan}\n${message}`);

  return `
You are Orion, the SwiftPark Project Manager / Orchestrator powered by Codex. This is a conversational Discord thread reply, not a plan rewrite and not an implementation run.

Goal:
${goal.description}

Current state:
- Goal id: ${goal.id}
- Status: ${goal.status}
- Mode: ${goal.mode}
- Agent preference: ${goal.agents}
- Primary screen: ${goal.primaryScreen || '(none)'}
- Configured product repo: ${repoPath}
- Command center repo: ${commandCenterRoot}
- Goal worktree: ${goal.worktreePath}
- Goal branch: ${goal.branchName}

Saved Orion plan/handoff:
${existingPlan || '(no saved plan found)'}

Recent thread context:
${formatGoalThreadHistoryForPrompt(threadHistory)}

Human thread message:
${redactSensitive(message)}
${phase7Context ? `\nImported Phase 7 context from ${relativeToCommandCenter(phase7ContextPath)}:\n${phase7Context}` : ''}

Rules:
- Answer the human directly and naturally, like a planning partner inside Discord.
- Do not use the full planning template.
- Treat the goal thread as chat-first: normal messages should get normal replies.
- Do not rewrite, revise, approve, run agents, or change saved goal state from this chat call.
- Do not claim to have inspected files or run commands unless that context is already present here.
- Do not modify files, browse, push, merge, deploy, open PRs, send emails, touch YC, contact Jira, or expose secrets.
- If the human is brainstorming, brainstorm with them.
- If the human asks whether the plan should change, explain the recommended change in prose.
- If the human clearly asks to change the saved plan, talk through the change and mention they can use the Revise Plan button or /revise-goal to save it.
- Keep the answer Discord-friendly: concise, complete, and split-friendly.
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
  progress?: GoalProgressReporter,
  options: { style?: 'structured' | 'conversational'; feedback?: string; target?: string; source?: string } = {}
): Promise<OrionPlanningResult> {
  const prompt = await buildOrionPrompt(goal, existingPlan, options);
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
  const responsePath = orionResponsePath(goal, job.id);
  await fs.writeFile(responsePath, redactSensitive(planSource || result.output || '(no response)') + '\n');
  await fs.writeFile(
    job.outputPath,
    redactSensitive(
      [
        'Raw Orion/Codex output:',
        result.output || '(no stdout)',
        '',
        `Final Orion response: ${relativeToCommandCenter(responsePath)}`,
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
    current.lastOrionResponsePath = responsePath;
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
  await updateGoalState(goal.id, (current) => {
    current.lastOrionResponsePath = responsePath;
  }).catch(() => undefined);
  await progress?.(latest, usedFallback ? 'Fallback Orion plan generated' : 'Orion plan complete', 'Posting plan to #orion-planning.');
  return { plan, job, usedFallback, fallbackReason };
}

async function runOrionChat(
  goal: GoalState,
  message: string,
  channels: Record<string, TextChannel>,
  requestedBy: string,
  source = 'goal thread message'
): Promise<string> {
  const safeMessage = redactSensitive(message);
  const existingPlan = await readPlan(goal);
  const chatId = `orion-chat-${Date.now()}`;
  const promptPath = path.join(goal.runDir, `${chatId}-prompt.md`);
  const lastMessagePath = path.join(goal.runDir, `${chatId}-response.md`);
  const logPath = path.join(goal.runDir, `${chatId}.log`);
  const threadHistory = await readGoalThreadHistory(goal);
  const prompt = await buildOrionChatPrompt(goal, safeMessage, existingPlan, threadHistory);

  await fs.writeFile(promptPath, prompt + '\n');
  await appendGoalThreadHistory(goal, {
    role: 'human',
    author: requestedBy,
    source,
    content: safeMessage,
  });
  await setAgentRunning('orion', goal, `Replying in ${source}`);
  await postAgentStatusBoard(channels).catch(() => undefined);

  const result = await shell(
    'codex',
    ['exec', '--cd', repoPath, '--sandbox', 'read-only', '--color', 'never', '--output-last-message', lastMessagePath, prompt],
    repoPath,
    {
      timeoutMs: orionPlanningTimeoutMs,
      activeKey: chatId,
      goalId: goal.id,
      agent: 'orion',
    }
  );

  let response = result.output;
  try {
    const lastMessage = await fs.readFile(lastMessagePath, 'utf8');
    if (lastMessage.trim()) response = lastMessage;
  } catch {
    // Fall back to stdout capture.
  }

  if (!result.ok || !response.trim()) {
    response = [
      `I tried to answer through Orion/Codex, but the local chat call did not complete cleanly for goal-${goal.id}.`,
      result.timedOut ? `It timed out after ${hardTimeoutLabel(orionPlanningTimeoutMs)}.` : '',
      `Local log: \`${relativeToCommandCenter(logPath)}\``,
      '',
      'The saved plan was not changed. You can ask again, use the buttons, or use `/goal-status` in this thread.',
    ].filter(Boolean).join('\n');
  }

  const safeResponse = redactSensitive(response);
  await fs.writeFile(logPath, [
    `Requested by: ${requestedBy}`,
    `Source: ${source}`,
    `Prompt: ${relativeToCommandCenter(promptPath)}`,
    '',
    'Raw output:',
    result.output || '(no stdout)',
    '',
    'Final response:',
    safeResponse,
  ].join('\n') + '\n');
  await fs.writeFile(lastMessagePath, safeResponse + '\n');
  await appendGoalThreadHistory(goal, {
    role: 'orion',
    author: 'orion',
    source,
    content: safeResponse,
  });
  await setAgentFinished('orion', result.ok, safeResponse).catch(() => undefined);
  await postAgentStatusBoard(channels).catch(() => undefined);
  return safeResponse;
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
  await channel.send({
    content: [
      `**Orion Plan Ready: goal-${goal.id}**`,
      goal.issueUrl ? `GitHub issue: ${goal.issueUrl}` : 'GitHub issue: not available; local run record was created.',
      `Mode: \`${goal.mode}\``,
      `Agents: \`${goal.agents}\``,
      `Primary screen: ${goal.primaryScreen ? `\`${goal.primaryScreen}\`` : '(none)'}`,
      `Branch: \`${goal.branchName}\``,
      `Worktree: \`${goal.worktreePath}\``,
      `Approval: run \`/approve target:${goal.planApprovalToken}\``,
      `Saved plan: \`${relativeToCommandCenter(goal.paths.planMd)}\``,
    ].join('\n'),
  });

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

  await postGoalControls(channel, goal);
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
    await postGoalControls(thread, goal);
  } catch {
    // Thread posting is best-effort; slash commands remain authoritative.
  }
}

async function postOrionResponseToGoalThreadOrPlanning(
  channels: Record<string, TextChannel>,
  goal: GoalState,
  title: string,
  response: string
): Promise<void> {
  if (goal.threadId) {
    try {
      const thread = await client.channels.fetch(goal.threadId) as any;
      if (thread?.send) {
        await postOrionConversation(thread, goal, title, response);
        return;
      }
    } catch {
      // Fall through to the planning channel.
    }
  }

  await postOrionConversation(channels['pm-planning'], goal, title, response);
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
- Write your final response as a natural Discord-ready answer.
- Do not pad empty sections.
- Do not repeat the same finding under multiple headings.
- Include files changed, checks/tests, risks, and next action only when they add useful context.
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
- Write your final response as a natural Discord-ready answer.
- Do not pad empty sections.
- Do not repeat the same finding under multiple headings.
- Include files changed, checks/tests, risks, and next action only when they add useful context.
`.trim();
}

function defaultAgentTask(goal: GoalState, agent: RunnableAgentId): string {
  if (agent === 'orion') {
    return `Revise or expand the Orion plan for goal-${goal.id}.`;
  }

  if (agent === 'atlas') {
    return `Run Atlas backend/systems tasks from the Orion plan for goal-${goal.id}. Obey any read-only, audit-only, hold, or no-code constraints in the plan.`;
  }

  if (agent === 'iris') {
    return `Run Iris frontend/visual tasks from the Orion plan for goal-${goal.id}. Obey any read-only, audit-only, hold, or no-code constraints in the plan.`;
  }

  if (agent === 'sentinel') {
    return goal.primaryScreen
      ? `Run screen QA for ${goal.primaryScreen} and post mobile + desktop screenshots.`
      : 'Run smoke QA and post selected screenshots.';
  }

  return 'Scout is stubbed for now. Do not browse, scrape, or access external accounts.';
}

function planHoldsAgent(text: string, agent: ImplementationAgentId | 'sentinel'): boolean {
  const label = agent === 'iris' ? 'iris' : agent === 'atlas' ? 'atlas' : 'sentinel';
  const role = agent === 'iris' ? 'frontend|visual|ui' : agent === 'atlas' ? 'backend|systems|api' : 'qa|screenshots|playwright';
  return new RegExp(`\\b${label}\\b[^\\n.]{0,80}\\b(hold|stand by|not needed|not required|wait|skip|defer)\\b`, 'i').test(text)
    || new RegExp(`\\b(no|skip|defer|hold)\\b[^\\n.]{0,80}\\b(${label}|${role})\\b`, 'i').test(text)
    || new RegExp(`\\b(${label}|${role})\\b[^\\n.]{0,80}\\b(only after|after .*confirmed|after .*identified)\\b`, 'i').test(text);
}

function resolveExecutionDecision(goal: GoalState, plan: string): ExecutionDecision {
  const text = `${goal.description}\n${plan}`.toLowerCase();
  const agents = new Set<ImplementationAgentId>();
  const reasons: string[] = [];
  const skipped: string[] = [];
  const wantsBackend = /\b(api|backend|server|database|schema|endpoint|supabase|auth|migration|yolo|occupancy|cv|detection|camera|websocket|ws)\b/.test(text);
  const wantsFrontend = /\b(frontend|ui|screen|route|page|component|layout|mobile|desktop|visual|button|card|map|bottom sheet|selected spot)\b/.test(text) || Boolean(goal.primaryScreen);
  const readOnlyAudit = /\b(read-only|read only|audit only|planning\/audit|planning and audit|inspect|review|summarize|no code|do not implement|no implementation)\b/.test(text);
  const implementationRequested = /\b(implement|build|fix|change|update|modify|polish|refactor|wire|add|remove)\b/.test(text) && !/\bdo not implement\b/.test(text);

  if (goal.agents === 'atlas' || goal.agents === 'both') agents.add('atlas');
  if (goal.agents === 'iris' || goal.agents === 'both') agents.add('iris');
  if (goal.agents !== 'auto') {
    reasons.push(`Goal agent preference is \`${goal.agents}\`.`);
  }

  if (goal.agents === 'auto') {
    if (wantsBackend) {
      agents.add('atlas');
      reasons.push(readOnlyAudit ? 'Atlas selected for backend/CV read-only audit language.' : 'Atlas selected from backend/systems language.');
    }
    if (wantsFrontend && (implementationRequested || !readOnlyAudit)) {
      agents.add('iris');
      reasons.push('Iris selected from frontend/visual language.');
    }
    if (agents.size === 0 && implementationRequested) {
      agents.add('atlas');
      agents.add('iris');
      reasons.push('Implementation was requested but ownership was ambiguous, so both implementation agents were selected.');
    }
  }

  for (const agent of ['atlas', 'iris'] as const) {
    if (agents.has(agent) && planHoldsAgent(text, agent)) {
      agents.delete(agent);
      skipped.push(`${agent} held by Orion plan language.`);
    }
  }

  if (readOnlyAudit && !implementationRequested && agents.has('iris') && !/\biris\b[^.\n]*(review|inspect|audit)\b/i.test(text)) {
    agents.delete('iris');
    skipped.push('Iris skipped because the current plan reads as read-only/audit work, not frontend implementation.');
  }

  const supportedScreenRequested = Boolean(qaScreenForText(text, goal.primaryScreen));
  const qaRequested = /\b(sentinel|qa|playwright|screenshot|screenshots|visual approval|visual check|test)\b/.test(text) || supportedScreenRequested;
  const unsupportedTarget = qaUnsupportedTargetForText(text);
  const sentinelHeld = planHoldsAgent(text, 'sentinel');
  let runSentinel = false;
  let sentinelReason = 'Sentinel not selected.';

  if (sentinelHeld) {
    skipped.push('Sentinel held by Orion plan language.');
    sentinelReason = 'Orion plan says Sentinel should wait.';
  } else if (unsupportedTarget && !supportedScreenRequested) {
    skipped.push(`Sentinel skipped: ${unsupportedTarget.reason}`);
    sentinelReason = unsupportedTarget.nextAction;
  } else if (qaRequested && supportedScreenRequested) {
    runSentinel = true;
    sentinelReason = 'Supported QA screen requested.';
  } else if (agents.size > 0 && !readOnlyAudit) {
    runSentinel = true;
    sentinelReason = 'Implementation agents are running, so Sentinel smoke QA follows.';
  } else {
    sentinelReason = readOnlyAudit
      ? 'Read-only/audit plan: Sentinel waits until a concrete supported QA target exists.'
      : 'No concrete supported QA target found.';
  }

  return {
    agents: [...agents],
    runSentinel,
    sentinelTask: runSentinel ? defaultAgentTask(goal, 'sentinel') : 'Sentinel not selected for this approved flow.',
    sentinelReason,
    reasons,
    skipped,
  };
}

function resolveExecutionAgents(goal: GoalState, plan: string): RunnableAgentId[] {
  return resolveExecutionDecision(goal, plan).agents;
}

async function runImplementationAgent(goal: GoalState, agent: 'iris' | 'atlas', task: string, jobId?: string): Promise<ShellResult> {
  assertSeparateWorktree(goal);
  const plan = await readPlan(goal);
  const prompt = agent === 'iris' ? buildIrisPrompt(goal, task, plan) : buildAtlasPrompt(goal, task, plan);

  if (agent === 'atlas') {
    const finalOutputPath = path.join(goal.runDir, `${jobId || `atlas-${Date.now()}`}-final.md`);
    const result = await shell(
      'codex',
      [
        'exec',
        '--cd',
        goal.worktreePath,
        '--sandbox',
        'workspace-write',
        '--color',
        'never',
        '--output-last-message',
        finalOutputPath,
        prompt,
      ],
      goal.worktreePath,
      {
        timeoutMs: timeoutForAgent(agent),
        activeKey: jobId,
        goalId: goal.id,
        agent,
      }
    );

    let finalOutput = '';
    let finalMessageCaptured = false;
    try {
      finalOutput = await fs.readFile(finalOutputPath, 'utf8');
      finalMessageCaptured = true;
    } catch {
      finalOutput = '';
    }

    return {
      ...result,
      finalOutput: cleanAgentFinalOutput(finalOutput || (result.ok ? result.output : '')),
      finalOutputPath: finalMessageCaptured ? finalOutputPath : undefined,
    };
  }

  const result = await shell(
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

  return {
    ...result,
    finalOutput: cleanAgentFinalOutput(result.output),
  };
}

async function cleanQaArtifacts(root: string) {
  await fs.rm(path.join(root, 'test-results'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'playwright-report'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'playwright-report-dashboard'), { recursive: true, force: true });
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
      'playwright-report-dashboard/**/*.md',
      'playwright-report-dashboard/**/*.{webm,zip}',
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

async function postLongAgentText(
  channel: TextChannel,
  title: string,
  content: string,
  options: { maxInlineChunks?: number; filePath?: string } = {}
): Promise<void> {
  const safeContent = redactSensitive(content || '(no output)').trim() || '(no output)';
  const chunks = chunkMarkdownForDiscord(safeContent, 1750);
  const maxInlineChunks = options.maxInlineChunks ?? 6;

  if (chunks.length <= maxInlineChunks) {
    for (const [index, chunk] of chunks.entries()) {
      const suffix = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
      await channel.send([`**${title}${suffix}**`, chunk].join('\n')).catch(() => undefined);
    }
    return;
  }

  if (options.filePath) {
    await channel.send({
      content: [
        `**${title}** is long, so the complete redacted output is attached and saved locally.`,
        `Local path: \`${relativeToCommandCenter(options.filePath)}\``,
        `Inline preview: ${Math.min(2, chunks.length)} of ${chunks.length} chunks.`,
      ].join('\n'),
      files: [options.filePath],
    }).catch(async () => {
      await channel.send(
        [
          `**${title}** is long. Discord attachment upload failed, but the full output is saved locally:`,
          `\`${relativeToCommandCenter(options.filePath!)}\``,
        ].join('\n')
      ).catch(() => undefined);
    });
  } else {
    await channel.send(`**${title}** is long. Posting inline preview only because no local file path was provided.`).catch(() => undefined);
  }

  for (const [index, chunk] of chunks.slice(0, 2).entries()) {
    await channel.send([`**${title} preview (${index + 1}/2)**`, chunk].join('\n')).catch(() => undefined);
  }
}

async function runQaFlow(
  root: string,
  channel: TextChannel,
  label: string,
  selection: ReturnType<typeof getQaSelection>,
  options: ShellOptions = {}
): Promise<ShellResult & { uploadSummary: string; qa: QaRunSummary }> {
  const script = buildQaScript(selection);
  const qaRoot = await resolveQaRoot(root, script);
  const displayQaRoot = qaRoot.ok ? qaRoot.root : root;
  const candidateLines = qaRoot.candidates.length
    ? qaRoot.candidates.slice(0, 8).map((candidate) => `- \`${candidate}\``)
    : ['- none'];

  if (!qaRoot.ok) {
    const warning = qaRoot.reason || `Could not resolve a QA root for \`${qaCommand}\`.`;
    const output = [
      'Status: SKIPPED (Sentinel)',
      `Label: ${label}`,
      `Mode: ${selection.mode}`,
      `Screen(s): ${selection.screens.join(', ') || '(none)'}`,
      `Requested root: \`${root}\``,
      `Required script: ${qaRoot.requiredScript ? `\`${qaRoot.requiredScript}\`` : '(not inferred)'}`,
      `Reason: ${warning}`,
      'Package candidates checked:',
      ...candidateLines,
      'Next action: set `QA_ROOT`/`QA_WORKDIR` to the package that owns visual QA, or add the required QA script before rerunning Sentinel.',
    ].join('\n');

    await channel.send([
      '# QA Result: SKIPPED',
      `Label: **${label}**`,
      `Mode: \`${selection.mode}\``,
      `Screens selected: ${selection.screens.join(', ') || '(none)'}`,
      `Requested root: \`${root}\``,
      `Reason: ${warning}`,
      `Candidates checked: ${qaRoot.candidates.length}`,
    ].join('\n')).catch(() => {});

    if (qaRoot.candidates.length > 0) {
      await postArtifactPaths(channel, 'QA package candidates checked', qaRoot.candidates, root).catch(() => undefined);
    }

    return {
      ok: true,
      skipped: true,
      output,
      uploadSummary: 'Screenshots uploaded: 0/0',
      qa: {
        status: 'SKIPPED',
        label,
        mode: selection.mode,
        screens: selection.screens,
        qaRoot: displayQaRoot,
        uploaded: 0,
        selected: 0,
        available: 0,
        skipped: 0,
        warnings: [warning],
        localScreenshots: '(not run)',
        localReport: '(not run)',
        playwrightSummary: 'Sentinel did not run Playwright because no safe QA package root was found.',
      },
    };
  }

  await cleanQaArtifacts(qaRoot.root);
  const result = await shellScript(script, qaRoot.root, {
    timeoutMs: options.timeoutMs ?? sentinelMaxRuntimeMs,
    activeKey: options.activeKey,
    goalId: options.goalId,
    agent: options.agent,
  });
  const uploadResult = await postQaScreenshots(channel, label, selection, qaRoot.root);
  const status = result.ok ? 'PASS' : 'FAIL';

  await channel.send(
    [
      `# QA Result: ${status}`,
      `Label: **${label}**`,
      `Mode: \`${selection.mode}\``,
      `Screens selected: ${selection.screens.join(', ') || '(none)'}`,
      `QA root: \`${path.relative(root, qaRoot.root) || '.'}\``,
      `Playwright: ${summarizeQaOutput(result.output)}`,
      `Screenshots uploaded: ${uploadResult.uploaded}/${uploadResult.selected}`,
      `Local screenshots: \`${path.relative(root, path.join(qaRoot.root, 'test-results/manual-screenshots'))}\``,
      `Local report: \`${localQaReportLabel(qaRoot.root, selection)}\``,
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

    const diagnostics = await findQaDiagnostics(qaRoot.root).catch(() => []);
    if (diagnostics.length > 0) {
      await postArtifactPaths(channel, 'QA video/error paths', diagnostics, qaRoot.root).catch(() => {});
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
      qaRoot: qaRoot.root,
      uploaded: uploadResult.uploaded,
      selected: uploadResult.selected,
      available: uploadResult.available,
      skipped: uploadResult.skipped,
      warnings: uploadResult.warnings,
      localScreenshots: path.relative(root, path.join(qaRoot.root, 'test-results/manual-screenshots')),
      localReport: localQaReportLabel(qaRoot.root, selection),
      playwrightSummary: summarizeQaOutput(result.output),
    },
  };
}

function formatSentinelSummary(goal: GoalState, qa: QaRunSummary): string {
  const approval = qa.status === 'PASS'
    ? `Approve QA with \`/approve target:${goal.qaApprovalToken}\` after reviewing screenshots.`
    : qa.status === 'SKIPPED'
      ? 'Review the skip reason and add/register the requested QA target before rerunning Sentinel.'
      : retryGuidance('sentinel', goal);

  return [
    `Status: ${qa.status} (Sentinel)`,
    `Goal: goal-${goal.id}`,
    `Mode: ${qa.mode}`,
    `Screen(s): ${qa.screens.join(', ') || '(none)'}`,
    `QA root: \`${qa.qaRoot}\``,
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

function formatSentinelSkippedSummary(goal: GoalState, task: string, target: QaUnsupportedTarget): string {
  return [
    'Status: SKIPPED (Sentinel)',
    `Goal: goal-${goal.id}`,
    'Mode: screen/smoke not run',
    `Requested target: ${target.id}`,
    `Reason: ${target.reason}`,
    `Task: ${redactSensitive(task)}`,
    'Screenshots posted: 0/0',
    `Supported screens:\n${validScreenList()}`,
    `Next action: ${target.nextAction}`,
  ].join('\n');
}

async function runSentinelAgent(
  goal: GoalState,
  task: string,
  channels: Record<string, TextChannel>,
  jobId?: string
): Promise<ShellResult> {
  const parsed = parseQaTask(task, goal.primaryScreen);
  if (parsed.unsupportedTarget && !parsed.screen && parsed.mode !== 'full') {
    const output = formatSentinelSkippedSummary(goal, task, parsed.unsupportedTarget);
    await channels['qa-visual'].send([
      '# Sentinel QA Skipped',
      output,
    ].join('\n')).catch(() => undefined);
    return {
      ok: true,
      skipped: true,
      output,
    };
  }

  const selection = getQaSelection(parsed.mode, parsed.screen);
  const label = `goal-${goal.id} ${selection.mode}${parsed.screen ? ` ${parsed.screen}` : ''}`;
  let qaExecutionRoot = goal.worktreePath;

  if (selectionIncludesDashboard(selection)) {
    const script = buildQaScript(selection);
    const worktreeQa = await resolveQaRoot(goal.worktreePath, script).catch(() => undefined);
    if (!worktreeQa?.ok) {
      const repoQa = await resolveQaRoot(repoPath, script).catch(() => undefined);
      if (repoQa?.ok) {
        qaExecutionRoot = repoPath;
        await channels['qa-visual'].send(
          [
            'Dashboard QA fallback:',
            `Goal worktree does not have the dashboard QA script yet: \`${goal.worktreePath}\``,
            `Running dashboard screenshots against configured product repo: \`${repoPath}\``,
            'Use a refreshed worktree after the dashboard QA harness is merged if you need screenshots of unmerged goal-specific dashboard changes.',
          ].join('\n')
        ).catch(() => undefined);
      }
    }
  }

  const result = await runQaFlow(qaExecutionRoot, channels['qa-visual'], label, selection, {
    timeoutMs: sentinelMaxRuntimeMs,
    activeKey: jobId,
    goalId: goal.id,
    agent: 'sentinel',
  });
  return {
    ok: result.ok,
    skipped: result.skipped,
    output: formatSentinelSummary(goal, result.qa),
  };
}

async function runOrionRevision(
  goal: GoalState,
  task: string,
  channels: Record<string, TextChannel>
): Promise<ShellResult> {
  const revised = await reviseGoalPlan(goal, task, 'orion', channels, 'run-agent', '/run-agent agent:orion');
  return { ok: true, output: revised.response };
}

async function reviseGoalPlan(
  goal: GoalState,
  feedback: string,
  target: string,
  channels: Record<string, TextChannel>,
  requestedBy: string,
  source = '/revise-goal'
): Promise<{ goal: GoalState; response: string }> {
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
    existingPlan,
    undefined,
    {
      style: 'conversational',
      feedback: safeFeedback,
      target,
      source,
    }
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

  await channels['pm-planning'].send(
    [
      `Orion revised goal-${latest.id}.`,
      latest.threadName ? `Thread: \`${latest.threadName}\`` : '',
      `Saved response: \`${latest.lastOrionResponsePath ? relativeToCommandCenter(latest.lastOrionResponsePath) : relativeToCommandCenter(latest.paths.planMd)}\``,
      `Approve with \`/approve target:${latest.planApprovalToken}\`.`,
    ].filter(Boolean).join('\n')
  ).catch(() => undefined);
  await postOrionResponseToGoalThreadOrPlanning(channels, latest, 'Orion Reply', revised.plan);
  return { goal: latest, response: revised.plan };
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
        `${agent} could not start for goal-${goal.id}: worktree unavailable. Check #echo-logs.`
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
  let implementationFinalOutput = '';
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

    job.status = result.skipped ? 'skipped' : result.timedOut ? 'timed-out' : result.ok ? 'succeeded' : 'failed';
    job.endedAt = new Date().toISOString();
    if (agent === 'iris' || agent === 'atlas') {
      changedFiles = await changedFilesForWorktree(goal.worktreePath).catch(() => []);
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
    } else {
      job.summary = formatGenericAgentSummary(agent, goal, job, result.output);
    }
  } finally {
    clearInterval(heartbeat);
    job.endedAt ||= new Date().toISOString();
    job.outputPath = path.join(goal.runDir, `${job.id}.log`);
    await fs.writeFile(job.outputPath, redactSensitive(result.output || '(no output)') + '\n');

    if (agent === 'iris' || agent === 'atlas') {
      implementationFinalOutput = cleanAgentFinalOutput(
        result.finalOutput || (job.status === 'succeeded' ? result.output : '')
      );
      if (implementationFinalOutput !== '(no final response captured)') {
        const finalPath = result.finalOutputPath || path.join(goal.runDir, `${job.id}-final.md`);
        await fs.writeFile(finalPath, implementationFinalOutput + '\n').catch(() => undefined);
        job.finalOutputPath = finalPath;
      }
      job.summary = formatImplementationAgentSummary(agent, goal, job, changedFiles);
    } else if (!job.summary) {
      job.summary = agent === 'sentinel'
        ? result.output
        : formatGenericAgentSummary(agent, goal, job, result.output);
    }

    activeJobs.delete(job.id);

    await updateGoalState(goal.id, (current) => {
      const succeeded = job.status === 'succeeded';
      const skipped = job.status === 'skipped';
      current.status = succeeded && agent === 'sentinel'
        ? 'ready-for-qa-approval'
        : succeeded || skipped
          ? 'plan-approved'
          : job.status === 'timed-out'
            ? 'timed-out'
            : 'blocked';
      current.currentStep = succeeded ? `${agent} complete` : skipped ? `${agent} skipped` : `${agent} failed`;
      current.currentAgent = agent;
      current.lastError = succeeded || skipped ? undefined : result.output;
      current.nextAction = succeeded
        ? agent === 'sentinel'
          ? defaultNextAction(current)
          : `Review ${agent} output, then approve with /approve target:${current.agentApprovalToken} or use the Sentinel button.`
        : skipped
          ? `Review ${agent} skip reason in ${relativeToCommandCenter(job.outputPath || goal.runDir)}, then revise or rerun only when ready.`
        : `Review ${agent} output in ${relativeToCommandCenter(job.outputPath || goal.runDir)}; revise or rerun after fixing the blocker.`;
      upsertJob(current, job);
    });

    await setAgentFinished(agent, job.status === 'succeeded' || job.status === 'skipped', job.summary || result.output);
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

  const completionLabel = job.status === 'succeeded'
    ? 'Complete'
    : job.status === 'skipped'
      ? 'Skipped'
      : job.status === 'timed-out'
        ? 'Timed Out'
        : 'Failed';
  const summaryPath = path.join(goal.runDir, `${job.id}-summary.md`);
  await fs.writeFile(summaryPath, redactSensitive(job.summary || '(no summary)') + '\n').catch(() => undefined);

  const completionHeader = [
    `# ${agent} ${completionLabel}`,
    `Goal: \`goal-${goal.id}\``,
    `Branch: \`${goal.branchName}\``,
    `Worktree: \`${goal.worktreePath}\``,
    `Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}`,
    agent === 'iris' || agent === 'atlas'
      ? `Final answer: ${job.finalOutputPath ? `\`${relativeToCommandCenter(job.finalOutputPath)}\`` : '(not captured)'}`
      : `Summary: \`${relativeToCommandCenter(summaryPath)}\``,
    `Raw log: \`${relativeToCommandCenter(job.outputPath)}\``,
  ].join('\n');

  await targetChannel.send({
    content: completionHeader,
    components: goalActionRows(goal),
  }).catch(() => {});

  if (agent === 'iris' || agent === 'atlas') {
    await postLongAgentText(
      targetChannel,
      `${agent} final answer`,
      implementationFinalOutput || '(no final response captured)',
      {
        maxInlineChunks: 8,
        filePath: job.finalOutputPath,
      }
    ).catch(() => undefined);
  } else {
    await postLongAgentText(
      targetChannel,
      `${agent} summary`,
      job.summary || '(no summary)',
      {
        maxInlineChunks: 4,
        filePath: summaryPath,
      }
    ).catch(() => undefined);
  }

  if (agent !== 'sentinel' && maxAgentLogChunks > 0 && !result.ok) {
    await postTerminalOutput(targetChannel, 'Captured output', result.output, maxAgentLogChunks).catch(() => {});
  }

  await channels['agent-status'].send(
    `${agent} for goal-${goal.id} ${job.status}. Elapsed: ${formatElapsed(job.startedAt, job.endedAt)}.`
  ).catch(() => {});

  if (job.status !== 'succeeded' && job.status !== 'skipped') {
    await postCommandCenterError(
      channels,
      `${agent} failed for goal-${goal.id}`,
      result.output || job.error || 'Agent failed without captured output.',
      goal.id
    ).catch(() => undefined);
  } else {
    await channels['build-feed']?.send(
      `${agent} ${job.status === 'skipped' ? 'skipped' : 'finished'} for goal-${goal.id}. Next: ${(await readGoalState(goal.id))?.nextAction || defaultNextAction(goal)}`
    ).catch(() => undefined);
  }

  await notifySubscribers(
    channels,
    job.status === 'succeeded'
      ? `${agent} finished for goal-${goal.id}. Summary: ${truncate(job.summary || '(no summary)', 700)}`
      : job.status === 'skipped'
        ? `${agent} skipped for goal-${goal.id}. Check the agent output channel for the prerequisite.`
      : `${agent} failed for goal-${goal.id}. Check #echo-status and the agent output channel.`
  ).catch(() => undefined);

  return job.status === 'succeeded' || job.status === 'skipped';
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
  const decision = resolveExecutionDecision(goal, plan);
  const agents = decision.agents;

  await channels['agent-status'].send(
    [
      `# Execution Started: goal-${goal.id}`,
      `Approved by: <@${approvedBy}>`,
      `Agents: ${agents.map((agent) => `\`${agent}\``).join(', ') || '(none)'}`,
      `Sentinel QA: ${decision.runSentinel ? `\`${goal.primaryScreen ? `screen ${goal.primaryScreen}` : 'smoke'}\`` : 'not selected'}`,
      decision.reasons.length ? `Why: ${decision.reasons.join(' ')}` : '',
      decision.skipped.length ? `Skipped: ${decision.skipped.join(' ')}` : '',
      `Sentinel reason: ${decision.sentinelReason}`,
    ].filter(Boolean).join('\n')
  );

  if (agents.length === 0 && !decision.runSentinel) {
    await updateGoalState(goal.id, (current) => {
      current.status = 'plan-approved';
      current.currentStep = 'Plan approved; no automatic agents selected';
      current.currentAgent = undefined;
      current.lastError = undefined;
      current.nextAction = `${decision.sentinelReason} Use the thread buttons or /run-agent when a concrete task is ready.`;
    });
    await channels['agent-status'].send(
      `goal-${goal.id} approved, but Orion did not select any automatic agent run. ${decision.sentinelReason}`
    ).catch(() => undefined);
    await postToGoalThread(
      goal,
      `Plan approved, but Orion did not select any automatic agent run. ${decision.sentinelReason}`
    ).catch(() => undefined);
    return;
  }

  for (const agent of agents) {
    const ok = await runAgentJob(goal.id, agent, defaultAgentTask(goal, agent), channels, approvedBy);
    if (!ok) {
      await channels['agent-status'].send(`Execution blocked for goal-${goal.id}; ${agent} did not complete successfully.`);
      return;
    }
  }

  if (!decision.runSentinel) {
    await updateGoalState(goal.id, (current) => {
      current.status = 'plan-approved';
      current.currentStep = agents.length > 0 ? 'Recommended agents complete' : 'Plan approved';
      current.currentAgent = undefined;
      current.lastError = undefined;
      current.nextAction = `${decision.sentinelReason} Use Run Sentinel only after a supported QA target is ready.`;
    });
    await channels['agent-status'].send(
      `goal-${goal.id} recommended agent flow finished without Sentinel. ${decision.sentinelReason}`
    ).catch(() => undefined);
    await notifySubscribers(
      channels,
      `Recommended agents finished for goal-${goal.id}. Sentinel was not run: ${decision.sentinelReason}`
    ).catch(() => undefined);
    return;
  }

  const qaOk = await runAgentJob(goal.id, 'sentinel', decision.sentinelTask, channels, approvedBy);
  const afterQa = await readGoalState(goal.id);
  const latestSentinelJob = afterQa?.jobs
    .filter((job) => job.agent === 'sentinel')
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  const qaSkipped = latestSentinelJob?.status === 'skipped';
  await updateGoalState(goal.id, (current) => {
    current.status = qaOk && !qaSkipped ? 'ready-for-qa-approval' : qaSkipped ? 'plan-approved' : 'blocked';
    current.currentStep = qaOk && !qaSkipped ? 'Sentinel QA complete' : qaSkipped ? 'Sentinel QA skipped' : 'Sentinel QA failed';
    current.currentAgent = 'sentinel';
    current.nextAction = qaOk && !qaSkipped
      ? `Review screenshots, then approve QA with /approve target:${current.qaApprovalToken}.`
      : qaSkipped
        ? 'Review #sentinel-qa and add/register the requested QA target before rerunning Sentinel.'
      : 'Review #sentinel-qa and rerun Sentinel after fixing the blocker.';
  });

  await channels['agent-status'].send(
    qaOk && !qaSkipped
      ? `goal-${goal.id} is waiting for QA approval. Run \`/approve target:${goal.qaApprovalToken}\` after reviewing screenshots.`
      : qaSkipped
        ? `goal-${goal.id} Sentinel QA was skipped with guidance. Merge and deploy remain blocked.`
      : `goal-${goal.id} is blocked after Sentinel QA. Merge and deploy remain blocked.`
  );
  await notifySubscribers(
    channels,
    qaOk && !qaSkipped
      ? `Sentinel QA finished for goal-${goal.id}. Approval needed: /approve target:${goal.qaApprovalToken}`
      : qaSkipped
        ? `Sentinel QA skipped for goal-${goal.id}. Check #sentinel-qa for the prerequisite.`
      : `Sentinel QA failed for goal-${goal.id}. Check #sentinel-qa.`
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
  const agentApprovalWithoutWork = goal.status === 'agent-approved' && !hasSuccessfulImplementationJob(goal);
  const sentinelBlocked = goal.status === 'blocked' && (goal.currentAgent === 'sentinel' || /\bSentinel\b/i.test(goal.currentStep || goal.lastError || ''));

  return [
    `## Goal Status: goal-${goal.id}`,
    `Status: ${goal.status}${stale ? ' (stale; needs attention)' : ''}${agentApprovalWithoutWork ? ' (agent approval recorded before Iris/Atlas work)' : ''}`,
    `Current step: ${goal.currentStep || '(unknown)'}`,
    `Agent: ${goal.currentAgent || runningJob?.agent || 'none'}`,
    `Elapsed: ${elapsed}`,
    `Worktree: \`${goal.worktreePath}\``,
    `Plan file exists: ${planExists ? 'yes' : 'no'}`,
    `Last error: ${goal.lastError ? truncate(goal.lastError, 700) : 'none'}`,
    sentinelBlocked ? 'Blocker note: this is a Sentinel/QA blocker, not an Orion planning failure.' : '',
    `Next action: ${agentApprovalWithoutWork ? 'Use Approve + Run, Run Iris/Atlas, or revise the plan before QA.' : sentinelBlocked ? `Fix/rerun Sentinel, cancel the old goal, or clear the stale blocker with /clear-blocker goal_id:${goal.id}.` : goal.nextAction || defaultNextAction(goal)}`,
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

function inspectSourceChannelId(source: InspectDiscordSource): ChannelId | undefined {
  const map: Partial<Record<InspectDiscordSource, ChannelId>> = {
    'orion-planning': 'pm-planning',
    'iris-frontend': 'frontend',
    'atlas-backend': 'backend',
    'sentinel-qa': 'qa-visual',
    'echo-status': 'agent-status',
    'echo-logs': 'logs',
    'build-feed': 'build-feed',
  };
  return map[source];
}

async function resolveInspectDiscordChannel(
  interaction: any,
  channels: Record<string, TextChannel>,
  source: InspectDiscordSource,
  goalId?: string
): Promise<{ channel?: any; label: string; error?: string }> {
  if (source !== 'current-thread') {
    const channelId = inspectSourceChannelId(source);
    const channel = channelId ? channels[channelId] : undefined;
    return channel
      ? { channel, label: `#${channel.name}` }
      : { label: source, error: `Could not find configured channel for ${source}. Run /setup, then retry.` };
  }

  const threadGoal = await goalForThreadId(interaction.channelId);
  const requestedGoal = goalId ? await readGoalState(goalId) : undefined;
  const goal = requestedGoal || threadGoal;
  if (goal?.threadId) {
    const channel = await client.channels.fetch(goal.threadId).catch(() => undefined);
    if (channel) return { channel, label: goal.threadName ? `thread ${goal.threadName}` : `goal-${goal.id} thread` };
  }

  if (interaction.channel?.isThread?.()) {
    return { channel: interaction.channel, label: `thread ${interaction.channel.name || interaction.channelId}` };
  }

  return {
    label: 'current-thread',
    error: 'Use `source:current-thread` inside a goal thread, or provide a goal_id whose thread exists.',
  };
}

async function inspectDiscordMessages(
  interaction: any,
  channels: Record<string, TextChannel>,
  source: InspectDiscordSource,
  limit: number,
  goalId?: string
): Promise<string> {
  const resolved = await resolveInspectDiscordChannel(interaction, channels, source, goalId);
  if (resolved.error || !resolved.channel?.messages?.fetch) {
    return resolved.error || `Could not fetch messages for ${resolved.label}.`;
  }

  const fetched = await resolved.channel.messages.fetch({ limit });
  const messages = [...fetched.values()].sort((a: any, b: any) => a.createdTimestamp - b.createdTimestamp);
  const reportDir = path.join(runsDir, 'discord-inspections');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportDir, `${timestamp}-${source}.md`);
  const lines = [
    `# Discord Inspection: ${source}`,
    '',
    `Created: ${new Date().toISOString()}`,
    `Mode: read-only bot-token Discord API inspection; no user token or self-bot access.`,
    `Source: ${resolved.label}`,
    `Messages fetched: ${messages.length}`,
    goalId ? `Goal filter/request: goal-${normalizeGoalId(goalId)}` : '',
    '',
  ].filter(Boolean);

  for (const message of messages) {
    const author = message.author?.tag || message.author?.username || message.author?.id || 'unknown';
    const created = message.createdAt?.toISOString?.() || new Date(message.createdTimestamp || Date.now()).toISOString();
    const content = redactSensitive(String(message.content || '').trim() || '(no visible message content)');
    const attachments = message.attachments?.size
      ? [...message.attachments.values()].map((attachment: any) => {
          const name = attachment.name || 'attachment';
          const type = attachment.contentType || 'unknown';
          const size = typeof attachment.size === 'number' ? `${attachment.size} bytes` : 'unknown size';
          return `${name} (${type}, ${size})`;
        })
      : [];

    lines.push(
      `## ${created} - ${author}`,
      '',
      content,
      attachments.length ? `Attachments: ${attachments.join(', ')}` : '',
      '',
    );
  }

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, lines.filter((line) => line !== undefined).join('\n').trim() + '\n');

  return [
    `Discord inspection complete for ${resolved.label}.`,
    `Messages fetched: ${messages.length}`,
    `Local report: \`${relativeToCommandCenter(reportPath)}\``,
    'Safety: read-only bot API inspection; no user token, self-bot, external posting, or secret printing.',
  ].join('\n');
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

  await channels['build-feed']?.send(`${prefix}${title}. See #echo-logs for details.`).catch(() => undefined);
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

async function approvePlanGoal(
  goal: GoalState,
  channels: Record<string, TextChannel>,
  approvedBy: string,
  options: { runRecommended?: boolean; forceMode?: GoalMode } = {}
): Promise<{ updated: GoalState; started: boolean; alreadyApproved: boolean; blockedReason?: string }> {
  const alreadyApproved = Boolean(goal.approvals.plan);
  const runRecommended = options.runRecommended ?? goal.mode === 'execute-after-approval';
  const updated = await updateGoalState(goal.id, (current) => {
    if (options.forceMode) current.mode = options.forceMode;
    if (runRecommended) current.mode = 'execute-after-approval';
    current.status = 'plan-approved';
    current.currentStep = 'Plan approved';
    current.currentAgent = undefined;
    current.lastError = undefined;
    current.nextAction = runRecommended
      ? 'Starting Orion-recommended agent flow.'
      : 'Plan-only mode: use the action buttons or /run-agent when ready.';
    current.approvals.plan ||= {
      approvedAt: new Date().toISOString(),
      approvedBy,
    };
  });

  await setAgentFinished('orion', true, `Plan approved for goal-${updated.id}.`).catch(() => undefined);
  await channels['approvals'].send(
    `Approved Orion plan **${updated.planApprovalToken}** for goal-${updated.id} by <@${approvedBy}>. ${runRecommended ? 'Recommended execution is starting.' : 'Plan-only approval recorded.'}`
  ).catch(() => undefined);
  await channels['pm-planning'].send(
    `Plan approved for goal-${updated.id}. ${runRecommended ? 'Starting Orion-recommended agent flow.' : 'Plan-only mode: waiting for an explicit agent run.'}`
  ).catch(() => undefined);
  await postToGoalThread(
    updated,
    `Plan approved by <@${approvedBy}>. ${runRecommended ? 'Starting recommended agent flow.' : 'Plan-only approval recorded.'}`
  );
  await postAgentStatusBoard(channels).catch(() => undefined);
  await notifySubscribers(
    channels,
    `Plan approved for goal-${updated.id}. ${runRecommended ? 'Execution is starting.' : 'Plan-only approval recorded.'}`
  ).catch(() => undefined);

  if (!runRecommended) {
    return { updated, started: false, alreadyApproved };
  }

  const runningJob = updated.jobs.find((job) => job.status === 'running');
  if (runningJob) {
    return {
      updated,
      started: false,
      alreadyApproved,
      blockedReason: `${runningJob.agent} is already running for this goal.`,
    };
  }

  void startApprovedExecution(updated.id, channels, approvedBy).catch(async (err: any) => {
    const errorOutput = err?.stack || err?.message || String(err);
    await postCommandCenterError(channels, `Execution crashed for goal-${updated.id}`, errorOutput, updated.id).catch(() => undefined);
    await channels['agent-status'].send(
      [`Execution crashed for goal-${updated.id}.`, '```text', truncate(errorOutput), '```'].join('\n')
    ).catch(() => {});
  });

  return { updated, started: true, alreadyApproved };
}

async function cancelGoalRun(
  goal: GoalState,
  reason: string,
  channels: Record<string, TextChannel>
): Promise<{ updated: GoalState; stopped: string[] }> {
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
  await channels['build-feed'].send(`goal-${updated.id} canceled. Tracked subprocesses stopped: ${stopped.length}.`).catch(() => undefined);
  await postAgentStatusBoard(channels).catch(() => undefined);

  return { updated, stopped };
}

async function clearGoalBlocker(
  goal: GoalState,
  reason: string,
  channels: Record<string, TextChannel>,
  userId: string
): Promise<{ updated?: GoalState; message: string }> {
  const runningJob = goal.jobs.find((job) => job.status === 'running');
  if (runningJob) {
    return {
      message: `Refusing to clear blocker for goal-${goal.id}: ${runningJob.agent} is still running.`,
    };
  }

  if (!goal.lastError && goal.status !== 'blocked' && goal.status !== 'timed-out') {
    return {
      message: `goal-${goal.id} does not have a blocker to clear. Current status: \`${goal.status}\`.`,
    };
  }

  const updated = await updateGoalState(goal.id, (current) => {
    current.status = current.approvals.plan ? 'plan-approved' : 'waiting-for-plan-approval';
    current.currentStep = 'Blocker cleared after human review';
    current.currentAgent = undefined;
    current.lastError = undefined;
    current.nextAction = current.approvals.plan
      ? 'Blocker cleared. Use the thread buttons or /run-agent when ready.'
      : `Blocker cleared. Approve the plan with /approve target:${current.planApprovalToken}.`;
  });

  await channels['logs'].send(
    [
      `Goal blocker cleared: \`goal-${updated.id}\``,
      `By: <@${userId}>`,
      `Reason: ${redactSensitive(reason)}`,
      `Status: \`${updated.status}\``,
      `Next: ${updated.nextAction}`,
    ].join('\n')
  ).catch(() => undefined);
  await channels['build-feed'].send(`goal-${updated.id} blocker cleared. Status: \`${updated.status}\`.`).catch(() => undefined);
  await postToGoalThread(updated, `Blocker cleared by <@${userId}>. ${updated.nextAction}`).catch(() => undefined);
  await postAgentStatusBoard(channels).catch(() => undefined);

  return {
    updated,
    message: [
      `Cleared blocker for goal-${updated.id}.`,
      `Status: \`${updated.status}\``,
      `Next: ${updated.nextAction}`,
    ].join('\n'),
  };
}

function formatSetupSummary(result: ChannelSetupResult): string {
  return [
    '## Echo finished command-center setup.',
    result.categoryCreated
      ? `Category created: \`${commandCenterCategoryName}\``
      : `Category already existed: \`${commandCenterCategoryName}\``,
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

const clientIntents = [GatewayIntentBits.Guilds];
if (orionThreadRepliesEnabled) {
  clientIntents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents: clientIntents,
});

process.once('SIGINT', () => {
  void shutdownBot('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdownBot('SIGTERM');
});

client.once('clientReady', async () => {
  await fs.mkdir(runsDir, { recursive: true });
  const recovered = await reconcileStartupState().catch((err) => {
    console.warn(`Startup reconciliation failed: ${err?.message || String(err)}`);
    return { goals: 0, agents: 0 };
  });
  await updateAgent('echo', {
    status: 'online',
    currentTask: 'Discord command center online',
    startedAt: new Date().toISOString(),
  }).catch(() => undefined);
  await refreshPulseAgentStatus().catch(() => undefined);
  await refreshStoredHelpGuide().catch((err) => {
    console.warn(`Help guide refresh failed: ${err?.message || String(err)}`);
  });
  await refreshStoredAgentStatusBoard().catch((err) => {
    console.warn(`Agent status board refresh failed: ${err?.message || String(err)}`);
  });
  startPulseScheduler();
  if (recovered.goals || recovered.agents) {
    console.warn(`Startup reconciliation recovered ${recovered.goals} goal(s) and ${recovered.agents} agent status record(s).`);
  }
  console.log(`SwiftPark Agent logged in as ${client.user?.tag}`);
});

async function handleInteractionError(interaction: any, err: any): Promise<void> {
  const errorOutput = err?.stack || err?.message || String(err);
  const friendly = 'Command failed safely. Check #echo-logs for details, then retry or adjust the command.';
  const interactionLabel = interaction.commandName ? `/${interaction.commandName}` : interaction.customId || 'interaction';

  if (isInteractionAckFailure(err)) {
    console.warn(
      `Ignored stale or duplicate ${interactionLabel} interaction without posting a failure: ${err?.message || String(err)}`
    );
    return;
  }

  try {
    if (interaction.guild) {
      const setup = await ensureChannels(interaction.guild);
      await postCommandCenterError(setup.channels, `${interactionLabel} failed`, errorOutput).catch(() => undefined);
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

async function handleAutocompleteInteraction(interaction: any): Promise<void> {
  if (!allowedUsers.has(interaction.user.id)) {
    await interaction.respond([]).catch(() => undefined);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const focusedValue = String(focused.value || '').toLowerCase();
  const goals = await listGoalStates();

  if (focused.name === 'goal_id') {
    const choices = goals
      .filter((goal) => {
        const haystack = `${goal.id} ${goal.description} ${goal.status}`.toLowerCase();
        return !focusedValue || haystack.includes(focusedValue.replace(/^goal-/, ''));
      })
      .slice(0, 25)
      .map((goal) => ({
        name: goalDisplayLabel(goal),
        value: goal.id,
      }));

    await interaction.respond(choices).catch(() => undefined);
    return;
  }

  if (focused.name === 'target') {
    const targets = goals.flatMap((goal) => [
      { name: `approve plan | ${goalDisplayLabel(goal)}`, value: goal.planApprovalToken },
      { name: `approve QA | ${goalDisplayLabel(goal)}`, value: goal.qaApprovalToken },
      { name: `approve agent | ${goalDisplayLabel(goal)}`, value: goal.agentApprovalToken },
    ]);
    const choices = targets
      .filter((choice) => {
        const haystack = `${choice.name} ${choice.value}`.toLowerCase();
        return !focusedValue || haystack.includes(focusedValue);
      })
      .slice(0, 25)
      .map((choice) => ({
        name: choice.name.length > 100 ? `${choice.name.slice(0, 97)}...` : choice.name,
        value: choice.value,
      }));

    await interaction.respond(choices).catch(() => undefined);
    return;
  }

  await interaction.respond([]).catch(() => undefined);
}

client.on('interactionCreate', async (interaction: any) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocompleteInteraction(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmitInteraction(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  } catch (err: any) {
    await handleInteractionError(interaction, err);
  }
});

client.on('messageCreate', async (message: any) => {
  if (!orionThreadRepliesEnabled) return;
  if (!message.guild || message.author?.bot) return;
  if (!allowedUsers.has(message.author.id)) return;

  const content = String(message.content || '').trim();
  if (!content || content.startsWith('/')) return;

  const goal = await goalForThreadId(message.channelId);
  if (!goal) return;

  const forbidden = isForbiddenTask(content);
  if (forbidden) {
    await message.reply(`Orion thread reply blocked: ${forbidden}.`).catch(() => undefined);
    return;
  }

  const intent = classifyGoalThreadMessage(content);
  if (intent === 'ignore') return;

  try {
    const setup = await ensureChannels(message.guild);
    if (intent === 'question') {
      if (hasLocalGoalThreadAnswer(content)) {
        await message.reply(await answerGoalThreadQuestion(goal, content)).catch(() => undefined);
        return;
      }
    }

    if (intent === 'approval-intent') {
      await message.reply({
        content: approvalIntentReply(goal),
        components: goalActionRows(goal),
      }).catch(() => undefined);
      return;
    }

    await message.channel?.sendTyping?.().catch(() => undefined);
    const response = await runOrionChat(
      goal,
      content,
      setup.channels,
      message.author.id,
      intent === 'revision' ? 'goal thread chat; revision not saved' : `goal thread ${intent}`
    );
    await replyToGoalThreadMessage(
      message,
      goal,
      intent === 'revision'
        ? [
          response,
          '',
          '_Saved plan unchanged. Use **Revise Plan** below or `/revise-goal` if you want Orion to save this as the new execution handoff._',
        ].join('\n')
        : response
    );
  } catch (err: any) {
    const errorOutput = err?.stack || err?.message || String(err);
    const setup = await ensureChannels(message.guild).catch(() => undefined);
    if (setup) {
      await postCommandCenterError(setup.channels, `Goal thread reply failed for goal-${goal.id}`, errorOutput, goal.id).catch(() => undefined);
    }
    await message.reply('Orion could not respond to that thread message. Check #echo-logs.').catch(() => undefined);
  }
});

async function handleButtonInteraction(interaction: any): Promise<void> {
  if (!allowedUsers.has(interaction.user.id)) {
    await safeInitialReply(interaction, {
      content: 'You are not authorized to use SwiftPark command-center buttons.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId?.startsWith('goal:')) {
    await handleGoalButtonInteraction(interaction);
    return;
  }

  if (!interaction.customId?.startsWith('pulse:gym:')) return;

  const [, , rawStatus, rawDate] = String(interaction.customId).split(':');
  const status = rawStatus === 'yes' ? 'yes' : 'not-yet';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate || '') ? rawDate : localDateParts().date;
  const message = await recordPulseGymCheckin(interaction.user.id, status, date);

  await safeInitialReply(interaction, {
    content: message,
    ephemeral: true,
  });
}

async function handleModalSubmitInteraction(interaction: any): Promise<void> {
  if (!allowedUsers.has(interaction.user.id)) {
    await safeInitialReply(interaction, {
      content: 'You are not authorized to use SwiftPark command-center modals.',
      ephemeral: true,
    });
    return;
  }

  const [scope, action, rawGoalId] = String(interaction.customId || '').split(':');
  if (scope !== 'goal-modal' || !['ask-orion', 'revise-plan'].includes(action)) return;

  const guild = interaction.guild;
  if (!guild) {
    await safeInitialReply(interaction, {
      content: action === 'revise-plan'
        ? 'Revise Plan must be used in the SwiftPark Discord server.'
        : 'Ask Orion must be used in the SwiftPark Discord server.',
      ephemeral: true,
    });
    return;
  }

  const goal = rawGoalId ? await readGoalState(rawGoalId) : undefined;
  if (!goal) {
    await safeInitialReply(interaction, {
      content: `Unknown goal for ${action === 'revise-plan' ? 'Revise Plan' : 'Ask Orion'}: \`${rawGoalId || '(missing)'}\`.`,
      ephemeral: true,
    });
    return;
  }

  const message = String(interaction.fields.getTextInputValue('orion-message') || '').trim();
  if (!message) {
    await safeInitialReply(interaction, {
      content: action === 'revise-plan'
        ? 'Revise Plan needs the feedback Orion should save into the plan.'
        : 'Ask Orion needs a question or brainstorming note.',
      ephemeral: true,
    });
    return;
  }

  const forbidden = isForbiddenTask(message);
  if (forbidden) {
    await safeInitialReply(interaction, {
      content: `${action === 'revise-plan' ? 'Revise Plan' : 'Ask Orion'} blocked: ${forbidden}.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const setup = await ensureChannels(guild);

  if (action === 'revise-plan') {
    await interaction.editReply(`Orion is revising the saved handoff for goal-${goal.id}.`);
    const { goal: revisedGoal } = await reviseGoalPlan(
      goal,
      message,
      'thread button',
      setup.channels,
      interaction.user.id,
      'Revise Plan button'
    );
    await postAgentStatusBoard(setup.channels).catch(() => undefined);
    await notifySubscribers(
      setup.channels,
      `Orion revised goal-${revisedGoal.id}. Approval needed: /approve target:${revisedGoal.planApprovalToken}`
    ).catch(() => undefined);
    await interaction.editReply(
      revisedGoal.threadName
        ? `Saved revision posted in thread \`${revisedGoal.threadName}\`.`
        : 'Saved revision posted to #orion-planning.'
    );
    return;
  }

  await interaction.editReply(`Orion is answering goal-${goal.id}. I will post the answer in the goal thread.`);

  const response = await runOrionChat(goal, message, setup.channels, interaction.user.id, 'Ask Orion button');
  await postOrionResponseToGoalThreadOrPlanning(setup.channels, goal, 'Orion Answer', response);
  await interaction.editReply(
    goal.threadName
      ? `Orion answered in thread \`${goal.threadName}\`.`
      : 'Orion answered in #orion-planning.'
  );
}

async function handleGoalButtonInteraction(interaction: any): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await safeInitialReply(interaction, {
      content: 'Goal buttons must be used in the SwiftPark Discord server.',
      ephemeral: true,
    });
    return;
  }

  const [, action, rawGoalId] = String(interaction.customId).split(':');
  const goal = rawGoalId ? await readGoalState(rawGoalId) : undefined;
  if (!goal) {
    await safeInitialReply(interaction, {
      content: `Unknown goal for this button: \`${rawGoalId || '(missing)'}\`.`,
      ephemeral: true,
    });
    return;
  }

  if (action === 'ask-orion') {
    const modal = new ModalBuilder()
      .setCustomId(`goal-modal:ask-orion:${goal.id}`)
      .setTitle('Ask Orion');
    const input = new TextInputBuilder()
      .setCustomId('orion-message')
      .setLabel('Question or brainstorm note')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1800)
      .setPlaceholder('Ask Orion anything about this goal. This will not revise the saved plan.');

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'revise-plan') {
    const modal = new ModalBuilder()
      .setCustomId(`goal-modal:revise-plan:${goal.id}`)
      .setTitle('Revise Plan');
    const input = new TextInputBuilder()
      .setCustomId('orion-message')
      .setLabel('What should Orion save?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1800)
      .setPlaceholder('Tell Orion exactly how to revise the saved handoff. This changes plan state and requires approval again.');

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const setup = await ensureChannels(guild);

  if (action === 'plan-summary' || action === 'plan-full') {
    const format = action === 'plan-full' ? 'full' : 'summary';
    const plan = await readPlan(goal);
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
      ].join('\n'),
      chunks
    );
    return;
  }

  if (action === 'approve-run' || action === 'approve-plan') {
    const runRecommended = action === 'approve-run';
    const result = await approvePlanGoal(goal, setup.channels, interaction.user.id, {
      runRecommended,
      forceMode: runRecommended ? 'execute-after-approval' : 'plan-only',
    });
    await interaction.editReply(
      [
        result.alreadyApproved ? `Plan was already approved for goal-${result.updated.id}.` : `Approval recorded for goal-${result.updated.id}.`,
        result.started ? 'Orion is starting the recommended agent flow.' : result.blockedReason || 'Plan-only approval recorded.',
      ].join('\n')
    );
    return;
  }

  if (action === 'cancel') {
    const { updated, stopped } = await cancelGoalRun(goal, 'Canceled from goal action button.', setup.channels);
    await interaction.editReply(
      [
        `Canceled goal-${updated.id}.`,
        stopped.length ? `Stopped tracked subprocesses: ${stopped.join(', ')}` : 'No tracked live subprocess was found.',
      ].join('\n')
    );
    return;
  }

  const runAgent = action === 'run-iris'
    ? 'iris'
    : action === 'run-atlas'
      ? 'atlas'
      : action === 'run-sentinel'
        ? 'sentinel'
        : undefined;

  if (runAgent) {
    if (!goal.approvals.plan) {
      await interaction.editReply(`Plan not approved yet. Click **Approve + Run** or use \`/approve target:${goal.planApprovalToken}\` first.`);
      return;
    }

    await interaction.editReply(`Started ${runAgent} for goal-${goal.id}. Updates will post to #echo-status.`);
    void runAgentJob(goal.id, runAgent, defaultAgentTask(goal, runAgent), setup.channels, interaction.user.id).catch(async (err: any) => {
      const errorOutput = err?.stack || err?.message || String(err);
      await setAgentFinished(runAgent, false, errorOutput).catch(() => undefined);
      await postCommandCenterError(setup.channels, `${runAgent} crashed for goal-${goal.id}`, errorOutput, goal.id).catch(() => undefined);
      await setup.channels['agent-status'].send(
        [`${runAgent} crashed for goal-${goal.id}.`, '```text', truncate(errorOutput), '```'].join('\n')
      ).catch(() => {});
    });
    return;
  }

  await interaction.editReply(`Unknown goal action: \`${action}\`.`);
}

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
        `Sentinel QA started: **${label}**. Mode: \`${mode}\`. Updates will be posted in #sentinel-qa.`
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

      await interaction.editReply('Visual QA errored before completion. Check #sentinel-qa for any posted artifacts.');
      return;
    }

    if (!qaVisual) {
      await setAgentFinished('sentinel', false, '#sentinel-qa unavailable').catch(() => undefined);
      await interaction.editReply('Visual QA errored before completion: #sentinel-qa was unavailable.');
      return;
    }

    const result = await runQaFlow(repoPath, qaVisual, label, selection, {
      timeoutMs: sentinelMaxRuntimeMs,
      agent: 'sentinel',
    });
    await setAgentFinished('sentinel', result.ok, result.output).catch(() => undefined);
    const status = result.qa.status;
    const uploadSuffix = result.uploadSummary ? ` ${result.uploadSummary}.` : '';
    await interaction.editReply(`Visual QA complete: **${status}**. Mode: \`${mode}\`. See #sentinel-qa.${uploadSuffix}`);
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
        `Updated the command-center guide in <#${channels['help'].id}>.`,
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

  if (interaction.commandName === 'inspect-discord') {
    const rawSource = interaction.options.getString('source', true);
    if (!isInspectDiscordSource(rawSource)) {
      await interaction.editReply(`Unknown inspection source: \`${rawSource}\`.`);
      return;
    }

    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const limit = interaction.options.getInteger('limit') || 25;
    const summary = await inspectDiscordMessages(interaction, channels, rawSource, limit, requestedGoalId);
    await interaction.editReply(truncate(summary, 1900));
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

  if (interaction.commandName === 'pulse') {
    const setting = interaction.options.getString('setting') || 'brief';
    const state = await readPulseState();
    const current = state.users[interaction.user.id] || { enabled: false, gymCheckIn: false, updatedAt: new Date().toISOString() };

    if (setting === 'on') {
      const updated = await setPulsePreference(interaction.user.id, { enabled: true, gymCheckIn: true });
      await interaction.editReply(
        [
          'Pulse is on for you.',
          updated.gymCheckIn
            ? `Gym check-in is on. Pulse asks at ${String(pulseGymPromptHour).padStart(2, '0')}:${String(pulseGymPromptMinute).padStart(2, '0')} ${pulseTimeZone}.`
            : '',
          'Use `/pulse-checkin gym:yes` any time to claim the cookie manually.',
        ].filter(Boolean).join('\n')
      );
      return;
    }

    if (setting === 'off') {
      await setPulsePreference(interaction.user.id, { enabled: false, gymCheckIn: false });
      await interaction.editReply('Pulse is off for you.');
      return;
    }

    if (setting === 'gym-on') {
      await setPulsePreference(interaction.user.id, { enabled: true, gymCheckIn: true });
      await interaction.editReply(`Pulse gym check-in is on. Prompt time: ${String(pulseGymPromptHour).padStart(2, '0')}:${String(pulseGymPromptMinute).padStart(2, '0')} ${pulseTimeZone}.`);
      return;
    }

    if (setting === 'gym-off') {
      await setPulsePreference(interaction.user.id, { gymCheckIn: false });
      await interaction.editReply('Pulse gym check-in is off.');
      return;
    }

    if (setting === 'status') {
      await interaction.editReply(
        [
          '## Pulse Status',
          `Pulse: ${current.enabled ? 'on' : 'off'}`,
          `Gym check-in: ${current.gymCheckIn ? 'on' : 'off'}`,
          `Gym prompt: ${String(pulseGymPromptHour).padStart(2, '0')}:${String(pulseGymPromptMinute).padStart(2, '0')} ${pulseTimeZone}`,
          `State file: \`${relativeToCommandCenter(pulseStatePath)}\``,
        ].join('\n')
      );
      return;
    }

    await interaction.editReply(truncate(await formatPulseBrief(interaction.user.id), 1900));
    return;
  }

  if (interaction.commandName === 'pulse-checkin') {
    const gym = interaction.options.getString('gym') || 'status';
    const today = localDateParts().date;

    if (gym === 'yes' || gym === 'not-yet') {
      await setPulsePreference(interaction.user.id, { enabled: true, gymCheckIn: true });
      const message = await recordPulseGymCheckin(interaction.user.id, gym, today);
      const channel = channels['personal-checkins'] || channels['agent-status'];
      await channel.send(
        gym === 'yes'
          ? `<@${interaction.user.id}> logged the gym for ${today}. 🍪`
          : `<@${interaction.user.id}> logged gym status for ${today}: not yet.`
      ).catch(() => undefined);
      await interaction.editReply(message);
      return;
    }

    const state = await readPulseState();
    const status = state.gym[today]?.[interaction.user.id]?.status;
    await interaction.editReply(`Gym today (${today}): ${status === 'yes' ? 'yes 🍪' : status === 'not-yet' ? 'not yet' : 'not logged'}.`);
    return;
  }

  if (interaction.commandName === 'daily-brief') {
    await interaction.editReply(truncate(await formatPulseBrief(interaction.user.id), 1900));
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
    const resolved = await resolveGoalForInteraction(interaction, requestedGoalId, { allowLatest: true });
    const goal = resolved.goal;

    if (!goal) {
      await interaction.editReply(resolved.message || 'No goal records found yet.');
      return;
    }

    await interaction.editReply(await formatGoalStatus(goal));
    return;
  }

  if (interaction.commandName === 'plan') {
    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const requestedFormat = interaction.options.getString('format');
    const format = isPlanDisplayFormat(requestedFormat) ? requestedFormat : 'summary';
    const resolved = await resolveGoalForInteraction(interaction, requestedGoalId, { allowLatest: true });
    const goal = resolved.goal;

    if (!goal) {
      await interaction.editReply(resolved.message || 'No goal records found yet.');
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
        format === 'summary' ? `Use \`/plan${resolved.source === 'thread' ? ' format:full' : ` goal_id:${goal.id} format:full`}\` for the complete saved plan.` : '',
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
    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const reason = interaction.options.getString('reason') || 'Canceled by human request.';
    const resolved = await resolveGoalForInteraction(interaction, requestedGoalId);
    const goal = resolved.goal;

    if (!goal) {
      await interaction.editReply(resolved.message || 'No goal records found yet.');
      return;
    }

    const { updated, stopped } = await cancelGoalRun(goal, reason, channels);
    await interaction.editReply(
      [
        `Canceled goal-${updated.id}.`,
        stopped.length ? `Stopped tracked subprocesses: ${stopped.join(', ')}` : 'No tracked live subprocess was found. If an older process survived a bot restart, stop it from the terminal.',
      ].join('\n')
    );
    return;
  }

  if (interaction.commandName === 'clear-blocker') {
    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const reason = interaction.options.getString('reason') || 'Cleared after human review.';
    const resolved = await resolveGoalForInteraction(interaction, requestedGoalId);
    const goal = resolved.goal;

    if (!goal) {
      await interaction.editReply(resolved.message || 'No goal records found yet.');
      return;
    }

    const result = await clearGoalBlocker(goal, reason, channels, interaction.user.id);
    await interaction.editReply(result.message);
    return;
  }

  if (interaction.commandName === 'revise-goal') {
    const feedback = interaction.options.getString('feedback', true);
    const target = interaction.options.getString('target') || 'general';
    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const resolved = await resolveGoalForInteraction(interaction, requestedGoalId);
    const goal = resolved.goal;

    if (!goal) {
      await interaction.editReply(resolved.message || 'No goal records found yet.');
      return;
    }

    const forbidden = isForbiddenTask(feedback);
    if (forbidden) {
      await interaction.editReply(`Revision feedback blocked: ${forbidden}.`);
      return;
    }

    await interaction.editReply(`Orion is revising goal-${goal.id}. No implementation agents will run automatically.`);

    try {
      const { goal: revisedGoal } = await reviseGoalPlan(goal, feedback, target, channels, interaction.user.id, '/revise-goal');
      await postAgentStatusBoard(channels).catch(() => undefined);
      await notifySubscribers(
        channels,
        `Orion revised goal-${revisedGoal.id}. Approval needed again: /approve target:${revisedGoal.planApprovalToken}`
      ).catch(() => undefined);
      await interaction.editReply(
        [
          `Orion revised goal-${revisedGoal.id}.`,
          revisedGoal.threadName ? `Response posted in thread \`${revisedGoal.threadName}\`.` : `Response posted to #orion-planning.`,
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
      await interaction.editReply(`Goal revision failed. See #echo-status.`);
    }

    return;
  }

  if (interaction.commandName === 'goal') {
    const description = interaction.options.getString('description', true);
    const requestedMode = interaction.options.getString('mode');
    const requestedAgents = interaction.options.getString('agents');
    const primaryScreen = interaction.options.getString('primary_screen') || undefined;
    const mode = isGoalMode(requestedMode) ? requestedMode : 'execute-after-approval';
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
          current.nextAction = 'Check #echo-logs, then rerun /goal or use /revise-goal if a plan exists.';
        }).catch(() => undefined);
      }
      await setAgentFinished('orion', false, errorOutput).catch(() => undefined);
      await postCommandCenterError(channels, 'Goal creation failed', errorOutput).catch(() => undefined);
      await agentStatus.send(
        ['# Goal Creation Failed', '```text', truncate(errorOutput), '```'].join('\n')
      ).catch(() => {});
      await safeEditReply(interaction, `Goal creation failed. See #echo-status.`);
    }

    return;
  }

  if (interaction.commandName === 'run-agent') {
    const requestedAgent = interaction.options.getString('agent', true);

    if (!isRunnableAgent(requestedAgent)) {
      await interaction.editReply(`Unsupported agent: \`${requestedAgent}\`.`);
      return;
    }

    const requestedGoalId = interaction.options.getString('goal_id') || undefined;
    const resolved = await resolveGoalForInteraction(interaction, requestedGoalId);
    const goal = resolved.goal;
    if (!goal) {
      await interaction.editReply(resolved.message || 'No goal records found yet.');
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

    await interaction.editReply(`Started ${requestedAgent} for goal-${goal.id}. Updates will post to #echo-status.`);
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
    const target = await resolveApprovalTargetForInteraction(interaction, interaction.options.getString('target'));
    if (!target) {
      await interaction.editReply('No approval target was provided, and this command was not used inside a recognized goal thread.');
      return;
    }
    const lowerTarget = target.toLowerCase();

    if (lowerTarget.startsWith('plan-')) {
      const goalId = normalizeGoalId(target);
      const goal = await readGoalState(goalId);

      if (!goal) {
        await interaction.editReply(`Unknown plan target: \`${target}\`.`);
        return;
      }

      const result = await approvePlanGoal(goal, channels, interaction.user.id);
      await interaction.editReply(
        [
          result.alreadyApproved ? `Plan **${result.updated.planApprovalToken}** was already approved.` : `Approval recorded for **${result.updated.planApprovalToken}**.`,
          result.started ? 'Orion is starting the recommended agent flow.' : result.blockedReason || 'Plan-only approval recorded.',
        ].join('\n')
      );

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
      if (approvalType === 'agent' && !hasSuccessfulImplementationJob(goal)) {
        await interaction.editReply(
          [
            `No Iris or Atlas implementation work has completed for goal-${goal.id} yet.`,
            'Agent approval is only for approving completed implementation work.',
            `Use **Approve + Run** or \`/run-agent\` when you want Orion to start work.`,
          ].join('\n')
        );
        return;
      }

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
    const target = await resolveApprovalTargetForInteraction(interaction, interaction.options.getString('target'));
    const reason = interaction.options.getString('reason', true);
    if (!target) {
      await interaction.editReply('No rejection target was provided, and this command was not used inside a recognized goal thread.');
      return;
    }

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
