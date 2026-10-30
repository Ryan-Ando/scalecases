// Which site this build is: 'law' (full Scale Cases) or a barebones insurance niche
// (VITE_NICHE=term | fex) that only has Ads Tracking and Spend Sheet for its own ad accounts.
const LABELS = { law: 'Scale Cases', term: 'Term Life', fex: 'Final Expense' };
export const NICHE = (import.meta.env.VITE_NICHE || 'law').toLowerCase();
export const isLaw = NICHE === 'law';
export const NICHE_LABEL = LABELS[NICHE] || NICHE;
