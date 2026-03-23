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
// Looks for -XX- patterns between dashes where XX is a valid state code
export function extractStateFromFilename(filename) {
  const parts = filename.replace(/\.[^.]+$/, '').split('-');
  for (const part of parts) {
    if (STATE_NAMES[part.toUpperCase()]) return part.toUpperCase();
  }
  return null;
}

// Extract state code from a campaign name (handles full names and codes)
export function extractStateFromCampaign(name) {
  // Check each word/segment for state codes first
  const segments = name.split(/[\s_\-\/]+/);
  for (const seg of segments) {
    const upper = seg.toUpperCase();
    if (STATE_NAMES[upper]) return upper;
  }
  // Then check for full state names (case insensitive, ignoring spaces/underscores)
  const normalized = name.toLowerCase().replace(/[\s_\-]+/g, '');
  for (const [code, fullName] of Object.entries(STATE_NAMES)) {
    const normalizedName = fullName.toLowerCase().replace(/\s+/g, '');
    if (normalized.includes(normalizedName)) return code;
  }
  return null;
}
