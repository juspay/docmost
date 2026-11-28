import { describe, expect, it } from 'vitest';
import * as B from './board';
import { boardToTaskListNodes } from './checklist';

const text = (s: string) => (s ? [{ type: 'text', text: s }] : undefined);

describe('boardToTaskListNodes', () => {
  it('nests children and marks done items checked', () => {
    const board = B.createEmptyBoard();
    const parent = { ...B.newTask('parent'), done: true };
    parent.children = [{ ...B.newTask('child'), done: true }];
    board.columns = [
      { ...B.newColumn('Sprint'), nodes: [parent, B.newTask('open')] },
    ];
    expect(boardToTaskListNodes(board)).toEqual([
      { type: 'heading', attrs: { level: 3 }, content: text('Sprint') },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [
              { type: 'paragraph', content: text('parent') },
              {
                type: 'taskList',
                content: [
                  {
                    type: 'taskItem',
                    attrs: { checked: true },
                    content: [{ type: 'paragraph', content: text('child') }],
                  },
                ],
              },
            ],
          },
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: text('open') }],
          },
        ],
      },
    ]);
  });

  it('turns sections into bold paragraphs and starts a new list after one', () => {
    const board = B.createEmptyBoard();
    const section = B.newSection('Backend');
    section.children = [B.newTask('api')];
    board.columns = [
      {
        ...B.newColumn('Card'),
        nodes: [B.newTask('first'), section, B.newTask('last')],
      },
    ];
    const out = boardToTaskListNodes(board) as any[];
    expect(out.map((n) => n.type)).toEqual([
      'heading',
      'taskList',
      'paragraph',
      'taskList',
      'taskList',
    ]);
    expect(out[2]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Backend', marks: [{ type: 'bold' }] }],
    });
    expect(out[3].content[0].content[0].content[0].text).toBe('api');
  });

  it('keeps a card with no items as a bare heading, and empty text as an empty paragraph', () => {
    const board = B.createEmptyBoard();
    board.columns = [
      { ...B.newColumn('Empty'), nodes: [] },
      { ...B.newColumn('Blank'), nodes: [B.newTask('')] },
    ];
    const out = boardToTaskListNodes(board) as any[];
    expect(out[0]).toEqual({
      type: 'heading',
      attrs: { level: 3 },
      content: text('Empty'),
    });
    expect(out[2].content[0].content).toEqual([{ type: 'paragraph' }]);
  });
});
