/**
 * Files on a board: a single file, or a folder of them.
 *
 * Not an editor. The other four artefact kinds are authored here and saved
 * back; these are bytes we did not write and cannot change, so the page is a
 * list, a way to add to it and a way out to the contents. There is no autosave
 * and nothing to flush, which is why this uses `ArtefactFrame` directly rather
 * than `useArtefactEditor`.
 *
 * Downloads point at the mindbox origin, never at this one. The URLs are
 * signed and expire, so they are fetched with the listing rather than built
 * here — the server mints them only after checking what the viewer may see.
 *
 * **Staging is the whole shape of this page.** A file is chosen or dropped, and
 * then sits there while its description is written, and only then uploads.
 * That order is what makes drag-and-drop possible at all: anything we cannot
 * read text out of needs a line saying what it is, and a drop has nowhere to
 * ask. Uploading on drop and refusing afterwards would mean the gesture fails
 * for exactly the files that most need to be kept.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type StoredFile } from "../api";
import { ArtefactFrame } from "./ArtefactFrame";
import { ShareMenu } from "../ShareMenu";
import { FileIcon, categorise } from "../ui/FileIcon";

/** Mirrors `isTextual` in the Worker, for the hint shown beside the field. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "csv", "tsv", "json", "jsonl", "ndjson",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm",
  "css", "scss", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "go",
  "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
  "sh", "bash", "zsh", "fish", "sql", "graphql", "gql", "proto", "tf",
  "dockerfile", "gitignore", "log", "diff", "patch",
]);

const TEXT_SNAPSHOT_MAX = 256_000;
const MAX_FILE_BYTES = 50_000_000;

/** Whether the server will read this file's text, and so not insist on a line. */
const readable = (name: string, type: string, size: number) => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return (type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) && size <= TEXT_SNAPSHOT_MAX;
};

const size = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} kB`;

const when = (ms: number) => {
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export function FileView() {
  const { nodeId = "" } = useParams();

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"file" | "folder">("folder");
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [staged, setStaged] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const descField = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [node, listing] = await Promise.all([api.node(nodeId), api.files(nodeId)]);
      setTitle(node.title ?? "");
      setKind(node.type === "file" ? "file" : "folder");
      setFiles(listing.files);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [nodeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveTitle = useCallback(
    (t: string) => {
      setTitle(t);
      void api.updateNode(nodeId, { title: t });
    },
    [nodeId],
  );

  // A `file` node holds one file, so once it has one the upload control is not
  // an option that happens to fail — it should not be on the page.
  const full = kind === "file" && !!files?.length;
  const needsDescription = staged ? !readable(staged.name, staged.type, staged.size) : false;
  const tooBig = staged ? staged.size > MAX_FILE_BYTES : false;

  /** Take a file from either gesture and put it in the same staging state. */
  const stage = useCallback((f: File | null) => {
    setStaged(f);
    setUploadError(null);
    setDescription("");
    // The description is the one thing that needs typing, so put the caret
    // there rather than making someone reach for it after every drop.
    if (f) setTimeout(() => descField.current?.focus(), 0);
  }, []);

  const clear = () => {
    setStaged(null);
    setDescription("");
    setUploadError(null);
    if (picker.current) picker.current.value = "";
  };

  const upload = async () => {
    if (!staged) return;
    setBusy(true);
    setUploadError(null);
    try {
      await api.uploadFile(nodeId, staged, description);
      clear();
      await load();
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (file: StoredFile) => {
    if (!confirm(`Delete ${file.name}? It can be restored for seven days.`)) return;
    try {
      await api.deleteFile(file.id);
      await load();
    } catch (e) {
      setUploadError((e as Error).message);
    }
  };

  return (
    <ArtefactFrame
      title={title}
      onTitle={saveTitle}
      state=""
      placeholder={kind === "file" ? "Untitled file" : "Untitled folder"}
      error={error}
      loading={files === null}
      dirty={false}
      onLeave={() => {}}
      actions={<ShareMenu nodeId={nodeId} />}
    >
      {() => (
        <div className="files">
          {files!.length ? (
            <ul className="file-list">
              {files!.map((f) => (
                <li key={f.id} className={`file-row ${categorise(f.name, f.contentType)}`}>
                  <span className="file-glyph">
                    <FileIcon category={categorise(f.name, f.contentType)} size={16} />
                  </span>

                  <div className="file-main">
                    <span className="file-name">{f.name}</span>
                    {f.description ? <p className="file-desc">{f.description}</p> : null}
                  </div>

                  <span className="file-meta">{size(f.size)}</span>
                  <span className="file-meta">{when(f.uploadedAt)}</span>

                  <div className="file-actions">
                    {f.url ? (
                      <a className="file-open" href={f.url} target="_blank" rel="noopener noreferrer">
                        Open
                      </a>
                    ) : (
                      // No signing key configured. Saying so beats an Open link
                      // that 503s, and beats serving bytes from the app origin.
                      <span className="file-meta">No downloads</span>
                    )}
                    <button className="file-x" onClick={() => void remove(f)} title="Delete">
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {full ? null : staged ? (
            /* Staged: the file is chosen, and the only thing left is the line
               that will find it again. */
            <div className="file-stage">
              <span className="file-glyph">
                <FileIcon category={categorise(staged.name, staged.type)} size={16} />
              </span>
              <div className="file-stage-main">
                <span className="file-name">{staged.name}</span>
                <span className={tooBig ? "file-refused" : "file-meta"}>
                  {size(staged.size)}
                  {tooBig ? ` — over the ${MAX_FILE_BYTES / 1_000_000} MB limit` : ""}
                </span>

                {/* Nothing below is worth showing for a file that cannot be
                    uploaded at all. Asking someone to describe it first and
                    refusing afterwards is wasted typing. */}
                {tooBig ? null : (
                  <>
                    <input
                      ref={descField}
                      className="file-desc-input"
                      value={description}
                      placeholder={
                        needsDescription
                          ? "What is this? One line — it is what will find it again"
                          : "What is this? Optional — its text is already indexed"
                      }
                      onChange={(e) => setDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !(needsDescription && !description.trim()))
                          void upload();
                        if (e.key === "Escape") clear();
                      }}
                    />
                    {needsDescription ? (
                      <span className="file-hint">
                        We cannot read text out of this one, so this line is the only thing that
                        will find it later.
                      </span>
                    ) : null}
                  </>
                )}
              </div>

              <div className="file-actions">
                <button className="file-cancel" onClick={clear} disabled={busy}>
                  Cancel
                </button>
                <button
                  className="file-upload-go"
                  disabled={busy || tooBig || (needsDescription && !description.trim())}
                  onClick={() => void upload()}
                >
                  {busy ? "Uploading…" : "Upload"}
                </button>
              </div>
            </div>
          ) : (
            /* Idle: the drop target, which is also the picker. */
            <label
              className={`file-drop${over ? " over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                // One at a time: each file needs its own description, and a
                // queue of them is a different page than this one.
                stage(e.dataTransfer?.files?.[0] ?? null);
              }}
            >
              <input
                ref={picker}
                type="file"
                onChange={(e) => stage(e.target.files?.[0] ?? null)}
              />
              <span className="file-drop-main">
                {files!.length ? "Add another file" : "Drop a file here"}
              </span>
              <span className="file-drop-sub">
                or click to choose · up to {MAX_FILE_BYTES / 1_000_000} MB
              </span>
            </label>
          )}

          {uploadError ? <p className="file-error">{uploadError}</p> : null}
        </div>
      )}
    </ArtefactFrame>
  );
}

export default FileView;
