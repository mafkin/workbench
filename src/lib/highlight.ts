// Syntax colours for code blocks in a note's view, with the parsers the editor
// already ships (a lazy chunk): JavaScript and TypeScript (with JSX), JSON, CSS,
// HTML and Markdown. Other languages stay plain.
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import type { Parser } from '@lezer/common'

const json = javascriptLanguage.parser.configure({ top: 'SingleExpression' })

const PARSERS: Record<string, Parser> = {
  js: javascriptLanguage.parser,
  javascript: javascriptLanguage.parser,
  mjs: javascriptLanguage.parser,
  cjs: javascriptLanguage.parser,
  jsx: jsxLanguage.parser,
  ts: typescriptLanguage.parser,
  typescript: typescriptLanguage.parser,
  tsx: tsxLanguage.parser,
  json,
  jsonc: json,
  css: cssLanguage.parser,
  html: htmlLanguage.parser,
  xml: htmlLanguage.parser,
  svg: htmlLanguage.parser,
  md: markdownLanguage.parser,
  markdown: markdownLanguage.parser,
}

export const highlightable = (lang: string) => lang.toLowerCase() in PARSERS

/** The code as runs of text, each with the `tok-…` classes of its kind; null for a language without a parser. */
export function highlight(code: string, lang: string): { text: string; cls: string }[] | null {
  const parser = PARSERS[lang.toLowerCase()]
  if (!parser) return null
  const out: { text: string; cls: string }[] = []
  highlightCode(
    code,
    parser.parse(code),
    classHighlighter,
    (text, cls) => out.push({ text, cls }),
    () => out.push({ text: '\n', cls: '' }),
  )
  return out
}
