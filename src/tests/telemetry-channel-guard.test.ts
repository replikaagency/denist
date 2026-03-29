import { describe, expect, it } from 'vitest';
import { runTelemetryChannelGuard } from './telemetry-channel-guard.scan';

describe('telemetry channel guard', () => {
  it('passes for current codebase (legacy allowlisted; turnPhaseComplete only in turn-phases)', () => {
    const { violations } = runTelemetryChannelGuard();
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
