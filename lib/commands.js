/**
 * Command discovery helpers.
 *
 * `artcraft_commands` returns either a compact list ({id,label}) or full
 * parameter documentation. Local scoring makes the best match survive the
 * limit instead of relying on registry order.
 */

'use strict';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_IDS = 8;

function limitValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
}

function termsOf(filter) {
  return String(filter || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Higher is better; 0 means the term was not found. */
function scoreTerm(command, term) {
  const id = String(command.id || '').toLowerCase();
  const label = String(command.label || '').toLowerCase();
  const description = String(command.description || '').toLowerCase();

  if (id === term) return 1000;
  if (id.startsWith(term)) return 900;
  if (id.includes(term)) return 800;
  if (label.startsWith(term)) return 700;
  if (label.includes(term)) return 600;
  if (description.includes(term)) return 500;
  return 0;
}

/**
 * Filter and rank commands. With no filter, registry order is preserved.
 * With a multi-word filter, every term must match somewhere.
 */
function filterCommands(commands, filter) {
  const terms = termsOf(filter);
  if (!terms.length) {
    return commands.map((command, index) => ({ command, score: 0, index }));
  }

  const hits = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    let score = 0;
    let matched = true;
    for (const term of terms) {
      const termScore = scoreTerm(command, term);
      if (!termScore) { matched = false; break; }
      score += termScore;
    }
    if (matched) hits.push({ command, score, index });
  }

  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return hits;
}

/** Project a command into the compact list or full describe shape. */
function projectCommand(command, detail = 'list') {
  if (detail === 'full') {
    return {
      id: command.id,
      label: command.label ?? null,
      params: command.params ?? null,
      enabled: command.enabled ?? null,
      disabled_reason: command.disabled_reason ?? null,
      ...(command.description ? { description: command.description } : {}),
    };
  }
  return { id: command.id, label: command.label ?? null };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_IDS,
  limitValue,
  termsOf,
  scoreTerm,
  filterCommands,
  projectCommand,
};
