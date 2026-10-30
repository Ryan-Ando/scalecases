// Which site this server runs: 'law' (the full Scale Cases site) or one of the barebones
// insurance niches, which only read their own Facebook ad accounts (Ads Tracking + Spend Sheet).
export const NICHES = {
  law:  { label: 'Scale Cases' },
  term: { label: 'Term Life' },
  fex:  { label: 'Final Expense' },
};
export const NICHE = (process.env.NICHE || 'law').toLowerCase();
if (!NICHES[NICHE]) throw new Error(`Unknown NICHE "${NICHE}" (use ${Object.keys(NICHES).join(', ')})`);
export const isLaw = NICHE === 'law';
