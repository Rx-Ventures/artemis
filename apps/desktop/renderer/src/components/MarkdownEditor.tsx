/**
 * A rich-text editor whose document *is* Markdown.
 * ============================================================================
 *
 * Standing instructions are prose with structure — a heading, a few bullets,
 * a fenced example — and the two obvious ways to let someone write that are
 * both bad in the same way. A plain `<textarea>` makes the user type the syntax
 * and read it back as syntax, which is the one part of writing a prompt that
 * has nothing to do with what they are trying to say. A rich editor with its
 * own document format makes the *stored* thing a rendering artefact, so the
 * file on disk stops being the thing that gets sent.
 *
 * This is the third option: ProseMirror for the editing, Markdown for the
 * value. What the user sees is a formatted document; what leaves this component
 * — on every keystroke, and to disk — is Markdown source. Hand-editing
 * `agent-prompts.json` and reopening the pane loads exactly what was written.
 *
 * ---------------------------------------------------------------------------
 * WHY `tiptap-markdown` AND NOT A SERIALISER OF OUR OWN
 * ---------------------------------------------------------------------------
 *
 * The first draft of this walked the ProseMirror document and emitted Markdown
 * by hand. It is about a hundred lines and it is wrong in ways that only show
 * up on real input: a `*` at the start of a paragraph that is not a list, a
 * backtick inside inline code, a nested ordered list under a bullet, a link
 * whose title contains a bracket. Every one of those silently corrupts a
 * prompt the user believes they wrote.
 *
 * `tiptap-markdown` is a thin binding over `prosemirror-markdown` — ProseMirror's
 * own serialiser, by ProseMirror's author, with `markdown-it` doing the parse.
 * Same argument as `ChoiceList` reaching for Radix's `RadioGroup` instead of
 * keeping its hand-rolled radiogroup: the escaping rules were already
 * implemented correctly by someone whose job it was, and a second copy only
 * creates a second place for them to be subtly wrong.
 *
 * `html: false` is the one option worth stating here. It stops raw HTML in the
 * source from being parsed into nodes, so a prompt containing `<script>` is
 * text that says `<script>` — the same posture `react-markdown` is used with
 * everywhere else in this app, applied at the other end of the pipe.
 *
 * ---------------------------------------------------------------------------
 * `value` IS AN INITIAL VALUE. REMOUNT TO CHANGE DOCUMENTS.
 * ---------------------------------------------------------------------------
 *
 * This is the one thing a caller has to get right, so it is stated twice: on
 * {@link MarkdownEditorProps.value} and here. ProseMirror owns the document,
 * the selection and the undo history once it is running. Pushing a new `value`
 * into a live editor on every render — the reflex a controlled `<input>`
 * teaches — would round-trip the user's own keystroke back through the
 * serialiser and the parser and reset their cursor to the top of the document
 * as they type.
 *
 * So `value` seeds the editor and is never read again. To show a *different*
 * document, give the component a `key` that changes with it; React unmounts the
 * old editor, which is also what discards the old undo history — correct, since
 * undo across two different prompts would be a surprise.
 */

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  SquareCodeIcon,
} from 'lucide-react';

import { Separator } from '@/components/ui/separator';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

export interface MarkdownEditorProps {
  /**
   * The Markdown to open with.
   *
   * **Read once.** See the note on this module: to show a different document,
   * change the component's `key`. A caller that expects this to behave like a
   * controlled input will find their cursor jumping to the top of the document
   * on every keystroke.
   */
  readonly value: string;
  /** Called with the whole document as Markdown, on every change. */
  readonly onChange: (markdown: string) => void;
  /** Shown in an empty document. */
  readonly placeholder?: string;
  /** Accessible name for the editing surface. Required — it is a text box. */
  readonly ariaLabel: string;
  /**
   * Render the document without letting it be edited.
   *
   * Used for the built-in prompts, whose text ships with Artemis. Read-only
   * rather than absent: "here is exactly what will be sent" is the whole reason
   * a user would open one, and paraphrasing it in a description would be
   * Artemis describing its own prompt rather than showing it.
   */
  readonly readOnly?: boolean;
  readonly className?: string;
}

/**
 * The document, as Markdown.
 *
 * `tiptap-markdown` hangs `getMarkdown()` off `editor.storage.markdown`, and
 * ships its types without the `@tiptap/core` module augmentation that would
 * make that key visible — `Storage` is declared empty, so indexing it is an
 * implicit `any`. Augmenting it from here was the other option and is worse:
 * `@tiptap/core` is a transitive dependency, so a `declare module` for it would
 * be a global type change made from a component file, aimed at a package this
 * one does not depend on.
 *
 * So the shape is asserted in exactly one place, with the failure handled. An
 * empty string rather than a throw: an editor that cannot serialise itself must
 * not take the settings dialog down with it, and the caller already treats an
 * empty prompt as one that contributes nothing.
 */
function readMarkdown(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)['markdown'];
  if (typeof storage !== 'object' || storage === null) return '';
  const read = (storage as { getMarkdown?: unknown }).getMarkdown;
  if (typeof read !== 'function') return '';
  const markdown: unknown = (read as () => unknown).call(storage);
  return typeof markdown === 'string' ? markdown : '';
}

/** Which extensions, and why each one is configured the way it is. */
function extensionsFor(placeholder: string | undefined) {
  return [
    StarterKit.configure({
      // The editor is a paragraph-level surface inside a settings pane, so the
      // document has no h1 to be the title of. Offering one would put a heading
      // level in the prompt that outranks the sections around it once several
      // prompts are joined — see `composeAgentPrompts`.
      heading: { levels: [2, 3] },
      link: {
        // A link the user cannot follow by accident. Clicking inside an editor
        // means "put the cursor here"; opening a browser instead is the kind of
        // surprise that loses a half-written sentence.
        openOnClick: false,
        // `linkOnPaste` is left on: pasting a URL over selected text is a
        // gesture people already have, and it is undoable.
      },
    }),
    ...(placeholder === undefined ? [] : [Placeholder.configure({ placeholder })]),
    Markdown.configure({
      // See the module note. Raw HTML in the source stays text.
      html: false,
      // Tight lists, so a three-bullet list serialises without a blank line
      // between each item. Loose lists round-trip correctly either way; this is
      // about what a person sees when they open the JSON file.
      tightLists: true,
      // `-` rather than `*`, which is the marker every other Markdown file in
      // this repo uses and the one that cannot be confused with emphasis.
      bulletListMarker: '-',
      // Off, both of them. These rewrite the clipboard: `transformPastedText`
      // would parse pasted text as Markdown, so pasting a code sample
      // containing `#` would turn it into a heading, and `transformCopiedText`
      // would put Markdown source on the clipboard when the user copied
      // formatted text out. Neither is what someone assembling a prompt from
      // fragments of other files expects.
      transformPastedText: false,
      transformCopiedText: false,
    }),
  ];
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  readOnly = false,
  className,
}: MarkdownEditorProps): ReactElement {
  const editor = useEditor({
    extensions: extensionsFor(readOnly ? undefined : placeholder),
    content: value,
    editable: !readOnly,
    // On, deliberately. TipTap defers its first render by default so that a
    // server-rendered tree and the client's agree; there is no SSR here, and
    // deferring only buys a frame of empty box before the document appears.
    immediatelyRender: true,
    editorProps: {
      attributes: {
        'aria-label': ariaLabel,
        // `.md` is the app's rendered-markdown treatment, reused rather than
        // restated: the whole point of this editor is that what is being edited
        // looks like what will be read. `outline-none` because the focus ring
        // belongs on the framed container below, not on the text itself.
        class: cn('md min-h-32 px-3 py-2.5 outline-none', readOnly && 'select-text'),
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(readMarkdown(instance));
    },
  });

  if (editor === null) return <div className={cn('rounded-lg border border-hairline', className)} />;

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-hairline bg-panel',
        // The ring lands on the frame rather than the text, which is why the
        // ProseMirror surface above sets `outline-none`. `has-focus-within`
        // rather than `focus-within` so it also lights when focus is in the
        // toolbar — the toolbar is part of this control.
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        className,
      )}
    >
      {readOnly ? null : <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What the marks and blocks currently under the cursor are.
 *
 * Read through `useEditorState` rather than by calling `editor.isActive()` in
 * the render body. The editor is a mutable object that changes without React
 * being told, so a component that read it directly would paint a toolbar
 * describing wherever the cursor was on the last unrelated re-render. This
 * subscribes properly and re-renders only when one of these booleans actually
 * flips — which also keeps the React Compiler from memoising a read of a value
 * it has no way to know is live.
 */
interface ToolbarState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: boolean;
  readonly h2: boolean;
  readonly h3: boolean;
  readonly bulletList: boolean;
  readonly orderedList: boolean;
  readonly blockquote: boolean;
  readonly codeBlock: boolean;
  readonly link: boolean;
}

function Toolbar({ editor }: { readonly editor: Editor }): ReactElement {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }): ToolbarState => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      code: e.isActive('code'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
    }),
  });

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      aria-orientation="horizontal"
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-hairline bg-wash px-1.5 py-1"
    >
      <Mark
        pressed={state.h2}
        label="Heading"
        onPressed={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2Icon aria-hidden="true" />
      </Mark>
      <Mark
        pressed={state.h3}
        label="Subheading"
        onPressed={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3Icon aria-hidden="true" />
      </Mark>

      <ToolbarRule />

      <Mark
        pressed={state.bold}
        label="Bold"
        onPressed={() => editor.chain().focus().toggleBold().run()}
      >
        <BoldIcon aria-hidden="true" />
      </Mark>
      <Mark
        pressed={state.italic}
        label="Italic"
        onPressed={() => editor.chain().focus().toggleItalic().run()}
      >
        <ItalicIcon aria-hidden="true" />
      </Mark>
      <Mark
        pressed={state.code}
        label="Inline code"
        onPressed={() => editor.chain().focus().toggleCode().run()}
      >
        <CodeIcon aria-hidden="true" />
      </Mark>

      <ToolbarRule />

      <Mark
        pressed={state.bulletList}
        label="Bulleted list"
        onPressed={() => editor.chain().focus().toggleBulletList().run()}
      >
        <ListIcon aria-hidden="true" />
      </Mark>
      <Mark
        pressed={state.orderedList}
        label="Numbered list"
        onPressed={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrderedIcon aria-hidden="true" />
      </Mark>
      <Mark
        pressed={state.blockquote}
        label="Quote"
        onPressed={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <QuoteIcon aria-hidden="true" />
      </Mark>
      <Mark
        pressed={state.codeBlock}
        label="Code block"
        onPressed={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <SquareCodeIcon aria-hidden="true" />
      </Mark>

      <ToolbarRule />

      <LinkButton editor={editor} active={state.link} />
    </div>
  );
}

function ToolbarRule(): ReactElement {
  return <Separator orientation="vertical" className="mx-1 !h-4" />;
}

function Mark({
  pressed,
  label,
  onPressed,
  children,
}: {
  readonly pressed: boolean;
  readonly label: string;
  readonly onPressed: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Toggle
      size="sm"
      pressed={pressed}
      onPressedChange={onPressed}
      aria-label={label}
      title={label}
      className="size-7 min-w-7 px-0 text-ink-muted data-[state=on]:text-ink"
    >
      {children}
    </Toggle>
  );
}

/**
 * Add or remove a link.
 *
 * A `window.prompt` would have been one line, and it is the one browser dialog
 * that cannot be styled, cannot be dismissed with the app's own Escape handling
 * and blocks the renderer's event loop while it is open. This is an inline
 * field instead: it opens under the toolbar, takes the URL, and closes on
 * Enter or Escape.
 *
 * Removing does not need the field, so a cursor already inside a link gets
 * "Remove link" rather than a pre-filled box the user has to clear.
 */
function LinkButton({
  editor,
  active,
}: {
  readonly editor: Editor;
  readonly active: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');

  // A closed field forgets what was in it. Without this, reopening it over a
  // different selection offers the *previous* selection's URL, pre-filled and
  // one Enter away from being applied to the wrong run of text.
  useEffect(() => {
    if (!open) setHref('');
  }, [open]);

  const apply = (): void => {
    const url = href.trim();
    if (url.length > 0) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    setOpen(false);
  };

  if (active) {
    return (
      <Toggle
        size="sm"
        pressed
        onPressedChange={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
        aria-label="Remove link"
        title="Remove link"
        className="size-7 min-w-7 px-0 text-ink-muted data-[state=on]:text-ink"
      >
        <LinkIcon aria-hidden="true" />
      </Toggle>
    );
  }

  return (
    <span className="flex items-center gap-1">
      <Toggle
        size="sm"
        pressed={open}
        onPressedChange={setOpen}
        aria-label="Add link"
        title="Add link"
        className="size-7 min-w-7 px-0 text-ink-muted data-[state=on]:text-ink"
      >
        <LinkIcon aria-hidden="true" />
      </Toggle>
      {open ? (
        <input
          autoFocus
          value={href}
          onChange={(event) => setHref(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              // Stopped here so the settings dialog does not also close. One
              // Escape should dismiss one thing, and the thing the user is
              // looking at is this field.
              event.stopPropagation();
              setOpen(false);
            }
          }}
          onBlur={apply}
          placeholder="https://…"
          aria-label="Link address"
          spellCheck={false}
          className="h-7 w-56 rounded-md border border-line bg-panel px-2 text-2xs text-ink outline-none placeholder:text-ink-faint focus-visible:border-ring"
        />
      ) : null}
    </span>
  );
}
