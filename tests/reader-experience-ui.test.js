'use strict';

// Deterministic tests for the Reader Experience UI in public/index.html.
//
// The dropdowns are populated by inline JS at page load, so these tests parse
// the source to prove the option tables, the default selection, and the
// machine-value/label mapping are correct — without an LLM or a browser.
// They also guard against the regression that originally caused the bug:
// the option-table constants being declared AFTER the page-load init call
// that consumed them (a `const`/`let` temporal-dead-zone reference that
// silently left all four selects blank).

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract a top-level function body by name, balancing braces so nested
// blocks (arrow functions, try/catch) don't terminate the match early.
function extractFunction(name) {
  const startRe = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const startMatch = HTML.match(startRe);
  if (!startMatch) return null;
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  while (depth > 0 && i < HTML.length) {
    const ch = HTML[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return HTML.slice(startMatch.index, i);
}

function extractArray(name) {
  // Matches: const NAME = [ 'a', 'b', ... ];
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

const EXPECTED_CATEGORIES = [
  'curiosity', 'suspense', 'tension', 'mystery', 'emotional_investment',
  'wonder', 'humor', 'excitement', 'romance', 'triumph',
];
const EXPECTED_INTENSITY = ['low', 'moderate', 'high'];
const EXPECTED_PACING = ['slow', 'moderate', 'fast'];
const EXPECTED_LABELS = {
  curiosity: 'Curiosity',
  suspense: 'Suspense',
  tension: 'Tension',
  mystery: 'Mystery',
  emotional_investment: 'Emotional Investment',
  wonder: 'Wonder',
  humor: 'Humor',
  excitement: 'Excitement',
  romance: 'Romance',
  triumph: 'Triumph',
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  slow: 'Slow',
  fast: 'Fast',
};

describe('Reader Experience UI (public/index.html)', () => {
  describe('option tables', () => {
    it('Primary/Secondary dropdowns contain all 10 expected categories', () => {
      const cats = extractArray('REX_CATEGORIES');
      expect(cats).toEqual(EXPECTED_CATEGORIES);
    });

    it('Emotional Intensity dropdown contains low/moderate/high', () => {
      expect(extractArray('REX_INTENSITY')).toEqual(EXPECTED_INTENSITY);
    });

    it('Pacing dropdown contains slow/moderate/fast', () => {
      expect(extractArray('REX_PACING')).toEqual(EXPECTED_PACING);
    });

    it('provides a machine-id → display-label map covering every option', () => {
      const labels = extractObject('REX_LABELS');
      for (const id of [...EXPECTED_CATEGORIES, ...EXPECTED_INTENSITY, ...EXPECTED_PACING]) {
        expect(labels[id]).toBe(EXPECTED_LABELS[id]);
      }
    });
  });

  describe('defaults', () => {
    it('declares the spec defaults (curiosity / suspense / moderate / moderate)', () => {
      const m = HTML.match(/const\s+REX_DEFAULTS\s*=\s*\{[^}]*\}/);
      expect(m).not.toBeNull();
      const defaults = m[0];
      expect(defaults).toContain("primary: 'curiosity'");
      expect(defaults).toContain("secondary: 'suspense'");
      expect(defaults).toContain("intensity: 'moderate'");
      expect(defaults).toContain("pacing: 'moderate'");
    });

    it('applies the defaults inside _populateReaderExperienceOptions', () => {
      const fn = extractFunction('_populateReaderExperienceOptions');
      expect(fn).not.toBeNull();
      expect(fn).toContain('_applyReaderExperienceSelection(REX_DEFAULTS)');
    });
  });

  describe('option value vs label mapping', () => {
    it('builds options with value=machine id and text=display label', () => {
      const fn = extractFunction('_populateReaderExperienceOptions');
      // The fill() helper must emit <option value="<id>"><label></option>.
      expect(fn).toMatch(/`<option value="\$\{o\}">\$\{escapeHtml\(REX_LABELS\[o\] \|\| o\)\}<\/option>`/);
    });
  });

  describe('temporal-dead-zone regression guard', () => {
    it('declares the REX constants BEFORE the page-load init call that uses them', () => {
      const declIdx = HTML.indexOf('const REX_CATEGORIES');
      const initIdx = HTML.indexOf('_populateReaderExperienceOptions();');
      expect(declIdx).toBeGreaterThan(-1);
      expect(initIdx).toBeGreaterThan(-1);
      expect(declIdx).toBeLessThan(initIdx);
    });

    it('does NOT re-declare REX_CATEGORIES (no duplicate const later on)', () => {
      const first = HTML.indexOf('const REX_CATEGORIES');
      const second = HTML.indexOf('const REX_CATEGORIES', first + 1);
      expect(second).toBe(-1);
    });
  });

  describe('save path sends machine values', () => {
    it('saveReaderExperienceConfig reads the select .value (machine id)', () => {
      const fn = extractFunction('saveReaderExperienceConfig');
      expect(fn).toContain("document.getElementById('rex-primary').value");
      expect(fn).toContain("document.getElementById('rex-secondary').value");
      expect(fn).toContain("document.getElementById('rex-intensity').value");
      expect(fn).toContain("document.getElementById('rex-pacing').value");
    });
  });
});
