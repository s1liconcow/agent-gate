// Shared by the browser runtime and its conformance probe. Labels and domain
// identifiers are never classifier inputs.
export function purposeInput(row) {
  const bounds = {goal: 1000, need: 500, context: 450, text: 450};
  const values = {};
  for (const [key, limit] of Object.entries(bounds)) {
    if (typeof row?.[key] !== 'string' || !row[key].trim() || row[key].length > limit) throw new Error('Invalid complete purpose input.');
    values[key] = row[key].normalize('NFKC').toLowerCase();
  }
  return ['User purpose: ' + values.goal + '\nRequested evidence: ' + values.need,
    'Observed source context: ' + values.context + '\nCandidate text: ' + values.text];
}

export function purposeProbability(logits, temperature) {
  if (logits.length !== 2 || !Array.from(logits).every(Number.isFinite) || !Number.isFinite(temperature) || temperature < .25 || temperature > 4) throw new Error('Invalid purpose logits.');
  return 1 / (1 + Math.exp((logits[0] - logits[1]) / temperature));
}
