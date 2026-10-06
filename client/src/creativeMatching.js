const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));

export function creativeKey(value) {
  // Strip only known file extensions/state customizations; keep numbers and creative variants.
  let name = String(value || '').normalize('NFKC').trim().replace(/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i, '');
  name = name.replace(/\bLSS[ _-]*([A-Za-z]{2})\b/gi, (all, state) => STATES.has(state.toUpperCase()) ? '' : all);
  name = name.replace(/\b([A-Za-z]{2})[ _-]+LSS\b/gi, (all, state) => STATES.has(state.toUpperCase()) ? '' : all);
  return name.split(/[-–—]+/).map(s => s.trim()).filter(s => s && !STATES.has(s.toUpperCase())).join('-').replace(/\s+/g, ' ').toLowerCase();
}

export function groupLibrary(files, facebookAds, merges = [], deleted = []) {
  const parents = new Map(), labels = new Map();
  function find(key) {
    if (!parents.has(key)) parents.set(key, key);
    if (parents.get(key) !== key) parents.set(key, find(parents.get(key)));
    return parents.get(key);
  }
  for (const group of merges) {
    const target = find(creativeKey(group.canonical));
    labels.set(target, group.canonical);
    for (const name of group.members || []) parents.set(find(creativeKey(name)), target);
  }
  const known = new Set(facebookAds.map(a => find(creativeKey(a.name))).filter(Boolean));
  const hidden = new Set([...deleted].map(name => find(creativeKey(name))));
  const groups = new Map();
  for (const file of files) {
    const key = find(creativeKey(file.name));
    if (!key || hidden.has(key)) continue;
    if (!groups.has(key)) groups.set(key, { key, name: labels.get(key) || file.name, files: [], known: known.has(key), date: file.date });
    const group = groups.get(key); group.files.push(file);
    // A later state export does not make an old creative new again.
    if (file.date && (!group.date || file.date < group.date)) group.date = file.date;
  }
  for (const group of groups.values()) {
    group.files.sort((a, b) => Number(!!a.state) - Number(!!b.state) || a.relativePath.localeCompare(b.relativePath));
    if (!labels.has(group.key)) group.name = group.files[0].name;
  }
  return [...groups.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
}

export function eligibleCampaigns(campaigns, brand, state) {
  return campaigns.filter(c => c.brand === brand && c.state === state && c.results > 0 && c.spend > 0 && c.spend / c.results < 300);
}

export function prependUntested(proven, localGroups, campaigns, brand, state, complete) {
  if (!complete) return proven;
  const targets = eligibleCampaigns(campaigns, brand, state);
  if (!targets.length) return proven;
  const used = new Set(proven.map(c => creativeKey(c.name)));
  const fresh = localGroups.filter(g => !g.known && !used.has(creativeKey(g.name))).map(g => ({
    name: g.name, tier: 0, library: g, targets, score: 0, hereLeads: 0, totalLeads: 0,
    hereCpl: null, totalCpl: null, cases: 0, usedHere: false, provenIn: [], activeNow: [],
  }));
  return [...fresh, ...proven];
}
