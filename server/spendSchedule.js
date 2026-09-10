// Spend exports use the same Eastern calendar as the sheet.
export function easternDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

export function monthWindow(year, monthIndex, today = easternDate()) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new Error('Invalid spend year/month');
  }
  const start = `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
  const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10);
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const end = [monthEnd, yesterday.toISOString().slice(0, 10)].sort()[0];
  return end < start ? null : { start, end };
}

export function createSpendSchedule({ push, load = () => ({}), save = () => {}, now = () => new Date(), enabled = () => true, log = console }) {
  const state = { lastSuccessDate: null, lastSuccessAt: null, lastError: null, nextRetryAt: 0, ...load(), running: false };
  async function tick() {
    if (!enabled() || state.running) return;
    const current = now();
    const today = easternDate(current);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(current);
    if (time < '06:15' || state.lastSuccessDate === today || current.getTime() < state.nextRetryAt) return;
    state.running = true;
    try {
      // On the first, finalize the previous month (including yesterday).
      const target = new Date(`${today}T12:00:00Z`);
      if (target.getUTCDate() === 1) target.setUTCDate(0);
      const result = await push({ year: target.getUTCFullYear(), monthIndex: target.getUTCMonth() });
      if (!result.updated) throw new Error('Spend export updated no cells');
      state.lastSuccessDate = today;
      state.lastSuccessAt = now().toISOString();
      state.lastError = null;
      state.nextRetryAt = 0;
      log.log(`[spend-push] daily OK: ${result.tab}, ${result.updated} cells`);
    } catch (error) {
      state.lastError = error.message;
      state.nextRetryAt = now().getTime() + 65 * 60_000;
      log.error('[spend-push] daily failed; retry in 65 minutes:', error.message);
    } finally {
      state.running = false;
      try { save(state); } catch (error) { log.error('[spend-push] checkpoint save failed:', error.message); }
    }
  }
  return { tick, status: () => ({ ...state, enabled: enabled(), timeZone: 'America/New_York', scheduledTime: '06:15' }) };
}
