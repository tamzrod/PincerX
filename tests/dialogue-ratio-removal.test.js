'use strict';

// Source-extraction test proving the Dialogue Ratio UI control has been
// removed from public/index.html. The slider, its label, its value span, and
// every request-payload read of #chapter-dialog-ratio must be gone. Chapter
// Length (a separate control) must remain. No browser required.

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('Dialogue Ratio UI removal (source extraction)', () => {
  it('has no Dialogue Ratio slider element', () => {
    expect(HTML).not.toMatch(/id="chapter-dialog-ratio"/);
  });

  it('has no Dialogue Ratio value display', () => {
    expect(HTML).not.toMatch(/id="chapter-dialog-ratio-val"/);
  });

  it('has no "Dialogue Ratio" label', () => {
    expect(HTML).not.toMatch(/Dialogue Ratio/i);
  });

  it('does not read #chapter-dialog-ratio in any request payload', () => {
    expect(HTML).not.toMatch(/getElementById\(['"]chapter-dialog-ratio['"]\)/);
  });

  it('does not include dialogRatio in any request body object', () => {
    expect(HTML).not.toMatch(/dialogRatio/);
  });

  it('still has the Chapter Length control (unaffected)', () => {
    expect(HTML).toMatch(/<select[^>]*id="chapter-length"/);
  });

  it('still has the Generate Chapters section', () => {
    expect(HTML).toMatch(/Generate Chapters/);
    expect(HTML).toMatch(/<button[^>]*id="chapter-btn"/);
  });
});
