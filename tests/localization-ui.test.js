'use strict';

// Deterministic tests for the Name & Place Localization UI in
// public/index.html. The style dropdown is populated by inline JS at page
// load, so these tests parse the source to prove the option table, the
// default selection, the machine-value/label mapping, and the presence of
// the key UI hooks (save/load/reset) — without a browser. They also guard
// against the temporal-dead-zone regression (constants declared AFTER the
// page-load init call that consumes them — the bug that once left the
// Reader Experience selects blank).

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractArray(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'm');
  const m = HTML.match(re);
  if (!m) throw new Error(`${name} array not found in index.html`);
  return m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
}

function extractObject(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\s*\\};`, 'm');
  const m = HTML.match(re);
  if (!m) throw new Error(`${name} object not found in index.html`);
  const out = {};
  const entryRe = /(\w+):\s*'([^']+)'/g;
  let em;
  while ((em = entryRe.exec(m[1])) !== null) out[em[1]] = em[2];
  return out;
}

// ── Option table + default ─────────────────────────────────────────────────

describe('Name & Place Localization UI (source extraction)', () => {
  it('declares the NLO_STYLES option table with the four styles', () => {
    const styles = extractArray('NLO_STYLES');
    expect(styles).toEqual(['original', 'english', 'english_distinctive', 'custom']);
  });

  it('declares NLO_LABELS mapping each machine id to a display label', () => {
    const labels = extractObject('NLO_LABELS');
    expect(labels.original).toBe('Original');
    expect(labels.english).toBe('English');
    expect(labels.english_distinctive).toBe('English — Distinctive');
    expect(labels.custom).toBe('Custom');
  });

  it('declares NLO_DEFAULTS as "original" (preserves existing behaviour)', () => {
    const re = /const\s+NLO_DEFAULTS\s*=\s*\{\s*style:\s*'original'\s*\};/;
    expect(HTML).toMatch(re);
  });

  it('has a #nlo-style <select> populated from NLO_STYLES at page load', () => {
    expect(HTML).toMatch(/<select[^>]*id="nlo-style"/);
    expect(HTML).toMatch(/function _populateLocalizationOptions\(\)/);
    // The page-load init call must exist.
    expect(HTML).toMatch(/_populateLocalizationOptions\(\);/);
  });

  it('declares NLO constants BEFORE the page-load init call (no TDZ)', () => {
    const constantsIdx = HTML.indexOf('const NLO_STYLES');
    const initIdx = HTML.indexOf('_populateLocalizationOptions();');
    expect(constantsIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeGreaterThan(-1);
    expect(constantsIdx).toBeLessThan(initIdx);
  });

  it('has a Name & Place Localization UI section header', () => {
    expect(HTML).toMatch(/Name & Place Localization/);
  });

  it('has Save / Load / Reset UI hooks', () => {
    expect(HTML).toMatch(/function saveLocalizationConfig\(/);
    expect(HTML).toMatch(/function loadLocalizationState\(/);
    expect(HTML).toMatch(/function resetLocalizationUI\(/);
  });

  it('wires loadLocalizationState() into loadStory', () => {
    // loadStory should call loadLocalizationState after loading a story.
    const loadStoryIdx = HTML.indexOf('async function loadStory(');
    expect(loadStoryIdx).toBeGreaterThan(-1);
    const segment = HTML.slice(loadStoryIdx, loadStoryIdx + 4000);
    expect(segment).toMatch(/loadLocalizationState\(\)/);
  });

  it('wires resetLocalizationUI() into resetStory', () => {
    const resetStoryIdx = HTML.indexOf('function resetStory()');
    expect(resetStoryIdx).toBeGreaterThan(-1);
    const segment = HTML.slice(resetStoryIdx, resetStoryIdx + 3000);
    expect(segment).toMatch(/resetLocalizationUI\(\)/);
  });

  it('forwards the selected style from #nlo-style in generateStory', () => {
    const genIdx = HTML.indexOf('async function generateStory()');
    expect(genIdx).toBeGreaterThan(-1);
    const segment = HTML.slice(genIdx, genIdx + 4000);
    expect(segment).toMatch(/nlo-style/);
    expect(segment).toMatch(/body\.localizationStyle/);
  });
});
