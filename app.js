/* 案件ノート — 入力アプリ（第1段階）
 * データはこの端末とDropboxのアプリフォルダにだけ置く。外部サーバーは使わない。
 */
(() => {
  "use strict";
  const CFG = window.CASE_NOTES_CONFIG || {};
  const INBOX = CFG.INBOX || "/00_受信箱";
  const $ = (id) => document.getElementById(id);
  const appKey = () => CFG.DROPBOX_APP_KEY || store.get("appKey", "");

  // ---------- 保存（端末内） ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("cn:" + key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("cn:" + key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
    del(key) { try { localStorage.removeItem("cn:" + key); } catch {} },
  };

  // ---------- Dropbox（PKCE認証） ----------
  const redirectUri = () => location.origin + location.pathname;
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // Dropbox-API-Arg ヘッダーは ASCII のみ許されるため、非ASCII文字を \uXXXX にする
  const apiArg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

  async function startAuth() {
    if (!appKey()) { $("authState").textContent = "先にApp keyを入力してください。"; return; }
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    sessionStorage.setItem("cn:pkce", verifier);
    const q = new URLSearchParams({
      client_id: appKey(), response_type: "code", code_challenge: challenge,
      code_challenge_method: "S256", redirect_uri: redirectUri(), token_access_type: "offline",
    });
    location.href = "https://www.dropbox.com/oauth2/authorize?" + q;
  }

  async function finishAuth() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    if (!code) return;
    const verifier = sessionStorage.getItem("cn:pkce");
    history.replaceState(null, "", redirectUri());
    if (!verifier) return;
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ code, grant_type: "authorization_code", code_verifier: verifier,
        client_id: appKey(), redirect_uri: redirectUri() }),
    });
    sessionStorage.removeItem("cn:pkce");
    if (!res.ok) { alertBox("Dropboxへの接続に失敗しました。もう一度お試しください。"); return; }
    const t = await res.json();
    store.set("auth", { refresh: t.refresh_token, access: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
  }

  async function accessToken() {
    const a = store.get("auth", null);
    if (!a || !a.refresh) throw new Error("not-connected");
    if (a.access && a.exp > Date.now()) return a.access;
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh, client_id: appKey() }),
    });
    if (!res.ok) throw new Error("refresh-failed");
    const t = await res.json();
    a.access = t.access_token; a.exp = Date.now() + (t.expires_in - 60) * 1000;
    store.set("auth", a);
    return a.access;
  }

  async function dbxUpload(path, text, overwrite) {
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": apiArg(overwrite ? { path, mode: "overwrite", mute: true } : { path, mode: "add", autorename: true, mute: true }) },
      body: new TextEncoder().encode(text),
    });
    if (!res.ok) throw new Error("upload " + res.status);
  }

  async function dbxList(path) {
    const call = async (ep, body) => {
      const res = await fetch("https://api.dropboxapi.com/2/files/" + ep, {
        method: "POST",
        headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) return { entries: [], has_more: false };
      if (!res.ok) throw new Error("list " + res.status);
      return res.json();
    };
    let r = await call("list_folder", { path, recursive: true }), out = r.entries;
    while (r.has_more) { r = await call("list_folder/continue", { cursor: r.cursor }); out = out.concat(r.entries); }
    return out;
  }

  async function dbxDownload(path) {
    const res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await accessToken()), "Dropbox-API-Arg": apiArg({ path }) },
    });
    if (res.status === 409) return null; // ファイルがまだない
    if (!res.ok) throw new Error("download " + res.status);
    return await res.text();
  }

  // ---------- 状態 ----------
  let cases = store.get("cases", []);          // Claudeが作る cases.json の写し＋端末で作った新規案件
  let current = store.get("currentCase", null);
  let outbox = store.get("outbox", []);         // 送信待ちのメモ
  // 終了して非表示にした案件（削除はしない）。Dropboxの /hidden.json で端末間に共有する
  let sentLog = store.get("sentLog", []);      // この端末から送ったメモの控え
  let remoteSent = store.get("remoteSent", []);  // Dropbox上の送信済みメモ（全端末分の一覧）
  let hidden = store.get("hidden", { ids: [], updated: 0, dirty: false });
  const isHidden = (id) => hidden.ids.includes(id);

  // 案件カードから宿題（未完了のチェック項目）と確認待ち（【要確認】の行）を取り出す
  function caseTasks(id) {
    const card = store.get("md:case:" + id, "") || "";
    const todo = [], ask = [];
    for (const l of card.split("\n")) {
      const m = l.match(/^\s*[-*]\s+\[ \]\s+(.*)/);
      if (m) todo.push(m[1].trim());
      else if (l.includes("【要確認】")) ask.push(l.replace(/^\s*[-*]\s+/, "").replace("【要確認】", "").trim());
    }
    return { todo, ask };
  }

  function renderTasks() {
    const box = $("caseTasks");
    const c = cases.find((x) => x.id === current);
    if (!c) { box.hidden = true; return; }
    const t = caseTasks(c.id);
    box.hidden = false;
    const li = (a) => a.map((x) => `<li>${esc(x)}</li>`).join("");
    box.innerHTML = `<details ${t.todo.length + t.ask.length ? "open" : ""}><summary>この案件の宿題 ${t.todo.length}件・確認待ち ${t.ask.length}件</summary>`
      + (t.ask.length ? `<div class="tk-h warn">確認待ち（答えは種類「確認待ちへの回答」で）</div><ul>${li(t.ask)}</ul>` : "")
      + (t.todo.length ? `<div class="tk-h">宿題</div><ul>${li(t.todo)}</ul>` : "")
      + (t.todo.length + t.ask.length ? "" : `<p class="muted small">今のところありません。</p>`) + `</details>`;
  }

  const caseLabel = (c) => [c.id, c.client || c.initials, c.crime].filter(Boolean).join(" ");

  // ---------- 画面: 案件一覧 ----------
  function renderCases() {
    const f = $("caseFilter").value.trim();
    const list = $("caseList");
    list.innerHTML = "";
    const showAll = $("showHidden").checked;
    const nHidden = cases.filter((c) => isHidden(c.id)).length;
    $("hiddenCount").textContent = nHidden ? `（${nHidden}件）` : "";
    const shown = cases.filter((c) => (showAll || !isHidden(c.id) || c.id === current) && (!f || JSON.stringify(c).includes(f)));
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.textContent = cases.length ? "該当する案件はありません" : "まだ案件がありません。「＋新規」で作るか、同期してください。";
      list.append(li);
    }
    for (const c of shown) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-current", String(current === c.id));
      b.textContent = caseLabel(c);
      const sub = document.createElement("span");
      sub.className = "sub";
      const tk = caseTasks(c.id);
      sub.textContent = [isHidden(c.id) ? "【終了・非表示】" : "", c.custody, tk.ask.length ? `確認待ち${tk.ask.length}` : "", tk.todo.length ? `宿題${tk.todo.length}` : "", c.next ? "次回 " + c.next : "", c.pending ? "（新規・未整理）" : ""].filter(Boolean).join("　");
      b.append(sub);
      b.addEventListener("click", () => selectCase(c.id));
      li.append(b);
      list.append(li);
    }
  }

  function selectCase(id) {
    saveDraft();
    current = id;
    store.set("currentCase", id);
    const c = cases.find((x) => x.id === id);
    $("currentCase").textContent = c ? caseLabel(c) : "案件を選んでください";
    $("memo").disabled = !c;
    $("toggleHidden").hidden = !c;
    $("toggleHidden").textContent = c && isHidden(c.id) ? "再表示する" : "終了（非表示）";
    $("memo").value = store.get("draft:" + id, "");
    updateSendState();
    renderCases();
    renderCaseCard();
    renderTasks();
  }

  // ---------- 下書き（打つたびに端末へ保存） ----------
  let draftTimer = null;
  function saveDraft() {
    if (!current) return;
    const v = $("memo").value;
    if (v) store.set("draft:" + current, v); else store.del("draft:" + current);
    $("draftState").textContent = v ? "下書きを端末に保存しました " + new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "";
  }
  function updateSendState() { $("send").disabled = !current || !$("memo").value.trim(); }

  // ---------- 送信（オフライン時は送信待ちに積む） ----------
  const pad = (n) => String(n).padStart(2, "0");
  function stamp(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
  function isoLocal(d) {
    const off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-";
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${s}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }
  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
    if (/iPhone/.test(ua)) return "iPhone";
    if (/Android/.test(ua)) return "Android";
    return "PC";
  }

  function queueMemo(caseId, type, body) {
    const d = new Date();
    const text = `---\n案件: ${caseId}\n種類: ${type}\n作成: ${isoLocal(d)}\n端末: ${deviceName()}\n---\n${body.trim()}\n`;
    const safe = caseId.replace(/[^0-9A-Za-z\-]/g, "_");
    const path = `${INBOX}/${stamp(d)}_${safe}.txt`;
    outbox.push({ path, text });
    store.set("outbox", outbox);
    sentLog.unshift({ name: path.split("/").pop(), caseId, type, at: isoLocal(d), body: body.trim() });
    sentLog = sentLog.slice(0, 300);
    store.set("sentLog", sentLog);
  }

  async function flushOutbox() {
    renderOutbox();
    if (!outbox.length || !navigator.onLine || !store.get("auth", null)) return;
    while (outbox.length) {
      try { await dbxUpload(outbox[0].path, outbox[0].text); }
      catch { break; }
      outbox.shift();
      store.set("outbox", outbox);
    }
    renderOutbox();
  }

  // ---------- 送信済み ----------
  const parseMemo = (text) => {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const head = {}; if (m) for (const l of m[1].split("\n")) { const i = l.indexOf(":"); if (i > 0) head[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    return { head, body: m ? m[2] : text };
  };

  const fmtAt = (at) => { if (!at) return ""; const d = new Date(at.replace(" ", "T")); return isNaN(d) ? at : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  async function loadRemoteSent() {
    $("sentState").textContent = "Dropboxから読み込み中…";
    try {
      const inbox = (await dbxList(INBOX)).filter((e) => e[".tag"] === "file");
      const done = (await dbxList("/案件")).filter((e) => e[".tag"] === "file" && /\/メモ原本\//.test(e.path_display));
      remoteSent = inbox.map((e) => ({ name: e.name, path: e.path_display, state: "未整理" }))
        .concat(done.map((e) => ({ name: e.name, path: e.path_display, state: "整理済み" })));
      store.set("remoteSent", remoteSent);
      $("sentState").textContent = "";
    } catch { $("sentState").textContent = "読み込めませんでした。オンラインか、Dropboxに接続しているか確認してください。"; }
    renderSent();
  }

  function renderSent() {
    const onlyCase = $("sentThisCase").checked && current;
    const pendingNames = new Set(outbox.map((o) => o.path.split("/").pop()));
    const remote = new Map(remoteSent.map((r) => [r.name, r]));
    const rows = new Map();
    for (const l of sentLog) rows.set(l.name, { ...l, state: pendingNames.has(l.name) ? "送信待ち" : (remote.get(l.name)?.state || "送信済み") });
    for (const r of remoteSent) if (!rows.has(r.name)) {
      const m = r.name.match(/^(\d{8})-(\d{2})(\d{2})\d{2}_(.+)\.txt$/);
      rows.set(r.name, { name: r.name, path: r.path, state: r.state, caseId: m ? m[4] : "", at: m ? `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6)} ${m[2]}:${m[3]}` : "", type: "", body: null });
    }
    let list = [...rows.values()].sort((a, b) => (b.name > a.name ? 1 : -1));
    if (onlyCase) list = list.filter((x) => x.caseId === current.replace(/[^0-9A-Za-z\-]/g, "_") || x.caseId === current);
    const box = $("sentList"); box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<p class="muted small">まだありません。</p>'; return; }
    for (const x of list.slice(0, 200)) {
      const c = cases.find((k) => k.id === x.caseId);
      const d = document.createElement("details"); d.className = "sent";
      d.innerHTML = `<summary><span class="st st-${x.state}">${esc(x.state)}</span> ${esc(fmtAt(x.at))}　${esc(c ? caseLabel(c) : x.caseId || "")}　<span class="muted">${esc(x.type || "")}</span></summary><pre class="memo-body">${x.body != null ? esc(x.body) : "（開くと読み込みます）"}</pre>`;
      if (x.body == null && x.path) d.addEventListener("toggle", async () => {
        if (!d.open || d.dataset.loaded) return;
        try { const t = await dbxDownload(x.path); const p = parseMemo(t || ""); d.dataset.loaded = "1";
          d.querySelector("pre").textContent = p.body; if (p.head["種類"]) d.querySelector("summary .muted").textContent = p.head["種類"];
        } catch { d.querySelector("pre").textContent = "読み込めませんでした（オフラインかもしれません）。"; }
      });
      box.append(d);
    }
  }

  function renderOutbox() {
    const n = outbox.length;
    $("outbox").textContent = n
      ? `送信待ち ${n}件（${store.get("auth", null) ? "接続が戻ると自動で送ります" : "設定からDropboxに接続してください"}）`
      : "";
  }

  async function sendMemo() {
    const body = $("memo").value;
    if (!current || !body.trim()) return;
    queueMemo(current, $("memoType").value, body);
    $("memo").value = "";
    store.del("draft:" + current);
    $("memoType").value = "自動判定";
    updateSendState();
    $("draftState").textContent = "受信箱に送りました（次回の定時処理でClaudeが整理します）";
    await flushOutbox();
  }

  // ---------- 新規案件 ----------
  function nextCaseId(kind) {
    // 事務所の番号（例: A000, A001）があれば、その続きを提案する。会務は K001 から
    if (kind === "会務") {
      const n = Math.max(0, ...cases.map((c) => (String(c.id).match(/^K(\d+)$/) || [])[1]).filter(Boolean).map(Number));
      return "K" + String(n + 1).padStart(3, "0");
    }
    let best = null;
    for (const c of cases.filter((x) => !/^K\d+$/.test(x.id))) {
      const m = String(c.id).match(/^([A-Za-z]+)(\d+)$/);
      if (m && (!best || parseInt(m[2], 10) > best.n)) best = { p: m[1], n: parseInt(m[2], 10), w: m[2].length };
    }
    if (best) return best.p + String(best.n + 1).padStart(best.w, "0");
    return "A001";
  }

  async function createCase(form) {
    const id = form.caseId.value.trim();
    if (cases.some((c) => c.id === id)) { alertBox("その案件番号はすでにあります。"); return; }
    const kaimu = form.kind.value === "会務";
    const c = kaimu
      ? { id, client: form.client.value.trim(), initials: "", crime: "会務", custody: "", kind: "会務", pending: true }
      : { id, client: form.client.value.trim(), initials: form.initials.value.trim(), crime: form.crime.value.trim(), custody: form.custody.value, pending: true };
    cases.push(c);
    store.set("cases", cases);
    queueMemo(id, "新規案件", kaimu ? `区分: 会務\n案件番号: ${c.id}\n名称: ${c.client}` : `区分: 事件\n案件番号: ${c.id}\n依頼者名: ${c.client}\nイニシャル: ${c.initials}\n罪名: ${c.crime}\n身柄: ${c.custody}`);
    selectCase(id);
    await flushOutbox();
  }

  // ---------- 同期（Claudeの整理結果を読み込み、端末に保存） ----------
  async function pushHidden() {
    if (!hidden.dirty || !store.get("auth", null) || !navigator.onLine) return;
    try {
      await dbxUpload("/hidden.json", JSON.stringify({ ids: hidden.ids, updated: hidden.updated }), true);
      hidden.dirty = false; store.set("hidden", hidden);
    } catch {}
  }

  async function toggleHidden() {
    if (!current) return;
    const on = !isHidden(current);
    hidden.ids = on ? hidden.ids.concat(current) : hidden.ids.filter((x) => x !== current);
    hidden.updated = Date.now(); hidden.dirty = true;
    store.set("hidden", hidden);
    selectCase(current);
    alertBox(on ? "終了にして一覧から隠しました（削除はしていません）。" : "一覧に戻しました。");
    await pushHidden();
  }

  async function syncHidden() {
    const hj = await dbxDownload("/hidden.json");
    const remote = hj ? JSON.parse(hj) : null;
    if (remote && (!hidden.dirty || remote.updated > hidden.updated)) {
      hidden = { ids: remote.ids || [], updated: remote.updated || 0, dirty: false };
      store.set("hidden", hidden);
    } else if (!remote && hidden.ids.length) hidden.dirty = true;
    await pushHidden();
  }

  async function sync() {
    if (!store.get("auth", null)) { openSettings(); return; }
    if (!navigator.onLine) { setNet(); return; }
    $("sync").disabled = true; $("sync").textContent = "同期中…";
    try {
      await flushOutbox();
      const cj = await dbxDownload("/cases.json");
      if (cj) {
        const remote = JSON.parse(cj).cases || [];
        const ids = new Set(remote.map((c) => c.id));
        cases = remote.concat(cases.filter((c) => c.pending && !ids.has(c.id)));
        store.set("cases", cases);
      }
      await syncHidden();
      renderCases();
      if (current) selectCase(current);
      const dash = await dbxDownload("/ダッシュボード.md");
      if (dash != null) store.set("md:dashboard", dash);
      // 種類別ノート（接見メモなどを1つにまとめたもの）
      try {
        const notes = (await dbxList("/案件")).filter((e) => e[".tag"] === "file" && /\/ノート_[^/]+\.md$/.test(e.path_display));
        const byFolder = {};
        await Promise.all(notes.map(async (e) => {
          const parts = e.path_display.split("/"); const folder = parts[parts.length - 2];
          const kind = e.name.replace(/^ノート_/, "").replace(/\.md$/, "");
          const t = await dbxDownload(e.path_display);
          if (t != null) { (byFolder[folder] = byFolder[folder] || []).push(kind); store.set(`md:note:${folder}:${kind}`, t); }
        }));
        store.set("noteIndex", byFolder);
      } catch {}
      await Promise.all(cases.filter((x) => !x.pending).map(async (c) => {
        const card = await dbxDownload(`/案件/${c.folder || c.id}/案件カード.md`);
        if (card != null) store.set("md:case:" + c.id, card);
      }));
      store.set("lastSync", Date.now());
    } catch (e) {
      if (String(e.message).includes("not-connected") || String(e.message).includes("refresh")) alertBox("Dropboxへの接続が切れています。設定から接続し直してください。");
    } finally {
      $("sync").disabled = false; $("sync").textContent = "同期";
      renderCases(); renderDashboard(); renderCaseCard(); renderTasks(); setNet();
    }
  }

  // ---------- 簡易Markdown表示 ----------
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/【要確認】|⚠/g, (m) => `<span class="warn">${m}</span>`);
  function md(src) {
    const lines = src.replace(/\r/g, "").split("\n");
    let html = "", list = false, i = 0;
    const closeList = () => { if (list) { html += "</ul>"; list = false; } };
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
        closeList();
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
        html += "<table><thead><tr>" + cells(l).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { html += "<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++; }
        html += "</tbody></table>";
        continue;
      }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
      else if ((m = l.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) { if (!list) { html += "<ul>"; list = true; } html += `<li class="task">${m[1].trim() ? "☑" : "☐"} ${inline(m[2])}</li>`; }
      else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(m[1])}</li>`; }
      else if (!l.trim()) closeList();
      else { closeList(); html += `<p>${inline(l)}</p>`; }
      i++;
    }
    closeList();
    return html;
  }

  function syncNote() {
    const t = store.get("lastSync", null);
    return t ? `<p class="muted small">最終同期 ${new Date(t).toLocaleString("ja-JP")}</p>` : "";
  }
  function renderDashboard() {
    const d = store.get("md:dashboard", null);
    $("dashboard").innerHTML = d ? md(d) + syncNote() : '<p class="muted">同期するとダッシュボードが表示されます。</p>';
  }
  const NOTE_ORDER = ["接見", "依頼者との打合せ", "会議メモ", "期日メモ", "裁判所打合せ", "検察官とのやりとり", "面談", "電話", "検討メモ", "その他"];
  let caseSub = store.get("caseSub", "card");

  function renderCaseCard() {
    const c = cases.find((x) => x.id === current);
    const tabs = $("caseSubTabs");
    if (!c) { tabs.innerHTML = ""; $("caseCard").innerHTML = '<p class="muted">入力タブで案件を選ぶと、ここに案件カードが表示されます。</p>'; return; }
    const folder = c.folder || c.id;
    const kinds = (store.get("noteIndex", {})[folder] || []).slice().sort((a, b) => NOTE_ORDER.indexOf(a) - NOTE_ORDER.indexOf(b));
    if (caseSub !== "card" && !kinds.includes(caseSub)) caseSub = "card";
    tabs.innerHTML = "";
    for (const k of ["card"].concat(kinds)) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = k === "card" ? "案件カード" : k + (k.endsWith("メモ") ? "" : "メモ");
      b.setAttribute("aria-pressed", String(k === caseSub));
      b.addEventListener("click", () => { caseSub = k; store.set("caseSub", k); renderCaseCard(); });
      tabs.append(b);
    }
    $("caseCard").classList.toggle("note", caseSub !== "card");
    if (caseSub === "card") {
      const card = store.get("md:case:" + c.id, null);
      $("caseCard").innerHTML = card ? md(card) + syncNote()
        : `<h1>${esc(caseLabel(c))}</h1><p class="muted">まだ案件カードがありません。メモを送ると、次回の定時処理でClaudeが作成します。</p>`;
    } else {
      $("caseCard").innerHTML = md(store.get(`md:note:${folder}:${caseSub}`, "")) + '<p id="noteEnd" class="muted small">― ここまで ―</p>' + syncNote();
      requestAnimationFrame(() => { const e = $("noteEnd"); if (e && !$("view-case").hidden) e.scrollIntoView({ block: "end" }); });
    }
  }

  // ---------- その他の画面要素 ----------
  function setNet() {
    const on = navigator.onLine;
    $("net").textContent = on ? "オンライン" : "オフライン";
    $("net").classList.toggle("off", !on);
  }
  function alertBox(msg) { $("draftState").textContent = msg; }
  function openSettings() {
    const a = store.get("auth", null);
    $("authState").textContent = a ? "Dropboxに接続済みです。" : "まだDropboxに接続していません。";
    $("keyOut").textContent = "";
    $("appKey").value = appKey();
    $("settingsDialog").showModal();
  }
  function showView(v) {
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.view === v));
    for (const s of document.querySelectorAll(".view")) s.hidden = s.id !== "view-" + v;
    store.set("view", v);
    if (v === "case") renderCaseCard();
    if (v === "sent") { renderSent(); if (navigator.onLine && store.get("auth", null)) loadRemoteSent(); }
  }

  // ---------- 起動 ----------
  async function init() {
    for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showView(b.dataset.view));
    $("caseFilter").addEventListener("input", renderCases);
    $("sentThisCase").addEventListener("change", renderSent);
    $("loadSent").addEventListener("click", loadRemoteSent);
    $("showHidden").addEventListener("change", renderCases);
    $("toggleHidden").addEventListener("click", toggleHidden);
    $("memo").addEventListener("input", () => { updateSendState(); clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });
    $("send").addEventListener("click", sendMemo);
    $("sync").addEventListener("click", sync);
    $("openSettings").addEventListener("click", openSettings);
    $("appKey").addEventListener("change", () => store.set("appKey", $("appKey").value.trim()));
    $("connect").addEventListener("click", () => { store.set("appKey", $("appKey").value.trim() || appKey()); startAuth(); });
    $("disconnect").addEventListener("click", () => { store.del("auth"); openSettings(); renderOutbox(); });
    $("showKey").addEventListener("click", () => { const a = store.get("auth", null); $("keyOut").textContent = a ? a.refresh : "先にDropboxに接続してください。"; });
    $("newCase").addEventListener("click", () => { const f = $("newCaseForm"); f.reset(); f.caseId.value = nextCaseId(f.kind.value); setKind(); $("newCaseDialog").showModal(); });
    const setKind = () => {
      const f = $("newCaseForm"), kaimu = f.kind.value === "会務";
      $("clientLabel").textContent = kaimu ? "名称（委員会・会議名）" : "依頼者名";
      f.client.placeholder = kaimu ? "刑事弁護委員会" : "山田太郎";
      for (const el of f.querySelectorAll(".jiken")) el.hidden = kaimu;
    };
    $("caseKind").addEventListener("change", () => { const f = $("newCaseForm"); f.caseId.value = nextCaseId(f.kind.value); setKind(); });
    $("cancelNewCase").addEventListener("click", () => $("newCaseDialog").close());
    $("newCaseForm").addEventListener("submit", (e) => { if (e.submitter && e.submitter.value === "ok") createCase(e.target); });
    window.addEventListener("online", () => { setNet(); flushOutbox(); });
    window.addEventListener("offline", setNet);
    window.addEventListener("pagehide", saveDraft);

    setNet();
    try { await finishAuth(); } catch {}
    renderCases(); renderDashboard(); renderOutbox();
    if (current) selectCase(current);
    showView(store.get("view", "input"));
    if ("serviceWorker" in navigator) {
      // 新しい版が入ったら一度だけ自動で読み込み直す
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) location.reload(); });
      navigator.serviceWorker.register("sw.js").then((r) => r.update()).catch(() => {});
    }
    if (store.get("auth", null) && navigator.onLine) sync();
  }
  init();
})();
