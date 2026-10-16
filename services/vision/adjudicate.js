/**
 * Model adjudication of assembly conflicts (duplicate labels, disputed
 * continuations). Decisions are stored on the session keyed by conflict id,
 * so re-assembly is stable and each conflict is decided once.
 */
import { ADJUDICATE_PROMPT, adjudicateSchema } from './visionPrompts.js';
import { askValidated, validateAdjudication } from './contract.js';

const BATCH = Number(process.env.VISION_ADJUDICATE_BATCH || 40);

async function adjudicateConflicts(conflicts, model) {
  const decisions = {};
  const usage = { promptTokens: 0, completionTokens: 0 };
  for (let i = 0; i < conflicts.length; i += BATCH) {
    const batch = conflicts.slice(i, i + BATCH);
    const { data, usage: u } = await askValidated({
      messages: [
        { role: 'system', content: ADJUDICATE_PROMPT },
        { role: 'user', content: JSON.stringify({ conflicts: batch }) },
      ],
      schema: adjudicateSchema({
        conflictIds: batch.map((c) => c.id),
        itemIds: [...new Set(batch.flatMap((c) => c.items.map((x) => x.itemId)))],
      }),
      schemaName: 'adjudication',
      validate: (r) => validateAdjudication(r, { conflicts: batch }),
      model,
    });
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
    for (const d of data.decisions) decisions[d.conflictId] = { drop: d.drop, merge: d.merge, reason: d.reason, decidedAt: Date.now() };
  }
  return { decisions, usage };
}

export { adjudicateConflicts };
