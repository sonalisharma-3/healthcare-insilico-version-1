// Patient safety checks. Always on: independent of friction level, run on
// the server for every caller, human or agent.
import { MED_BY_CODE, CROSS_REACTIVE_CLASSES, SYSTEMS } from './catalog.mjs';
import { lifecycleOf } from '../../platform/server/state-machines.mjs';

export const ALERT_SYSTEM = 'urn:hospital-desktop:safety-alert';
export const OVERRIDE_URLS = {
  'duplicate-order': 'urn:hospital-desktop:duplicate-override-reason',
  'allergy-conflict': 'urn:hospital-desktop:allergy-override-reason',
};

const OPEN_STATES = {
  ServiceRequest: ['draft', 'active', 'results-received', 'report-signed'],
  MedicationRequest: ['ordered', 'pending-verification', 'active', 'on-hold'],
};

const codings = (doc) => (doc.resourceType === 'MedicationRequest' ? doc.medicationCodeableConcept?.coding : doc.code?.coding) || [];
const sameCode = (a, b) => a.some((x) => b.some((y) => x.code === y.code && (x.system || '') === (y.system || '')));
const display = (doc) => codings(doc)[0]?.display || doc.medicationCodeableConcept?.text || doc.code?.text || codings(doc)[0]?.code || 'item';

export function overrideReason(doc, alertCode) {
  const value = (doc.extension || []).find((e) => e.url === OVERRIDE_URLS[alertCode])?.valueString;
  return typeof value === 'string' && value.trim().length >= 3 ? value.trim() : null;
}

export const isCritical = (doc) => doc?.resourceType === 'Observation'
  && (doc.interpretation || []).some((i) => (i.coding || []).some((c) => c.code === 'LL' || c.code === 'HH'));

export async function duplicateOrder(tx, doc, branch) {
  if (!doc._patient && !doc.subject?.reference) return null;
  const patient = doc.subject.reference;
  const mine = codings(doc);
  if (!mine.length) return null;
  const existing = (await tx.query(doc.resourceType, { patient }, { branch }))
    .filter((o) => o.id !== doc.id && OPEN_STATES[doc.resourceType].includes(lifecycleOf(o)) && sameCode(mine, codings(o)));
  if (!existing.length) return null;
  const first = existing[existing.length - 1];
  const when = first.authoredOn || first._recordedAt;
  return {
    code: 'duplicate-order',
    message: `Duplicate order: ${display(first)} is already ${lifecycleOf(first)} for this patient (ordered ${when.slice(0, 10)}).`,
    existing: `${first.resourceType}/${first.id}`,
    existingDate: when,
  };
}

const SNOMED_ALLERGEN_CLASSES = {
  '764146007': ['penicillins'], '91936005': ['penicillins'], '294499007': ['penicillins'], '294505008': ['penicillins'],
  '91930004': ['cephalosporins'], '91939003': ['sulfonamides'], '293586001': ['nsaids'], '293585002': ['nsaids', 'salicylates'],
  '293597001': ['opioids'], '294923007': ['ace-inhibitors'],
};
const CLASS_KEYWORDS = [
  ['penicillins', /\b(penicillin|amoxicillin|ampicillin|piperacillin|beta[- ]?lactam)/i],
  ['cephalosporins', /\b(cephalosporin|cephalexin|ceftriaxone|cefazolin|cefepime)/i],
  ['sulfonamides', /\b(sulfa|sulfonamide|sulfamethoxazole|trimethoprim)/i],
  ['nsaids', /\b(nsaid|ibuprofen|naproxen|ketorolac|aspirin|salicylate)/i],
  ['opioids', /\b(opioid|morphine|oxycodone|codeine|hydromorphone|fentanyl)/i],
];

function allergenClasses(allergy) {
  const classes = new Set();
  const ingredients = new Set();
  const texts = [allergy.code?.text].filter(Boolean);
  for (const c of allergy.code?.coding || []) {
    if (c.display) texts.push(c.display);
    if (c.system === SYSTEMS.drugClass) classes.add(c.code);
    if (c.system === SYSTEMS.rxnorm) {
      ingredients.add(c.code);
      for (const cls of MED_BY_CODE.get(c.code)?.classes || []) if (CROSS_REACTIVE_CLASSES.includes(cls)) classes.add(cls);
    }
    if (c.system === SYSTEMS.snomed && SNOMED_ALLERGEN_CLASSES[c.code]) {
      for (const cls of SNOMED_ALLERGEN_CLASSES[c.code]) classes.add(cls);
    }
  }
  const joined = texts.join(' ');
  if (joined) {
    for (const [cls, rx] of CLASS_KEYWORDS) if (rx.test(joined)) classes.add(cls);
    for (const [code, med] of MED_BY_CODE.entries()) {
      if (med.name && new RegExp(`\\b${med.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(joined)) {
        ingredients.add(code);
        for (const cls of med.classes || []) if (CROSS_REACTIVE_CLASSES.includes(cls)) classes.add(cls);
      }
    }
  }
  return { classes, ingredients };
}

export async function allergyConflict(tx, doc, branch) {
  const patient = doc.subject?.reference;
  const rx = (doc.medicationCodeableConcept?.coding || []).filter((c) => c.system === SYSTEMS.rxnorm);
  if (!patient || !rx.length) return null;
  const medClasses = new Set(rx.flatMap((c) => MED_BY_CODE.get(c.code)?.classes || []));
  const allergies = (await tx.query('AllergyIntolerance', { patient }, { branch }))
    .filter((a) => (a.clinicalStatus?.coding?.[0]?.code ?? 'active') === 'active' && a.verificationStatus?.coding?.[0]?.code !== 'entered-in-error');
  for (const allergy of allergies) {
    const { classes, ingredients } = allergenClasses(allergy);
    const direct = rx.some((c) => ingredients.has(c.code));
    const viaClass = [...classes].find((cls) => medClasses.has(cls));
    if (direct || viaClass) {
      const allergen = allergy.code?.coding?.[0]?.display || allergy.code?.text || 'documented allergen';
      const reaction = allergy.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display;
      return {
        code: 'allergy-conflict',
        message: `Allergy conflict: patient has a documented ${allergy.criticality === 'high' ? 'high-criticality ' : ''}allergy to ${allergen}`
          + `${reaction ? ` (reaction: ${reaction})` : ''}. ${display(doc)} ${direct ? 'is the same substance' : `is in the same class (${viaClass})`}.`,
        existing: `AllergyIntolerance/${allergy.id}`,
        existingDate: allergy.recordedDate || allergy._recordedAt,
        criticality: allergy.criticality || null,
      };
    }
  }
  return null;
}

/**
 * Runs the checks that apply to a new order. Returns
 * { blocking: [alert], overridden: [alert + reason] }.
 */
export async function checkNewOrder(tx, doc, branch) {
  const found = [];
  if (doc.resourceType === 'ServiceRequest' || doc.resourceType === 'MedicationRequest') {
    const dup = await duplicateOrder(tx, doc, branch);
    if (dup) found.push(dup);
  }
  if (doc.resourceType === 'MedicationRequest') {
    const conflict = await allergyConflict(tx, doc, branch);
    if (conflict) found.push(conflict);
  }
  const blocking = [];
  const overridden = [];
  for (const alert of found) {
    const reason = overrideReason(doc, alert.code);
    if (reason) overridden.push({ ...alert, reason });
    else blocking.push(alert);
  }
  return { blocking, overridden };
}

export function alertIssues(alerts) {
  return alerts.map((a) => ({
    severity: 'error',
    code: 'business-rule',
    details: { coding: [{ system: ALERT_SYSTEM, code: a.code }], text: a.message },
    diagnostics: a.message,
    extension: [
      { url: 'existing', valueReference: { reference: a.existing } },
      { url: 'existingDate', valueDateTime: a.existingDate },
      { url: 'overrideExtension', valueUri: OVERRIDE_URLS[a.code] },
    ],
  }));
}
