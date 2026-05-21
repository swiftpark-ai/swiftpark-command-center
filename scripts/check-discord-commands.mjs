import 'dotenv/config';
import assert from 'node:assert/strict';
import { REST, Routes } from 'discord.js';

const requiredEnv = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];
for (const key of requiredEnv) {
  assert(process.env[key], `missing ${key}`);
}

const expectedCommands = [
  'setup',
  'status',
  'github-status',
  'jira-status',
  'help',
  'commands',
  'agents',
  'run-agent',
  'test',
  'goal',
  'goal-status',
  'plan',
  'runs',
  'active-runs',
  'cancel-goal',
  'cancel',
  'revise-goal',
  'approve',
  'reject',
  'notify',
  'pulse',
  'pulse-checkin',
  'daily-brief',
  'log-change',
  'decision',
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
const commands = await rest.get(Routes.applicationGuildCommands(
  process.env.DISCORD_CLIENT_ID,
  process.env.DISCORD_GUILD_ID
));
const names = commands.map((command) => command.name).sort();

for (const command of expectedCommands) {
  assert(names.includes(command), `registered Discord commands missing /${command}`);
}

console.log(`registered Discord commands (${names.length}): ${names.join(', ')}`);
