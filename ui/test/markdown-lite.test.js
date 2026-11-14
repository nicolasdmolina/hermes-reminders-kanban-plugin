import assert from 'node:assert/strict'
import test from 'node:test'

import { inlineSpans, markdownBlocks } from '../src/lib/markdown-lite.js'

test('a result reads as headings, lists, code and paragraphs', () => {
  const blocks = markdownBlocks('## Summary\nDone in **two** steps.\nSecond line.\n\n- one\n- two\n\n1. first\n2) second\n\n```\nx = 1\n```\nTail')
  assert.deepEqual(blocks, [
    { type: 'h', text: 'Summary' },
    { type: 'p', text: 'Done in **two** steps.\nSecond line.' },
    { type: 'ul', items: ['one', 'two'] },
    { type: 'ol', start: 1, items: ['first', 'second'] },
    { type: 'pre', text: 'x = 1' },
    { type: 'p', text: 'Tail' }
  ])
})

test('a numbered list that resumes after something else goes on counting', () => {
  const blocks = markdownBlocks('1. Install\n- brew\n2. Run\n```\ngo\n```\n3. Done')
  assert.deepEqual(blocks.filter(block => block.type === 'ol'), [
    { type: 'ol', start: 1, items: ['Install'] },
    { type: 'ol', start: 2, items: ['Run'] },
    { type: 'ol', start: 3, items: ['Done'] }
  ])
})

test('a table stays aligned text without its rule; prose that starts with a year is prose', () => {
  assert.deepEqual(markdownBlocks('| a | b |\n|---|---|\n| 1 | 2 |\nafter'), [
    { type: 'pre', text: '| a | b |\n| 1 | 2 |' },
    { type: 'p', text: 'after' }
  ])
  assert.deepEqual(markdownBlocks('2024 was a good year'), [{ type: 'p', text: '2024 was a good year' }])
})

test('inline marks and links become spans', () => {
  assert.deepEqual(inlineSpans('Use `npm test`, **now**, *please*: [docs](https://example.com/a)'), [
    { text: 'Use ' },
    { code: 'npm test' },
    { text: ', ' },
    { text: 'now', bold: true },
    { text: ', ' },
    { text: 'please', italic: true },
    { text: ': ' },
    { href: 'https://example.com/a', label: 'docs' }
  ])
})

test('stars that are not emphasis stay stars', () => {
  for (const text of ['2 * 3 * 4 and a lone ** mark', 'Updated *.test.js and *.spec.js files', 'a*b*c', 'snake_case_name', '*.test.js, *.spec.js and src/*', '*args, **kwargs and **']) {
    assert.deepEqual(inlineSpans(text), [{ text }])
  }
})

test('a link inside bold or code keeps its address clean', () => {
  assert.deepEqual(inlineSpans('**[Docs](https://example.com/d)** and **see https://x.com**'), [
    { href: 'https://example.com/d', label: 'Docs', bold: true },
    { text: ' and ' },
    { text: 'see ', bold: true },
    { href: 'https://x.com', label: 'https://x.com', bold: true }
  ])
  assert.deepEqual(inlineSpans('`curl https://example.com/a_b`'), [{ code: 'curl https://example.com/a_b' }])
  assert.deepEqual(inlineSpans('see https://example.com/a_b` then'), [{ text: 'see ' }, { href: 'https://example.com/a_b', label: 'https://example.com/a_b' }, { text: '` then' }])
})

test('an unclosed code fence still shows as code, and plain text is one paragraph', () => {
  assert.deepEqual(markdownBlocks('```js\nlet a'), [{ type: 'pre', text: 'let a' }])
  assert.deepEqual(markdownBlocks('just text'), [{ type: 'p', text: 'just text' }])
})

test('Windows line endings read the same as plain ones', () => {
  assert.deepEqual(markdownBlocks('# Title\r\n- one\r\n- two'), [{ type: 'h', text: 'Title' }, { type: 'ul', items: ['one', 'two'] }])
})
