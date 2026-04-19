'use strict';

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const FILES_DIR = path.join(__dirname, 'pdfs');
const OUTPUT_PATH = path.join(__dirname, 'data', 'docs.json');
const CHUNK_MIN = 300;
const CHUNK_MAX = 500;

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.txt', '.md', '.json', '.csv']);

/**
 * Parse a file into normalized text based on its extension.
 * Supports .pdf, .txt, .md, .json, and .csv.
 *
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<{text: string, title: string}>}
 */
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const title = path.basename(filePath, path.extname(filePath));

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  let text;

  if (ext === '.txt' || ext === '.md') {
    text = fs.readFileSync(filePath, 'utf-8');
  } else if (ext === '.json') {
    const raw = fs.readFileSync(filePath, 'utf-8');
    text = JSON.stringify(JSON.parse(raw), null, 2);
  } else if (ext === '.csv') {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const [header, ...rows] = lines;
    // Simple split on comma — does not handle quoted fields containing commas
    const columns = header.split(',').map((c) => c.trim());
    text = rows
      .map((row, i) => {
        const values = row.split(',').map((v) => v.trim());
        const pairs = columns.map((col, j) => `${col}=${values[j] ?? ''}`).join(', ');
        return `Row ${i + 1}: ${pairs}`;
      })
      .join('\n');
  } else {
    // .pdf
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    text = parsed.text;
  }

  return { text, title };
}

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
 * Ingest all supported files from FILES_DIR and write docs.json to OUTPUT_PATH.
 * Throws if ingestion is already running to prevent concurrent writes.
 */
async function ingest() {
  if (ingestionInProgress) {
    const err = new Error('Ingestion is already in progress.');
    err.code = 'INGESTION_IN_PROGRESS';
    throw err;
  }

  ingestionInProgress = true;

  try {
    if (!fs.existsSync(FILES_DIR)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    }

    const files = fs.readdirSync(FILES_DIR).filter((f) =>
      SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase())
    );

    if (files.length === 0) {
      console.warn('No supported files found in', FILES_DIR);
    }

    const docs = [];
    let idCounter = 1;

    for (const file of files) {
      const filePath = path.join(FILES_DIR, file);

      console.log(`Processing: ${file}`);

      const { text, title } = await parseFile(filePath);

      const cleaned = cleanText(text);
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

module.exports = { ingest, parseFile, SUPPORTED_EXTENSIONS };
