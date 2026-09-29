/**
 * Files on a board: a single file, or a folder of them.
 *
 * Not an editor. The other four artefact kinds are authored here and saved
 * back; these are bytes we did not write and cannot change, so the page is a
 * list, an upload control and a set of download links. There is no autosave
 * and nothing to flush, which is why this uses `ArtefactFrame` directly rather
 * than `useArtefactEditor`.
 *
 * Downloads point at the mindbox origin, never at this one. The URLs are
 * signed and expire, so they are fetched with the listing rather than built
 * here — the server mints them only after checking what the viewer may see.
 *
 * The description field is required for anything we cannot read text out of,
 * and the form says so before the upload rather than after. It is the only
 * thing that makes a zip or a spreadsheet findable by meaning later, which is
 * the entire reason for keeping files here instead of on a disk somewhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type StoredFile } from "../api";
import { ArtefactFrame } from "./ArtefactFrame";
import { ShareMenu } from "../ShareMenu";

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

const readable = (name: string, type: string, size: number) => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const textual = type.startsWith("text/") || TEXT_EXTENSIONS.has(ext);
  return textual && size <= TEXT_SNAPSHOT_MAX;
};

const size = (bytes: number) =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} kB`;

const when = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

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
  const picker = useRef<HTMLInputElement>(null);

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

  // A `file` node holds one file, so once it has one the upload form is not an
  // option that happens to fail — it should not be there.
  const full = kind === "file" && !!files?.length;
  const needsDescription = staged ? !readable(staged.name, staged.type, staged.size) : false;

  const upload = async () => {
    if (!staged) return;
    setBusy(true);
    setUploadError(null);
    try {
      await api.uploadFile(nodeId, staged, description);
      setStaged(null);
      setDescription("");
      if (picker.current) picker.current.value = "";
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
          <ul className="file-list">
            {files!.map((f) => (
              <li key={f.id} className="file-row">
                <div className="file-main">
                  <span className="file-name">{f.name}</span>
                  <span className="file-meta">
                    {size(f.size)} · {f.contentType} · {when(f.uploadedAt)}
                  </span>
                  {f.description ? <p className="file-desc">{f.description}</p> : null}
                </div>
                <div className="file-actions">
                  {f.url ? (
                    <a
                      className="card-open"
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open
                    </a>
                  ) : (
                    // No signing key configured. Saying so beats an Open link
                    // that 503s, and beats serving the bytes from this origin.
                    <span className="file-meta">Downloads unavailable</span>
                  )}
                  <button className="file-x" onClick={() => void remove(f)} title="Delete">
                    ×
                  </button>
                </div>
              </li>
            ))}
            {!files!.length ? <li className="sheet-msg">Nothing here yet.</li> : null}
          </ul>

          {full ? null : (
            <div className="file-upload">
              <input
                ref={picker}
                type="file"
                onChange={(e) => {
                  setStaged(e.target.files?.[0] ?? null);
                  setUploadError(null);
                }}
              />

              {staged ? (
                <>
                  <label className="file-desc-label">
                    {needsDescription ? "What is this? (required)" : "What is this? (optional)"}
                    <input
                      className="file-desc-input"
                      value={description}
                      placeholder={
                        needsDescription
                          ? "One line — this is what makes it findable later"
                          : "Its text is indexed, so this is only for context"
                      }
                      onChange={(e) => setDescription(e.target.value)}
                    />
                  </label>

                  <button
                    className="card-open"
                    disabled={busy || (needsDescription && !description.trim())}
                    onClick={() => void upload()}
                  >
                    {busy ? "Uploading…" : `Upload ${staged.name}`}
                  </button>
                </>
              ) : null}

              {uploadError ? <p className="sheet-msg sheet-err">{uploadError}</p> : null}
            </div>
          )}
        </div>
      )}
    </ArtefactFrame>
  );
}

export default FileView;
