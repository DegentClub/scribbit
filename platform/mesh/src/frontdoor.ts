// frontdoor/1 - the door a property publishes at /.well-known/frontdoor.json.
//
// `validateFrontdoor` reproduces FlashyLabs' vendored check-frontdoor.mjs rule for
// rule; `emitFrontdoor` mirrors emit-frontdoor.mjs (the door object and its HTML
// partial - the React component is not reproduced; render your own from the JSON).
import { asArray, asString, Collector, type Finding, isRecord } from './common.ts';

export const FRONTDOOR_VERSION = '1';
export const FRONTDOOR_WELL_KNOWN = '/.well-known/frontdoor.json';
export const LANES = ['capital', 'partnership', 'integrate', 'machine', 'general'] as const;
export type LaneId = (typeof LANES)[number];

/**
 * The normative paragraph, verbatim. A door that drops it has quietly become a claim
 * about authority, which is the one failure the contract exists to prevent.
 */
export const NOT_AUTHORITY =
  'A rung buys a reply and a place in a queue. It never buys authority, money, or access. ' +
  'Publishing a file at a domain proves that someone can write to that host — it does not prove ' +
  'an organisation is who it says it is, and this door does not treat it as though it did. ' +
  'Where real authority is needed it is delegated and verified through flashyID, and the chain is checked.';

export interface FrontdoorLane {
  id: LaneId;
  /** Required for every lane but `general`: a lane with no question is a form. */
  question?: string;
  /** A rung number this door publishes. */
  minRung?: number;
}

export interface FrontdoorRung {
  n: number;
  id: string;
  name: string;
  /** What the applicant did. */
  did: string;
  detail?: string;
  /** What it costs an applicant. Missing above rung 0 is a warning. */
  cost?: string;
  /** What the property owes in return. */
  owed: string;
  /** The promise. */
  sla: string;
}

export interface Frontdoor {
  frontdoor: '1';
  property: string;
  org: string;
  lanes: FrontdoorLane[];
  rungs: FrontdoorRung[];
  endpoint: string;
  ladder: string;
  /** YYYY-MM-DD */
  updated: string;
  notAuthority: string;
}

/** The per-repository `frontdoor.config.json` emit-frontdoor.mjs is driven by. */
export interface FrontdoorConfig {
  property: string;
  org: string;
  /** Heading of the rendered partial. */
  voice?: string;
  lanes: FrontdoorLane[];
  rungs: FrontdoorRung[];
  endpoint: string;
  ladder: string;
  updated: string;
  /** Where the door is written; default public/.well-known/frontdoor.json. */
  out?: string;
  htmlOut?: string;
  reactOut?: string;
}

export const isHttpsUrl = (s: unknown): s is string => typeof s === 'string' && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s);

const LANE_SET = new Set<string>(LANES);

/** Every problem in a door. Errors fail it; a missing cost above rung 0 is a warning. */
export function validateFrontdoor(doc: unknown): Finding[] {
  const out = new Collector();
  const err = (code: string, at: string, m: string): void => out.bad(code, at, m);
  const warn = (code: string, at: string, m: string): void => out.warn(code, at, m);
  if (!isRecord(doc)) {
    err('not-an-object', '', 'a door is a JSON object');
    return out.findings;
  }
  const door = doc;

  if (door.frontdoor !== FRONTDOOR_VERSION) err('frontdoor-version', 'frontdoor', `frontdoor must be "${FRONTDOOR_VERSION}", got ${JSON.stringify(door.frontdoor)}`);
  if (!door.property) err('property-missing', 'property', 'a door must name the property it belongs to');
  if (!door.org) err('org-missing', 'org', 'a door must name its organisation slug');
  if (!isHttpsUrl(door.endpoint)) err('endpoint-not-https', 'endpoint', 'endpoint must be an https url');
  if (!isHttpsUrl(door.ladder)) err('ladder-not-https', 'ladder', 'ladder must be an https url a human can read');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asString(door.updated))) err('updated-not-date', 'updated', 'updated must be an ISO date');

  if (door.notAuthority !== NOT_AUTHORITY)
    err('not-authority-drift', 'notAuthority', 'notAuthority must be carried verbatim — a door without it reads as an authorisation');

  const lanes = asArray(door.lanes);
  if (!Array.isArray(door.lanes) || !door.lanes.length) {
    err('lanes-empty', 'lanes', 'a door must open at least one lane');
  } else {
    const seen = new Set<unknown>();
    lanes.forEach((raw, i) => {
      const l = isRecord(raw) ? raw : {};
      const at = `lanes[${i}]`;
      if (!LANE_SET.has(asString(l.id))) err('lane-unknown', at, `unknown lane "${String(l.id)}"`);
      if (seen.has(l.id)) err('lane-duplicate', at, `lane "${String(l.id)}" is opened twice`);
      seen.add(l.id);
      if (l.id !== 'general' && !l.question) err('lane-no-question', at, `lane "${String(l.id)}" asks nothing — a lane with no question is a form`);
    });
  }

  if (!Array.isArray(door.rungs) || !door.rungs.length) {
    err('rungs-empty', 'rungs', 'a door must publish its ladder');
  } else {
    const rungs = door.rungs.map((r) => (isRecord(r) ? r : {}));
    const ns = rungs.map((r) => r.n);
    if (!ns.includes(0)) err('rung-0-missing', 'rungs', 'there is no rung 0 — a ladder with no open door is a wall');
    if (new Set(ns).size !== ns.length) err('rung-duplicate-n', 'rungs', 'two rungs share a number');
    rungs.forEach((r, i) => {
      const at = `rungs[${i}]`;
      if (!r.did || !r.owed || !r.sla) err('rung-incomplete', at, `rung ${String(r.n)} does not state what was done, what is owed, and the promise`);
      if (typeof r.n === 'number' && r.n > 0 && !r.cost) warn('rung-no-cost', at, `rung ${r.n} does not say what it costs an applicant`);
    });
    lanes.forEach((raw, i) => {
      const l = isRecord(raw) ? raw : {};
      if (l.minRung !== undefined && !ns.includes(l.minRung))
        err('lane-min-rung-missing', `lanes[${i}]`, `lane "${String(l.id)}" requires rung ${String(l.minRung)}, which this door does not publish`);
    });
  }

  return out.findings;
}

/** The door object emit-frontdoor.mjs writes, key order included. */
export function emitFrontdoor(cfg: FrontdoorConfig): Frontdoor {
  return {
    frontdoor: '1',
    property: cfg.property,
    org: cfg.org,
    lanes: cfg.lanes,
    rungs: cfg.rungs,
    endpoint: cfg.endpoint,
    ladder: cfg.ladder,
    updated: cfg.updated,
    notAuthority: NOT_AUTHORITY,
  };
}

const esc = (s: unknown): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The framework-free HTML partial of emit-frontdoor.mjs: class names only, no script, no styling opinions. */
export function frontdoorHtml(door: Frontdoor, voice = 'Reach us'): string {
  const lanesHtml = door.lanes
    .map(
      (l) => `      <li class="fd-lane">
        <span class="fd-lane-name">${esc(l.id)}</span>
        ${l.question ? `<span class="fd-lane-q">${esc(l.question)}</span>` : ''}
      </li>`,
    )
    .join('\n');
  return `<!-- Generated by @bsh/mesh from frontdoor.config.json. Do not edit. -->
<section class="fd" aria-labelledby="fd-h">
  <h2 class="fd-h" id="fd-h">${esc(voice)}</h2>
  <ul class="fd-lanes">
${lanesHtml}
  </ul>
  <p class="fd-ladder">
    <a href="${esc(door.ladder)}">What each rung costs, and what it buys &rarr;</a>
  </p>
  <p class="fd-note">${esc(NOT_AUTHORITY)}</p>
  <link rel="frontdoor" href="${FRONTDOOR_WELL_KNOWN}">
</section>
`;
}

/** One line, the way check-frontdoor.mjs prints it. */
export const frontdoorSummary = (doc: unknown, findings: readonly Finding[]): string => {
  const d = isRecord(doc) ? doc : {};
  return `${asString(d.property) || '(unnamed)'} — ${asArray(d.lanes).length} lane(s) · ${asArray(d.rungs).length} rung(s) · ${findings.length} problem(s)`;
};
