export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas',
  CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
};

// Extract valid state code from a filename
// Scans from the END since state code is always near the end (e.g. "LSS-Campaign-TX-img.jpg")
export function extractStateFromFilename(filename) {
  const parts = filename.replace(/\.[^.]+$/, '').split(/[-_\s]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (STATE_NAMES[parts[i].toUpperCase()]) return parts[i].toUpperCase();
  }
  return null;
}

// Extract state code from a campaign name (handles full names and codes)
export function extractStateFromCampaign(name) {
  if (!name) return null;

  // Pass 1: ALL-CAPS 2-letter state codes at word boundaries (e.g. "- TX -", "| FL |")
  // Requiring all-caps rules out common lowercase words: "in", "or", "me", "hi", "ok"
  const upperMatches = name.match(/\b([A-Z]{2})\b/g) || [];
  for (const m of upperMatches) {
    if (STATE_NAMES[m]) return m;
  }

  // Pass 2: full state name (case-insensitive) — handles "Texas", "Alabama", etc.
  const normalized = name.toLowerCase().replace(/[\s_\-]+/g, '');
  for (const [code, fullName] of Object.entries(STATE_NAMES)) {
    if (normalized.includes(fullName.toLowerCase().replace(/\s+/g, ''))) return code;
  }

  // Pass 3: any 2-letter word-boundary match regardless of case (last resort)
  const anyMatches = name.match(/\b([a-zA-Z]{2})\b/g) || [];
  for (const m of anyMatches) {
    const code = m.toUpperCase();
    if (STATE_NAMES[code]) return code;
  }

  return null;
}
