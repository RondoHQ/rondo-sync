'use strict';

/**
 * Interpret a missing relation end in the context of its Sportlink season.
 * Explicit end dates always remain authoritative.
 */
function closedSeasonEnd(row, today) {
  if (String(row.RelationEnd || '').trim()) return null;
  const match = String(row.SeasonDescription || '').trim()
    .match(/^(?:seizoen\s+)?(\d{4})\s*[/–-]\s*['’]?(\d{2}|\d{4})$/i);
  if (!match) return null;

  const startYear = Number(match[1]);
  const endYear = match[2].length === 2
    ? Math.floor(startYear / 100) * 100 + Number(match[2]) + (Number(match[2]) < startYear % 100 ? 100 : 0)
    : Number(match[2]);
  if (endYear !== startYear + 1) return null;

  const end = `${endYear}-06-30`;
  if (end >= today) return null;
  // Do not guess when the supplied dates contradict the season.
  const start = String(row.RelationStart || '').trim();
  if (start && (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start > end)) return null;
  return end;
}

function stintKey(row) {
  const team = String(row.PublicTeamId || row.TeamName || '').trim().toLowerCase();
  if (!team) return null;
  const role = String(row.RoleFunctionDescription || row.FunctionDescription || row.RoleDescription || 'Teamspeler').trim().toLowerCase();
  return JSON.stringify([team, role, String(row.RelationStart || '').trim()]);
}

/**
 * Sportlink repeats continuing stints in multiple seasons. Prefer a real end
 * date or an open current-season copy over an inferred old-season end; otherwise
 * retain the most recent seasonal copy. Input records are never mutated.
 */
function normalizeTeamMembershipSeasons(rows, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(now);
  const candidates = rows.map(row => ({ row, key: stintKey(row), end: closedSeasonEnd(row, today) }));
  const authoritative = new Set(candidates.filter(item => !item.end && item.key).map(item => item.key));
  const latest = new Map();
  for (const item of candidates) {
    if (item.end && item.key && (!latest.has(item.key) || latest.get(item.key) < item.end)) latest.set(item.key, item.end);
  }
  const seen = new Set();
  return candidates.flatMap(({ row, key, end }) => {
    if (!end) return [row];
    if (key && (authoritative.has(key) || latest.get(key) !== end || seen.has(key))) return [];
    if (key) seen.add(key);
    return [{ ...row, RelationEnd: end }];
  });
}

module.exports = { normalizeTeamMembershipSeasons };
