import { useState, useRef, useEffect } from "react";
import { readFile, writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { analyzePdfStream } from "./lib/gemini";
import "./App.css";

const LS_API_KEY   = "gemini_api_key";
const LS_MODEL     = "gemini_model";
const LS_PROMPT    = "gemini_prompt";
const LS_CHECKSUMS = "gemini_checksums";
const LS_HISTORY   = "suma_history";

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";
const DEFAULT_PROMPT =
  "You are an expert academic summarizer. Create a perfectly machine-readable, exhaustive yet compact Markdown summary of this research paper. Include ALL of the following sections with proper Markdown headers:\n\n# Title\n## Authors\n## Publication Year\n## Context / Problem Statement\n## Research Objectives / Questions\n## Methods\n## Key Results & Findings\n## Conclusions\n## Limitations\n## Implications & Future Work\n\nBe exhaustive and scientifically precise. Include every quantitative detail, metric, figure, and table reference. No filler, no hallucinations.";

type DocStatus = "queued" | "processing" | "done" | "error" | "duplicate";

interface Doc {
  id: string;
  name: string;
  path: string;
  base64: string;
  checksum: string;
  status: DocStatus;
  progress: string;
  outputPath: string;
  duplicateOf?: string;
  forced: boolean;
  fromHistory: boolean;
}

type StoredDoc = Omit<Doc, "base64">;

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function outputPath(pdfPath: string): string {
  const lastSlash = pdfPath.lastIndexOf("/");
  const dir  = pdfPath.substring(0, lastSlash);
  const base = pdfPath.substring(lastSlash + 1).replace(/\.pdf$/i, "");
  return `${dir}/summary/${base}.md`;
}

function loadChecksums(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LS_CHECKSUMS) ?? "{}"); }
  catch { return {}; }
}
function saveChecksums(c: Record<string, string>) {
  localStorage.setItem(LS_CHECKSUMS, JSON.stringify(c));
}

function loadHistory(): StoredDoc[] {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) ?? "[]"); }
  catch { return []; }
}
function persistHistory(docs: Doc[]) {
  const toStore: StoredDoc[] = docs
    .filter((d) => d.status === "done" || d.status === "error")
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ base64: _b, ...rest }) => rest);
  localStorage.setItem(LS_HISTORY, JSON.stringify(toStore));
}

async function resaveDoc(doc: Doc) {
  const dir = doc.outputPath.substring(0, doc.outputPath.lastIndexOf("/"));
  if (!await exists(dir)) await mkdir(dir, { recursive: true });
  await writeTextFile(doc.outputPath, doc.progress);
}

function SettingsModal({ apiKey, model, onSave, onClose }: {
  apiKey: string; model: string;
  onSave: (k: string, m: string) => void; onClose: () => void;
}) {
  const [k, setK] = useState(apiKey);
  const [m, setM] = useState(model);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="field-label">Gemini API Key</label>
        <input className="field-input" type="password" value={k}
          onChange={(e) => setK(e.target.value)} placeholder="AIza…" autoFocus />
        <label className="field-label mt">Model</label>
        <input className="field-input" type="text" value={m}
          onChange={(e) => setM(e.target.value)} />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onSave(k, m); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function PromptModal({ prompt, onSave, onClose }: {
  prompt: string; onSave: (p: string) => void; onClose: () => void;
}) {
  const [p, setP] = useState(prompt);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide modal-tall" onClick={(e) => e.stopPropagation()}>
        <h2>Prompt Template</h2>
        <textarea className="field-input" rows={12} value={p}
          onChange={(e) => setP(e.target.value)} autoFocus />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onSave(p); onClose(); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ResultModal({ doc, onClose, onResave }: {
  doc: Doc; onClose: () => void; onResave: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(doc.progress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide modal-tall" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{doc.name}</h2>
          <div className="modal-header-actions">
            <button className="btn" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
            {doc.status === "done" && (
              <button className="btn" onClick={(e) => { e.stopPropagation(); onResave(); }}>
                Re-save
              </button>
            )}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
        {doc.status === "error"
          ? <p className="error-text">{doc.progress}</p>
          : <pre className="result-pre">{doc.progress}</pre>}
      </div>
    </div>
  );
}
function Badge({ status }: { status: DocStatus }) {
  const cls: Record<DocStatus, string> = {
    queued: "badge-gray", processing: "badge-blue",
    done: "badge-green", error: "badge-red", duplicate: "badge-yellow",
  };
  return <span className={`badge ${cls[status]}`}>{status}</span>;
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_API_KEY) ?? "");
  const [model,  setModel]  = useState(() => localStorage.getItem(LS_MODEL)   ?? DEFAULT_MODEL);
  const [prompt, setPrompt] = useState(() => localStorage.getItem(LS_PROMPT)  ?? DEFAULT_PROMPT);

  const [docs, setDocs] = useState<Doc[]>(() =>
    loadHistory().map((d) => ({ ...d, base64: "", fromHistory: true }))
  );
  const [dragging,        setDragging]        = useState(false);
  const [showSettings,    setShowSettings]    = useState(false);
  const [showPrompt,      setShowPrompt]      = useState(false);
  const [viewDoc,         setViewDoc]         = useState<Doc | null>(null);
  const [editingOutId,    setEditingOutId]    = useState<string | null>(null);
  const [editingOutValue, setEditingOutValue] = useState("");

  const processingIds = useRef<Set<string>>(new Set());

  useEffect(() => { persistHistory(docs); }, [docs]);

  function saveSettings(k: string, m: string) {
    setApiKey(k); setModel(m);
    localStorage.setItem(LS_API_KEY, k);
    localStorage.setItem(LS_MODEL, m);
  }
  function savePrompt(p: string) {
    setPrompt(p);
    localStorage.setItem(LS_PROMPT, p);
  }

  async function enqueue(filePath: string, name: string, bytes: Uint8Array) {
    const checksum = await sha256hex(bytes);
    const out = outputPath(filePath);
    const checksums = loadChecksums();

    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk)
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    const base64 = btoa(binary);

    const alreadyDone = checksums[checksum];
    const status: DocStatus = alreadyDone ? "duplicate" : "queued";

    const doc: Doc = {
      id: crypto.randomUUID(), name, path: filePath, base64, checksum,
      status, progress: "", outputPath: out,
      duplicateOf: alreadyDone, forced: false, fromHistory: false,
    };

    setDocs((prev) => {
      if (prev.some((d) => d.checksum === checksum && !d.forced && d.status !== "error")) {
        return prev;
      }
      return [...prev, doc];
    });
  }


  useEffect(() => {
    type Payload = { paths: string[] };
    const ul  = listen<Payload>("tauri://drag-drop", async (e) => {
      setDragging(false);
      for (const path of e.payload.paths) {
        if (!path.toLowerCase().endsWith(".pdf")) continue;
        const bytes = await readFile(path);
        await enqueue(path, path.split("/").pop() ?? path, bytes);
      }
    });
    const ule = listen("tauri://drag-enter", () => setDragging(true));
    const ull = listen("tauri://drag-leave", () => setDragging(false));
    return () => { ul.then((f) => f()); ule.then((f) => f()); ull.then((f) => f()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function forceDoc(id: string) {
    setDocs((prev) =>
      prev.map((d) => d.id === id
        ? { ...d, status: "queued", forced: true, progress: "", duplicateOf: undefined }
        : d)
    );
  }

  function removeDoc(id: string) {
    setDocs((prev) => prev.filter((d) => d.id !== id));
  }

  function startEditingOutput(doc: Doc) {
    setEditingOutId(doc.id);
    setEditingOutValue(doc.outputPath);
  }

  function commitOutputEdit(id: string) {
    const value = editingOutValue.trim();
    if (value) setDocs((prev) => prev.map((d) => d.id === id ? { ...d, outputPath: value } : d));
    setEditingOutId(null);
  }

  function resetOutputPath(id: string) {
    setDocs((prev) => prev.map((d) => {
      if (d.id !== id) return d;
      const def = outputPath(d.path);
      if (editingOutId === id) setEditingOutValue(def);
      return { ...d, outputPath: def };
    }));
  }

  async function processDoc(doc: Doc) {
    if (processingIds.current.has(doc.id)) return;
    processingIds.current.add(doc.id);
    setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "processing" } : d));
    try {
      let result = "";
      await analyzePdfStream(apiKey, model, doc.base64, prompt, (text) => {
        result += text;
        setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, progress: result } : d));
      });
      const dir = doc.outputPath.substring(0, doc.outputPath.lastIndexOf("/"));
      if (!await exists(dir)) await mkdir(dir, { recursive: true });
      await writeTextFile(doc.outputPath, result);
      const checksums = loadChecksums();
      checksums[doc.checksum] = doc.outputPath;
      saveChecksums(checksums);
      setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "done", progress: result } : d));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "error", progress: msg } : d));
    } finally {
      processingIds.current.delete(doc.id);
    }
  }

  useEffect(() => {
    const queued = docs.filter((d) => d.status === "queued" && !processingIds.current.has(d.id));
    if (queued.length === 0 || !apiKey.trim()) return;
    for (const doc of queued) processDoc(doc);
  }, [docs, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep result modal in sync with streaming updates
  useEffect(() => {
    if (!viewDoc) return;
    const updated = docs.find((d) => d.id === viewDoc.id);
    if (updated) setViewDoc(updated);
  }, [docs]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasActive  = docs.some((d) => d.status === "processing");
  const errorIds   = docs.filter((d) => d.status === "error").map((d) => d.id);

  return (
    <div className={`app ${dragging ? "app-dragging" : ""}`}>
      <header className="topbar">
        <span className="topbar-title">Suma</span>
        <div className="topbar-actions">
          {hasActive && <span className="processing-indicator">Processing…</span>}
          {errorIds.length > 0 && (
            <button className="btn" onClick={() => errorIds.forEach(forceDoc)}>
              Retry failed ({errorIds.length})
            </button>
          )}
          <button className="btn" onClick={() => setShowPrompt(true)}>Prompt</button>
          <button className="btn" onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>


      {docs.length > 0 ? (
        <div className="table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Output</th>
                <th>Status</th>
                <th style={{ textAlign: "center" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <td className="td-name">{doc.name}</td>
                  <td className="td-out">
                    {editingOutId === doc.id ? (
                      <div className="out-edit-row">
                        <input
                          className="out-edit-input"
                          value={editingOutValue}
                          onChange={(e) => setEditingOutValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitOutputEdit(doc.id);
                            if (e.key === "Escape") setEditingOutId(null);
                          }}
                          autoFocus
                        />
                        <button className="action-btn" onClick={() => commitOutputEdit(doc.id)}>Save</button>
                        <button className="action-btn" onClick={() => resetOutputPath(doc.id)}>Reset</button>
                        <button className="action-btn" onClick={() => setEditingOutId(null)}>Cancel</button>
                      </div>
                    ) : (
                      <button className="out-path-btn" title="Click to edit output path" onClick={() => startEditingOutput(doc)}>
                        {doc.outputPath}
                      </button>
                    )}
                  </td>
                  <td className="td-status">
                    <Badge status={doc.status} />
                    {doc.status === "duplicate" && (
                      <span className="dup-hint">already summarized</span>
                    )}
                  </td>
                  <td className="td-actions">
                    <div className="td-actions-inner">
                      {(doc.status === "done" || doc.status === "error" || doc.status === "processing") && (
                        <button className="action-btn" onClick={() => setViewDoc(doc)}>View</button>
                      )}
                      {doc.status === "done" && (
                        <button className="action-btn" onClick={() => resaveDoc(doc)}>Re-save</button>
                      )}
                      {doc.status === "duplicate" && (
                        <button className="action-btn" onClick={() => forceDoc(doc.id)}>Re-run</button>
                      )}
                      {doc.status === "error" && (
                        <button className="action-btn" onClick={() => forceDoc(doc.id)}>Retry</button>
                      )}
                      {doc.status !== "processing" && (
                        <button className="action-btn danger" onClick={() => removeDoc(doc.id)}>Remove</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">Drop one or more PDFs to get started.</p>
      )}

      {dragging && <div className="drag-overlay"><span>Drop PDFs to add</span></div>}

      {showSettings && <SettingsModal apiKey={apiKey} model={model} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
      {showPrompt   && <PromptModal   prompt={prompt}               onSave={savePrompt}   onClose={() => setShowPrompt(false)} />}
      {viewDoc      && (
        <ResultModal
          doc={viewDoc}
          onClose={() => setViewDoc(null)}
          onResave={() => resaveDoc(viewDoc)}
        />
      )}
    </div>
  );
}
