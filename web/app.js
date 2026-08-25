"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

let csrfToken = "";
let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let lastRecording = null;
let recordingStartedAt = 0;
let recordingTimer = null;
let audioContext = null;
let analyser = null;
let animationFrame = null;
let libraryAudio = null;
let libraryAudioUrl = null;
let libraryAudioId = null;
let registerMode = false;

const MAX_RECORDING_SECONDS = 180;

const auth = $("#auth");
const app = $("#app");
const authForm = $("#auth-form");
const authSubmit = $("#auth-submit");
const authSwitch = $("#auth-switch");
const usernameInput = $("#user");
const passwordInput = $("#pass");
const emailInput = $("#email");
const message = $("#msg");
const forgotPasswordButton = $("#forgot-password");
const logoutButton = $("#logout");
const startButton = $("#start");
const stopButton = $("#stop");
const saveButton = $("#save");
const fileInput = $("#fi");
const fileResult = $("#fr");
const verdict = $("#verdict");
const confidence = $("#confidence");
const circleStatus = $("#circle-status");
const detectorOrb = document.querySelector(".detector-orb");
const recordingTimerElement = $("#recording-timer");
const statusElement = $("#status");

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function setMessage(text, error = false) {
    if (!message) return;
    message.textContent = text || "";
    message.classList.toggle("error", error);
}

async function getCSRF() {
    const response = await fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Unable to initialize security session.");
    const data = await response.json();
    csrfToken = data.csrf_token || "";
    return csrfToken;
}

async function api(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    if (method !== "GET" && method !== "HEAD") {
        await getCSRF();
        headers.set("X-CSRF-Token", csrfToken);
    }
    const response = await fetch(url, { ...options, method, headers, credentials: "same-origin", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
}

function showAuth() { auth?.classList.remove("hidden"); app?.classList.add("hidden"); }
function showApp() { auth?.classList.add("hidden"); app?.classList.remove("hidden"); }

function updateAuthMode() {
    const eyebrow = $("#auth-eyebrow");
    const title = $("#auth-title");
    const description = $("#auth-description");
    const fields = $$(".register-only");
    if (registerMode) {
        eyebrow.textContent = "NEW PRIVATE IDENTITY";
        title.textContent = "CREATE GHOSTVOICE";
        description.textContent = "Create a private account for your encrypted workspace.";
        authSubmit.textContent = "CREATE ACCOUNT";
        authSwitch.textContent = "BACK TO SIGN IN";
        passwordInput.setAttribute("autocomplete", "new-password");
        fields.forEach((field) => field.classList.remove("hidden"));
        if (emailInput) emailInput.required = true;
    } else {
        eyebrow.textContent = "PRIVATE MODE";
        title.textContent = "ENTER GHOSTVOICE";
        description.textContent = "Sign in to access your private analysis workspace.";
        authSubmit.textContent = "SIGN IN";
        authSwitch.textContent = "CREATE ACCOUNT";
        passwordInput.setAttribute("autocomplete", "current-password");
        fields.forEach((field) => field.classList.add("hidden"));
        if (emailInput) { emailInput.required = false; emailInput.value = ""; }
    }
}

function verdictLabel(value) { return String(value || "READY") === "AI_GENERATED" ? "AI-GENERATED" : String(value || "READY"); }
function setCircleState(state) { if (circleStatus) circleStatus.textContent = state; detectorOrb?.classList.toggle("encrypting", state === "ENCRYPTING"); }

function showResult(result) {
    const raw = String(result.verdict || "UNCERTAIN").toUpperCase();
    const probability = Math.round(Number(result.ai_probability || 0) * 100);
    const conf = Math.round(Number(result.confidence || 0) * 100);
    const state = raw === "HUMAN" ? "human" : raw === "AI_GENERATED" ? "ai" : "uncertain";
    const label = verdictLabel(raw);
    if (verdict) {
        verdict.textContent = label;
        verdict.classList.remove("result-ai", "result-human", "result-uncertain");
        verdict.classList.add(`result-${state}`);
    }
    if (confidence) confidence.textContent = `AI probability ${probability}% · analysis confidence ${conf}% · ${result.windows || 0} windows`;
    setCircleState(label);
    if (fileResult) {
        fileResult.classList.remove("result-ai", "result-human", "result-uncertain");
        fileResult.classList.add(`result-${state}`);
        fileResult.innerHTML = `<span class="eyebrow">ANALYSIS RESULT</span><strong>${escapeHtml(label)}</strong><div class="result-metrics"><span>AI probability: <b>${probability}%</b></span><span>Confidence: <b>${conf}%</b></span><span>Windows: <b>${result.windows || 0}</b></span></div>`;
    }
}

function formatTime(seconds) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateRecordingTimer() {
    if (!recordingStartedAt) return;
    const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
    if (recordingTimerElement) recordingTimerElement.textContent = `${formatTime(Math.min(elapsed, MAX_RECORDING_SECONDS))} / 03:00`;
    if (elapsed >= MAX_RECORDING_SECONDS) stopRecording();
}
function startRecordingTimer() { recordingStartedAt = Date.now(); clearInterval(recordingTimer); recordingTimer = setInterval(updateRecordingTimer, 250); updateRecordingTimer(); }
function stopRecordingTimer() { clearInterval(recordingTimer); recordingTimer = null; recordingStartedAt = 0; if (recordingTimerElement) recordingTimerElement.textContent = "00:00 / 03:00"; }

function createVisualizer() {
    const container = $("#bars");
    if (!container) return;
    container.innerHTML = "";
    for (let i = 0; i < 36; i++) { const bar = document.createElement("span"); bar.className = "visual-bar"; bar.style.height = `${10 + Math.random() * 30}px`; container.appendChild(bar); }
}
function startVisualizer() {
    if (!analyser) return;
    const container = $("#bars");
    if (!container) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
        animationFrame = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(data);
        container.querySelectorAll(".visual-bar").forEach((bar, index, bars) => {
            const position = Math.floor((index / bars.length) * data.length);
            bar.style.height = `${8 + ((data[position] || 0) / 255) * 65}px`;
        });
    };
    draw();
}
function stopVisualizer() { if (animationFrame) cancelAnimationFrame(animationFrame); animationFrame = null; }
function cleanupAudio() { stopVisualizer(); mediaStream?.getTracks().forEach((track) => track.stop()); mediaStream = null; if (audioContext) audioContext.close().catch(() => {}); audioContext = null; analyser = null; }

function stopRecording() {
    stopRecordingTimer();
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
}

startButton?.addEventListener("click", async () => {
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable. Use HTTPS or localhost.");
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioContext.createMediaStreamSource(mediaStream);
        analyser = audioContext.createAnalyser(); analyser.fftSize = 256; source.connect(analyser); startVisualizer();
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
        const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
        mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
        chunks = [];
        mediaRecorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
        mediaRecorder.onstop = async () => {
            try {
                const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" }); chunks = [];
                if (!blob.size) throw new Error("No audio was captured.");
                lastRecording = blob; verdict.textContent = "ANALYZING"; setCircleState("ANALYZING"); confidence.textContent = "Examining the recorded voice…";
                const form = new FormData(); form.append("file", blob, "ghostvoice.webm");
                const result = await api("/api/analyze", { method: "POST", body: form });
                showResult(result); saveButton.disabled = false;
            } catch (error) { setCircleState("ERROR"); verdict.textContent = "ERROR"; confidence.textContent = error.message; }
            finally { cleanupAudio(); }
        };
        mediaRecorder.start(1000); startRecordingTimer(); startButton.disabled = true; stopButton.disabled = false; saveButton.disabled = true;
        verdict.textContent = "LISTENING"; setCircleState("LISTENING"); confidence.textContent = "Private capture active — maximum 03:00";
    } catch (error) { cleanupAudio(); alert(error.message || "Microphone access failed."); }
});
stopButton?.addEventListener("click", stopRecording);

saveButton?.addEventListener("click", async () => {
    if (!lastRecording) return;
    saveButton.disabled = true; setCircleState("ENCRYPTING"); verdict.textContent = "ENCRYPTING"; confidence.textContent = "Encrypting and securing your recording…";
    try {
        const form = new FormData(); form.append("file", lastRecording, "ghostvoice.webm");
        const result = await api("/api/analyze-and-save", { method: "POST", body: form });
        showResult(result); setCircleState("ENCRYPTED"); verdict.textContent = "ENCRYPTED"; confidence.textContent = "Recording encrypted and stored securely."; lastRecording = null; await loadLibrary();
    } catch (error) { setCircleState("ERROR"); verdict.textContent = "ERROR"; confidence.textContent = error.message; saveButton.disabled = false; }
});

fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    if (file.size > 200 * 1024 * 1024) { fileResult.innerHTML = `<span class="eyebrow">ERROR</span><strong>File is larger than 200 MB.</strong>`; return; }
    fileResult.innerHTML = `<span class="eyebrow">ANALYZING</span><strong>Examining your recording…</strong>`;
    try { const form = new FormData(); form.append("file", file); showResult(await api("/api/analyze", { method: "POST", body: form })); }
    catch (error) { fileResult.innerHTML = `<span class="eyebrow">ERROR</span><strong>${escapeHtml(error.message)}</strong>`; }
});

function stopLibraryAudio() { if (libraryAudio) { libraryAudio.pause(); libraryAudio.currentTime = 0; } if (libraryAudioUrl) URL.revokeObjectURL(libraryAudioUrl); libraryAudio = null; libraryAudioUrl = null; libraryAudioId = null; }
async function playLibraryRecording(id, playButton, pauseButton) {
    if (libraryAudioId === id && libraryAudio) { if (libraryAudio.paused) await libraryAudio.play(); else libraryAudio.pause(); return; }
    stopLibraryAudio();
    const response = await fetch(`/api/recordings/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load recording.");
    libraryAudioUrl = URL.createObjectURL(await response.blob()); libraryAudio = new Audio(libraryAudioUrl); libraryAudioId = id;
    libraryAudio.addEventListener("play", () => { playButton.textContent = "▶ PLAYING"; pauseButton.disabled = false; });
    libraryAudio.addEventListener("pause", () => { if (libraryAudio && !libraryAudio.ended) { playButton.textContent = "▶ RESUME"; pauseButton.disabled = false; } });
    libraryAudio.addEventListener("ended", () => { playButton.textContent = "▶ PLAY"; pauseButton.disabled = true; stopLibraryAudio(); });
    await libraryAudio.play();
}
async function downloadRecording(id, button) {
    const original = button.textContent; button.disabled = true; button.textContent = "DOWNLOADING…";
    try { const response = await fetch(`/api/recordings/${encodeURIComponent(id)}/download`, { credentials: "same-origin", cache: "no-store" }); if (!response.ok) throw new Error("Unable to download recording."); const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `ghostvoice-${id}.wav`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    finally { button.disabled = false; button.textContent = original; }
}

async function loadLibrary() {
    const list = $("#list"); if (!list) return;
    list.innerHTML = `<div class="result-card glass"><span class="eyebrow">PRIVATE STORAGE</span><strong>Loading encrypted recordings…</strong></div>`;
    try {
        const rows = await api("/api/recordings");
        if (!rows.length) { list.innerHTML = `<div class="result-card glass"><span class="eyebrow">PRIVATE STORAGE</span><strong>No encrypted recordings yet.</strong></div>`; return; }
        list.innerHTML = rows.map((row) => {
            const state = row.verdict === "HUMAN" ? "result-human" : row.verdict === "AI_GENERATED" ? "result-ai" : "result-uncertain";
            return `<article class="library-item glass ${state}"><div class="gv-recording-info"><span class="eyebrow">ENCRYPTED RECORDING</span><strong>${escapeHtml(verdictLabel(row.verdict))}</strong><small>${escapeHtml(new Date(row.created_at).toLocaleString())} · ${formatTime(row.duration)} · AI probability ${Math.round((row.ai_probability || 0) * 100)}%</small></div><div class="gv-recording-actions"><button class="gv-audio-btn gv-play" type="button" data-id="${escapeHtml(row.id)}">▶ PLAY</button><button class="gv-audio-btn gv-pause" type="button" data-id="${escapeHtml(row.id)}" disabled>⏸ PAUSE</button><button class="gv-audio-btn gv-download" type="button" data-id="${escapeHtml(row.id)}">⬇ DOWNLOAD</button><button class="gv-audio-btn gv-delete" type="button" data-id="${escapeHtml(row.id)}">✕ DELETE</button></div></article>`;
        }).join("");
        list.querySelectorAll(".gv-play").forEach((button) => button.addEventListener("click", async () => { try { const card = button.closest(".library-item"); await playLibraryRecording(button.dataset.id, button, card.querySelector(".gv-pause")); } catch (error) { setMessage(error.message, true); } }));
        list.querySelectorAll(".gv-pause").forEach((button) => button.addEventListener("click", () => { if (libraryAudio && libraryAudioId === button.dataset.id) libraryAudio.pause(); }));
        list.querySelectorAll(".gv-download").forEach((button) => button.addEventListener("click", async () => { try { await downloadRecording(button.dataset.id, button); } catch (error) { setMessage(error.message, true); } }));
        list.querySelectorAll(".gv-delete").forEach((button) => button.addEventListener("click", async () => { if (!confirm("Permanently delete this encrypted recording?")) return; button.disabled = true; try { if (libraryAudioId === button.dataset.id) stopLibraryAudio(); await api(`/api/recordings/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" }); await loadLibrary(); } catch (error) { button.disabled = false; setMessage(error.message, true); } }));
    } catch (error) { list.innerHTML = `<div class="result-card glass"><strong>${escapeHtml(error.message)}</strong></div>`; }
}

authSwitch?.addEventListener("click", () => { registerMode = !registerMode; setMessage(""); updateAuthMode(); });
authForm?.addEventListener("submit", async (event) => {
    event.preventDefault(); setMessage(""); authSubmit.disabled = true;
    try { await api(registerMode ? "/api/register" : "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: usernameInput.value.trim(), password: passwordInput.value, email: emailInput?.value.trim() || "" }) }); showApp(); statusElement.textContent = "SECURE SESSION"; await loadLibrary(); }
    catch (error) { setMessage(error.message, true); }
    finally { authSubmit.disabled = false; }
});
logoutButton?.addEventListener("click", async () => { logoutButton.disabled = true; try { await api("/api/logout", { method: "POST" }); } catch (error) { console.error(error); } stopRecording(); cleanupAudio(); showAuth(); logoutButton.disabled = false; usernameInput.value = ""; passwordInput.value = ""; statusElement.textContent = "SECURE ENGINE"; });
$$(".tab").forEach((tab) => tab.addEventListener("click", async () => { const target = tab.dataset.t; $$(".tab").forEach((item) => item.classList.toggle("active", item === tab)); $$(".panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== target)); if (target === "library") await loadLibrary(); }));

function setupPasswordRecovery() {
    if (!forgotPasswordButton) return;
    const modal = document.createElement("div"); modal.className = "gv-modal hidden";
    modal.innerHTML = `<div class="gv-modal-card glass" role="dialog" aria-modal="true"><button class="gv-modal-close" type="button" aria-label="Close">×</button><span class="eyebrow">ACCOUNT RECOVERY</span><h2>RESET PASSWORD</h2><form id="gv-forgot-form"><label><span>RECOVERY EMAIL</span><input id="gv-recovery-email" type="email" required></label><button class="primary" type="submit">SEND RESET LINK</button><p id="gv-forgot-msg" class="message"></p></form><form id="gv-reset-form" class="hidden"><label><span>NEW PASSWORD</span><input id="gv-new-password" type="password" minlength="12" required></label><label><span>CONFIRM PASSWORD</span><input id="gv-confirm-password" type="password" minlength="12" required></label><button class="primary" type="submit">RESET PASSWORD</button><p id="gv-reset-msg" class="message"></p></form></div>`;
    document.body.appendChild(modal);
    const close = () => modal.classList.add("hidden");
    modal.querySelector(".gv-modal-close").addEventListener("click", close);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    forgotPasswordButton.addEventListener("click", () => { modal.classList.remove("hidden"); modal.querySelector("#gv-forgot-form").classList.remove("hidden"); modal.querySelector("#gv-reset-form").classList.add("hidden"); });
    const token = new URLSearchParams(location.search).get("reset_token");
    if (token) { modal.classList.remove("hidden"); modal.querySelector("#gv-forgot-form").classList.add("hidden"); modal.querySelector("#gv-reset-form").classList.remove("hidden"); }
    modal.querySelector("#gv-forgot-form").addEventListener("submit", async (event) => { event.preventDefault(); const msg = $("#gv-forgot-msg"); try { const result = await api("/api/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: $("#gv-recovery-email").value.trim() }) }); msg.textContent = result.message || "If that email is registered, a reset link has been sent."; } catch (error) { msg.textContent = error.message; msg.classList.add("error"); } });
    modal.querySelector("#gv-reset-form").addEventListener("submit", async (event) => { event.preventDefault(); const password = $("#gv-new-password").value; const confirmPassword = $("#gv-confirm-password").value; const msg = $("#gv-reset-msg"); if (password !== confirmPassword) { msg.textContent = "Passwords do not match."; msg.classList.add("error"); return; } try { const result = await api("/api/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, new_password: password }) }); msg.textContent = result.message || "Password changed. You can now sign in."; history.replaceState({}, "", location.pathname); setTimeout(close, 800); } catch (error) { msg.textContent = error.message; msg.classList.add("error"); } });
}

createVisualizer();
updateAuthMode();
setCircleState("READY");
setupPasswordRecovery();

async function checkSession() { try { await api("/api/me"); showApp(); await loadLibrary(); } catch { showAuth(); } }
checkSession();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js").catch(() => {});
\n\n/* =========================================================\n   GHOSTVOICE ENHANCEMENTS\n   ========================================================= */\n\n(function () {\n    const state = { audio: null, url: null, id: null, rendering: false };\n\n    function stopCurrent() {\n        if (state.audio) {\n            state.audio.pause();\n            state.audio.currentTime = 0;\n        }\n        if (state.url) {\n            URL.revokeObjectURL(state.url);\n        }\n        state.audio = null;\n        state.url = null;\n        state.id = null;\n    }\n\n    function formatLocalTime(value) {\n        const date = new Date(value);\n        if (Number.isNaN(date.getTime())) return "Unknown time";\n        return new Intl.DateTimeFormat(undefined, {\n            dateStyle: "medium",\n            timeStyle: "short"\n        }).format(date);\n    }\n\n    async function downloadRecording(id) {\n        const response = await fetch(`/api/recordings/${encodeURIComponent(id)}/download`, {\n            credentials: "same-origin",\n            cache: "no-store"\n        });\n        if (!response.ok) throw new Error("Download failed");\n        const blob = await response.blob();\n        const url = URL.createObjectURL(blob);\n        const a = document.createElement("a");\n        a.href = url;\n        a.download = `ghostvoice-${id}.wav`;\n        document.body.appendChild(a);\n        a.click();\n        a.remove();\n        setTimeout(() => URL.revokeObjectURL(url), 1000);\n    }\n\n    async function playRecording(id, playButton, pauseButton) {\n        if (state.id === id && state.audio) {\n            if (state.audio.paused) {\n                await state.audio.play();\n            } else {\n                state.audio.pause();\n            }\n            return;\n        }\n\n        stopCurrent();\n        const response = await fetch(`/api/recordings/${encodeURIComponent(id)}`, {\n            credentials: "same-origin",\n            cache: "no-store"\n        });\n        if (!response.ok) throw new Error("Unable to play recording");\n        const blob = await response.blob();\n        state.url = URL.createObjectURL(blob);\n        state.audio = new Audio(state.url);\n        state.id = id;\n        state.audio.addEventListener("ended", () => {\n            playButton.textContent = "▶ PLAY";\n            pauseButton.disabled = true;\n            playButton.disabled = false;\n            stopCurrent();\n        });\n        state.audio.addEventListener("play", () => {\n            playButton.textContent = "▶ PLAYING";\n            pauseButton.disabled = false;\n        });\n        state.audio.addEventListener("pause", () => {\n            if (state.audio && state.audio.currentTime > 0 && !state.audio.ended) {\n                playButton.textContent = "▶ RESUME";\n                pauseButton.disabled = false;\n            }\n        });\n        await state.audio.play();\n    }\n\n    async function renderLibrary() {\n        if (state.rendering) return;\n        const list = document.querySelector("#list");\n        if (!list || list.dataset.gvEnhanced === "1") return;\n        state.rendering = true;\n        try {\n            const rows = await api("/api/recordings");\n            list.dataset.gvEnhanced = "1";\n            list.innerHTML = "";\n            if (!rows.length) {\n                list.innerHTML = `<div class="library-empty glass"><span class="eyebrow">PRIVATE STORAGE</span><strong>No encrypted recordings yet.</strong><p>Save an analysis to create your first encrypted recording.</p></div>`;\n                return;\n            }\n            for (const row of rows) {\n                const card = document.createElement("article");\n                card.className = "library-item glass gv-library-item";\n                const verdict = escapeHtml(row.verdict === "AI_GENERATED" ? "AI-GENERATED" : row.verdict);\n                const probability = Math.round((row.ai_probability || 0) * 100);\n                const duration = Math.round(Number(row.duration || 0));\n                card.innerHTML = `\n                    <div class="gv-recording-info">\n                        <span class="eyebrow">ENCRYPTED RECORDING</span>\n                        <strong>${verdict}</strong>\n                        <small>${formatLocalTime(row.created_at)} · ${formatTime(duration)} · AI probability ${probability}%</small>\n                    </div>\n                    <div class="gv-recording-actions">\n                        <button class="gv-audio-btn gv-play" type="button">▶ PLAY</button>\n                        <button class="gv-audio-btn gv-pause" type="button" disabled>⏸ PAUSE</button>\n                        <button class="gv-audio-btn gv-download" type="button">⬇ DOWNLOAD</button>\n                        <button class="gv-audio-btn gv-delete gv-danger" type="button">✕ DELETE</button>\n                    </div>`;\n                const play = card.querySelector(".gv-play");\n                const pause = card.querySelector(".gv-pause");\n                const download = card.querySelector(".gv-download");\n                const del = card.querySelector(".gv-delete");\n                play.addEventListener("click", async () => {\n                    try { await playRecording(row.id, play, pause); } catch (e) { setMessage(e.message, true); }\n                });\n                pause.addEventListener("click", () => {\n                    if (state.audio && state.id === row.id) state.audio.pause();\n                });\n                download.addEventListener("click", async () => {\n                    download.disabled = true;\n                    try { await downloadRecording(row.id); } catch (e) { setMessage(e.message, true); } finally { download.disabled = false; }\n                });\n                del.addEventListener("click", async () => {\n                    if (!confirm("Delete this encrypted recording permanently?")) return;\n                    del.disabled = true;\n                    try {\n                        if (state.id === row.id) stopCurrent();\n                        await api(`/api/recordings/${encodeURIComponent(row.id)}`, { method: "DELETE" });\n                        list.dataset.gvEnhanced = "0";\n                        await renderLibrary();\n                    } catch (e) {\n                        del.disabled = false;\n                        setMessage(e.message, true);\n                    }\n                });\n                list.appendChild(card);\n            }\n        } finally {\n            state.rendering = false;\n        }\n    }\n\n    // Re-render whenever the original library loader changes #list.\n    const list = document.querySelector("#list");\n    if (list) {\n        const observer = new MutationObserver(() => {\n            if (list.dataset.gvEnhanced !== "1") renderLibrary();\n        });\n        observer.observe(list, { childList: true });\n    }\n\n    // Make the first library render deterministic even if the original loader is slow.\n    document.addEventListener("click", (event) => {\n        const tab = event.target.closest?.('.tab[data-t="library"]');\n        if (tab) {\n            setTimeout(() => {\n                if (list) list.dataset.gvEnhanced = "0";\n                renderLibrary();\n            }, 150);\n        }\n    });\n\n    // Forgot-password modal.\n    const forgot = document.querySelector("#forgot-password");\n    if (forgot) {\n        const modal = document.createElement("div");\n        modal.className = "gv-modal hidden";\n        modal.innerHTML = `\n          <div class="gv-modal-card glass" role="dialog" aria-modal="true" aria-labelledby="gv-recovery-title">\n            <button class="gv-modal-close" type="button" aria-label="Close">×</button>\n            <span class="eyebrow">ACCOUNT RECOVERY</span>\n            <h2 id="gv-recovery-title">RESET PASSWORD</h2>\n            <p class="gv-modal-copy">Enter your recovery email. If it belongs to a GhostVoice account, we'll send a single-use reset link.</p>\n            <form id="gv-forgot-form">\n              <label><span>RECOVERY EMAIL</span><input id="gv-recovery-email" type="email" required autocomplete="email"></label>\n              <button class="primary" type="submit">SEND RESET LINK</button>\n              <p id="gv-forgot-msg" class="message" role="status"></p>\n            </form>\n            <form id="gv-reset-form" class="hidden">\n              <label><span>NEW PASSWORD</span><input id="gv-new-password" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></label>\n              <button class="primary" type="submit">SET NEW PASSWORD</button>\n              <p id="gv-reset-msg" class="message" role="status"></p>\n            </form>\n          </div>`;\n        document.body.appendChild(modal);\n        const close = () => modal.classList.add("hidden");\n        forgot.addEventListener("click", () => { modal.classList.remove("hidden"); });\n        modal.querySelector(".gv-modal-close").addEventListener("click", close);\n        modal.addEventListener("click", e => { if (e.target === modal) close(); });\n        const forgotForm = modal.querySelector("#gv-forgot-form");\n        const resetForm = modal.querySelector("#gv-reset-form");\n        const forgotMsg = modal.querySelector("#gv-forgot-msg");\n        const resetMsg = modal.querySelector("#gv-reset-msg");\n        const token = new URLSearchParams(location.search).get("reset_token");\n        if (token) {\n            forgotForm.classList.add("hidden");\n            resetForm.classList.remove("hidden");\n            modal.classList.remove("hidden");\n        }\n        forgotForm.addEventListener("submit", async e => {\n            e.preventDefault();\n            try {\n                await api("/api/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "recovery", password: "placeholder-password-123", email: modal.querySelector("#gv-recovery-email").value.trim() }) });\n                forgotMsg.textContent = "If that email is registered, a reset link has been sent.";\n            } catch (err) { forgotMsg.textContent = err.message; forgotMsg.classList.add("error"); }\n        });\n        resetForm.addEventListener("submit", async e => {\n            e.preventDefault();\n            try {\n                await api("/api/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, new_password: modal.querySelector("#gv-new-password").value }) });\n                resetMsg.textContent = "Password changed. You can now sign in.";\n                history.replaceState({}, "", location.pathname);\n                setTimeout(close, 1000);\n            } catch (err) { resetMsg.textContent = err.message; resetMsg.classList.add("error"); }\n        });\n    }\n})();\n