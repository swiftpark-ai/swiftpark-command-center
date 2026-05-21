export const orionPlanSections = [
  'User Story',
  'Intent / Why This Matters',
  'Affected Screens/Routes',
  'Acceptance Criteria',
  'Backend Tasks for Atlas',
  'Frontend/Visual Tasks for Iris',
  'QA Plan for Sentinel',
  'Visual Approval Checklist',
  'Suggested Agent Assignment',
  'Risks / Constraints',
  'Human Approvals Needed',
];

export type OrionPlanExtraction = {
  ok: boolean;
  plan: string;
  reason?: string;
};

type PlanDisplayMode = 'summary' | 'full';

type PlanSection = {
  title: string;
  body: string;
};

export function extractOrionPlan(rawOutput: string): OrionPlanExtraction {
  const normalized = normalizePlanHeadings(stripAnsi(rawOutput || '').replace(/\r\n/g, '\n'));
  const starts = [...normalized.matchAll(/^## User Story\s*$/gim)].map((match) => match.index ?? 0);

  for (const start of starts.reverse()) {
    const candidate = trimCliNoise(normalized.slice(start));
    if (hasRequiredSections(candidate)) {
      return {
        ok: true,
        plan: candidate,
      };
    }
  }

  const fallback = trimCliNoise(normalized);
  if (fallback.trim()) {
    return {
      ok: true,
      plan: fallback.trim(),
    };
  }

  return {
    ok: false,
    plan: fallback.trim(),
    reason: 'Codex output was empty after CLI noise was removed.',
  };
}

export function formatPlanForDiscord(
  plan: string,
  options: { maxLinesPerSection?: number; mode?: PlanDisplayMode } = {}
): string[] {
  const sections = parsePlanSections(plan);
  const mode = options.mode ?? 'summary';
  const maxLinesPerSection = options.maxLinesPerSection ?? 10;

  if (sections.length === 0) {
    return chunkDiscordText(plan.replace(/^#{1,6}\s+/gm, '**').trim() || '(no plan content)');
  }

  const lines: string[] = [];

  for (const section of sections) {
    if (shouldHideSection(section, mode)) continue;

    const body = mode === 'full'
      ? cleanFullBody(section.body)
      : compactBody(section.body, maxLinesPerSection);

    if (!body) continue;

    lines.push(`**${section.title}**`);
    lines.push(body);
    lines.push('');
  }

  return chunkDiscordText(lines.join('\n').trim());
}

export function validateOrionPlan(plan: string): boolean {
  return hasRequiredSections(normalizePlanHeadings(plan));
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizePlanHeadings(input: string): string {
  const sectionLookup = new Map(orionPlanSections.map((section) => [section.toLowerCase(), section]));

  return input
    .split('\n')
    .map((line) => {
      const trimmed = line.trim().replace(/^#{1,6}\s+/, '');
      const section = sectionLookup.get(trimmed.toLowerCase());
      return section ? `## ${section}` : line;
    })
    .join('\n');
}

function trimCliNoise(input: string): string {
  return input
    .replace(/\n?tokens used\n[\s\S]*$/i, '')
    .replace(/\n?--------\n[\s\S]*$/i, '')
    .replace(/\n?OpenAI Codex v[^\n]*\n[\s\S]*$/i, '')
    .trim();
}

function hasRequiredSections(plan: string): boolean {
  return orionPlanSections.every((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^##\\s+${escaped}\\s*$`, 'im').test(plan);
  });
}

function parsePlanSections(plan: string): PlanSection[] {
  const normalized = normalizePlanHeadings(plan);
  const matches = [...normalized.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections: PlanSection[] = [];

  for (const [index, match] of matches.entries()) {
    const title = match[1]?.trim();
    if (!title) continue;

    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? normalized.length;
    const body = normalized.slice(bodyStart, bodyEnd).trim();
    sections.push({ title, body });
  }

  return sections;
}

function cleanFullBody(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function compactBody(body: string, maxLines: number): string {
  const sourceLines = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.trim() || (index > 0 && all[index - 1]?.trim()))
    .filter((line) => !/^```/.test(line));

  const lines = sourceLines.map((line) => {
    if (/^\s*[-*]\s+/.test(line)) return line;
    if (!line.trim()) return line;
    return line.length > 220 ? `${line.slice(0, 217).trimEnd()}...` : line;
  });

  const kept = lines.slice(0, maxLines);
  return kept.join('\n').trim();
}

function shouldHideSection(section: PlanSection, mode: PlanDisplayMode): boolean {
  const body = section.body
    .replace(/[`*_]/g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!body) return true;
  if (mode === 'full') return false;

  return [
    'not needed',
    'not applicable',
    'no backend work expected',
    'no frontend work expected',
    'stand by',
    'none.',
  ].some((marker) => body === marker || body.startsWith(marker));
}

function chunkDiscordText(input: string, max = 1800): string[] {
  const chunks: string[] = [];
  let remaining = input.trim();

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
  return chunks.length ? chunks : ['(no plan content)'];
}
