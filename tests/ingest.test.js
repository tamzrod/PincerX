'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock pdf-parse so no real PDF processing happens in unit tests
const mockGetText = jest.fn().mockResolvedValue({ text: 'Mocked PDF content.' });
const MockPDFParse = jest.fn().mockImplementation(() => ({ getText: mockGetText }));
jest.mock('pdf-parse', () => ({ PDFParse: MockPDFParse }));

const { parseFile, SUPPORTED_EXTENSIONS } = require('../ingest');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
  MockPDFParse.mockClear();
  mockGetText.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── SUPPORTED_EXTENSIONS ────────────────────────────────────────────────────

describe('SUPPORTED_EXTENSIONS', () => {
  it('includes .pdf, .txt, .md, .json, .csv', () => {
    expect(SUPPORTED_EXTENSIONS.has('.pdf')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('.txt')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('.md')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('.json')).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has('.csv')).toBe(true);
  });

  it('does not include unsupported types', () => {
    expect(SUPPORTED_EXTENSIONS.has('.xyz')).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has('.docx')).toBe(false);
  });
});

// ─── parseFile() ─────────────────────────────────────────────────────────────

describe('parseFile() — .txt', () => {
  it('reads file content as plain text and uses basename as title', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(filePath, 'Hello, world!', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toBe('Hello, world!');
    expect(result.title).toBe('hello');
  });

  it('preserves newlines in txt files', async () => {
    const filePath = path.join(tmpDir, 'multi.txt');
    fs.writeFileSync(filePath, 'line one\nline two\nline three', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toContain('line one');
    expect(result.text).toContain('line two');
  });
});

describe('parseFile() — .md', () => {
  it('reads markdown file as plain text', async () => {
    const filePath = path.join(tmpDir, 'readme.md');
    fs.writeFileSync(filePath, '# Title\n\nSome content here.', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toContain('# Title');
    expect(result.text).toContain('Some content here.');
    expect(result.title).toBe('readme');
  });
});

describe('parseFile() — .json', () => {
  it('pretty-prints JSON with 2-space indentation', async () => {
    const filePath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(filePath, '{"name":"Alice","age":30}', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toContain('"name": "Alice"');
    expect(result.text).toContain('"age": 30');
    expect(result.title).toBe('data');
  });

  it('throws on malformed JSON', async () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, '{invalid json}', 'utf-8');

    await expect(parseFile(filePath)).rejects.toThrow();
  });
});

describe('parseFile() — .csv', () => {
  it('converts rows into readable "Row X: col=value" sentences', async () => {
    const filePath = path.join(tmpDir, 'data.csv');
    fs.writeFileSync(filePath, 'name,age,city\nAlice,30,Paris\nBob,25,London', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toContain('Row 1: name=Alice, age=30, city=Paris');
    expect(result.text).toContain('Row 2: name=Bob, age=25, city=London');
    expect(result.title).toBe('data');
  });

  it('handles a CSV with a single data row', async () => {
    const filePath = path.join(tmpDir, 'single.csv');
    fs.writeFileSync(filePath, 'id,label\n42,test', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toBe('Row 1: id=42, label=test');
  });

  it('ignores blank lines in CSV files', async () => {
    const filePath = path.join(tmpDir, 'blanks.csv');
    fs.writeFileSync(filePath, 'col\nval\n\n  \n', 'utf-8');

    const result = await parseFile(filePath);
    expect(result.text).toBe('Row 1: col=val');
  });
});

describe('parseFile() — .pdf', () => {
  it('calls PDFParse and returns mocked text', async () => {
    const filePath = path.join(tmpDir, 'document.pdf');
    const pdfBuffer = Buffer.from('%PDF-1.4 fake');
    fs.writeFileSync(filePath, pdfBuffer);

    const result = await parseFile(filePath);
    expect(result.text).toBe('Mocked PDF content.');
    expect(result.title).toBe('document');
    expect(MockPDFParse).toHaveBeenCalledWith({ data: expect.any(Buffer) });
    expect(mockGetText).toHaveBeenCalledTimes(1);
  });
});

describe('parseFile() — unsupported type', () => {
  it('throws an error for an unsupported extension', async () => {
    const filePath = path.join(tmpDir, 'file.xyz');
    fs.writeFileSync(filePath, 'some content', 'utf-8');

    await expect(parseFile(filePath)).rejects.toThrow('Unsupported file type: .xyz');
  });
});
