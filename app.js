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

  async function dbxUpload(path, text) {
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await accessToken()), "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": apiArg({ path, mode: "add", autorename: true, mute: true }) },
      body: new TextEncoder().encode(text),
    });
    if (!res.ok) throw new Error("upload " + res.status);
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

  const caseLabel = (c) => `${c.id} ${c.initials || ""}${c.crime ? "・" + c.crime : ""}`;

  // ---------- 画面: 案件一覧 ----------
  function renderCases() {
    const f = $("caseFilter").value.trim();
    const list = $("caseList");
    list.innerHTML = "";
    const shown = cases.filter((c) => !f || JSON.stringify(c).includes(f));
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
      sub.textContent = [c.custody, c.next ? "次回 " + c.next : "", c.pending ? "（新規・未整理）" : ""].filter(Boolean).join("　");
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
    $("memo").value = store.get("draft:" + id, "");
    updateSendState();
    renderCases();
    renderCaseCard();
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
    outbox.push({ path: `${INBOX}/${stamp(d)}_${safe}.txt`, text });
    store.set("outbox", outbox);
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
  function nextCaseId() {
    const y = new Date().getFullYear();
    const nums = cases.map((c) => (String(c.id).startsWith(y + "-") ? parseInt(String(c.id).slice(5), 10) : 0)).filter((n) => !isNaN(n));
    return `${y}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, "0")}`;
  }

  async function createCase(form) {
    const id = form.caseId.value.trim();
    if (cases.some((c) => c.id === id)) { alertBox("その案件番号はすでにあります。"); return; }
    const c = { id, initials: form.initials.value.trim(), crime: form.crime.value.trim(), custody: form.custody.value, pending: true };
    cases.push(c);
    store.set("cases", cases);
    queueMemo(id, "新規案件", `案件番号: ${c.id}\nイニシャル: ${c.initials}\n罪名: ${c.crime}\n身柄: ${c.custody}`);
    selectCase(id);
    await flushOutbox();
  }

  // ---------- 同期（Claudeの整理結果を読み込み、端末に保存） ----------
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
      const dash = await dbxDownload("/ダッシュボード.md");
      if (dash != null) store.set("md:dashboard", dash);
      for (const c of cases.filter((x) => !x.pending)) {
        const card = await dbxDownload(`/案件/${c.folder || c.id}/案件カード.md`);
        if (card != null) store.set("md:case:" + c.id, card);
      }
      store.set("lastSync", Date.now());
    } catch (e) {
      if (String(e.message).includes("not-connected") || String(e.message).includes("refresh")) alertBox("Dropboxへの接続が切れています。設定から接続し直してください。");
    } finally {
      $("sync").disabled = false; $("sync").textContent = "同期";
      renderCases(); renderDashboard(); renderCaseCard(); setNet();
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
  function renderCaseCard() {
    const c = cases.find((x) => x.id === current);
    if (!c) { $("caseCard").innerHTML = '<p class="muted">入力タブで案件を選ぶと、ここに案件カードが表示されます。</p>'; return; }
    const card = store.get("md:case:" + c.id, null);
    $("caseCard").innerHTML = card ? md(card) + syncNote()
      : `<h1>${esc(caseLabel(c))}</h1><p class="muted">まだ案件カードがありません。メモを送ると、次回の定時処理でClaudeが作成します。</p>`;
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
  }

  // ---------- 起動 ----------
  async function init() {
    for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showView(b.dataset.view));
    $("caseFilter").addEventListener("input", renderCases);
    $("memo").addEventListener("input", () => { updateSendState(); clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 400); });
    $("send").addEventListener("click", sendMemo);
    $("sync").addEventListener("click", sync);
    $("openSettings").addEventListener("click", openSettings);
    $("appKey").addEventListener("change", () => store.set("appKey", $("appKey").value.trim()));
    $("connect").addEventListener("click", () => { store.set("appKey", $("appKey").value.trim() || appKey()); startAuth(); });
    $("disconnect").addEventListener("click", () => { store.del("auth"); openSettings(); renderOutbox(); });
    $("showKey").addEventListener("click", () => { const a = store.get("auth", null); $("keyOut").textContent = a ? a.refresh : "先にDropboxに接続してください。"; });
    $("newCase").addEventListener("click", () => { const f = $("newCaseForm"); f.reset(); f.caseId.value = nextCaseId(); $("newCaseDialog").showModal(); });
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
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    if (store.get("auth", null) && navigator.onLine) sync();
  }
  init();
})();
