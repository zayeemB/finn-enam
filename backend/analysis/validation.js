import { resultSchema } from './schema.js';
import { inputHash } from '../sources.js';

export const normalise = text => String(text).normalize('NFKC').replace(/\s+/g, ' ').trim();
export function metadataText(disclosure) {
  const values = value => value && typeof value === 'object' ? Object.values(value).flatMap(values) : [String(value ?? '')];
  return [disclosure.title, ...values(disclosure.raw_metadata)].join('\n');
}
export const citationKey = citation => inputHash([citation.block_id, citation.modality, normalise(citation.quote)]);
export const observationKey = o => inputHash([o.metric,o.value,o.unit,o.period_start,o.period_end,o.frequency,o.scope]);
export function validateResult(value, { blocks, disclosure, coveredIds, priorEvents = [], allowedCitations, allowedObservations }) {
  const result = resultSchema.parse(value);
  const actual = [...result.covered_block_ids].sort();
  const expected = [...coveredIds].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Model page coverage does not match the supplied input');
  const blockMap = new Map(blocks.map(b => [b.id, b]));
  const knownEvents = new Map(priorEvents.map(e => [e.id, e]));
  for (const development of result.developments) {
    if (development.matched_event_id && (!knownEvents.has(development.matched_event_id) || knownEvents.get(development.matched_event_id).category !== development.category)) throw new Error('Invalid prior-event match');
    if (development.matched_event_id && development.category==='results') {
      const earlier=knownEvents.get(development.matched_event_id).details?.observations || [];
      const previousPeriod=earlier.filter(o=>o.frequency==='quarterly').map(o=>o.period_end).sort().at(-1);
      const incoming=development.observations.filter(o=>o.frequency==='quarterly');
      const incomingPeriod=incoming.map(o=>o.period_end).sort().at(-1);
      if (previousPeriod && incomingPeriod && previousPeriod!==incomingPeriod) throw new Error('Cannot merge results for different reporting periods');
    }
    if ((development.relationship === 'new') !== (development.matched_event_id === null)) throw new Error('Event relationship and match disagree');
    if (['update','correction'].includes(development.relationship) && !development.change_reason?.trim()) throw new Error('Updates/corrections need an explicit change reason');
    for (const citation of development.evidence) {
      if (allowedCitations && !allowedCitations.has(citationKey(citation))) throw new Error('Synthesis invented evidence not present in validated findings');
      if (citation.modality === 'metadata') {
        if (citation.block_id !== null || !normalise(metadataText(disclosure)).includes(normalise(citation.quote))) throw new Error('Unverifiable metadata citation');
      } else {
        const block = blockMap.get(citation.block_id);
        if (!block || !coveredIds.includes(block.id)) throw new Error('Citation references a page outside the model input');
        if (citation.modality === 'text' && !normalise(block.content.text || '').includes(normalise(citation.quote))) throw new Error('Text citation is not present in its source page');
        if (citation.modality === 'visual' && !block.temporary_image_path) throw new Error('Visual citation has no page image');
      }
    }
    const refs = indexes => {
      if (indexes.some(i => i >= development.evidence.length)) throw new Error('Evidence index is outside the development');
      return indexes.map(i => development.evidence[i]);
    };
    for (const fact of development.key_facts) refs(fact.evidence_indexes);
    if (development.management_change) refs(development.management_change.evidence_indexes);
    for (const observation of development.observations) {
      observation.scope=observation.scope.trim().toLowerCase();
      observation.unit=observation.unit.trim();
      const citations = refs(observation.evidence_indexes);
      for (const value of [observation.period_start, observation.period_end]) {
        if (!Number.isFinite(+new Date(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Invalid observation date');
      }
      if (observation.period_start > observation.period_end) throw new Error('Observation periods are reversed');
      // Visual transcriptions need model judgement; text-only numbers must occur in their evidence.
      if (!citations.some(c => c.modality === 'visual')) {
        const numbers = citations.flatMap(c => [...c.quote.matchAll(/\(?-?\d[\d,]*(?:\.\d+)?\)?/g)]
          .map(m => Number(m[0].replaceAll(',', '').replace(/^\((.*)\)$/, '-$1'))));
        if (!numbers.some(n => Math.abs(n - observation.value) < 1e-8)) throw new Error('Observation value is not present in its cited evidence');
      }
      if (allowedObservations && !allowedObservations.has(observationKey(observation))) throw new Error('Synthesis invented a new observation');
    }
  }
  return result;
}
