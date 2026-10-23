import test from 'node:test';
import assert from 'node:assert/strict';
import { countLiveAdsets } from '../../client/src/liveAdsets.js';

test('counts distinct qualifying adsets independent of budget, excluding off and finished delivery', () => {
  const row = (id, effectiveStatus, extra = {}) => ({ id, effectiveStatus, campaignName: 'LSS TX', ...extra });
  const rows = [row('a', 'ACTIVE'), row('a', 'ACTIVE'), row('b', 'IN_PROCESS'), row('c', 'WITH_ISSUES'),
    ...['INACTIVE', 'DELETED', 'ARCHIVED', 'COMPLETED', 'OFF', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].map(s => row(s, s)),
    row('finished', 'ACTIVE', {endTime: '2026-10-01T00:00:00Z'}), row('whop:synthetic', 'ACTIVE'), row('unknown', ''),
    row('other', 'ACTIVE', {campaignName: 'Halo CA'}), row('no-name', 'ACTIVE', {campaignName: ''})];
  assert.deepEqual(countLiveAdsets(rows, name => name, Date.parse('2026-10-23T12:00:00Z')), {'LSS TX': 3, 'Halo CA': 1});
});
