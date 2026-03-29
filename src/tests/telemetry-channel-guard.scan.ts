/**
 * Static scan for telemetry channel discipline (see docs/TELEMETRY_CHANNELS.md).
 * Grandfathered legacy paths are listed in telemetry-channel-guard.allowlist.json.
 */

import fs from 'fs';
import path from 'path';

const FLOW_IMPORT = /from\s+['"]@\/lib\/logger\/flow-logger['"]/;
const FLOW_CALL = /\blogConversationFlow\s*\(/;
const TURN_PHASE_COMPLETE = /\bturnPhaseComplete\s*\(/;
/** Only flow-logger should emit the structured `conversation_flow` log line. */
const CONVERSATION_FLOW_EMIT = /\blog\s*\(\s*['"]info['"]\s*,\s*['"]conversation_flow['"]/;

function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function isUnderTurnPhases(relativePosix: string): boolean {
  return relativePosix.split('/').includes('turn-phases');
}

function isMetricsAdjacentPath(relativePosix: string): boolean {
  const parts = relativePosix.split('/').map((p) => p.toLowerCase());
  return parts.some((p) => ['metrics', 'analytics', 'dashboard', 'monitoring'].includes(p));
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTsFiles(full, out);
    else if (
      (ent.name.endsWith('.ts') || ent.name.endsWith('.tsx')) &&
      !ent.name.endsWith('.d.ts')
    )
      out.push(full);
  }
}

export type TelemetryChannelGuardResult = {
  violations: string[];
};

/**
 * Returns human-readable violation lines (empty when OK).
 */
export function runTelemetryChannelGuard(cwd = process.cwd()): TelemetryChannelGuardResult {
  const violations: string[] = [];
  const allowlistPath = path.join(cwd, 'src/tests/telemetry-channel-guard.allowlist.json');
  const raw = JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) as {
    logConversationFlowAllowedPaths: string[];
  };
  const allowed = new Set(raw.logConversationFlowAllowedPaths);

  const srcRoot = path.join(cwd, 'src');
  const files: string[] = [];
  walkTsFiles(srcRoot, files);

  for (const abs of files) {
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    if (rel.includes('telemetry-channel-guard')) continue;

    const content = fs.readFileSync(abs, 'utf8');
    const stripped = stripTsComments(content);

    const usesFlowLogger = FLOW_IMPORT.test(content) || FLOW_CALL.test(content);

    if (usesFlowLogger && !allowed.has(rel)) {
      violations.push(
        `[conversation_flow] ${rel}: flow-logger import or logConversationFlow( not in legacy allowlist. Prefer turn_engine.branch; extend allowlist only after explicit legacy review.`,
      );
    }

    if (usesFlowLogger && isMetricsAdjacentPath(rel)) {
      violations.push(
        `[conversation_flow × metrics] ${rel}: logConversationFlow must not live under a metrics/analytics/dashboard/monitoring path segment.`,
      );
    }

    if (TURN_PHASE_COMPLETE.test(stripped) && !isUnderTurnPhases(rel)) {
      violations.push(
        `[turnPhaseComplete.branchTaken] ${rel}: turnPhaseComplete( only allowed under **/turn-phases/** (internal phase helper).`,
      );
    }

    if (CONVERSATION_FLOW_EMIT.test(stripped) && rel !== 'src/lib/logger/flow-logger.ts') {
      violations.push(
        `[conversation_flow emit] ${rel}: only flow-logger.ts may emit the conversation_flow log event.`,
      );
    }
  }

  return { violations };
}
