import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { useEffect, useRef } from 'react';

if (typeof self !== 'undefined') {
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}

export function MonacoDiff({
  original,
  modified,
  language,
  theme,
  sideBySide,
}: {
  original: string;
  modified: string;
  language: string;
  theme: string;
  sideBySide: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (container.current === null) return;
    const originalModel = monaco.editor.createModel(original, language);
    const modifiedModel = monaco.editor.createModel(modified, language);
    const editor = monaco.editor.createDiffEditor(container.current, {
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      originalEditable: false,
      readOnly: true,
      renderSideBySide: sideBySide,
      scrollBeyondLastLine: false,
      wordWrap: 'on',
    });
    editor.setModel({ original: originalModel, modified: modifiedModel });
    monaco.editor.setTheme(theme === 'vs-dark' ? 'vs-dark' : 'vs');

    return () => {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [language, modified, original, sideBySide, theme]);

  return <div ref={container} className="h-[34rem] w-full" aria-label="Validated patch diff" />;
}
