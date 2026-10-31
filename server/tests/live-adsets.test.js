import test from 'node:test';
import assert from 'node:assert/strict';
import { countLiveAdsets, countLiveAdsetsByType } from '../../client/src/liveAdsets.js';
import { enabledAdsetIds } from '../adDelivery.js';

test('all-off and empty adsets are excluded; one enabled child qualifies only its parent', () => {
  const enabled = enabledAdsetIds([
    {adset_id: 'off', status: 'PAUSED', effective_status: 'PAUSED'},
    {adset_id: 'mixed', status: 'PAUSED', effective_status: 'PAUSED'},
    {adset_id: 'mixed', status: 'ACTIVE', effective_status: 'ACTIVE'},
    {adset_id: 'parent-off', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED'},
  ]);
  assert.deepEqual([...enabled], ['mixed']);
  const rows = ['off', 'mixed', 'empty', 'parent-off'].map(id => ({id, effectiveStatus: 'ACTIVE', campaignName: 'LSS TX', hasEnabledAds: enabled.has(id)}));
  rows.push({id: 'missing-evidence', effectiveStatus: 'ACTIVE', campaignName: 'LSS TX'});
  assert.deepEqual(countLiveAdsets(rows, name => name), {'LSS TX': 1});
});

test('counts distinct qualifying adsets independent of budget, excluding off and finished delivery', () => {
  const row = (id, effectiveStatus, extra = {}) => ({ id, effectiveStatus, hasEnabledAds: true, campaignName: 'LSS TX', ...extra });
  const rows = [row('a', 'ACTIVE'), row('a', 'ACTIVE'), row('b', 'IN_PROCESS'), row('c', 'WITH_ISSUES'),
    ...['INACTIVE', 'DELETED', 'ARCHIVED', 'COMPLETED', 'OFF', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'].map(s => row(s, s)),
    row('finished', 'ACTIVE', {endTime: '2026-10-01T00:00:00Z'}), row('whop:synthetic', 'ACTIVE'), row('unknown', ''),
    row('other', 'ACTIVE', {campaignName: 'Halo CA'}), row('no-name', 'ACTIVE', {campaignName: ''})];
  assert.deepEqual(countLiveAdsets(rows, name => name, Date.parse('2026-10-23T12:00:00Z')), {'LSS TX': 3, 'Halo CA': 1});
});

test('splits live adsets between CBO and normal campaigns', () => {
  const row = (id, extra = {}) => ({ id, effectiveStatus: 'ACTIVE', hasEnabledAds: true, campaignName: 'LSS TX', ...extra });
  const rows = [row('a', {campaignDailyBudget: '50000'}), row('b', {campaignDailyBudget: '50000'}), row('c', {campaignLifetimeBudget: '900000'}),
    row('d', {dailyBudget: '10000'}), row('e', {dailyBudget: '10000', campaignDailyBudget: '0'}), row('f', {campaignName: 'Halo CA', dailyBudget: '5000'})];
  assert.deepEqual(countLiveAdsetsByType(rows, name => name), {'LSS TX': {cbo: 3, normal: 2}, 'Halo CA': {cbo: 0, normal: 1}});
});
