(() => {
  const SESSION_KEY = "sandboxed-auth-session";
  const DEVICE_KEY = "sandboxed-device-id";
  const modal = document.querySelector("#membership-modal");
  const content = document.querySelector("#membership-content");
  const accountButton = document.querySelector("#account-button");
  const statusButton = document.querySelector("#membership-status");
  const closeButton = document.querySelector("#close-membership");

  let config = {membershipEnabled:false, annualPrice:20, currency:"USD", maxDevices:4, maxStreams:2};
  let session = loadSession();
  let account = null;
  let returnFocus = null;
  let pendingPlay = null;
  let heartbeatTimer = null;
  let playbackSessionId = null;
  let recoveryMode = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }

  function saveSession(value) {
    session = value;
    try {
      if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  }

  function normalizeSession(value) {
    if (!value?.access_token) return null;
    return {
      access_token:value.access_token,
      refresh_token:value.refresh_token || session?.refresh_token || "",
      expires_at:Number(value.expires_at) || Math.floor(Date.now() / 1000) + Number(value.expires_in || 3600),
      token_type:value.token_type || "bearer",
      user:value.user || session?.user || null
    };
  }

  async function authRequest(body) {
    const response = await fetch("/api/auth", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || "Authentication failed"), {code:payload.code, status:response.status});
    return payload;
  }

  async function refreshSession(force = false) {
    if (!session?.refresh_token) return session;
    if (!force && Number(session.expires_at || 0) > Date.now() / 1000 + 90) return session;
    try {
      const payload = await authRequest({action:"refresh", refreshToken:session.refresh_token});
      const next = normalizeSession(payload.session);
      saveSession(next);
      return next;
    } catch {
      saveSession(null);
      account = null;
      updateHeader();
      return null;
    }
  }

  async function authorizedFetch(path, options = {}, retry = true) {
    const current = await refreshSession();
    if (!current?.access_token) throw Object.assign(new Error("Sign in required"), {status:401, code:"AUTH_REQUIRED"});
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${current.access_token}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {...options, headers});
    if (response.status === 401 && retry && await refreshSession(true)) return authorizedFetch(path, options, false);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || "Request failed"), {status:response.status, code:payload.code, payload});
    return payload;
  }

  function deviceId() {
    let id = "";
    try { id = localStorage.getItem(DEVICE_KEY) || ""; } catch {}
    if (!id) {
      id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      try { localStorage.setItem(DEVICE_KEY, id); } catch {}
    }
    return id;
  }

  async function fingerprint() {
    const values = [
      navigator.userAgent,
      navigator.platform,
      navigator.language,
      (navigator.languages || []).join(","),
      navigator.hardwareConcurrency,
      navigator.deviceMemory,
      navigator.maxTouchPoints,
      screen.width,
      screen.height,
      screen.colorDepth,
      Intl.DateTimeFormat().resolvedOptions().timeZone
    ].join("|");
    try {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(values));
      return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
    } catch {
      return values;
    }
  }

  function deviceName() {
    const userAgent = navigator.userAgent || "";
    const isiPad = /iPad/i.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (/iPhone/i.test(userAgent)) return "iPhone";
    if (isiPad) return "iPad";
    if (/Android/i.test(userAgent)) return "Android device";
    if (/Windows/i.test(userAgent)) return "Windows computer";
    if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
    if (/Linux/i.test(userAgent)) return "Linux computer";
    return "Web browser";
  }

  async function devicePayload() {
    return {deviceId:deviceId(), fingerprint:await fingerprint(), deviceName:deviceName()};
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat(undefined, {dateStyle:"medium", timeStyle:"short"}).format(new Date(value));
  }

  function statusLabel(profile) {
    if (!profile) return "";
    if (profile.state === "active") return "ACTIVE";
    if (profile.state === "expired") return "EXPIRED";
    if (profile.state === "eligible") return "3-DAY TRIAL";
    const hours = Math.max(1, Math.ceil((Date.parse(profile.trialEndsAt) - Date.now()) / 3600000));
    return hours > 24 ? `${Math.ceil(hours / 24)} DAYS LEFT` : `${hours}H LEFT`;
  }

  function updateHeader() {
    if (!config.membershipEnabled) {
      statusButton.hidden = true;
      accountButton.textContent = "S";
      accountButton.setAttribute("aria-label", "Account");
      return;
    }
    statusButton.hidden = false;
    statusButton.textContent = account ? statusLabel(account.profile) : "FREE TRIAL";
    statusButton.className = `membership-status ${account?.profile?.state ? `is-${account.profile.state}` : ""}`;
    accountButton.textContent = account?.user?.email ? account.user.email[0].toUpperCase() : "S";
    accountButton.setAttribute("aria-label", account ? "Open account" : "Sign in");
  }

  function openModal(view = "account", message = "") {
    returnFocus = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    if (view === "signup" || view === "login") renderAuth(view, message);
    else if (view === "verify") renderVerify(message);
    else if (view === "forgot") renderForgot(message);
    else if (view === "recovery") renderRecovery(message);
    else if (view === "paywall") renderPaywall(message);
    else if (view === "device-limit") renderDeviceLimit(message);
    else if (account) renderAccount(message);
    else if (config.membershipEnabled) renderAuth("login", message);
    else renderSetup();
    setTimeout(() => content.querySelector("input, button, a")?.focus(), 0);
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = document.querySelector("#player-modal")?.hidden === false ? "hidden" : "";
    returnFocus?.focus?.();
  }

  function panelHeader(eyebrow, title, copy = "") {
    return `<p class="membership-eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2>${copy ? `<p class="membership-copy">${escapeHtml(copy)}</p>` : ""}`;
  }

  function setMessage(message, error = false) {
    const target = content.querySelector("#membership-message");
    if (!target) return;
    target.textContent = message || "";
    target.classList.toggle("is-error", error);
  }

  function renderSetup() {
    content.innerHTML = `${panelHeader("MEMBERSHIP", "Account setup is finishing", "Sandboxed playback is still available while the private membership connection is completed.")}<p class="membership-message">No account is required yet.</p>`;
  }

  function renderAuth(mode, message = "") {
    const signup = mode === "signup";
    content.innerHTML = `${panelHeader(signup ? "START FREE" : "WELCOME BACK", signup ? "Try Sandboxed for three days" : "Sign in to Sandboxed", signup ? "No card required. Your trial begins when your first video starts." : "Continue your trial or membership on this device.")}
      <div class="auth-switch"><button type="button" data-auth-view="login" class="${signup ? "" : "active"}">Sign in</button><button type="button" data-auth-view="signup" class="${signup ? "active" : ""}">Create account</button></div>
      <form class="membership-form" id="membership-auth-form">
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        <label>Password<input type="password" name="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="8" required></label>
        <button class="membership-primary" type="submit">${signup ? "Create account" : "Sign in"}</button>
      </form>
      ${signup ? "" : '<button class="membership-text-button" type="button" id="forgot-password">Forgot password?</button>'}
      <p class="membership-legal">By continuing, you agree to the <a href="/terms" target="_blank" rel="noopener">Sandboxed terms</a> and <a href="/privacy" target="_blank" rel="noopener">privacy notice</a>.</p>
      <p class="membership-message" id="membership-message"></p>`;
    content.querySelectorAll("[data-auth-view]").forEach((button) => button.addEventListener("click", () => renderAuth(button.dataset.authView)));
    content.querySelector("#forgot-password")?.addEventListener("click", () => renderForgot());
    content.querySelector("#membership-auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const submit = event.currentTarget.querySelector("button[type=submit]");
      submit.disabled = true;
      setMessage(signup ? "Creating your account…" : "Signing in…");
      try {
        const payload = await authRequest({action:signup ? "signup" : "login", email:form.get("email"), password:form.get("password")});
        if (payload.confirmationRequired) return renderVerify("Check your email and tap the verification link, then return here to sign in.");
        const next = normalizeSession(payload.session);
        saveSession(next);
        await refreshAccount();
        closeModal();
        if (pendingPlay) {
          const item = pendingPlay;
          pendingPlay = null;
          window.dispatchEvent(new CustomEvent("sandboxed:resume-play", {detail:item}));
        }
      } catch (error) {
        setMessage(error.message, true);
        submit.disabled = false;
      }
    });
    if (message) setMessage(message, true);
  }

  function renderVerify(message) {
    content.innerHTML = `${panelHeader("CHECK YOUR EMAIL", "Verify your account", message || "Tap the verification link we sent, then come back and sign in.")}<button class="membership-primary" type="button" id="back-to-login">Back to sign in</button><p class="membership-message" id="membership-message"></p>`;
    content.querySelector("#back-to-login").addEventListener("click", () => renderAuth("login"));
  }

  function renderForgot(message = "") {
    content.innerHTML = `${panelHeader("PASSWORD RESET", "Reset your password", "We will email you a secure recovery link.")}
      <form class="membership-form" id="recovery-email-form"><label>Email<input type="email" name="email" autocomplete="email" required></label><button class="membership-primary" type="submit">Send recovery link</button></form>
      <button class="membership-text-button" type="button" id="back-to-login">Back to sign in</button><p class="membership-message" id="membership-message"></p>`;
    content.querySelector("#back-to-login").addEventListener("click", () => renderAuth("login"));
    content.querySelector("#recovery-email-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        await authRequest({action:"recover", email:new FormData(event.currentTarget).get("email")});
        setMessage("Recovery link sent. Check your email.");
      } catch (error) {
        setMessage(error.message, true);
        submit.disabled = false;
      }
    });
    if (message) setMessage(message, true);
  }

  function renderRecovery(message = "") {
    content.innerHTML = `${panelHeader("NEW PASSWORD", "Choose a new password", "Use at least eight characters.")}
      <form class="membership-form" id="new-password-form"><label>New password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label><button class="membership-primary" type="submit">Update password</button></form>
      <p class="membership-message" id="membership-message"></p>`;
    content.querySelector("#new-password-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        await authRequest({action:"update-password", accessToken:session?.access_token, password:new FormData(event.currentTarget).get("password")});
        recoveryMode = false;
        setMessage("Password updated. You are signed in.");
        setTimeout(async () => { await refreshAccount(); renderAccount(); }, 700);
      } catch (error) {
        setMessage(error.message, true);
        submit.disabled = false;
      }
    });
    if (message) setMessage(message, true);
  }

  function paymentButtons() {
    return `<div class="payment-actions">
      <button class="membership-primary" type="button" data-checkout="stripe" ${config.stripeEnabled ? "" : "disabled"}>Pay $20 with card</button>
      <button class="membership-secondary" type="button" data-checkout="nowpayments" ${config.nowPaymentsEnabled ? "" : "disabled"}>Pay with Bitcoin or crypto</button>
    </div>${!config.stripeEnabled || !config.nowPaymentsEnabled ? '<p class="membership-small">Payment buttons activate when the private processor keys are connected.</p>' : ""}`;
  }

  function supportLine() {
    const email = String(config.supportEmail || "").trim();
    return email ? `<p class="membership-small">Need help? <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>` : "";
  }

  function bindPaymentButtons() {
    content.querySelectorAll("[data-checkout]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      setMessage("Opening secure checkout…");
      try {
        const endpoint = button.dataset.checkout === "stripe" ? "/api/stripe-checkout" : "/api/nowpayments-invoice";
        const payload = await authorizedFetch(endpoint, {method:"POST"});
        location.href = payload.url;
      } catch (error) {
        setMessage(error.message, true);
        button.disabled = false;
      }
    }));
  }

  function renderPaywall(message = "") {
    content.innerHTML = `${panelHeader("TRIAL COMPLETE", "Keep Sandboxed for $20 a year", "Your account, saved list, and four registered devices stay available after payment.")}
      <div class="membership-price"><strong>$20</strong><span>per year</span></div>${paymentButtons()}
      <ul class="membership-features"><li>Four registered devices</li><li>Two simultaneous streams</li><li>Card, Bitcoin, or other supported crypto</li></ul>
      ${supportLine()}
      <button class="membership-text-button" type="button" id="paywall-signout">Sign out</button><p class="membership-message" id="membership-message"></p>`;
    bindPaymentButtons();
    content.querySelector("#paywall-signout").addEventListener("click", signOut);
    if (message) setMessage(message, true);
  }

  function renderAccount(message = "") {
    if (!account) return renderAuth("login");
    const profile = account.profile;
    const statusCopy = profile.state === "active"
      ? `Paid through ${formatDate(profile.accessUntil)}`
      : profile.state === "trial"
        ? `Free access ends ${formatDate(profile.trialEndsAt)}`
        : profile.state === "eligible"
          ? "Your three days begin when your first video starts."
          : "Your free trial has ended.";
    const devices = (account.devices || []).map((device) => `<li><span><strong>${escapeHtml(device.name)}</strong><small>${device.id === account.deviceId ? "This device" : `Last used ${formatDate(device.last_seen_at)}`}</small></span>${device.id === account.deviceId ? '<b>Current</b>' : `<button type="button" data-remove-device="${escapeHtml(device.id)}">Remove</button>`}</li>`).join("");
    content.innerHTML = `${panelHeader("ACCOUNT", escapeHtml(account.user.email), statusCopy)}
      <div class="account-status"><span>${escapeHtml(statusLabel(profile))}</span><small>${config.maxDevices} devices · ${config.maxStreams} streams at once</small></div>
      <div class="device-heading"><strong>Devices</strong><span>${account.devices.length}/${config.maxDevices}</span></div><ul class="device-list">${devices || "<li>No registered devices</li>"}</ul>
      ${profile.state === "active" && account.billing?.hasStripeCustomer ? '<button class="membership-secondary" type="button" id="billing-portal">Manage card subscription</button>' : profile.state === "active" ? '<p class="membership-small">Crypto membership active. Renew from this account before it expires.</p>' : paymentButtons()}
      ${supportLine()}
      <button class="membership-text-button" type="button" id="account-signout">Sign out</button><p class="membership-message" id="membership-message"></p>`;
    bindPaymentButtons();
    content.querySelector("#account-signout").addEventListener("click", signOut);
    content.querySelector("#billing-portal")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        const payload = await authorizedFetch("/api/stripe-portal", {method:"POST"});
        location.href = payload.url;
      } catch (error) {
        setMessage(error.message, true);
        event.currentTarget.disabled = false;
      }
    });
    content.querySelectorAll("[data-remove-device]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const payload = await authorizedFetch("/api/devices", {method:"DELETE", body:JSON.stringify({deviceId:button.dataset.removeDevice})});
        account.devices = payload.devices;
        renderAccount("Device removed.");
        setMessage("Device removed.");
      } catch (error) {
        setMessage(error.message, true);
        button.disabled = false;
      }
    }));
    if (message) setMessage(message);
  }

  async function renderDeviceLimit(message) {
    content.innerHTML = `${panelHeader("DEVICE LIMIT", "Choose a device to remove", message || `Your account already has ${config.maxDevices} active devices.`)}<p class="membership-message" id="membership-message">Loading devices…</p>`;
    try {
      const payload = await authorizedFetch("/api/devices");
      account = account || {user:session?.user || {email:"Account"}, profile:{state:"eligible"}, deviceId:"", devices:payload.devices};
      account.devices = payload.devices;
      renderAccount(message || "Remove one device, then try playback again.");
    } catch (error) {
      setMessage(error.message, true);
    }
  }

  async function refreshAccount() {
    if (!session) return null;
    const payload = await authorizedFetch("/api/me", {method:"POST", body:JSON.stringify(await devicePayload())});
    account = payload;
    updateHeader();
    return payload;
  }

  async function signOut() {
    stopPlayback();
    const old = session;
    saveSession(null);
    account = null;
    updateHeader();
    closeModal();
    if (old?.access_token) authRequest({action:"logout", accessToken:old.access_token}).catch(() => {});
  }

  async function authorizePlay(item) {
    if (!config.membershipEnabled) return {url:null, sessionId:null};
    if (!session) {
      pendingPlay = item;
      openModal("signup");
      return null;
    }
    try {
      const payload = await authorizedFetch("/api/play", {
        method:"POST",
        body:JSON.stringify({...await devicePayload(), item:{id:item.id, type:item.type}})
      });
      if (account) account.profile = payload.access;
      updateHeader();
      return payload;
    } catch (error) {
      if (error.status === 401 || error.code === "EMAIL_NOT_VERIFIED") {
        pendingPlay = item;
        openModal(error.code === "EMAIL_NOT_VERIFIED" ? "verify" : "login", error.message);
      } else if (error.status === 402) {
        openModal("paywall", error.message);
      } else if (error.code === "DEVICE_LIMIT") {
        openModal("device-limit", error.message);
      } else {
        openModal("account", error.message);
      }
      return null;
    }
  }

  function startHeartbeat(sessionId) {
    stopPlayback();
    if (!sessionId) return;
    playbackSessionId = sessionId;
    heartbeatTimer = setInterval(() => {
      authorizedFetch("/api/heartbeat", {method:"POST", body:JSON.stringify({sessionId})}).catch(() => stopPlayback(false));
    }, 45000);
  }

  function stopPlayback(notify = true) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    const sessionId = playbackSessionId;
    playbackSessionId = null;
    if (notify && sessionId && session) {
      authorizedFetch("/api/heartbeat", {method:"POST", body:JSON.stringify({sessionId, end:true}), keepalive:true}).catch(() => {});
    }
  }

  async function checkPaymentReturn() {
    const params = new URLSearchParams(location.search);
    if (params.get("payment") !== "success" || !session) return;
    openModal("account", "Payment received. Confirming your membership…");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      try {
        await refreshAccount();
        if (account?.profile?.state === "active") {
          renderAccount("Payment confirmed. Your membership is active.");
          history.replaceState({}, "", location.pathname);
          return;
        }
      } catch {}
    }
    renderAccount("Payment is still confirming. Reopen your account in a minute.");
  }

  function parseAuthRedirect() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (!hash.get("access_token")) return;
    const next = normalizeSession({
      access_token:hash.get("access_token"),
      refresh_token:hash.get("refresh_token"),
      expires_in:hash.get("expires_in"),
      token_type:hash.get("token_type")
    });
    saveSession(next);
    recoveryMode = hash.get("type") === "recovery" || new URLSearchParams(location.search).get("auth") === "recovery";
    history.replaceState({}, "", location.pathname);
  }

  async function init() {
    parseAuthRedirect();
    try {
      const response = await fetch("/api/config", {headers:{accept:"application/json"}});
      config = await response.json();
    } catch {}
    updateHeader();
    if (session && config.membershipEnabled) {
      try { await refreshAccount(); }
      catch (error) {
        if (error.code === "DEVICE_LIMIT") openModal("device-limit", error.message);
        else if (error.status === 401) saveSession(null);
      }
    }
    if (recoveryMode && session) openModal("recovery");
    else checkPaymentReturn();
  }

  accountButton.addEventListener("click", () => openModal("account"));
  statusButton.addEventListener("click", () => openModal(account?.profile?.state === "expired" ? "paywall" : "account"));
  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => { if (event.target === modal) closeModal(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !modal.hidden) closeModal(); });
  window.addEventListener("beforeunload", () => stopPlayback(true));

  window.SandboxedMembership = {authorizePlay, startHeartbeat, stopPlayback, openAccount:() => openModal("account")};
  init();
})();
