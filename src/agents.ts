export type AgentId = 'orion' | 'iris' | 'atlas' | 'sentinel' | 'scout' | 'echo' | 'pulse';

export type AgentStatus = 'idle' | 'running' | 'waiting-approval' | 'failed' | 'disabled' | 'online';

export type AgentDefinition = {
  id: AgentId;
  displayName: string;
  role: string;
  tool: string;
  defaultStatus: AgentStatus;
  outputChannelId: string;
};

export const agentDefinitions: AgentDefinition[] = [
  {
    id: 'orion',
    displayName: 'Orion',
    role: 'PM / Orchestrator',
    tool: 'Codex / ChatGPT-style planning',
    defaultStatus: 'idle',
    outputChannelId: 'pm-planning',
  },
  {
    id: 'iris',
    displayName: 'Iris',
    role: 'Frontend / Visual',
    tool: 'Claude Code',
    defaultStatus: 'idle',
    outputChannelId: 'frontend',
  },
  {
    id: 'atlas',
    displayName: 'Atlas',
    role: 'Backend / Systems',
    tool: 'Codex',
    defaultStatus: 'idle',
    outputChannelId: 'backend',
  },
  {
    id: 'sentinel',
    displayName: 'Sentinel',
    role: 'QA / Visual Testing',
    tool: 'Playwright + bot scripts',
    defaultStatus: 'idle',
    outputChannelId: 'qa-visual',
  },
  {
    id: 'scout',
    displayName: 'Scout',
    role: 'Research / YC / Reddit / Client Intel',
    tool: 'Codex/browser later',
    defaultStatus: 'disabled',
    outputChannelId: 'yc-reddit',
  },
  {
    id: 'echo',
    displayName: 'Echo',
    role: 'Discord Comms / Status Reporter',
    tool: 'Discord bot',
    defaultStatus: 'online',
    outputChannelId: 'agent-status',
  },
  {
    id: 'pulse',
    displayName: 'Pulse',
    role: 'Personal Check-ins / Founder Briefs',
    tool: 'Discord opt-in check-ins',
    defaultStatus: 'disabled',
    outputChannelId: 'personal-checkins',
  },
];
