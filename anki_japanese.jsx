import { useState, useCallback, useEffect, useRef } from "react";

const DECK_KEY = "anki-deck-v7";
const KNOWN_KEY = "anki-known-v1";

const JO = { N5: 0, N4: 1, N3: 2, N2: 3, N1: 4, biz: 5, other: 6 };
const sortJLPT = (arr, k = "level") => [...arr].sort((a, b) => (JO[a[k]] ?? 6) - (JO[b[k]] ?? 6));
const LC = { N5: "#6b9e78", N4: "#5a8fa8", N3: "#7b7fb5", N2: "#b07a9e", N1: "#c4785a", biz: "#8a7a5a", other: "#5a6a7a" };

function buildTSV(cards) {
  return cards.map((c) => {
    if (c.type === "vocab") {
      let back = `【${c.level}】${c.meaning}\n\n例: ${c.example || ""}`;
      if (c.synonyms?.length) { back += "\n\n── Synonyms ──"; for (const s of c.synonyms) back += `\n• ${s.word} (${s.reading}) 【${s.level}】→ ${s.meaning}${s.nuance ? ` [${s.nuance}]` : ""}`; }
      if (c.nuanceTip) back += `\n\n💡 ${c.nuanceTip}`;
      return `${c.word} (${c.reading})\t${back}\tvocab`;
    } else if (c.type === "grammar") {
      return `📝 ${c.title}\t【${c.level}】${c.explanation}\n\n例: ${c.example}\tgrammar`;
    } else if (c.type === "sentence") {
      let back = c.furigana || c.original;
      if (c.english) back += `\n\n${c.english}`;
      if (c.keyVocab?.length) { back += "\n\n── Key Vocab ──"; for (const k of c.keyVocab) back += `\n• ${k.word} (${k.reading}) → ${k.meaning}`; }
      return `${c.original}\t${back}\tsentence`;
    }
    return "";
  }).join("\n");
}

function parseKnownWords(text) {
  const words = new Set();
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let raw = line.split("\t")[0].trim().replace(/\s*[\(（].*?[\)）]\s*/g, "").replace(/^\d+[\.\)]\s*/, "").replace(/^[📝🔹•\-\*]\s*/, "").trim();
    if (raw && raw.length <= 20) words.add(raw);
  }
  return words;
}

function chunkText(text, maxLen = 500) {
  const sentences = text.split(/(?<=[。！？\n])|(?<=\. )/g).filter((s) => s.trim());
  if (!sentences.length) return [text];
  const chunks = []; let cur = "";
  for (const s of sentences) { if (cur.length + s.length > maxLen && cur) { chunks.push(cur.trim()); cur = s; } else cur += s; }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

// ═══ API CALL WITH FULL ERROR REPORTING ════════════════════════════════
async function callAPI(systemPrompt, userContent, log, label = "API") {
  const steps = [];
  const step = (msg) => { steps.push(msg); log(`[${label}] ${msg}`); };

  step("Building request body…");
  let body;
  try {
    body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
    step(`Body ready (${body.length} bytes)`);
  } catch (e) {
    step(`FAILED to build body: ${e.name}: ${e.message}`);
    throw new Error(`Body build failed: ${e.message}`);
  }

  step("Creating AbortController (60s timeout)…");
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    step("⚠ 60s TIMEOUT — aborting fetch");
    ctrl.abort();
  }, 60000);

  let res;
  try {
    step("Calling fetch('https://api.anthropic.com/v1/messages')…");
    const t0 = Date.now();
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body,
    });
    clearTimeout(timer);
    step(`Fetch returned in ${Date.now() - t0}ms — status: ${res.status} ${res.statusText}`);
  } catch (e) {
    clearTimeout(timer);
    step(`FETCH FAILED: ${e.name}: ${e.message}`);
    if (e.name === "AbortError") throw new Error("Request timed out after 60s — fetch never resolved");
    throw new Error(`Fetch error: ${e.name}: ${e.message}`);
  }

  if (!res.ok) {
    let errBody = "";
    try { errBody = await res.text(); step(`Error body: ${errBody.slice(0, 300)}`); } catch {}
    throw new Error(`API returned ${res.status}: ${errBody.slice(0, 100)}`);
  }

  step("Reading response body…");
  let data;
  try {
    data = await res.json();
    step(`JSON parsed — keys: ${Object.keys(data).join(", ")}`);
  } catch (e) {
    step(`JSON parse FAILED: ${e.message}`);
    throw new Error(`Response JSON parse failed: ${e.message}`);
  }

  if (data.error) {
    step(`API error object: ${JSON.stringify(data.error).slice(0, 200)}`);
    throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  step(`Content blocks: ${data.content?.length || 0}, stop_reason: ${data.stop_reason}`);
  const raw = data.content?.map((b) => b.text || "").join("") || "";
  step(`Raw text: ${raw.length} chars — first 150: ${raw.slice(0, 150)}`);

  if (!raw) throw new Error("Empty response from API");

  step("Parsing JSON from response text…");
  // Try direct parse
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    step(`Parsed OK`);
    return parsed;
  } catch (e) {
    step(`Direct parse failed: ${e.message} — attempting repair…`);
  }

  // Repair
  let fixed = clean;
  if ((fixed.match(/"/g) || []).length % 2 !== 0) fixed += '"';
  for (let i = 0; i < 10; i++) {
    try { const p = JSON.parse(fixed); step("Repair succeeded"); return p; } catch {}
    const ob = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
    const oc = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
    if (ob > 0) fixed += "]"; else if (oc > 0) fixed += "}"; else break;
  }
  try { const p = JSON.parse(fixed); step("Repair succeeded (final)"); return p; } catch {}

  step("All parse attempts failed");
  throw new Error(`JSON parse failed. Raw response starts with: ${clean.slice(0, 100)}`);
}

// ═══ PROMPTS ═══════════════════════════════════════════════════════════
const EXTRACT_PROMPT = `Extract ALL Japanese vocab, grammar, and key sentences. User speaks conversational JP but cannot read kanji.
Return ONLY valid JSON. No markdown fences, no explanation.
{"vocab":[{"word":"kanji","reading":"hiragana","meaning":"English 2-5 words","level":"N5|N4|N3|N2|N1|biz|other"}],"grammar":[{"title":"～pattern","explanation":"brief","example":"with furigana 漢字(かんじ)","level":"N5|N4|N3|N2|N1|biz|other"}],"sentences":[{"original":"important sentence from text"}]}
Rules: Skip は,が,の,で,に,を,です,ます unless grammar. Include ALL kanji words & ALL grammar. Pick 3-5 key sentences.`;

const ENRICH_PROMPT = `Japanese vocab tutor. Return ONLY valid JSON. No markdown.
{"synonyms":[{"word":"synonym","reading":"hiragana","meaning":"English 2-4 words","level":"N5|N4|N3|N2|N1|biz|other","nuance":"3-6 words"}],"example":"sentence with furigana 漢字(かんじ)","nuanceTip":"1 sentence comparing usage"}
2-4 synonyms with nuance.`;

const SENT_PROMPT = `Japanese sentence tutor. Return ONLY valid JSON. No markdown.
{"furigana":"full sentence with furigana on every kanji: 漢字(かんじ)","english":"natural translation","keyVocab":[{"word":"key word","reading":"hiragana","meaning":"English 2-4 words"}]}
3-6 key vocab from sentence.`;

// ═══ COMPONENT ═════════════════════════════════════════════════════════
export default function AnkiFlow() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [savedCards, setSavedCards] = useState([]);
  const [knownWords, setKnownWords] = useState(new Set());
  const [vw, setVw] = useState("extract");
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [showTSV, setShowTSV] = useState(false);
  const [hideKnown, setHideKnown] = useState(false);
  const [knownInput, setKnownInput] = useState("");
  const [customSent, setCustomSent] = useState("");
  const [enriched, setEnriched] = useState({});
  const [sentEnriched, setSentEnriched] = useState({});
  const [logs, setLogs] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const logRef = useRef(null);

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((p) => [...p, `[${ts}] ${msg}`]);
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);
  useEffect(() => { if (loading) { setElapsed(0); timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000); } else clearInterval(timerRef.current); return () => clearInterval(timerRef.current); }, [loading]);

  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get(DECK_KEY); if (r?.value) setSavedCards(JSON.parse(r.value)); } catch {}
      try { const r = await window.storage.get(KNOWN_KEY); if (r?.value) setKnownWords(new Set(JSON.parse(r.value))); } catch {}
    })();
  }, []);

  const persistCards = useCallback(async (c) => { setSavedCards(c); try { await window.storage.set(DECK_KEY, JSON.stringify(c)); } catch {} }, []);
  const persistKnown = useCallback(async (w) => { setKnownWords(w); try { await window.storage.set(KNOWN_KEY, JSON.stringify([...w])); } catch {} }, []);
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(null), 2500); };
  const isKnown = (w) => knownWords.has(w);

  // ── Extract ───────────────────────────────────────────────────────────
  const handleAnalyze = async () => {
    if (!input.trim()) return;
    setLoading(true); setError(null); setResult(null); setSelected(new Set()); setEnriched({}); setSentEnriched({}); setLogs([]);
    addLog(`Starting extraction — ${input.trim().length} chars`);
    try {
      const text = input.trim();
      // Send as single call if under 1500 chars
      if (text.length <= 1500) {
        addLog("Single call mode");
        const raw = await callAPI(EXTRACT_PROMPT, text, addLog, "Extract");
        const vocab = sortJLPT(raw.vocab || []);
        const grammar = sortJLPT(raw.grammar || []);
        const sentences = raw.sentences || [];
        const data = { vocab, grammar, sentences };
        setResult(data);
        const ids = new Set();
        vocab.forEach((v, i) => { if (!isKnown(v.word)) ids.add(`v-${i}`); });
        grammar.forEach((_, i) => ids.add(`g-${i}`));
        sentences.forEach((_, i) => ids.add(`s-${i}`));
        setSelected(ids);
        addLog(`✓ Done: ${vocab.length} vocab, ${grammar.length} grammar, ${sentences.length} sentences`);
      } else {
        const chunks = chunkText(text);
        addLog(`Chunked into ${chunks.length} pieces`);
        const sV = new Set(), sG = new Set(), sS = new Set();
        const vocab = [], grammar = [], sentences = [];
        for (let i = 0; i < chunks.length; i++) {
          addLog(`--- Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars) ---`);
          try {
            const raw = await callAPI(EXTRACT_PROMPT, chunks[i], addLog, `Chunk${i + 1}`);
            for (const v of raw.vocab || []) { if (!sV.has(v.word)) { sV.add(v.word); vocab.push(v); } }
            for (const g of raw.grammar || []) { if (!sG.has(g.title)) { sG.add(g.title); grammar.push(g); } }
            for (const s of raw.sentences || []) { if (!sS.has(s.original)) { sS.add(s.original); sentences.push(s); } }
          } catch (e) { addLog(`Chunk ${i + 1} FAILED: ${e.message}`); }
        }
        if (!vocab.length && !grammar.length) throw new Error("All chunks failed — no results");
        const sorted = { vocab: sortJLPT(vocab), grammar: sortJLPT(grammar), sentences };
        setResult(sorted);
        const ids = new Set();
        sorted.vocab.forEach((v, i) => { if (!isKnown(v.word)) ids.add(`v-${i}`); });
        sorted.grammar.forEach((_, i) => ids.add(`g-${i}`));
        sorted.sentences.forEach((_, i) => ids.add(`s-${i}`));
        setSelected(ids);
        addLog(`✓ Merged: ${sorted.vocab.length} vocab, ${sorted.grammar.length} grammar, ${sorted.sentences.length} sentences`);
      }
    } catch (e) {
      addLog(`✗ FINAL ERROR: ${e.message}`);
      setError(e.message);
    }
    setLoading(false);
  };

  const toggleSelect = (id) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const handleEnrich = async (v) => {
    if (enriched[v.word]?.data || enriched[v.word]?.loading) return;
    setEnriched((p) => ({ ...p, [v.word]: { loading: true } }));
    addLog(`Enriching vocab: ${v.word}`);
    try {
      const data = await callAPI(ENRICH_PROMPT, `Word: ${v.word} (${v.reading}) — ${v.meaning}`, addLog, "Enrich");
      setEnriched((p) => ({ ...p, [v.word]: { loading: false, data } }));
    } catch (e) {
      addLog(`Enrich failed: ${e.message}`);
      setEnriched((p) => ({ ...p, [v.word]: { loading: false, error: e.message } }));
    }
  };

  const handleEnrichSent = async (s) => {
    if (sentEnriched[s.original]?.data || sentEnriched[s.original]?.loading) return;
    setSentEnriched((p) => ({ ...p, [s.original]: { loading: true } }));
    addLog(`Enriching sentence: ${s.original.slice(0, 40)}…`);
    try {
      const data = await callAPI(SENT_PROMPT, s.original, addLog, "Sent");
      setSentEnriched((p) => ({ ...p, [s.original]: { loading: false, data } }));
    } catch (e) {
      addLog(`Sentence enrich failed: ${e.message}`);
      setSentEnriched((p) => ({ ...p, [s.original]: { loading: false, error: e.message } }));
    }
  };

  const addToDeck = () => {
    if (!result) return;
    const nc = [];
    result.vocab?.forEach((v, i) => { if (!selected.has(`v-${i}`)) return; const e = enriched[v.word]?.data; nc.push({ ...v, type: "vocab", id: `${Date.now()}-v-${i}`, example: e?.example || "", synonyms: e?.synonyms || [], nuanceTip: e?.nuanceTip || "" }); });
    result.grammar?.forEach((g, i) => { if (selected.has(`g-${i}`)) nc.push({ ...g, type: "grammar", id: `${Date.now()}-g-${i}` }); });
    result.sentences?.forEach((s, i) => { if (!selected.has(`s-${i}`)) return; const e = sentEnriched[s.original]?.data; nc.push({ type: "sentence", id: `${Date.now()}-s-${i}`, original: s.original, furigana: e?.furigana || "", english: e?.english || "", keyVocab: e?.keyVocab || [] }); });
    const existing = new Set(savedCards.map((c) => c.word || c.title || c.original));
    const unique = nc.filter((c) => !existing.has(c.word || c.title || c.original));
    if (unique.length) persistCards([...savedCards, ...unique]);
    const nk = new Set(knownWords); for (const c of unique) { if (c.type === "vocab" && c.word) nk.add(c.word); } if (nk.size > knownWords.size) persistKnown(nk);
    showToast(unique.length ? `Added ${unique.length}` : "All in deck");
    setInput(""); setResult(null); setEnriched({}); setSentEnriched({});
  };

  const removeCard = (id) => persistCards(savedCards.filter((c) => c.id !== id));
  const exportDeck = async () => { try { await navigator.clipboard.writeText(buildTSV(savedCards)); showToast("Copied!"); } catch { setShowTSV(true); } };
  const handleImportKnown = () => { if (!knownInput.trim()) return; const m = new Set([...knownWords, ...parseKnownWords(knownInput)]); persistKnown(m); setKnownInput(""); showToast(`${m.size} known words`); };

  const vcnt = savedCards.filter((c) => c.type === "vocab").length;
  const gcnt = savedCards.filter((c) => c.type === "grammar").length;
  const scnt = savedCards.filter((c) => c.type === "sentence").length;
  const newV = result?.vocab?.filter((v) => !isKnown(v.word)).length || 0;
  const knownV = result?.vocab?.filter((v) => isKnown(v.word)).length || 0;

  // ── Sub-components ────────────────────────────────────────────────────
  const VocabCard = ({ v, i }) => {
    const id = `v-${i}`, isSel = selected.has(id), known = isKnown(v.word), e = enriched[v.word];
    return (
      <div style={{ ...S.vcard, ...(known ? S.vcardKnown : isSel ? S.vcardSel : {}) }}>
        <div style={S.vcardTop} onClick={() => toggleSelect(id)}>
          <div style={S.hdr}><div style={{ display: "flex", gap: 8, alignItems: "center" }}><div style={{ ...S.chk, ...(isSel ? S.chkOn : {}) }}>{isSel ? "✓" : ""}</div>{known && <span style={S.knTag}>known</span>}</div><span style={{ ...S.badge, background: LC[v.level] || "#888" }}>{v.level}</span></div>
          <div style={{ fontSize: 24, fontWeight: 700, opacity: known ? 0.5 : 1, marginBottom: 2 }}>{v.word}</div>
          <div style={{ fontSize: 15, color: "#666", fontWeight: 500, marginBottom: 4 }}>{v.reading}</div>
          <div style={{ fontSize: 14, color: "#444", marginBottom: 4 }}>{v.meaning}</div>
        </div>
        <div style={S.toggle} onClick={(ev) => { ev.stopPropagation(); if (!e) handleEnrich(v); else if (e.data) setEnriched((p) => { const n = { ...p }; delete n[v.word]; return n; }); }}>
          {e?.loading ? <em style={{ color: "#999" }}>Loading…</em> : e?.data ? "▾ Hide synonyms" : "▸ Load synonyms"}
        </div>
        {e?.data && (
          <div style={S.synSec}>
            {e.data.example && <div style={{ fontSize: 13, color: "#666", fontStyle: "italic", marginBottom: 10, padding: "6px 10px", background: "#faf8f5", borderRadius: 6 }}>例: {e.data.example}</div>}
            {(e.data.synonyms || []).map((s, j) => (
              <div key={j} style={{ padding: "8px 0", borderBottom: "1px dashed #e0dcd6" }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}><span style={{ fontSize: 16, fontWeight: 600 }}>{s.word}</span><span style={{ fontSize: 13, color: "#888" }}>({s.reading})</span>{s.level && <span style={{ ...S.synLv, background: LC[s.level] || "#888" }}>{s.level}</span>}</div>
                <div style={{ fontSize: 13, color: "#555", marginTop: 2 }}>→ {s.meaning}</div>
                {s.nuance && <div style={{ fontSize: 12, color: "#8a7a5a", marginTop: 2, fontStyle: "italic" }}>{s.nuance}</div>}
              </div>
            ))}
            {e.data.nuanceTip && <div style={{ marginTop: 10, padding: "8px 12px", background: "#faf5e8", borderRadius: 8, fontSize: 13, color: "#6a5a3a" }}>💡 {e.data.nuanceTip}</div>}
          </div>
        )}
        {e?.error && <div style={{ padding: "8px 16px", fontSize: 12, color: "#9a3131" }}>Error: {e.error}</div>}
      </div>
    );
  };

  const GrammarCard = ({ g, i }) => {
    const id = `g-${i}`, isSel = selected.has(id);
    return (
      <div style={{ ...S.gcard, ...(isSel ? S.gcardSel : {}) }} onClick={() => toggleSelect(id)}>
        <div style={S.hdr}><div style={{ ...S.chk, ...(isSel ? S.chkOnG : {}) }}>{isSel ? "✓" : ""}</div><span style={{ ...S.badge, background: LC[g.level] || "#888" }}>{g.level}</span></div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#3a2a4e", marginBottom: 6 }}>{g.title}</div>
        <div style={{ fontSize: 14, color: "#444", marginBottom: 4 }}>{g.explanation}</div>
        <div style={{ fontSize: 13, color: "#888", fontStyle: "italic" }}>{g.example}</div>
      </div>
    );
  };

  const SentenceCard = ({ s, i }) => {
    const id = `s-${i}`, isSel = selected.has(id), e = sentEnriched[s.original];
    return (
      <div style={{ ...S.scard, ...(isSel ? S.scardSel : {}) }}>
        <div style={{ padding: "14px 16px 10px", cursor: "pointer" }} onClick={() => toggleSelect(id)}>
          <div style={S.hdr}><div style={{ ...S.chk, ...(isSel ? S.chkOnS : {}) }}>{isSel ? "✓" : ""}</div><span style={{ ...S.badge, background: "#5a6a8e" }}>句</span></div>
          <div style={{ fontSize: 16, lineHeight: 1.8, fontWeight: 500 }}>{s.original}</div>
        </div>
        <div style={{ ...S.toggle, color: "#4a5a7e", borderColor: "#dde0ea" }} onClick={(ev) => { ev.stopPropagation(); if (!e) handleEnrichSent(s); else if (e.data) setSentEnriched((p) => { const n = { ...p }; delete n[s.original]; return n; }); }}>
          {e?.loading ? <em style={{ color: "#999" }}>Loading…</em> : e?.data ? "▾ Hide breakdown" : "▸ Load furigana & translation"}
        </div>
        {e?.data && (
          <div style={{ padding: "10px 16px 14px", background: "#f0f2f8", borderTop: "1px solid #dde0ea" }}>
            {e.data.furigana && <div style={{ fontSize: 15, lineHeight: 2, marginBottom: 8 }}>{e.data.furigana}</div>}
            {e.data.english && <div style={{ fontSize: 14, color: "#555", fontStyle: "italic", marginBottom: 10 }}>{e.data.english}</div>}
            {e.data.keyVocab?.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{e.data.keyVocab.map((k, j) => <span key={j} style={{ fontSize: 12, padding: "4px 10px", background: "#e8eaf2", borderRadius: 6 }}><strong>{k.word}</strong> ({k.reading}) {k.meaning}</span>)}</div>}
          </div>
        )}
        {e?.error && <div style={{ padding: "8px 16px", fontSize: 12, color: "#9a3131" }}>Error: {e.error}</div>}
      </div>
    );
  };

  return (
    <div style={S.root}>
      {toast && <div style={S.toast}>{toast}</div>}
      {showTSV && (
        <div style={S.overlay} onClick={() => setShowTSV(false)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>TSV</h3><button style={{ border: "none", background: "transparent", fontSize: 24, cursor: "pointer" }} onClick={() => setShowTSV(false)}>×</button></div>
            <textarea style={S.tsvArea} readOnly value={buildTSV(savedCards)} onFocus={(e) => e.target.select()} />
            <button style={S.btn} onClick={async () => { try { await navigator.clipboard.writeText(buildTSV(savedCards)); showToast("Copied!"); setShowTSV(false); } catch {} }}>Copy</button>
          </div>
        </div>
      )}

      <div style={S.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}><span style={S.logo}>暗</span><div><h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>AnkiFlow</h1><p style={{ fontSize: 13, margin: 0, color: "#888" }}>Paste → Extract → Learn</p></div></div>
        <div style={S.tabs}>
          {["extract", "deck", "known"].map((t) => <button key={t} style={vw === t ? S.tabOn : S.tab} onClick={() => setVw(t)}>{t === "extract" ? "Extract" : t === "deck" ? `Deck (${savedCards.length})` : `Known (${knownWords.size})`}</button>)}
        </div>
      </div>

      {/* ════ EXTRACT ════ */}
      {vw === "extract" && (
        <div>
          <textarea style={S.textarea} placeholder={"日本語のテキストをここに貼り付けてください…"} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAnalyze(); }} rows={4} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, marginBottom: 20 }}>
            <span style={{ fontSize: 12, color: "#aaa" }}>⌘/Ctrl+Enter{input.length > 500 ? ` · ${chunkText(input).length} chunks` : ""}</span>
            <button style={loading || !input.trim() ? S.btnOff : S.btn} onClick={handleAnalyze} disabled={loading || !input.trim()}>{loading ? `Extracting… ${elapsed}s` : "Extract"}</button>
          </div>

          {error && <div style={S.errBox}>{error}</div>}

          {/* DEBUG LOG — always visible when there are logs */}
          {logs.length > 0 && (
            <div style={S.logSection}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#888" }}>Debug Log ({logs.length})</span>
                <button style={{ fontSize: 12, border: "none", background: "#e8e4de", color: "#666", padding: "4px 10px", borderRadius: 6, cursor: "pointer" }} onClick={() => setLogs([])}>Clear</button>
              </div>
              <div ref={logRef} style={S.logBox}>
                {logs.map((l, i) => <div key={i} style={{ color: l.includes("FAIL") || l.includes("ERROR") || l.includes("✗") ? "#ff6b6b" : l.includes("✓") ? "#a8e6a0" : "#8ac" }}>{l}</div>)}
              </div>
            </div>
          )}

          {result && !loading && (
            <div>
              <div style={{ padding: "12px 16px", background: "#f0f6f3", borderRadius: 10, marginBottom: 20, border: "1px solid #d4e8dc" }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#2c4a3e" }}>✓ {result.vocab?.length} vocab · {result.grammar?.length} grammar · {result.sentences?.length} sentences</div>
                {knownV > 0 && <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}><span style={S.newBadge}>{newV} new</span><span style={S.knBadge}>{knownV} known</span><label style={{ fontSize: 12, color: "#666", cursor: "pointer" }}><input type="checkbox" checked={hideKnown} onChange={(e) => setHideKnown(e.target.checked)} style={{ marginRight: 4 }} />Hide known</label></div>}
              </div>

              {result.vocab?.length > 0 && <div style={{ marginBottom: 28 }}><h2 style={S.secT}><span style={S.secI}>言</span> Vocabulary</h2><div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{result.vocab.map((v, i) => { if (hideKnown && isKnown(v.word)) return null; return <VocabCard key={i} v={v} i={i} />; })}</div></div>}
              {result.grammar?.length > 0 && <div style={{ marginBottom: 28 }}><h2 style={S.secT}><span style={{ ...S.secI, background: "#6a5a7e" }}>文</span> Grammar</h2><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12 }}>{result.grammar.map((g, i) => <GrammarCard key={i} g={g} i={i} />)}</div></div>}
              {<div style={{ marginBottom: 28 }}><h2 style={S.secT}><span style={{ ...S.secI, background: "#5a6a8e" }}>句</span> Sentences</h2><div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{result.sentences?.map((s, i) => <SentenceCard key={i} s={s} i={i} />)}</div><div style={{ display: "flex", gap: 8, marginTop: 12 }}><input style={{ flex: 1, padding: "10px 14px", fontSize: 14, border: "2px solid #dde0ea", borderRadius: 10, outline: "none", background: "#f8f9fc", fontFamily: "'Noto Sans JP',sans-serif" }} placeholder="Add custom sentence…" value={customSent} onChange={(e) => setCustomSent(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { if (!customSent.trim() || !result) return; setResult((p) => ({ ...p, sentences: [...(p.sentences || []), { original: customSent.trim() }] })); setSelected((p) => new Set([...p, `s-${result.sentences?.length || 0}`])); setCustomSent(""); } }} /><button style={!customSent.trim() ? S.btnSmOff : S.btnSm} onClick={() => { if (!customSent.trim() || !result) return; setResult((p) => ({ ...p, sentences: [...(p.sentences || []), { original: customSent.trim() }] })); setSelected((p) => new Set([...p, `s-${result.sentences?.length || 0}`])); setCustomSent(""); }}>+</button></div></div>}

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 0", borderTop: "2px solid #e8e4de", marginTop: 8 }}>
                <span style={{ fontSize: 14, color: "#888" }}>{selected.size} selected</span>
                <button style={!selected.size ? S.btnOff : { ...S.btn, padding: "12px 32px" }} onClick={addToDeck} disabled={!selected.size}>Add to Deck</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════ DECK ════ */}
      {vw === "deck" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, fontSize: 15, color: "#666" }}><span><strong>{vcnt}</strong> vocab</span>·<span><strong>{gcnt}</strong> grammar</span>·<span><strong>{scnt}</strong> sent</span></div>
            <div style={{ display: "flex", gap: 8 }}><button style={!savedCards.length ? S.btnSmOff : S.btnSm} onClick={exportDeck}>Export</button><button style={!savedCards.length ? S.btnSmOff : S.btnSmD} onClick={() => { persistCards([]); showToast("Cleared"); }}>Clear</button></div>
          </div>
          {!savedCards.length ? <div style={{ textAlign: "center", padding: 60 }}><p style={{ color: "#aaa" }}>空 — No cards yet</p></div> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {savedCards.map((c) => (
                <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#faf8f5", border: "1px solid #e8e4de", borderRadius: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
                    <span style={{ ...S.deckT, background: c.type === "vocab" ? "#5a7a6e" : c.type === "grammar" ? "#6a5a7e" : "#5a6a8e" }}>{c.type === "vocab" ? "言" : c.type === "grammar" ? "文" : "句"}</span>
                    <div style={{ minWidth: 0 }}><div style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.word || c.title || c.original?.slice(0, 50)}</div><div style={{ fontSize: 13, color: "#888" }}>{c.type === "vocab" ? `${c.reading} — ${c.meaning}` : c.type === "grammar" ? c.explanation : c.english || ""}</div></div>
                  </div>
                  <button style={{ border: "none", background: "transparent", color: "#bbb", fontSize: 20, cursor: "pointer" }} onClick={() => removeCard(c.id)}>×</button>
                </div>
              ))}
            </div>
          )}
          {savedCards.length > 0 && <div style={{ marginTop: 24, padding: 14, background: "#f5f2ec", borderRadius: 10, fontSize: 13, color: "#666" }}><strong>Import:</strong> Export → paste into .tsv → Anki: File → Import → Tab</div>}
        </div>
      )}

      {/* ════ KNOWN ════ */}
      {vw === "known" && (
        <div>
          <p style={{ fontSize: 14, color: "#666", padding: "12px 16px", background: "#f5f2ec", borderRadius: 10, marginBottom: 20 }}>Known words are dimmed in extraction. Words added to Deck auto-track here.</p>
          <div style={{ marginBottom: 28, padding: 20, background: "#faf8f5", borderRadius: 12, border: "1px solid #e8e4de" }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Import from Anki</h3>
            <textarea style={S.textarea} placeholder={"念頭\n考慮\n配慮"} value={knownInput} onChange={(e) => setKnownInput(e.target.value)} rows={4} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
              <span style={{ fontSize: 12, color: "#aaa" }}>{knownInput.trim() ? `~${parseKnownWords(knownInput).size} words` : ""}</span>
              <button style={!knownInput.trim() ? S.btnOff : S.btn} onClick={handleImportKnown}>Import</button>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}><h3 style={{ margin: 0, fontSize: 16 }}>Known ({knownWords.size})</h3>{knownWords.size > 0 && <button style={S.btnSmD} onClick={() => { persistKnown(new Set()); showToast("Cleared"); }}>Clear</button>}</div>
          {!knownWords.size ? <p style={{ color: "#aaa", textAlign: "center", padding: 40 }}>None yet</p> : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{[...knownWords].sort().map((w) => (
              <div key={w} style={{ display: "flex", gap: 4, padding: "6px 10px 6px 12px", background: "#f0ece0", borderRadius: 8, fontSize: 14, fontWeight: 500 }}><span>{w}</span><button style={{ border: "none", background: "transparent", color: "#bba880", fontSize: 16, cursor: "pointer" }} onClick={() => { const n = new Set(knownWords); n.delete(w); persistKnown(n); }}>×</button></div>
            ))}</div>
          )}
        </div>
      )}
    </div>
  );
}

const S = {
  root: { fontFamily: "'Noto Sans JP','Helvetica Neue',sans-serif", maxWidth: 740, margin: "0 auto", padding: "0 16px 40px", color: "#2c2c2c", minHeight: "100vh" },
  toast: { position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)", background: "#2c4a3e", color: "#e8f0ec", padding: "10px 24px", borderRadius: 8, fontSize: 14, fontWeight: 500, zIndex: 999 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 0 20px", borderBottom: "2px solid #d4cec4", marginBottom: 24, flexWrap: "wrap", gap: 12 },
  logo: { fontSize: 28, fontWeight: 800, color: "#fff", background: "#2c4a3e", width: 44, height: 44, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10 },
  tabs: { display: "flex", gap: 4, background: "#ece8e1", borderRadius: 10, padding: 3 },
  tab: { padding: "8px 14px", border: "none", background: "transparent", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#666" },
  tabOn: { padding: "8px 14px", border: "none", background: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#1a1a1a", boxShadow: "0 1px 4px rgba(0,0,0,.08)" },
  textarea: { width: "100%", boxSizing: "border-box", padding: 14, fontSize: 15, lineHeight: 1.7, fontFamily: "'Noto Sans JP',sans-serif", border: "2px solid #d4cec4", borderRadius: 12, resize: "vertical", outline: "none", background: "#faf8f5" },
  btn: { padding: "10px 24px", fontSize: 14, fontWeight: 600, border: "none", borderRadius: 10, background: "#2c4a3e", color: "#fff", cursor: "pointer" },
  btnOff: { padding: "10px 24px", fontSize: 14, fontWeight: 600, border: "none", borderRadius: 10, background: "#ccc", color: "#888", cursor: "not-allowed" },
  btnSm: { padding: "8px 16px", fontSize: 13, fontWeight: 600, border: "none", borderRadius: 8, background: "#2c4a3e", color: "#fff", cursor: "pointer" },
  btnSmOff: { padding: "8px 16px", fontSize: 13, fontWeight: 600, border: "none", borderRadius: 8, background: "#ccc", color: "#888", cursor: "not-allowed" },
  btnSmD: { padding: "8px 16px", fontSize: 13, fontWeight: 600, border: "none", borderRadius: 8, background: "#e8e4de", color: "#9a3131", cursor: "pointer" },
  errBox: { padding: "12px 16px", background: "#fdf2f2", color: "#9a3131", borderRadius: 10, fontSize: 14, marginBottom: 16, wordBreak: "break-word" },
  logSection: { marginBottom: 20 },
  logBox: { maxHeight: 250, overflowY: "auto", background: "#111", borderRadius: 10, padding: 12, fontFamily: "'SF Mono','Fira Code',monospace", fontSize: 11, lineHeight: 1.7 },

  hdr: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  chk: { width: 22, height: 22, borderRadius: "50%", border: "2px solid #ccc", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#2c4a3e" },
  chkOn: { borderColor: "#2c4a3e", background: "#d8ece2" },
  chkOnG: { borderColor: "#5a4a6e", background: "#e2d8ec" },
  chkOnS: { borderColor: "#4a5a7e", background: "#d8e0ec" },
  badge: { fontSize: 11, fontWeight: 600, color: "#fff", padding: "2px 8px", borderRadius: 6 },
  knTag: { fontSize: 11, fontWeight: 500, color: "#8a7a5a", background: "#f0ece0", padding: "2px 8px", borderRadius: 6 },
  vcard: { borderRadius: 12, border: "2px solid #e0dcd6", background: "#faf8f5", overflow: "hidden" },
  vcardSel: { borderColor: "#2c4a3e", background: "#f0f6f3", boxShadow: "0 0 0 1px #2c4a3e" },
  vcardKnown: { borderColor: "#e8e4de", background: "#f8f7f5", opacity: 0.7 },
  vcardTop: { padding: "14px 16px 10px", cursor: "pointer" },
  toggle: { padding: "8px 16px", fontSize: 13, fontWeight: 600, color: "#5a7a6e", cursor: "pointer", borderTop: "1px solid #eae6e0", userSelect: "none" },
  synSec: { padding: "8px 16px 14px", background: "#f5f2ed", borderTop: "1px solid #eae6e0" },
  synLv: { fontSize: 10, fontWeight: 600, color: "#fff", padding: "1px 6px", borderRadius: 4 },
  gcard: { padding: 14, borderRadius: 12, border: "2px solid #e4dde8", background: "#faf8fc", cursor: "pointer" },
  gcardSel: { borderColor: "#5a4a6e", background: "#f3f0f6", boxShadow: "0 0 0 1px #5a4a6e" },
  scard: { borderRadius: 12, border: "2px solid #dde0ea", background: "#f8f9fc", overflow: "hidden" },
  scardSel: { borderColor: "#4a5a7e", background: "#eef0f6", boxShadow: "0 0 0 1px #4a5a7e" },
  secT: { fontSize: 16, fontWeight: 600, margin: "0 0 14px", display: "flex", alignItems: "center", gap: 8 },
  secI: { fontSize: 14, fontWeight: 700, color: "#fff", background: "#5a7a6e", width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 7 },
  newBadge: { fontSize: 12, fontWeight: 600, color: "#fff", background: "#2c4a3e", padding: "2px 8px", borderRadius: 6 },
  knBadge: { fontSize: 12, fontWeight: 600, color: "#8a7a5a", background: "#f0ece0", padding: "2px 8px", borderRadius: 6 },
  deckT: { fontSize: 13, fontWeight: 700, color: "#fff", width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 7, flexShrink: 0 },
  overlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 },
  modal: { background: "#fff", borderRadius: 16, padding: 24, maxWidth: 560, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 12 },
  tsvArea: { width: "100%", boxSizing: "border-box", height: 200, padding: 12, fontFamily: "monospace", fontSize: 12, border: "2px solid #e8e4de", borderRadius: 10, resize: "vertical", background: "#faf8f5" },
};
