// The Markdown editor (CodeMirror 6). Loaded on first use, so the main bundle
// stays small. Colours come from the theme tokens.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Transaction } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

const highlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--text-strong)', fontWeight: '600' },
  { tag: t.strong, color: 'var(--text-strong)', fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--warn)' },
  { tag: t.quote, color: 'var(--muted)' },
  // The Markdown punctuation itself: # * _ ` > - [ ]
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--faint)' },
])

const theme = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: '13px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
    '.cm-content': { padding: '14px 0 40vh', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 18px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
    },
  },
  { dark: true },
)

/** End of the text, or of its last line when the text ends in a line break: after "- [ ] " in a template. */
const endOf = (text: string) => (/[^\n]\n$/.test(text) ? text.length - 1 : text.length)

interface Props {
  value: string
  onChange: (text: string) => void
  /** Put the cursor at the end, e.g. after the heading of a new note. */
  atEnd?: boolean
}

// Ctrl+S and Ctrl+E are handled by the note page, around the editor.
export default function NoteEditor({ value, onChange, atEnd }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        selection: { anchor: atEnd ? endOf(value) : 0 },
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          theme,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changed.current(u.state.doc.toString())
          }),
          EditorView.contentAttributes.of({ 'aria-label': 'Note text' }),
        ],
      }),
    })
    view.current = v
    v.focus()
    return () => {
      v.destroy()
      view.current = null
    }
    // Created once; later `value` changes arrive through the effect below.
  }, [])

  // The text was replaced from outside (reloaded from disk): swap it in, keeping the cursor where it can stay.
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === value) return
    const head = Math.min(v.state.selection.main.head, value.length)
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: value },
      selection: { anchor: head },
      annotations: Transaction.addToHistory.of(false),
    })
  }, [value])

  return <div className="note-editor" ref={host} />
}
