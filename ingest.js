'use strict';

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const PDF_DIR = path.join(__dirname, 'pdfs');
const OUTPUT_PATH = path.join(__dirname, 'data', 'docs.json');
const CHUNK_MIN = 300;
const CHUNK_MAX = 500;

/**
 * Clean extracted text by collapsing extra whitespace and line breaks.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
  return text
    .replace(/\r\n|\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Split text into chunks of CHUNK_MIN–CHUNK_MAX characters,
 * breaking on whitespace boundaries where possible.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoChunks(text) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + CHUNK_MAX;

    if (end >= text.length) {
      chunks.push(text.slice(start).trim());
      break;
    }

    // Try to break at the last whitespace within the window
    const boundary = text.lastIndexOf(' ', end);
    if (boundary > start + CHUNK_MIN) {
      end = boundary;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    start = end + 1;
  }

  return chunks.filter((c) => c.length > 0);
}

let ingestionInProgress = false;

/**
 * Ingest all PDFs from PDF_DIR and write docs.json to OUTPUT_PATH.
 * Throws if ingestion is already running to prevent concurrent writes.
 */
async function ingest() {
  if (ingestionInProgress) {
    throw new Error('Ingestion is already in progress.');
  }

  ingestionInProgress = true;

  try {
    if (!fs.existsSync(PDF_DIR)) {
      fs.mkdirSync(PDF_DIR, { recursive: true });
    }

    const files = fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));

    if (files.length === 0) {
      console.warn('No PDF files found in', PDF_DIR);
    }

    const docs = [];
    let idCounter = 1;

    for (const file of files) {
      const filePath = path.join(PDF_DIR, file);
      const title = path.basename(file, path.extname(file));

      console.log(`Processing: ${file}`);

      const buffer = fs.readFileSync(filePath);
      const parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();

      const cleaned = cleanText(parsed.text);
      const chunks = splitIntoChunks(cleaned);

      for (const chunk of chunks) {
        docs.push({
          id: String(idCounter++),
          title,
          content: chunk,
        });
      }

      console.log(`  → ${chunks.length} chunk(s)`);
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(docs, null, 2), 'utf8');

    console.log(`\nWrote ${docs.length} document chunk(s) to ${OUTPUT_PATH}`);
  } finally {
    ingestionInProgress = false;
  }
}

if (require.main === module) {
  ingest().catch((err) => {
    console.error('Ingestion failed:', err.message);
    process.exit(1);
  });
}

module.exports = { ingest };
