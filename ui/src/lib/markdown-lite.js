// The few Markdown shapes a Hermes result uses, for the browser task page, which has no Markdown
// renderer: headings, bullet and numbered lists, code fences, tables (kept as aligned text), and
// bold, italic, inline code and links inside a line. Pure: no host imports. Anything else stays
// as the text it is.
import { linkParts } from './task-link.js'

// Inline code, bold, then italic. Marks hug their text (no space just inside), and italic also
// needs word edges and a letter or digit first, so a file glob (*.test.js), a product (a*b*c) or
// Python's *args and **kwargs keep their stars.
const INLINE = /(`[^`\n]+`|\*\*[^*\s](?:[^*\n]*[^*\s])?\*\*|(?<![\w*])\*[A-Za-z0-9](?:[^*\n]*[^*\s])?\*(?![\w*]))/g

/** One line of text as spans: { text } | { code } | { href, label }, each with bold or italic set
 *  when it sits inside those marks. Marks are split first, so a link inside bold stays one link. */
export function inlineSpans(text) {
  const spans = []
  const plain = (piece, style) => {
    for (const part of linkParts(piece)) {
      if (typeof part === 'string') {
        if (part) spans.push({ text: part, ...style })
      } else spans.push({ href: part.href, label: part.label, ...style })
    }
  }
  // Only what the pattern itself matched is a mark; the text between matches is never guessed at
  // from its first and last characters.
  const source = String(text ?? '')
  let at = 0
  for (const match of source.matchAll(INLINE)) {
    if (match.index > at) plain(source.slice(at, match.index), {})
    const piece = match[0]
    if (piece.startsWith('`')) spans.push({ code: piece.slice(1, -1) })
    else if (piece.startsWith('**')) plain(piece.slice(2, -2), { bold: true })
    else plain(piece.slice(1, -1), { italic: true })
    at = match.index + piece.length
  }
  if (at < source.length) plain(source.slice(at), {})
  return spans
}

const HEADING = /^#{1,6}\s+(.*)$/
const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/
const TABLE = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|[\s|:-]+\|\s*$/

/** Blocks: { type: 'p' | 'h', text } | { type: 'ul', items } | { type: 'ol', start, items } |
 *  { type: 'pre', text }. A numbered list keeps its first number, so one that resumes after a code
 *  block or a paragraph goes on counting. */
export function markdownBlocks(source) {
  const blocks = []
  let paragraph = []
  let fence = null
  let table = null
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join('\n') })
    paragraph = []
    if (table?.length) blocks.push({ type: 'pre', text: table.join('\n') })
    table = null
  }
  for (const line of String(source ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      if (line.trim().startsWith('```')) {
        blocks.push({ type: 'pre', text: fence.join('\n') })
        fence = null
      } else fence.push(line)
      continue
    }
    if (line.trim().startsWith('```')) {
      flush()
      fence = []
      continue
    }
    // A table reads as aligned text that scrolls sideways; its |---| rule is dropped.
    if (TABLE.test(line)) {
      if (!table) {
        flush()
        table = []
      }
      if (!TABLE_RULE.test(line)) table.push(line.trim())
      continue
    }
    if (table) flush()
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = HEADING.exec(line)
    const bullet = BULLET.exec(line)
    const number = bullet ? null : NUMBER.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'h', text: heading[1] })
    } else if (bullet) {
      flush()
      const last = blocks[blocks.length - 1]
      if (last?.type === 'ul') last.items.push(bullet[1])
      else blocks.push({ type: 'ul', items: [bullet[1]] })
    } else if (number) {
      flush()
      const last = blocks[blocks.length - 1]
      if (last?.type === 'ol') last.items.push(number[2])
      else blocks.push({ type: 'ol', start: Number(number[1]), items: [number[2]] })
    } else paragraph.push(line)
  }
  // An unclosed fence is still code.
  if (fence) blocks.push({ type: 'pre', text: fence.join('\n') })
  flush()
  return blocks
}
