import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LiveBlockInputError } from '../snapshot';
import { validateScene } from './schema';
import { readFiles, setFile } from './ydoc';
import '../index';
import { kindDefinition } from '../registry';

const ID = '0193c7a0-1111-7abc-8def-0000000000aa';

describe('whiteboard file references', () => {
  it('validateScene accepts only an attachment uuid', () => {
    for (const attachmentId of [
      'x',
      '../../api/users/me?',
      ID.toUpperCase(),
      `${ID}x`,
    ]) {
      expect(() =>
        validateScene({
          elements: [],
          files: { f: { attachmentId, mimeType: 'image/png' } },
        }),
      ).toThrow(LiveBlockInputError);
    }
    expect(
      validateScene({
        elements: [],
        files: { f: { attachmentId: ID, mimeType: 'image/png' } },
      }).files,
    ).toEqual({ f: { attachmentId: ID, mimeType: 'image/png' } });
  });

  it('a stored reference that is not a uuid is never read (so copies and fetches never see it)', () => {
    const doc = new Y.Doc();
    setFile(doc, 'bad', { attachmentId: 'x', mimeType: 'image/png' });
    setFile(doc, 'ok', { attachmentId: ID, mimeType: 'image/png' });
    expect(readFiles(doc)).toEqual({
      ok: { attachmentId: ID, mimeType: 'image/png' },
    });
    expect(kindDefinition('whiteboard').attachmentIds!(doc)).toEqual([ID]);
  });

  it('validateScene caps the number of files', () => {
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 2_001; i++)
      files[`f${i}`] = { attachmentId: ID, mimeType: 'image/png' };
    expect(() => validateScene({ elements: [], files })).toThrow(/at most/);
  });
});

describe('the key __proto__', () => {
  it('is refused as a file id on input and skipped on read', () => {
    const files = JSON.parse(
      `{"__proto__": {"attachmentId": "${ID}", "mimeType": "image/png"}}`,
    );
    expect(() => validateScene({ elements: [], files })).toThrow(
      LiveBlockInputError,
    );
    const doc = new Y.Doc();
    setFile(doc, '__proto__', { attachmentId: ID, mimeType: 'image/png' });
    const read = readFiles(doc);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect((read as any).attachmentId).toBeUndefined();
    expect(Object.keys(read)).toEqual([]);
  });
});

describe('file references read from a document', () => {
  it('stop at the file limit', async () => {
    const { MAX_WHITEBOARD_FILES } = await import('./schema');
    const doc = new Y.Doc();
    doc.transact(() => {
      for (let i = 0; i < MAX_WHITEBOARD_FILES + 500; i++) {
        setFile(doc, `f${i}`, { attachmentId: ID, mimeType: 'image/png' });
      }
    });
    expect(Object.keys(readFiles(doc))).toHaveLength(MAX_WHITEBOARD_FILES);
  });
});
