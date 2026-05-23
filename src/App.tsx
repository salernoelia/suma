import { useState, useRef, useEffect } from "react";
import { readFile, writeTextFile, mkdir, exists, stat, readDir } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { openPath, revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { analyzePdfStream } from "./lib/gemini";
import "./App.css";

const LS_API_KEY   = "gemini_api_key";
const LS_API_KEYS  = "gemini_api_keys";
const LS_MODEL     = "gemini_model";
const LS_PROMPT    = "gemini_prompt";
const LS_PROMPTS   = "suma_prompts";
const LS_ACTIVE_PROMPT_ID = "suma_active_prompt_id";
const LS_CHECKSUMS = "gemini_checksums";
const LS_HISTORY   = "suma_history";

const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const DEFAULT_PROMPT_CONTENT =
  "You are an expert academic summarizer. Create a perfectly machine-readable, exhaustive yet compact Markdown summary of this research paper. Include ALL of the following sections with proper Markdown headers:\n\n# Title\n## Authors\n## Publication Year\n## Context / Problem Statement\n## Research Objectives / Questions\n## Methods\n## Key Results & Findings\n## Conclusions\n## Limitations\n## Implications & Future Work\n\nBe exhaustive and scientifically precise. Include every quantitative detail, metric, figure, and table reference. No filler, no hallucinations.";

const DEFAULT_PROMPTS: Prompt[] = [
  {
    id: "default",
    title: "Academic Summarizer",
    content: DEFAULT_PROMPT_CONTENT,
    extension: ".md",
  }
];

type DocStatus = "queued" | "processing" | "done" | "error" | "duplicate";

interface Prompt {
  id: string;
  title: string;
  content: string;
  extension: string;
}

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

function outputPath(pdfPath: string, extension: string = ".md"): string {
  const lastSlash = pdfPath.lastIndexOf("/");
  const dir  = pdfPath.substring(0, lastSlash);
  const base = pdfPath.substring(lastSlash + 1).replace(/\.pdf$/i, "");
  return `${dir}/summary/${base}${extension}`;
}

function joinPath(p1: string, p2: string): string {
  const cleanP1 = p1.replace(/[/\\]+$/, "");
  const cleanP2 = p2.replace(/^[/\\]+/, "");
  if (p1.includes("\\")) {
    return cleanP1 + "\\" + cleanP2;
  }
  return cleanP1 + "/" + cleanP2;
}

async function traverseAndCollectPdfs(
  dirPath: string,
  rootPath: string
): Promise<{ path: string; relativePath: string }[]> {
  const results: { path: string; relativePath: string }[] = [];

  async function recurse(currentPath: string) {
    try {
      const entries = await readDir(currentPath);
      for (const entry of entries) {
        const fullPath = joinPath(currentPath, entry.name);
        if (entry.isDirectory) {
          await recurse(fullPath);
        } else if (entry.isFile && entry.name.toLowerCase().endsWith(".pdf")) {
          let relativePath = fullPath.substring(rootPath.length);
          if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
            relativePath = relativePath.substring(1);
          }
          results.push({ path: fullPath, relativePath });
        }
      }
    } catch (err) {
      console.error(`Error reading directory ${currentPath}:`, err);
    }
  }

  await recurse(dirPath);
  return results;
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

function SettingsModal({ apiKeys, model, onSave, onClose }: {
  apiKeys: string[]; model: string;
  onSave: (k: string[], m: string) => void; onClose: () => void;
}) {
  const [keys, setKeys] = useState<string[]>(apiKeys.length > 0 ? apiKeys : [""]);
  const [m, setM] = useState(model);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const handleKeyChange = (index: number, val: string) => {
    const newKeys = [...keys];
    newKeys[index] = val;
    setKeys(newKeys);
  };

  const addKeyField = () => {
    setKeys([...keys, ""]);
  };

  const removeKeyField = (index: number) => {
    if (keys.length === 1) {
      setKeys([""]);
    } else {
      setKeys(keys.filter((_, i) => i !== index));
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <label className="field-label">Gemini API Keys</label>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxHeight: "250px", overflowY: "auto", paddingRight: "4px" }}>
          {keys.map((key, idx) => (
            <div key={idx} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input className="field-input" type="password" value={key}
                onChange={(e) => handleKeyChange(idx, e.target.value)} placeholder="AIza…" autoFocus={idx === keys.length - 1 && key === ""} />
              <button className="action-btn danger" type="button" onClick={() => removeKeyField(idx)} style={{ height: "30px" }}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <button className="btn" type="button" onClick={addKeyField} style={{ marginTop: "0.25rem", alignSelf: "flex-start" }}>
          + Add API Key
        </button>
        <label className="field-label mt">Model</label>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <input className="field-input" type="text" value={m}
            onChange={(e) => setM(e.target.value)} />
          <button 
            className="btn-link" 
            style={{ alignSelf: "flex-start", fontSize: "0.7rem" }}
            onClick={() => openUrl("https://ai.google.dev/gemini-api/docs/models").catch(console.error)}
          >
            View all available models ↗
          </button>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => {
            const filteredKeys = keys.map(k => k.trim()).filter(k => k.length > 0);
            onSave(filteredKeys.length > 0 ? filteredKeys : [""], m);
            onClose();
          }}>Save</button>
        </div>
      </div>
    </div>
  );
}

function PromptModal({ prompts, activeId, onSave, onClose }: {
  prompts: Prompt[]; activeId: string;
  onSave: (ps: Prompt[], activeId: string) => void; onClose: () => void;
}) {
  const [localPrompts, setLocalPrompts] = useState<Prompt[]>(prompts);
  const [currentId, setCurrentId] = useState(activeId);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const currentPrompt = localPrompts.find(p => p.id === currentId) ?? localPrompts[0];

  const updateCurrent = (updates: Partial<Prompt>) => {
    setLocalPrompts(prev => prev.map(p => p.id === currentId ? { ...p, ...updates } : p));
  };

  const addNew = () => {
    const newP: Prompt = { id: crypto.randomUUID(), title: "New Prompt", content: "", extension: ".md" };
    setLocalPrompts([...localPrompts, newP]);
    setCurrentId(newP.id);
  };

  const duplicatePrompt = (p: Prompt) => {
    const newP: Prompt = { ...p, id: crypto.randomUUID(), title: `${p.title} (Copy)` };
    setLocalPrompts([...localPrompts, newP]);
    setCurrentId(newP.id);
  };

  const deletePrompt = (id: string) => {
    if (localPrompts.length <= 1) return;
    const remaining = localPrompts.filter(p => p.id !== id);
    setLocalPrompts(remaining);
    if (currentId === id) {
      setCurrentId(remaining[0].id);
    }
  };

  const extensions = [".md", ".txt", ".csv", ".json"];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-wide modal-tall" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", flexDirection: "column" }}>
            <h2 style={{ marginBottom: 0 }}>Prompt Templates</h2>
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Manage and switch between different summary styles</span>
          </div>
          <div className="modal-header-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={() => { onSave(localPrompts, currentId); onClose(); }}>Save All</button>
          </div>
        </div>

        <div className="prompt-modal-container">
          <div className="prompt-sidebar">
            <div className="prompt-list">
              {localPrompts.map(p => (
                <div key={p.id} className="prompt-item-container">
                  <button 
                    className={`prompt-item ${p.id === currentId ? "active" : ""}`}
                    onClick={() => setCurrentId(p.id)}
                    style={{ flex: 1 }}
                  >
                    {p.title || "Untitled"}
                  </button>
                </div>
              ))}
            </div>
            <button className="btn" onClick={addNew} style={{ marginTop: "0.5rem" }}>
              + New Template
            </button>
          </div>

          <div className="prompt-editor">
            <div className="prompt-title-row">
              <input 
                className="prompt-title-input"
                value={currentPrompt.title}
                onChange={(e) => updateCurrent({ title: e.target.value })}
                placeholder="Prompt Title"
              />
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <span className="field-label" style={{ margin: 0, textTransform: "none" }}>Format:</span>
                <select 
                  className="prompt-select" 
                  style={{ background: "var(--bg)", border: "1px solid var(--border)" }}
                  value={currentPrompt.extension || ".md"}
                  onChange={(e) => updateCurrent({ extension: e.target.value })}
                >
                  {extensions.map(ext => <option key={ext} value={ext}>{ext}</option>)}
                </select>
                <button 
                  className="btn" 
                  onClick={() => duplicatePrompt(currentPrompt)}
                  title="Duplicate this prompt"
                >
                  Duplicate
                </button>
                {localPrompts.length > 1 && (
                  <button 
                    className="btn danger" 
                    onClick={() => deletePrompt(currentId)}
                    title="Delete this prompt"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <div className="prompt-content-area">
              <label className="field-label">Template Content</label>
              <textarea 
                className="field-input" 
                style={{ marginTop: "0.4rem" }}
                value={currentPrompt.content}
                onChange={(e) => updateCurrent({ content: e.target.value })}
                placeholder="Write your prompt here..."
                autoFocus 
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultModal({ doc, onClose, onResave }: {
  doc: Doc; onClose: () => void; onResave: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

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

function ConfirmModal({ message, onConfirm, onClose }: {
  message: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Confirm Action</h2>
        <p style={{ color: "var(--text-muted)", fontSize: "0.825rem", margin: "0.5rem 0 1rem", lineHeight: "1.4" }}>
          {message}
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { onConfirm(); onClose(); }} style={{ backgroundColor: "var(--red)", borderColor: "var(--red)" }}>
            Clear List
          </button>
        </div>
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
  const [apiKeys, setApiKeys] = useState<string[]>(() => {
    const stored = localStorage.getItem(LS_API_KEYS);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }
    const legacy = localStorage.getItem(LS_API_KEY);
    if (legacy) return [legacy];
    return [""];
  });
  const [model,  setModel]  = useState(() => localStorage.getItem(LS_MODEL)   ?? DEFAULT_MODEL);
  
  const [prompts, setPrompts] = useState<Prompt[]>(() => {
    const stored = localStorage.getItem(LS_PROMPTS);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {}
    }
    const legacy = localStorage.getItem(LS_PROMPT);
    if (legacy) {
      return [{ id: "legacy", title: "Legacy Prompt", content: legacy }, ...DEFAULT_PROMPTS];
    }
    return DEFAULT_PROMPTS;
  });

  const [activePromptId, setActivePromptId] = useState(() => 
    localStorage.getItem(LS_ACTIVE_PROMPT_ID) ?? prompts[0].id
  );

  const activePrompt = prompts.find(p => p.id === activePromptId) ?? prompts[0];

  const [docs, setDocs] = useState<Doc[]>(() =>
    loadHistory().map((d) => ({ ...d, base64: "", fromHistory: true }))
  );
  const [dragging,        setDragging]        = useState(false);
  const [showSettings,    setShowSettings]    = useState(false);
  const [showPrompt,      setShowPrompt]      = useState(false);
  const [viewDoc,         setViewDoc]         = useState<Doc | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const processingIds = useRef<Set<string>>(new Set());

  useEffect(() => { persistHistory(docs); }, [docs]);

  function saveSettings(keys: string[], m: string) {
    setApiKeys(keys); setModel(m);
    localStorage.setItem(LS_API_KEYS, JSON.stringify(keys));
    localStorage.setItem(LS_MODEL, m);
    if (keys.length > 0) {
      localStorage.setItem(LS_API_KEY, keys[0]);
    } else {
      localStorage.removeItem(LS_API_KEY);
    }
  }

  function updatePrompts(newPrompts: Prompt[], newActiveId: string) {
    setPrompts(newPrompts);
    setActivePromptId(newActiveId);
    localStorage.setItem(LS_PROMPTS, JSON.stringify(newPrompts));
    localStorage.setItem(LS_ACTIVE_PROMPT_ID, newActiveId);
  }

  async function enqueue(filePath: string, name: string, bytes: Uint8Array, customOutPath?: string) {
    const checksum = await sha256hex(bytes);
    const out = customOutPath ?? outputPath(filePath, activePrompt.extension || ".md");
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

  const enqueueRef = useRef(enqueue);
  useEffect(() => {
    enqueueRef.current = enqueue;
  });

  useEffect(() => {
    type Payload = { paths: string[] };
    const ul  = listen<Payload>("tauri://drag-drop", async (e) => {
      setDragging(false);
      for (const path of e.payload.paths) {
        try {
          const info = await stat(path);
          if (info.isDirectory) {
            const pdfs = await traverseAndCollectPdfs(path, path);
            for (const pdf of pdfs) {
              const bytes = await readFile(pdf.path);
              const safeName = pdf.relativePath.replace(/[/\\]/g, "_");
              const baseName = safeName.replace(/\.pdf$/i, "");
              const outDir = joinPath(path, "summaries");
              const customOutPath = joinPath(outDir, `${baseName}${activePrompt.extension || ".md"}`);
              await enqueueRef.current(pdf.path, pdf.relativePath, bytes, customOutPath);
            }
          } else if (path.toLowerCase().endsWith(".pdf")) {
            const bytes = await readFile(path);
            await enqueueRef.current(path, path.split("/").pop() ?? path, bytes);
          }
        } catch (err) {
          console.error(`Error processing path ${path}:`, err);
        }
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

  async function processDoc(doc: Doc) {
    if (processingIds.current.has(doc.id)) return;
    processingIds.current.add(doc.id);

    const activeKeys = apiKeys.filter(k => k.trim().length > 0);
    if (activeKeys.length === 0) {
      setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "error", progress: "No Gemini API Key provided." } : d));
      processingIds.current.delete(doc.id);
      return;
    }

    let success = false;
    let lastError: any = null;

    for (let i = 0; i < activeKeys.length; i++) {
      const currentKey = activeKeys[i];
      try {
        let result = "";
        const keyIndicator = activeKeys.length > 1 ? ` (Key ${i + 1}/${activeKeys.length})` : "";
        setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "processing", progress: `Initializing connection...${keyIndicator}` } : d));

        await analyzePdfStream(currentKey, model, doc.base64, activePrompt.content, (text) => {
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
        success = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(`API Key ${i + 1} failed for ${doc.name}:`, err);
      }
    }

    if (!success) {
      const msg = lastError instanceof Error ? lastError.message : String(lastError);
      setDocs((prev) => prev.map((d) => d.id === doc.id ? { ...d, status: "error", progress: `All API keys failed. Last error: ${msg}` } : d));
    }
    
    processingIds.current.delete(doc.id);
  }

  useEffect(() => {
    const queued = docs.filter((d) => d.status === "queued" && !processingIds.current.has(d.id));
    const activeKeys = apiKeys.filter(k => k.trim().length > 0);
    if (queued.length === 0 || activeKeys.length === 0) return;
    for (const doc of queued) processDoc(doc);
  }, [docs, apiKeys]); // eslint-disable-line react-hooks/exhaustive-deps

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
        
        <div className="topbar-center">
          <div className="prompt-selector">
            <span className="prompt-selector-label">Active Prompt:</span>
            <select 
              className="prompt-select"
              value={activePromptId} 
              onChange={(e) => {
                if (e.target.value === "new") {
                  const newPrompt: Prompt = {
                    id: crypto.randomUUID(),
                    title: "New Prompt",
                    content: "",
                    extension: ".md"
                  };
                  updatePrompts([...prompts, newPrompt], newPrompt.id);
                  setShowPrompt(true);
                } else {
                  setActivePromptId(e.target.value);
                  localStorage.setItem(LS_ACTIVE_PROMPT_ID, e.target.value);
                }
              }}
            >
              {prompts.map(p => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
              <option value="new">+ Add New Prompt...</option>
            </select>
          </div>
        </div>

        <div className="topbar-actions">
          {hasActive && <span className="processing-indicator">Processing…</span>}
          {errorIds.length > 0 && (
            <button className="btn" onClick={() => errorIds.forEach(forceDoc)}>
              Retry failed ({errorIds.length})
            </button>
          )}
          {docs.length > 0 && (
            <button className="btn" onClick={() => setShowClearConfirm(true)}>
              Clear List
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
              {[...docs].reverse().map((doc) => (
                <tr key={doc.id}>
                  <td className="td-name">
                    <button className="file-link-btn" title="Reveal in directory" onClick={() => revealItemInDir(doc.path).catch(console.error)}>
                      {doc.name}
                    </button>
                  </td>
                  <td className="td-out">
                    <button className="out-path-btn" title="Open output directory" onClick={() => revealItemInDir(doc.outputPath).catch(console.error)}>
                      {doc.outputPath}
                    </button>
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

      {showSettings && <SettingsModal apiKeys={apiKeys} model={model} onSave={saveSettings} onClose={() => setShowSettings(false)} />}
      {showPrompt   && <PromptModal   prompts={prompts} activeId={activePromptId} onSave={updatePrompts} onClose={() => setShowPrompt(false)} />}
      {showClearConfirm && (
        <ConfirmModal
          message="Are you sure you want to clear all documents from the list? This will not delete the files on your disk."
          onConfirm={() => {
            setDocs([]);
            processingIds.current.clear();
          }}
          onClose={() => setShowClearConfirm(false)}
        />
      )}
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
