// Request only months with an explicit budget, clipped to the pacing dates.
export function pacingWindows(cfg, today) {
  if (!cfg || cfg.enabled === false || !cfg.startDate || !cfg.endDate || cfg.startDate > cfg.endDate) return [];
  return Object.entries(cfg.monthlyBudgets || {}).filter(([ym, amount]) =>
    /^\d{4}-(0[1-9]|1[0-2])$/.test(ym) && amount != null && String(amount).trim() !== '' && Number.isFinite(Number(amount))
  ).sort(([a], [b]) => a.localeCompare(b)).flatMap(([ym]) => {
    const [year, month] = ym.split('-').map(Number);
    const first = `${ym}-01`;
    const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const since = [first, cfg.startDate].sort().at(-1);
    const until = [last, cfg.endDate, today].sort()[0];
    return since <= until ? [{ since, until }] : [];
  });
}
