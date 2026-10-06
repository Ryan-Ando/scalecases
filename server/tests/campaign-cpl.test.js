import test from 'node:test';
import assert from 'node:assert/strict';
import { reportWindow, campaignTotals, formatCampaignReport, createCampaignSchedule } from '../campaignCplReport.js';

test('five Pacific calendar days include today across year and DST boundaries', () => {
  assert.deepEqual(reportWindow(new Date('2027-01-02T02:00:00Z')), { start: '2026-12-28', end: '2027-01-01' });
  assert.deepEqual(reportWindow(new Date('2026-03-09T13:30:00Z')), { start: '2026-03-05', end: '2026-03-09' });
});

test('campaign CPL uses weighted totals, includes paused adsets, and sorts zero-lead spend first', () => {
  const rows = [
    { adset_id: 'a', campaign_id: '1', campaign_name: 'Campaign A', spend: 100, results: 1 },
    { adset_id: 'b', campaign_id: '1', campaign_name: 'Campaign A', spend: 900, results: 9, status: 'PAUSED' },
    { adset_id: 'c', campaign_id: '2', campaign_name: 'Campaign B', spend: 500, results: 2 },
    { adset_id: 'd', campaign_id: '3', campaign_name: 'No leads', spend: 60, results: 0 },
  ];
  const totals = campaignTotals(rows, { windowByAdset: { a: 2, b: 3, e: 5, missing: 1 } }, [{id: 'e', campaignId: '1', campaignName: 'Campaign A'}]);
  assert.deepEqual(totals.campaigns.map(c => c.name), ['No leads', 'Campaign B', 'Campaign A']);
  assert.equal(totals.campaigns[2].spend / totals.campaigns[2].fbLeads, 100);
  assert.equal(totals.campaigns[2].hyLeads, 10);
  assert.equal(totals.unmatched, 1);
  const text = formatCampaignReport(totals, {start: '2026-10-02', end: '2026-10-06'});
  assert.match(text, /today so far/);
  assert.match(text, /FB CPL \$100.00 \| Hyros CPL \$100.00/);
  assert.match(text, /N\/A \(0 leads\)/);
});

test('same-named campaigns stay separate and Hyros sort is supported', () => {
  const rows = [
    {adset_id: 'a', campaign_id: '1', campaign_name: 'TX', spend: 500, results: 5},
    {adset_id: 'b', campaign_id: '2', campaign_name: 'TX', spend: 100, results: 1},
  ];
  const totals = campaignTotals(rows, {windowByAdset: {a: 10, b: 1}}, [], 'hyros');
  assert.deepEqual(totals.campaigns.map(c => c.id), ['2', '1']);
});

test('06:30 Pacific schedule persists successful delivery across restart, summer and winter', async () => {
  for (const hour of ['13', '14']) {
    const day = hour === '13' ? '2026-10-07' : '2027-01-07';
    let current = new Date(`${day}T${hour}:29:00Z`), calls = 0, saved = {};
    const options = { now: () => current, run: async () => { calls++; }, save: state => { saved = {...state}; }, load: () => saved };
    const schedule = createCampaignSchedule(options);
    await schedule.tick(); assert.equal(calls, 0);
    current = new Date(`${day}T${hour}:30:00Z`);
    await Promise.all([schedule.tick(), schedule.tick()]); assert.equal(calls, 1);
    await createCampaignSchedule(options).tick(); assert.equal(calls, 1);
  }
});

test('failed data/delivery retries after cooldown and sends one delay notice per day', async () => {
  let current = new Date('2026-10-07T13:30:00Z'), calls = 0, notices = 0;
  const schedule = createCampaignSchedule({ now: () => current, run: async () => {calls++; throw Error('cooldown');}, notifyFailure: async () => {notices++;}, log: {error() {}} });
  await schedule.tick(); await schedule.tick();
  assert.equal(calls, 1); assert.equal(notices, 1);
  assert.equal(schedule.status().lastSuccessDate, null);
  current = new Date('2026-10-07T14:35:00Z');
  await schedule.tick(); assert.equal(calls, 2); assert.equal(notices, 1);
});
