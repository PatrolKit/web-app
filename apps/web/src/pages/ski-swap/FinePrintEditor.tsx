import { useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { FinePrintCallout } from '../public/receiptLayout';
import { FINE_PRINT_MAX_CHARS, finePrintText } from './swapSettingsForm';

/**
 * A swap's fine print (Plan 36 D13): paragraphs, bold, italic, links and
 * lists, and nothing else, so it can't make anything the server would strip.
 * Loaded only with the swap dialog, lazily, to keep the editor out of the
 * rest of the app.
 */
export default function FinePrintEditor({ value, onChange }: {
  value: string | null;
  onChange: (html: string | null) => void;
}) {
  const [preview, setPreview] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        // No empty paragraph forced after a list: it would be a blank line in the email.
        trailingNode: false,
        // The server keeps a link's href and nothing more.
        link: {
          openOnClick: false,
          protocols: ['mailto'],
          defaultProtocol: 'https',
          isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url),
          HTMLAttributes: { target: null, rel: null, class: null },
        },
      }),
    ],
    content: value ?? '',
    editorProps: {
      attributes: {
        'aria-label': 'Fine print',
        class: 'min-h-[6rem] px-3 py-2 text-sm text-white outline-none [&_p]:mb-2 [&_ul]:list-disc [&_ol]:list-decimal '
          + '[&_ul]:pl-5 [&_ol]:pl-5 [&_li]:mb-1 [&_a]:text-brand-500 [&_a]:underline',
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? null : e.getHTML()),
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => e && ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
    }),
  });

  const count = finePrintText(value).length;
  const over = count > FINE_PRINT_MAX_CHARS;

  function setLink() {
    if (!editor) return;
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const url = prompt('Link to (https://… or mailto:…)')?.trim();
    if (!url) return;
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="border border-gray-700 rounded bg-surface-100">
        <div className="flex gap-1 border-b border-gray-700 px-1.5 py-1" role="toolbar" aria-label="Fine print formatting">
          <ToolButton label="Bold" active={!!state?.bold} onClick={() => editor?.chain().focus().toggleBold().run()}>
            <span className="font-bold">B</span>
          </ToolButton>
          <ToolButton label="Italic" active={!!state?.italic} onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <span className="italic">I</span>
          </ToolButton>
          <ToolButton label={state?.link ? 'Remove link' : 'Link'} active={!!state?.link} onClick={setLink}>
            Link
          </ToolButton>
          <ToolButton label="Bulleted list" active={!!state?.bullet} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            • List
          </ToolButton>
          <ToolButton label="Numbered list" active={!!state?.ordered} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            1. List
          </ToolButton>
        </div>
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          disabled={!value}
          className="text-brand-500 hover:underline disabled:text-gray-600 disabled:no-underline"
        >
          {preview ? 'Hide preview' : 'Preview on the receipt'}
        </button>
        <span className={over ? 'text-red-400' : 'text-gray-500'}>
          {count.toLocaleString('en-US')} / {FINE_PRINT_MAX_CHARS.toLocaleString('en-US')} characters
        </span>
      </div>
      {preview && value && (
        <div className="bg-surface-50 border border-gray-800 rounded-xl p-4">
          <FinePrintCallout html={value} />
        </div>
      )}
    </div>
  );
}

function ToolButton({ label, active, onClick, children }: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep the editor's selection while clicking.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`px-2 py-1 rounded text-xs ${active ? 'bg-surface-200 text-white' : 'text-gray-300 hover:bg-surface-200'}`}
    >
      {children}
    </button>
  );
}
