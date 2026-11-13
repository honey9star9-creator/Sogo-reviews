/* SOGO REVIEWS — Chat Core (WhatsApp-Web style)
   ------------------------------------------------------------------
   Admin aur Client DONO side ye hi file use karti hain.
   - Messages hamesha time ke hisaab se sahi order mein (purane upar, naye neeche)
   - Message bhejte hi foran screen par (optimistic), fail ho to "tap to retry"
   - Realtime + auto reconnect + fallback polling (message miss nahi hota)
   - Ticks: ✓ (sent) / ✓✓ blue (seen), day separators, image messages
   - uid-based queries (har message par email se user dhoondne wali extra query khatam)
*/
import { supabase } from "./supabase-config.js";

const TABLE = "messages";
const BUCKET = "chat-attachments";
const PAGE = 300;

/* ---------------- small helpers ---------------- */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function ts(m) {
  const v = Date.parse(m && (m.time || m.created_at));
  return isNaN(v) ? 0 : v;
}
function cmp(a, b) {
  const d = ts(a) - ts(b);
  if (d) return d;
  const na = Number(a.id), nb = Number(b.id);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  const sa = String(a.id), sb = String(b.id);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function isImageUrl(text) {
  const t = (text || "").trim();
  if (!/^https?:\/\//i.test(t)) return false;
  if (/\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(t)) return true;
  return /\/chat-attachments\//i.test(t);
}
function clock(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}
function dayLabel(t) {
  const d = new Date(t), now = new Date(), y = new Date();
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
function listTime(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return "";
  const d = new Date(t), now = new Date(), y = new Date();
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return clock(t);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  if (now - d < 6 * 86400000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" });
}
function avatarColor(seed) {
  let h = 0;
  for (const c of String(seed || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
  return "hsl(" + h + " 42% 44%)";
}
async function shrinkImage(file, maxSide = 1280, quality = 0.8) {
  try {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) return file;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (e) { return file; }
}

function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

const SVG_SINGLE = '<svg viewBox="0 0 16 15" width="16" height="15"><path fill="currentColor" d="M10.91 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/></svg>';
const SVG_DOUBLE = '<svg viewBox="0 0 16 15" width="16" height="15"><path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.064-.512zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.365.365 0 0 0-.063-.51z"/></svg>';
const SVG_CLOCK = '<svg viewBox="0 0 16 16" width="13" height="13"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function tickHtml(m, st) {
  if (st === "sending") return '<span class="wa-tick">' + SVG_CLOCK + "</span>";
  if (st === "failed") return '<span class="wa-tick wa-fail">!</span>';
  return m.read ? '<span class="wa-tick wa-read">' + SVG_DOUBLE + "</span>" : '<span class="wa-tick">' + SVG_SINGLE + "</span>";
}

function msgHtml(m, mine, first, st, p) {
  const t = ts(m) || Date.now();
  const meta = '<span class="wa-meta">' + clock(t) + (mine ? tickHtml(m, st) : "") + "</span>";
  const imgSrc = isImageUrl(m.text) ? m.text : (p && p.preview) || "";
  const cls = "wa-row " + (mine ? "mine" : "theirs") + (first ? " first" : "") + (st === "failed" ? " failed" : "");
  const tmp = p ? ' data-tmp="' + esc(p.tmp) + '"' : "";
  const failNote = st === "failed" ? '<div class="wa-failnote">Not sent · tap to retry</div>' : "";
  if (imgSrc) {
    return '<div class="' + cls + '"' + tmp + '><div class="wa-bubble img"><a href="' + esc(imgSrc) + '" target="_blank" rel="noopener"><img src="' + esc(imgSrc) + '" alt="Photo" decoding="async">' +
      (st === "sending" ? '<span class="wa-spin"></span>' : "") + "</a>" + meta + "</div>" + failNote + "</div>";
  }
  return '<div class="' + cls + '"' + tmp + '><div class="wa-bubble"><span class="wa-text">' + linkify(esc(m.text)) + "</span>" + meta + "</div>" + failNote + "</div>";
}

/* ---------------- admin ids (client -> admin notifications) ---------------- */
let _adminIds = null;
async function getAdminIds() {
  if (_adminIds) return _adminIds;
  try {
    const { data } = await supabase.from("users").select("id").eq("role", "admin");
    _adminIds = (data || []).map(u => u.id);
  } catch (e) { _adminIds = []; }
  return _adminIds;
}
async function notifyAdmins(text, info) {
  try {
    const ids = await getAdminIds();
    if (!ids.length) return;
    const who = info.name || info.email || "A client";
    const msg = isImageUrl(text)
      ? who + " sent you a photo."
      : who + ' sent you a message: "' + (text.length > 80 ? text.slice(0, 80) + "…" : text) + '"';
    await supabase.from("notifications").insert(ids.map(id => ({
      user_id: id, type: "chat_message", title: "New chat message", message: msg, meta: { email: info.email || "" }
    })));
  } catch (e) { /* non-fatal */ }
}

/* ---------------- admin chat list (RPC) ---------------- */
async function fetchSummaries() {
  const { data, error } = await supabase.rpc("admin_chat_summaries");
  if (error) { console.error("admin_chat_summaries failed:", error.message); return []; }
  return data || [];
}

/* ---------------- thread controller ---------------- */
function mountThread(opts) {
  const box = opts.container;
  const uid = opts.uid;
  const me = opts.me; // 'admin' | 'client'
  const other = me === "admin" ? "client" : "admin";
  const isActive = opts.isActive || (() => true);

  let thread = [], pending = [];
  let closed = false, loaded = false, hasMore = false, loadingMore = false, prepend = false;
  let connected = false, everConnected = false, stick = true, newCount = 0;
  let raf = 0, markTimer = 0, lastUnread = -1, channel = null, pollTimer = 0;

  const wrap = box.parentElement;
  const downBtn = document.createElement("button");
  downBtn.type = "button";
  downBtn.className = "wa-down wa-hide";
  downBtn.innerHTML = '<span class="wa-down-n"></span>↓';
  if (wrap) wrap.appendChild(downBtn);
  const downN = downBtn.querySelector(".wa-down-n");

  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const scrollBottom = () => { box.scrollTop = box.scrollHeight; };

  function updateDown() {
    downBtn.classList.toggle("wa-hide", stick);
    downN.textContent = newCount > 0 ? String(newCount) : "";
    downN.style.display = newCount > 0 ? "inline-flex" : "none";
  }

  function onScroll() {
    stick = nearBottom();
    if (stick) newCount = 0;
    updateDown();
  }
  box.addEventListener("scroll", onScroll, { passive: true });
  // jab images load hon aur hum bottom par hon to bottom par hi rakho
  const onImgLoad = () => { if (stick) scrollBottom(); };
  box.addEventListener("load", onImgLoad, true);
  downBtn.addEventListener("click", () => { stick = true; newCount = 0; scrollBottom(); updateDown(); });

  box.addEventListener("click", e => {
    const more = e.target.closest('[data-act="more"]');
    if (more) { loadMore(); return; }
    const failed = e.target.closest(".wa-row.failed[data-tmp]");
    if (failed) {
      const p = pending.find(x => x.tmp === failed.getAttribute("data-tmp"));
      if (p && p.status === "failed") deliver(p);
    }
  });

  function merge(rows) {
    const map = new Map(thread.map(m => [String(m.id), m]));
    rows.forEach(r => { if (r && r.id != null) map.set(String(r.id), r); });
    thread = Array.from(map.values()).sort(cmp);
  }

  function render() {
    if (raf || closed) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function draw() {
    if (closed) return;
    const prevH = box.scrollHeight, prevTop = box.scrollTop;
    const wasStick = stick;

    if (!loaded) {
      box.innerHTML = '<div class="wa-sys">Loading messages…</div>';
      return;
    }
    if (!thread.length && !pending.length) {
      box.innerHTML = '<div class="wa-sys">' + esc(opts.emptyText || "No messages yet. Say hello 👋") + "</div>";
      notifyUnread();
      return;
    }

    const items = thread.map(m => ({ m, st: "ok", p: null })).concat(pending.map(p => ({ m: p.row, st: p.status, p })));
    let html = hasMore ? '<button type="button" class="wa-more" data-act="more">Load earlier messages</button>' : "";
    let lastDay = "", prevFrom = null, prevT = 0;
    items.forEach(it => {
      const t = ts(it.m) || Date.now();
      const dk = dayKey(t);
      if (dk !== lastDay) {
        html += '<div class="wa-day"><span>' + esc(dayLabel(t)) + "</span></div>";
        lastDay = dk; prevFrom = null;
      }
      const first = prevFrom !== it.m.from || t - prevT > 5 * 60000;
      prevFrom = it.m.from; prevT = t;
      html += msgHtml(it.m, it.m.from === me, first, it.st, it.p);
    });
    box.innerHTML = html;

    if (wasStick) scrollBottom();
    else if (prepend) { box.scrollTop = box.scrollHeight - prevH + prevTop; prepend = false; }
    else box.scrollTop = prevTop;
    updateDown();
    notifyUnread();
  }

  function notifyUnread() {
    const n = thread.filter(m => m.from === other && !m.read).length;
    if (n !== lastUnread) {
      lastUnread = n;
      if (opts.onUnreadChange) opts.onUnreadChange(n);
    }
    if (n > 0) scheduleMarkRead();
  }

  function scheduleMarkRead() {
    if (closed || document.hidden || !isActive()) return;
    if (!thread.some(m => m.from === other && !m.read)) return;
    clearTimeout(markTimer);
    markTimer = setTimeout(async () => {
      if (closed) return;
      const { error } = await supabase.from(TABLE).update({ read: true })
        .eq("user_id", uid).eq("from", other).eq("read", false);
      if (!error) {
        thread.forEach(m => { if (m.from === other) m.read = true; });
        lastUnread = -1;
        notifyUnread();
        if (opts.onRead) opts.onRead();
      }
    }, 350);
  }

  async function fetchLatest() {
    const { data, error } = await supabase.from(TABLE).select("*")
      .eq("user_id", uid).order("time", { ascending: false }).limit(PAGE);
    if (closed) return;
    if (error) { console.error("chat fetch failed:", error.message); if (!loaded) { loaded = true; render(); } return; }
    if (!loaded) hasMore = (data || []).length >= PAGE;
    merge(data || []);
    loaded = true;
    render();
  }

  async function loadMore() {
    if (loadingMore || !thread.length) return;
    loadingMore = true;
    const first = thread[0];
    const { data } = await supabase.from(TABLE).select("*").eq("user_id", uid)
      .lt("time", first.time || first.created_at).order("time", { ascending: false }).limit(PAGE);
    hasMore = (data || []).length >= PAGE;
    merge(data || []);
    prepend = true; stick = false;
    loadingMore = false;
    render();
  }

  function onRow(row, ev) {
    if (closed || !row) return;
    merge([row]);
    if (row.from === me) {
      const i = pending.findIndex(p => p.status !== "failed" && p.row.text === row.text);
      if (i >= 0) { pending.splice(i, 1); stick = true; }
    } else if (ev === "INSERT" && !stick) {
      newCount++;
    }
    render();
    if (opts.onActivity) opts.onActivity(row);
  }

  /* ---- sending ---- */
  function makePending(o) {
    const p = {
      tmp: "tmp" + Date.now() + Math.random().toString(36).slice(2, 6),
      status: "sending",
      file: o.file || null,
      preview: o.preview || null,
      row: { id: "tmp", from: me, text: o.text || "", read: false, time: new Date().toISOString() }
    };
    pending.push(p);
    stick = true;
    render();
    return p;
  }

  async function deliver(p) {
    p.status = "sending";
    render();
    try {
      let text = p.row.text;
      if (p.file) {
        const small = await shrinkImage(p.file);
        const safe = (small.name || "photo").replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = uid + "/" + Date.now() + "-" + safe;
        const up = await supabase.storage.from(BUCKET).upload(path, small, { upsert: true });
        if (up.error) throw up.error;
        const pub = supabase.storage.from(BUCKET).getPublicUrl(path);
        const url = pub && pub.data ? pub.data.publicUrl : "";
        if (!url) throw new Error("Could not get public URL for uploaded file.");
        text = url;
        p.row.text = url;
        p.file = null;
      }
      const { data, error } = await supabase.from(TABLE)
        .insert([{ user_id: uid, from: me, text, read: false }]).select().single();
      if (error) throw error;
      pending = pending.filter(x => x !== p);
      if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (e) {} }
      if (data) merge([data]);
      stick = true;
      render();
      if (me === "client") notifyAdmins(text, opts.notify || {});
      if (opts.onActivity) opts.onActivity(data);
    } catch (e) {
      console.error("chat send failed:", e && e.message);
      p.status = "failed";
      render();
    }
  }

  function sendText(text) {
    text = (text || "").trim();
    if (!text) return;
    deliver(makePending({ text }));
  }

  function sendFile(file) {
    if (!file) return;
    if (!/^image\//i.test(file.type || "")) { alert("Please choose an image file."); return; }
    if (file.size > 10 * 1024 * 1024) { alert("Image is too large (max 10 MB)."); return; }
    deliver(makePending({ file, preview: URL.createObjectURL(file) }));
  }

  /* ---- realtime (+ reconnect + fallback polling) ---- */
  channel = supabase
    .channel("wa-" + uid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: TABLE, filter: "user_id=eq." + uid }, p => onRow(p.new, "INSERT"))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: TABLE, filter: "user_id=eq." + uid }, p => onRow(p.new, "UPDATE"))
    .subscribe(status => {
      connected = status === "SUBSCRIBED";
      if (connected) {
        if (everConnected) fetchLatest(); // disconnect ke dauran miss hue messages wapas la lo
        everConnected = true;
      }
    });

  pollTimer = setInterval(() => { if (!connected && !document.hidden) fetchLatest(); }, 10000);

  const onVisible = () => { if (!document.hidden) { fetchLatest(); scheduleMarkRead(); } };
  document.addEventListener("visibilitychange", onVisible);

  render();
  fetchLatest();

  return {
    sendText,
    sendFile,
    refresh: fetchLatest,
    // tab/chat jab dobara visible ho
    activated() { stick = true; newCount = 0; scrollBottom(); updateDown(); scheduleMarkRead(); },
    destroy() {
      closed = true;
      clearInterval(pollTimer);
      clearTimeout(markTimer);
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisible);
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("load", onImgLoad, true);
      if (downBtn.parentNode) downBtn.parentNode.removeChild(downBtn);
      try { supabase.removeChannel(channel); } catch (e) {}
      pending.forEach(p => { if (p.preview) { try { URL.revokeObjectURL(p.preview); } catch (e) {} } });
    }
  };
}

/* ---------------- composer wiring (textarea + attach + send) ---------------- */
function bindComposer(o) {
  const { input, sendBtn, attachBtn, fileInput, getCtl } = o;
  if (!input) return;
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
  const doSend = () => {
    const ctl = getCtl();
    if (!ctl) return;
    const v = input.value;
    if (!v.trim()) return;
    input.value = "";
    autosize();
    ctl.sendText(v);
    input.focus();
  };
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
  });
  input.addEventListener("paste", e => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === "file" && /^image\//i.test(it.type)) {
        const f = it.getAsFile(), ctl = getCtl();
        if (f && ctl) { e.preventDefault(); ctl.sendFile(f); }
        return;
      }
    }
  });
  if (sendBtn) sendBtn.addEventListener("click", doSend);
  if (attachBtn && fileInput) attachBtn.addEventListener("click", () => fileInput.click());
  if (fileInput) fileInput.addEventListener("change", () => {
    const ctl = getCtl(), f = fileInput.files && fileInput.files[0];
    if (ctl && f) ctl.sendFile(f);
    fileInput.value = "";
  });
}

export const ChatCore = { mountThread, bindComposer, fetchSummaries, esc, isImageUrl, listTime, avatarColor, clock };
window.ChatCore = ChatCore;
