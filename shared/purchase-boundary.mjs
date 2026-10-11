// Signed task constraints can only remove authority from a model assessment.
export function purchaseBoundary(task, review) {
  if (!review || !task.origins.includes(review.origin) || review.currency !== 'USD') return false;
  const goal = task.goal.normalize('NFKC');
  if (/[€£]|\b(?:EUR|GBP|CAD|AUD|NZD)\b/i.test(goal)) return false;
  const counts = {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10};
  const quantity = /^(?:please\s+)?(?:buy|purchase|order)\s+(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i.exec(goal);
  if (quantity && (review.items.length !== 1 || review.items[0].quantity !== (counts[quantity[1].toLowerCase()] || Number(quantity[1])))) return false;
  const amounts = [...goal.matchAll(/\b(?:at most|up to|no more than|under|below|less than|budget(?: of)?|maximum(?: of)?)\s*\$\s*(\d+(?:\.\d{2})?)(?![\d.])/gi)];
  // Ambiguous monetary instructions cannot receive automatic purchase authority.
  if ((goal.match(/\$/g) || []).length !== amounts.length) return false;
  for (const match of amounts) {
    const cents = Math.round(Number(match[1]) * 100), exclusive = /^(?:under|below|less than)/i.test(match[0]);
    if (review.total_cents > cents || exclusive && review.total_cents === cents) return false;
  }
  return true;
}
