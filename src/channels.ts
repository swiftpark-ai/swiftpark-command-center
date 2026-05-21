import type { AgentId } from './agents.js';

export type ChannelId =
  | 'agent-command'
  | 'help'
  | 'pm-planning'
  | 'agent-status'
  | 'build-feed'
  | 'qa-visual'
  | 'approvals'
  | 'frontend'
  | 'backend'
  | 'yc-reddit'
  | 'client-outreach'
  | 'personal-checkins'
  | 'manual-log'
  | 'logs'
  | 'iris-frontend'
  | 'atlas-backend'
  | 'sentinel-qa';

export type ChannelDefinition = {
  id: ChannelId;
  displayName: string;
  purpose: string;
  aliases: string[];
  required: boolean;
  primaryAgent?: AgentId;
};

export const channelDefinitions: ChannelDefinition[] = [
  {
    id: 'agent-command',
    displayName: 'agent-command',
    purpose: 'Primary command room for running bot commands and coordinating active work.',
    aliases: ['agent-command', 'commands', 'command-center'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'help',
    displayName: 'help',
    purpose: 'Onboarding, command directory, example workflows, approval rules, and notification instructions.',
    aliases: ['help', 'command-help', 'commands-help', 'start-here'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'pm-planning',
    displayName: 'orion-planning',
    purpose: 'Orion posts plans, revised plans, acceptance criteria, risks, and agent assignments.',
    aliases: ['pm-planning', 'planning', 'orion-planning'],
    required: true,
    primaryAgent: 'orion',
  },
  {
    id: 'agent-status',
    displayName: 'agent-status',
    purpose: 'Live structured status board for Orion, Iris, Atlas, Sentinel, Scout, Echo, and Pulse.',
    aliases: ['agent-status', 'status-board', 'agent-board'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'build-feed',
    displayName: 'build-feed',
    purpose: 'High-level goal lifecycle updates and build/run summaries.',
    aliases: ['build-feed', 'builds', 'goal-feed'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'qa-visual',
    displayName: 'qa-visual',
    purpose: 'Sentinel posts QA summaries, visual screenshots, and Playwright diagnostics.',
    aliases: ['qa-visual', 'visual-qa', 'qa-screenshots'],
    required: true,
    primaryAgent: 'sentinel',
  },
  {
    id: 'approvals',
    displayName: 'approvals',
    purpose: 'Human approvals, rejections, and approval audit trail.',
    aliases: ['approvals', 'approval-log', 'human-approval'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'frontend',
    displayName: 'frontend',
    purpose: 'Iris frontend and visual implementation summaries.',
    aliases: ['frontend', 'front-end', 'ui'],
    required: true,
    primaryAgent: 'iris',
  },
  {
    id: 'backend',
    displayName: 'backend',
    purpose: 'Atlas backend, API, systems, and reliability implementation summaries.',
    aliases: ['backend', 'back-end', 'systems'],
    required: true,
    primaryAgent: 'atlas',
  },
  {
    id: 'yc-reddit',
    displayName: 'yc-reddit',
    purpose: 'Future Scout research and YC/Reddit/client intel drafts. Currently approval-gated and mostly idle.',
    aliases: ['yc-reddit', 'research', 'scout-research'],
    required: true,
    primaryAgent: 'scout',
  },
  {
    id: 'client-outreach',
    displayName: 'client-outreach',
    purpose: 'Future client outreach drafts only. The bot must not send emails or external messages.',
    aliases: ['client-outreach', 'outreach', 'client-intel'],
    required: true,
    primaryAgent: 'scout',
  },
  {
    id: 'personal-checkins',
    displayName: 'personal-checkins',
    purpose: 'Future Pulse personal reminders and check-ins.',
    aliases: ['personal-checkins', 'checkins', 'pulse'],
    required: true,
    primaryAgent: 'pulse',
  },
  {
    id: 'manual-log',
    displayName: 'manual-log',
    purpose: 'Discord-first human decisions, change notes, and manual audit breadcrumbs. No external posting.',
    aliases: ['manual-log', 'decision-log', 'change-log'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'logs',
    displayName: 'logs',
    purpose: 'Command-center logs, captured output locations, warnings, and operational notes.',
    aliases: ['logs', 'bot-logs', 'agent-logs'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'iris-frontend',
    displayName: 'iris-frontend',
    purpose: 'Optional Iris-specific frontend channel. Preserved if user-created.',
    aliases: ['iris-frontend'],
    required: false,
    primaryAgent: 'iris',
  },
  {
    id: 'atlas-backend',
    displayName: 'atlas-backend',
    purpose: 'Optional Atlas-specific backend channel. Preserved if user-created.',
    aliases: ['atlas-backend'],
    required: false,
    primaryAgent: 'atlas',
  },
  {
    id: 'sentinel-qa',
    displayName: 'sentinel-qa',
    purpose: 'Optional Sentinel-specific QA channel. Preserved if user-created.',
    aliases: ['sentinel-qa'],
    required: false,
    primaryAgent: 'sentinel',
  },
];

export const requiredChannelDefinitions = channelDefinitions.filter((channel) => channel.required);
