'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import LinkExtension from '@tiptap/extension-link';
import ImageExtension from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useRef, useState } from 'react';
import {
  Bold,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Link2,
  ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import { createClient } from '@/utils/supabase/client';

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  clientId?: string;
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      title={title}
      className={`p-1.5 rounded text-sm transition-colors ${
        active
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}

async function convertToWebP(file: File, maxPx = 1920, quality = 0.85): Promise<File> {
  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;
  if (width > maxPx || height > maxPx) {
    const ratio = Math.min(maxPx / width, maxPx / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Conversión WebP fallida'));
          return;
        }
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' }));
      },
      'image/webp',
      quality
    );
  });
}

export function RichTextEditor({ content, onChange, placeholder, clientId }: RichTextEditorProps) {
  const [linkInput, setLinkInput] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2] },
      }),
      LinkExtension.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      ImageExtension.configure({ inline: false }),
      Placeholder.configure({ placeholder: placeholder ?? 'Escribe aquí...' }),
    ],
    content,
    editorProps: {
      attributes: {
        class: 'ProseMirror bitacora-content text-sm text-foreground px-3 py-2 focus:outline-none',
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  // Sync content when switching between entries
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [content, editor]);

  const applyLink = () => {
    if (!editor || linkInput === null) return;
    if (linkInput.trim() === '') {
      editor.chain().focus().unsetLink().run();
    } else {
      const url = linkInput.startsWith('http') ? linkInput : `https://${linkInput}`;
      editor.chain().focus().setLink({ href: url }).run();
    }
    setLinkInput(null);
  };

  const handleImageUpload = async (file: File) => {
    if (!editor) return;
    setImageUploading(true);
    try {
      const supabase = createClient();
      const webpFile = await convertToWebP(file);
      const path = `${clientId ?? 'general'}/${Date.now()}.webp`;
      const { error } = await supabase.storage
        .from('bitacoras-images')
        .upload(path, webpFile, { contentType: 'image/webp', upsert: true });
      if (error) throw error;
      const {
        data: { publicUrl },
      } = supabase.storage.from('bitacoras-images').getPublicUrl(path);
      editor.chain().focus().setImage({ src: publicUrl }).run();
    } catch (err) {
      console.error('Error uploading image:', err);
    } finally {
      setImageUploading(false);
    }
  };

  if (!editor) return null;

  return (
    <div className="border border-input rounded-md overflow-hidden bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-input bg-muted/30 flex-wrap">
        <ToolbarButton
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Negrita"
        >
          <Bold className="w-3.5 h-3.5" />
        </ToolbarButton>

        <ToolbarButton
          active={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Título H1"
        >
          <Heading1 className="w-3.5 h-3.5" />
        </ToolbarButton>

        <ToolbarButton
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Título H2"
        >
          <Heading2 className="w-3.5 h-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-border mx-1" />

        <ToolbarButton
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Lista de viñetas"
        >
          <List className="w-3.5 h-3.5" />
        </ToolbarButton>

        <ToolbarButton
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Lista numerada"
        >
          <ListOrdered className="w-3.5 h-3.5" />
        </ToolbarButton>

        <div className="w-px h-4 bg-border mx-1" />

        <ToolbarButton
          active={editor.isActive('link')}
          onClick={() =>
            setLinkInput(editor.isActive('link') ? (editor.getAttributes('link').href ?? '') : '')
          }
          title="Enlace"
        >
          <Link2 className="w-3.5 h-3.5" />
        </ToolbarButton>

        <ToolbarButton
          active={false}
          onClick={() => fileInputRef.current?.click()}
          title="Subir imagen"
        >
          {imageUploading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ImageIcon className="w-3.5 h-3.5" />
          )}
        </ToolbarButton>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImageUpload(file);
            e.target.value = '';
          }}
        />
      </div>

      {/* Link input bar */}
      {linkInput !== null && (
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-input bg-muted/20">
          <Link2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            autoFocus
            type="url"
            placeholder="https://..."
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink();
              if (e.key === 'Escape') setLinkInput(null);
            }}
            className="flex-1 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={applyLink}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            Aplicar
          </button>
          <button type="button" onClick={() => setLinkInput(null)}>
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      )}

      {/* Editor content */}
      <EditorContent editor={editor} />
    </div>
  );
}
