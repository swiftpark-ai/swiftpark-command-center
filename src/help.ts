import { agentDefinitions } from './agents.js';
import { requiredChannelDefinitions, type ChannelDefinition } from './channels.js';

export function buildHelpGuide(channels: ChannelDefinition[] = requiredChannelDefinitions): string {
  return buildHelpGuideMessages(channels).join('\n\n');
}

export function buildHelpGuideMessages(channels: ChannelDefinition[] = requiredChannelDefinitions): string[] {
  const channelLines = channels.map((channel) => {
    const agent = channel.primaryAgent ? ` (${agentName(channel.primaryAgent)})` : '';
    return `- #${channel.displayName}: ${channel.purpose}${agent}`;
  });

  const agentLines = agentDefinitions.map((agent) => {
    return `- ${agent.displayName}: ${agent.role}. Tool: ${agent.tool}.`;
  });

  const first = [
    '# SwiftPark Command Center Guide',
    '',
    'This server is a Discord command center for local SwiftPark agent work. Slash commands are the primary control surface; opt-in goal thread replies can revise Orion planning. Humans approve plans, agent work, and QA before anything moves toward merge or deploy.',
    '',
    'Neo is reserved for the future SwiftPark user-facing assistant. Orion is the project manager / orchestrator.',
    '',
    '## Channels',
    ...channelLines,
    '',
    '## Agents',
    ...agentLines,
    '',
    '## Command Directory',
    '- `/setup`: create missing channels, refresh this guide, and refresh the agent status board.',
    '- `/help`: show this guide and update the guide in the help channel.',
    '- `/commands`: show the command directory.',
    '- `/agents`: show current agent status.',
    '- `/github-status`: show safe GitHub readiness and optional read-only gh auth status.',
    '- `/jira-status`: show safe Jira configuration readiness without contacting Jira.',
    '- `/goal`: ask Orion to plan a goal.',
    '- `/plan`: show a saved Orion plan as a phone summary or full multi-message plan.',
    '- `/goal-status`: inspect the latest active goal, or a specific goal id.',
    '- `/runs` / `/active-runs`: list recent, active, stale, failed, and approved goal runs.',
    '- `/cancel-goal`: cancel a goal and stop tracked local subprocesses when possible.',
    '- `/cancel`: short alias for `/cancel-goal`.',
    '- `/revise-goal`: ask Orion to revise a plan from feedback.',
    '- `/approve`: approve `plan-<goal_id>`, `agent-<goal_id>`, or `qa-<goal_id>`.',
    '- `/reject`: reject a plan, agent run, QA result, issue, PR, or branch with a reason.',
  ].join('\n');

  const second = [
    '# SwiftPark Command Center Guide, Continued',
    '',
    '## Command Directory, Continued',
    '- `/run-agent`: run Orion, Iris, Atlas, Sentinel, or Scout for an approved goal.',
    '- `/test`: run standalone Sentinel visual QA.',
    '- `/notify`: opt into or out of completion notifications.',
    '- `/pulse`: enable Pulse, show Pulse status, or get a founder brief.',
    '- `/pulse-checkin`: log a personal Pulse check-in, including gym status.',
    '- `/daily-brief`: show Pulse active goals, waiting approvals, blockers, and next command.',
    '- `/log-change`: record a Discord-first manual change note in #echo-manual-log.',
    '- `/decision`: record a Discord-first manual decision in #echo-manual-log.',
    '',
    '## Example Workflow',
    '1. `/goal description:"Improve Brighton spot map mobile clarity" mode:plan-only primary_screen:"brighton-spot-map" agents:iris`',
    '2. Orion posts the complete plan in #orion-planning, split across messages when needed.',
    '3. Use `/plan format:summary` in the goal thread, or add `goal_id:<id>` outside the thread.',
    '4. Discuss revisions in the goal thread. If thread replies are enabled, normal messages become Orion feedback.',
    '5. If something looks stuck, run `/goal-status` in the thread or `/runs` anywhere.',
    '6. `/revise-goal feedback:"Make the plan focus only on the selected spot state and mobile bottom sheet."`',
    '7. `/approve` in the thread, or `/approve target:plan-<id>` outside it.',
    '8. `/run-agent agent:iris`',
    '9. `/run-agent agent:sentinel task:"Run screen QA for brighton-spot-map"`',
    '10. Review screenshots in #sentinel-qa.',
    '11. `/approve target:qa-<id>` or `/reject reason:"..." target:qa-<id>`',
    '12. `/cancel reason:"No longer needed"` in the thread if the run should stop.',
    '13. `/decision summary:"Ship the phone-friendly planning flow for review" rationale:"Smoke checks passed; human Discord review remains." goal_id:<id>`',
    '',
    '## Approval Rules',
    '- Orion can plan or revise without implementation approval.',
    '- Iris, Atlas, and Sentinel require an approved plan.',
    '- Orion, Iris, Atlas, and Sentinel have configurable hard timeouts; `0` means no hard kill and heartbeats continue until they finish or are canceled.',
    '- Sentinel posts visual screenshots before QA approval.',
    '- No merge, deploy, push, PR creation, email sending, YC change, Jira action, Reddit scraping, or external account access is automatic.',
    '- Secrets, tokens, cookies, private keys, and `.env` values must not be printed.',
    '',
    '## Screenshots',
    'Sentinel posts visual QA screenshots in #sentinel-qa. Screen mode posts only mobile + desktop for the selected screen. Smoke mode posts a small core set. Full mode posts all available screenshots, capped.',
    'Example: `/test mode:screen screen:brighton-spot-map label:"Brighton map mobile check"`',
    '',
    '## Revisions',
    'Use `/revise-goal` for explicit plan changes. In goal threads, goal ids are inferred. When `ORION_THREAD_REPLIES_ENABLED=true` and Discord Message Content intent is enabled, normal messages from allowed users inside that goal thread become conversational Orion revision feedback.',
    '',
    '## Notifications',
    'Use `/notify setting:on` to receive completion and approval-needed pings. Use `/notify setting:off` to disable them. The bot never uses @everyone or @here.',
    '',
    '## Pulse',
    'Use `/pulse setting:on` to enable Pulse for yourself. Pulse posts in #pulse-checkins, can ask whether you went to the gym at noon, and gives you a cookie when you log `gym:yes`.',
    'Use `/daily-brief` for active goals, waiting approvals, blockers, gym status, and the next suggested command.',
    '',
    '## Future Integrations',
    'Use `/github-status` for read-only GitHub readiness. GitHub writes remain disabled unless separately configured and approved. Use `/jira-status` to check Jira env readiness; the bot does not contact Jira or require a Jira token. Use `/log-change` and `/decision` for Discord-first manual audit notes in #echo-manual-log.',
  ].join('\n');

  return [first, second];
}

export function buildCommandDirectory(): string {
  return [
    '# SwiftPark Commands',
    '',
    '- `/setup`',
    '- `/help`',
    '- `/commands`',
    '- `/agents`',
    '- `/github-status`',
    '- `/jira-status`',
    '- `/goal description:<text> mode:<plan-only|execute-after-approval> primary_screen:<screen> agents:<atlas|iris|both|auto>`',
    '- `/plan goal_id:<optional id> format:<summary|full>`',
    '- `/goal-status goal_id:<optional id>`',
    '- `/runs limit:<optional number>`',
    '- `/active-runs limit:<optional number>`',
    '- `/cancel-goal goal_id:<optional id> reason:<optional text>`',
    '- `/cancel goal_id:<optional id> reason:<optional text>`',
    '- `/revise-goal feedback:<text> target:<plan|iris|atlas|sentinel|general> goal_id:<optional id>`',
    '- `/approve target:<optional plan-id|agent-id|qa-id>`',
    '- `/reject reason:<text> target:<optional id>`',
    '- `/run-agent agent:<orion|iris|atlas|sentinel|scout> goal_id:<optional id> task:<optional text>`',
    '- `/test mode:<smoke|screen|full> screen:<optional> label:<optional>`',
    '- `/notify setting:<on|off|status>`',
    '- `/pulse setting:<brief|status|on|off|gym-on|gym-off>`',
    '- `/pulse-checkin gym:<yes|not-yet|status>`',
    '- `/daily-brief`',
    '- `/log-change summary:<text> goal_id:<optional id>`',
    '- `/decision summary:<text> rationale:<optional text> goal_id:<optional id>`',
  ].join('\n');
}

function agentName(agentId: string): string {
  return agentDefinitions.find((agent) => agent.id === agentId)?.displayName || agentId;
}
