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
    displayName: 'echo-command',
    purpose: 'Primary command room for running bot commands and coordinating active work.',
    aliases: ['agent-command', 'echo-command', 'commands', 'command-center'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'help',
    displayName: 'helppppppppppppppppppppppppppppppppppppp',
    purpose: 'Onboarding, command directory, example workflows, approval rules, and notification instructions.',
    aliases: ['help', 'helppppppppppppppppppppppppppppppppppppp', 'command-help', 'commands-help', 'start-here'],
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
    displayName: 'echo-status',
    purpose: 'Live structured status board for Orion, Iris, Atlas, Sentinel, Scout, Echo, and Pulse.',
    aliases: ['agent-status', 'echo-status', 'status-board', 'agent-board'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'build-feed',
    displayName: 'echo-build-feed',
    purpose: 'High-level goal lifecycle updates and build/run summaries.',
    aliases: ['build-feed', 'echo-build-feed', 'builds', 'goal-feed'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'qa-visual',
    displayName: 'sentinel-qa',
    purpose: 'Sentinel posts QA summaries, visual screenshots, and Playwright diagnostics.',
    aliases: ['qa-visual', 'sentinel-qa', 'visual-qa', 'qa-screenshots'],
    required: true,
    primaryAgent: 'sentinel',
  },
  {
    id: 'approvals',
    displayName: 'echo-approvals',
    purpose: 'Human approvals, rejections, and approval audit trail.',
    aliases: ['approvals', 'echo-approvals', 'approval-log', 'human-approval'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'frontend',
    displayName: 'iris-frontend',
    purpose: 'Iris frontend and visual implementation summaries.',
    aliases: ['frontend', 'iris-frontend', 'front-end', 'ui'],
    required: true,
    primaryAgent: 'iris',
  },
  {
    id: 'backend',
    displayName: 'atlas-backend',
    purpose: 'Atlas backend, API, systems, and reliability implementation summaries.',
    aliases: ['backend', 'atlas-backend', 'back-end', 'systems'],
    required: true,
    primaryAgent: 'atlas',
  },
  {
    id: 'yc-reddit',
    displayName: 'scout-research',
    purpose: 'Future Scout research and YC/Reddit/client intel drafts. Currently approval-gated and mostly idle.',
    aliases: ['yc-reddit', 'research', 'scout-research'],
    required: true,
    primaryAgent: 'scout',
  },
  {
    id: 'client-outreach',
    displayName: 'scout-outreach',
    purpose: 'Future client outreach drafts only. The bot must not send emails or external messages.',
    aliases: ['client-outreach', 'scout-outreach', 'outreach', 'client-intel'],
    required: true,
    primaryAgent: 'scout',
  },
  {
    id: 'personal-checkins',
    displayName: 'pulse-checkins',
    purpose: 'Future Pulse personal reminders and check-ins.',
    aliases: ['personal-checkins', 'pulse-checkins', 'checkins', 'pulse'],
    required: true,
    primaryAgent: 'pulse',
  },
  {
    id: 'manual-log',
    displayName: 'echo-manual-log',
    purpose: 'Discord-first human decisions, change notes, and manual audit breadcrumbs. No external posting.',
    aliases: ['manual-log', 'echo-manual-log', 'decision-log', 'change-log'],
    required: true,
    primaryAgent: 'echo',
  },
  {
    id: 'logs',
    displayName: 'echo-logs',
    purpose: 'Command-center logs, captured output locations, warnings, and operational notes.',
    aliases: ['logs', 'echo-logs', 'bot-logs', 'agent-logs'],
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
