import { useEffect, useRef, useState } from 'react';
import { fromDataTransfer, fromFileList } from '../lib/picker';
import type { PickedFile } from '../lib/transfers';
import { isTouchDevice } from '../lib/device';

/** Where files are chosen or dropped. Folders keep their structure. */
export function SendPanel({
  peerDevice,
  disabled,
  onSend,
}: {
  peerDevice: string;
  disabled?: boolean;
  onSend: (files: PickedFile[]) => string | null;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touch = isTouchDevice();
  // Phones can't pick folders, so only offer it where it works.
  const canPickFolders = !touch && 'webkitdirectory' in document.createElement('input');

  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
    folderInput.current?.setAttribute('directory', '');
  }, []);

  // Accept drops anywhere on the page, not just on the panel.
  useEffect(() => {
    if (disabled) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      submit(await fromDataTransfer(e.dataTransfer));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  });

  function submit(files: PickedFile[]) {
    if (!files.length) return;
    setError(onSend(files));
  }

  return (
    <section className={`send${dragging ? ' is-dragging' : ''}${disabled ? ' is-disabled' : ''}`} aria-label="Send files">
      <div className="send-inner">
        <svg className="send-icon" viewBox="0 0 48 48" aria-hidden="true">
          <path d="M24 32V10M15 19l9-9 9 9" />
          <path d="M8 30v6a4 4 0 0 0 4 4h24a4 4 0 0 0 4-4v-6" />
        </svg>
        <h2 className="send-title">{dragging ? `Drop to send to ${peerDevice}` : `Send to ${peerDevice}`}</h2>
        {!touch && !dragging && <p className="send-hint">Drag files or folders anywhere on this page</p>}
        <div className="send-actions">
          <button className="btn btn-primary" disabled={disabled} onClick={() => fileInput.current?.click()}>
            {touch ? 'Choose photos or files' : 'Choose files'}
          </button>
          {canPickFolders && (
            <button className="btn btn-secondary" disabled={disabled} onClick={() => folderInput.current?.click()}>
              Choose folder
            </button>
          )}
        </div>
        {error && (
          <p className="send-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          submit(fromFileList(e.target.files));
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        data-testid="folder-input"
        onChange={(e) => {
          submit(fromFileList(e.target.files));
          e.target.value = '';
        }}
      />
    </section>
  );
}
