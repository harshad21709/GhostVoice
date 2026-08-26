"use strict";

(function () {
    const app = document.querySelector("#app");
    const workspaceHead = document.querySelector(".workspace-head");
    if (!app || !workspaceHead) return;

    const api = async (url, options = {}) => {
        const headers = new Headers(options.headers || {});
        const method = String(options.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
            const csrfResponse = await fetch("/api/csrf", { credentials: "same-origin", cache: "no-store" });
            const csrf = await csrfResponse.json();
            if (csrf.csrf_token) headers.set("X-CSRF-Token", csrf.csrf_token);
        }
        const response = await fetch(url, { ...options, method, headers, credentials: "same-origin", cache: "no-store" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
        return data;
    };

    const menu = document.createElement("div");
    menu.className = "gv-profile-wrap";
    menu.innerHTML = `
        <button id="gv-profile-button" class="gv-profile-button" type="button" aria-expanded="false" aria-haspopup="menu">
            <span class="gv-profile-avatar"><img src="/static/ghostvoice-logo.png" alt=""></span><span>PROFILE</span><span class="gv-profile-chevron">⌄</span>
        </button>
        <div id="gv-profile-menu" class="gv-profile-menu" role="menu" hidden>
            <div class="gv-profile-heading"><span class="eyebrow">PRIVATE ACCOUNT</span><div class="gv-profile-identity"><img src="/static/ghostvoice-logo.png" alt=""><div><strong id="gv-profile-name">ACCOUNT</strong><small id="gv-profile-email"></small></div></div></div>
            <a id="gv-admin-link" class="gv-profile-item gv-admin-item" href="/admin" target="_blank" rel="noopener" role="menuitem" hidden>▣ ADMIN PANEL</a>
            <button id="gv-delete-audios" class="gv-profile-item" type="button" role="menuitem">▣ DELETE ALL SAVED AUDIOS</button>
            <button id="gv-delete-account" class="gv-profile-item gv-danger-item" type="button" role="menuitem">✕ DELETE ACCOUNT</button>
            <button id="gv-logout" class="gv-profile-item" type="button" role="menuitem">↪ LOG OUT</button>
        </div>`;
    workspaceHead.appendChild(menu);

    const button = menu.querySelector("#gv-profile-button");
    const panel = menu.querySelector("#gv-profile-menu");
    const adminLink = menu.querySelector("#gv-admin-link");
    const nameElement = menu.querySelector("#gv-profile-name");
    const emailElement = menu.querySelector("#gv-profile-email");

    function closeMenu() { panel.hidden = true; button.setAttribute("aria-expanded", "false"); }
    button.addEventListener("click", (event) => { event.stopPropagation(); panel.hidden = !panel.hidden; button.setAttribute("aria-expanded", String(!panel.hidden)); });
    document.addEventListener("click", (event) => { if (!menu.contains(event.target)) closeMenu(); });

    function modal(title, body, buttons) {
        const overlay = document.createElement("div"); overlay.className = "gv-account-modal";
        overlay.innerHTML = `<div class="gv-account-dialog glass" role="dialog" aria-modal="true"><button class="gv-modal-x" type="button" aria-label="Close">×</button><span class="eyebrow">ACCOUNT CONTROL</span><h2>${title}</h2><div class="gv-modal-body">${body}</div><div class="gv-modal-actions"></div></div>`;
        document.body.appendChild(overlay); const actions = overlay.querySelector(".gv-modal-actions");
        buttons.forEach(({ label, className = "", onClick }) => { const b = document.createElement("button"); b.type="button"; b.className=`gv-modal-action ${className}`; b.textContent=label; b.addEventListener("click",()=>onClick(overlay,b)); actions.appendChild(b); });
        const close=()=>overlay.remove(); overlay.querySelector(".gv-modal-x").addEventListener("click",close); overlay.addEventListener("click",e=>{if(e.target===overlay)close();}); return overlay;
    }

    menu.querySelector("#gv-delete-audios").addEventListener("click", () => {
        closeMenu();
        modal("DELETE ALL SAVED AUDIOS?", `<p>This permanently deletes <strong>all encrypted recordings</strong> saved to your GhostVoice account. Your account will remain active.</p><p class="gv-warning">This action cannot be undone.</p>`, [
            {label:"CANCEL",onClick:o=>o.remove()},
            {label:"DELETE ALL",className:"gv-modal-danger",onClick:async(o,b)=>{b.disabled=true;b.textContent="DELETING…";try{const result=await api("/api/profile/delete-audios",{method:"POST"});o.querySelector(".gv-modal-body").innerHTML=`<p><strong>${result.deleted||0}</strong> saved recording(s) deleted.</p>`;b.textContent="DONE";setTimeout(()=>o.remove(),900);}catch(error){b.disabled=false;b.textContent="DELETE ALL";o.querySelector(".gv-modal-body").innerHTML+=`<p class="gv-error">${error.message}</p>`;}}}
        ]);
    });

    menu.querySelector("#gv-delete-account").addEventListener("click", () => {
        closeMenu();
        const overlay=modal("DELETE ACCOUNT",`<p>This permanently deletes your GhostVoice account, encrypted recordings, password-reset records and account audit data.</p><label class="gv-modal-label"><span>ACCOUNT PASSWORD</span><input id="gv-delete-password" type="password" minlength="12" autocomplete="current-password" placeholder="Enter your password"></label><p class="gv-error" id="gv-delete-error"></p>`,[
            {label:"CANCEL",onClick:o=>o.remove()},
            {label:"DELETE ACCOUNT",className:"gv-modal-danger",onClick:async(o,b)=>{const password=o.querySelector("#gv-delete-password").value;if(!password){o.querySelector("#gv-delete-error").textContent="Enter your password.";return;}b.disabled=true;b.textContent="VERIFYING…";try{await api("/api/profile/delete-account",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});o.remove();window.location.href="/";}catch(error){b.disabled=false;b.textContent="DELETE ACCOUNT";o.querySelector("#gv-delete-error").textContent=error.message;}}}
        ]); setTimeout(()=>overlay.querySelector("#gv-delete-password")?.focus(),50);
    });

    menu.querySelector("#gv-logout").addEventListener("click",async()=>{closeMenu();try{await api("/api/logout",{method:"POST"});}finally{window.location.href="/";}});

    async function loadProfile(){try{const profile=await api("/api/profile");nameElement.textContent=profile.username||"ACCOUNT";emailElement.textContent=profile.email||"No recovery email";adminLink.hidden=!profile.is_admin;}catch(_){} }
    const observer=new MutationObserver(()=>{if(!app.classList.contains("hidden"))loadProfile();}); observer.observe(app,{attributes:true,attributeFilter:["class"]}); loadProfile();
})();
