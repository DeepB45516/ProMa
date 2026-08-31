// app.js — ProMa frontend
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  teams: [],
  currentTeamId: null,
  currentTeam: null,
  currentTeamRole: null,
  members: [],
  pendingInvites: [],
  pendingTeamInvites: [],
  pendingSignup: null,
  tasks: [],
  dashboard: null,
  assignedTasks: [],
  view: "main",
  taskFilter: "all",
  dashboardMemberFilter: "all",
};

let emailOtpTimer = null;

// ---------- API ----------
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path.startsWith("/api") ? path : `/api${path}`, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
  } catch (netErr) {
    const err = new Error(navigator.onLine ? "Unable to connect to ProMa servers." : "You are currently offline.");
    err.isNetworkError = true;
    err.status = 0;
    throw err;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || "Something went wrong.");
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2600);
}

// Delays calling `fn` until `wait` ms after the last call — keeps fast
// typing (search boxes, etc.) from re-rendering on every keystroke.
function debounce(fn, wait = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initials(name) {
  return (name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
function fmtDate(iso) {
  if (!iso) return "No date";
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return String(iso).slice(0, 10);
  }
  const dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (typeof iso === "string" && (iso.includes("T") || iso.includes(":")) && iso.length > 10) {
    const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${dateStr} at ${timeStr}`;
  }
  return dateStr;
}

function toInputDateTime(val, defaultTime = "18:00") {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d.getTime())) {
    if (typeof val === "string" && val.length === 10) return `${val}T${defaultTime}`;
    return "";
  }
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const H = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${Y}-${M}-${D}T${H}:${min}`;
}

function deadlineMeta(task) {
  if (task.effectiveStatus === "complete") return "Completed";
  if (task.effectiveStatus === "overdue") {
    if (task.deadline && (String(task.deadline).includes("T") || String(task.deadline).includes(":"))) {
      const d = new Date(task.deadline);
      if (!isNaN(d.getTime())) {
        const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        if (d.toDateString() === new Date().toDateString()) {
          return `Overdue (was due today at ${timeStr})`;
        }
        return `Overdue (was due ${fmtDate(task.deadline)})`;
      }
    }
    const days = Math.abs(task.daysUntilDeadline || 1);
    return `${days} day${days === 1 ? "" : "s"} overdue`;
  }
  if (task.isDueToday || task.daysUntilDeadline === 0) {
    if (task.deadline && (String(task.deadline).includes("T") || String(task.deadline).includes(":"))) {
      const d = new Date(task.deadline);
      if (!isNaN(d.getTime())) {
        return `Due today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      }
    }
    return "Due today";
  }
  if (task.daysUntilDeadline === 1) {
    if (task.deadline && (String(task.deadline).includes("T") || String(task.deadline).includes(":"))) {
      const d = new Date(task.deadline);
      if (!isNaN(d.getTime())) {
        return `Due tomorrow at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      }
    }
    return "Due tomorrow";
  }
  return `Due ${fmtDate(task.deadline)}`;
}

/* ============================================================
   AUTH SCREENS
   ============================================================ */

function showLanding() {
  $("#landing-page").hidden = false;
  $("#auth-wrap").hidden = true;
  $("#app-shell").hidden = true;
}

function openAuth(panel = "login") {
  $("#auth-wrap").hidden = false;
  showAuthPanel(panel);
}

function closeAuth() {
  $("#auth-wrap").hidden = true;
}

function wireLandingAndOverlay() {
  const pillBtn = $("#landing-pill-btn");
  if (pillBtn) pillBtn.addEventListener("click", () => openAuth("signup"));
  $("#landing-login-btn").addEventListener("click", () => openAuth("login"));
  $("#landing-signup-btn").addEventListener("click", () => openAuth("signup"));
  $("#landing-cta-btn").addEventListener("click", () => openAuth("signup"));
  $("#landing-cta-login-btn").addEventListener("click", () => openAuth("login"));

  const bottomSignup = $("#landing-bottom-signup-btn");
  if (bottomSignup) bottomSignup.addEventListener("click", () => openAuth("signup"));
  const bottomLogin = $("#landing-bottom-login-btn");
  if (bottomLogin) bottomLogin.addEventListener("click", () => openAuth("login"));

  $("#auth-close-btn").addEventListener("click", closeAuth);
  $("#auth-wrap").addEventListener("click", (e) => {
    if (e.target.id === "auth-wrap") closeAuth();
  });
}

function showAuthPanel(name) {
  $$(".auth-panel").forEach((p) => (p.hidden = true));
  $(`#panel-${name}`).hidden = false;
  hideAuthBanner();
}
function showAuthBanner(msg, kind = "error") {
  const el = $("#auth-banner");
  el.textContent = msg;
  el.className = `auth-banner ${kind === "success" ? "success" : ""}`;
  el.hidden = false;
}
function hideAuthBanner() {
  $("#auth-banner").hidden = true;
}

function startEmailOtpCooldown(seconds) {
  const btn = $("#email-otp-resend-btn");
  const counter = $("#email-otp-cooldown");
  if (!btn || !counter) return;

  clearInterval(emailOtpTimer);
  btn.disabled = true;
  let remaining = seconds;
  counter.textContent = `(Resend in ${remaining}s)`;

  emailOtpTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(emailOtpTimer);
      btn.disabled = false;
      counter.textContent = "";
    } else {
      counter.textContent = `(Resend in ${remaining}s)`;
    }
  }, 1000);
}

function wireAuthNav() {
  $("#go-signup").addEventListener("click", () => showAuthPanel("signup"));
  $("#go-login-from-signup").addEventListener("click", () => showAuthPanel("login"));
  $("#go-forgot").addEventListener("click", () => showAuthPanel("forgot"));
  $("#go-login-from-forgot").addEventListener("click", () => showAuthPanel("login"));
  $("#go-login-from-reset").addEventListener("click", () => showAuthPanel("login"));
  $("#go-mobile-login").addEventListener("click", () => showAuthPanel("mobile"));
  $("#go-login-from-mobile").addEventListener("click", () => showAuthPanel("login"));
  $("#go-login-from-otp").addEventListener("click", () => showAuthPanel("login"));

  $("#google-login-btn").addEventListener("click", handleGoogleClick);
  $("#google-signup-btn").addEventListener("click", handleGoogleClick);
}

async function handleGoogleClick() {
  try {
    const { configured } = await api("/auth/google/status");
    if (!configured) {
      showAuthBanner("Google sign-in isn't set up on this server yet — add GOOGLE_CLIENT_ID/SECRET to enable it.");
      return;
    }
    window.location.href = "/api/auth/google";
  } catch (e) {
    showAuthBanner("Couldn't reach the server. Try again.");
  }
}

function wireAuthForms() {
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAuthBanner();
    const btn = $("#login-submit");
    btn.disabled = true;
    btn.textContent = "Logging in…";
    try {
      const { user } = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          identifier: $("#login-identifier").value,
          password: $("#login-password").value,
        }),
      });
      await onAuthed(user);
    } catch (err) {
      showAuthBanner(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });

  $("#signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAuthBanner();
    const btn = $("#signup-submit");
    const fullName = $("#signup-name").value.trim();
    const username = $("#signup-username").value.trim();
    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;

    if (!fullName || !username || !email || !password) {
      showAuthBanner("Please fill in all required fields.");
      return;
    }
    if (username.length < 3) {
      showAuthBanner("Username must be at least 3 characters long.");
      return;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      showAuthBanner("Username can only contain letters, numbers, dots, underscores, and dashes.");
      return;
    }
    if (password.length < 8) {
      showAuthBanner("Password must be at least 8 characters.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Checking details…";

    try {
      // Step 1: Email and Username checks
      const [emailCheck, userCheck] = await Promise.all([
        api("/auth/check-email", { method: "POST", body: JSON.stringify({ email }) }),
        api("/auth/check-username", { method: "POST", body: JSON.stringify({ username }) }),
      ]);

      if (emailCheck.exists) {
        showAuthBanner("An account with that email already exists. Please log in.");
        $("#login-identifier").value = email;
        showAuthPanel("login");
        return;
      }

      if (!userCheck.available) {
        showAuthBanner("This username is already taken. Please choose another username.");
        return;
      }

      // Step 2: Send OTP
      btn.textContent = "Sending verification code…";
      await api("/auth/otp/email/send", {
        method: "POST",
        body: JSON.stringify({ email }),
      });

      state.pendingSignup = { fullName, username, email, password };
      $("#email-otp-sent-to").textContent = `We sent a 6-digit verification code to ${email}.`;
      $("#email-otp-code").value = "";
      showAuthPanel("email-otp");
      startEmailOtpCooldown(60);
    } catch (err) {
      showAuthBanner(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Continue with Email Verification";
    }
  });

  const emailOtpForm = $("#email-otp-form");
  if (emailOtpForm) {
    emailOtpForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      hideAuthBanner();
      const btn = $("#email-otp-submit");
      btn.disabled = true;
      btn.textContent = "Verifying code…";
      try {
        const code = $("#email-otp-code").value.trim();
        const draft = state.pendingSignup || {
          fullName: $("#signup-name").value,
          username: $("#signup-username").value,
          email: $("#signup-email").value,
          password: $("#signup-password").value,
        };

        const { user } = await api("/auth/otp/email/verify", {
          method: "POST",
          body: JSON.stringify({
            email: draft.email,
            code,
            fullName: draft.fullName,
            username: draft.username,
            password: draft.password,
          }),
        });

        state.pendingSignup = null;
        await onAuthed(user);
      } catch (err) {
        showAuthBanner(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Verify Code & Complete Signup";
      }
    });
  }

  const resendBtn = $("#email-otp-resend-btn");
  if (resendBtn) {
    resendBtn.addEventListener("click", async () => {
      hideAuthBanner();
      const draft = state.pendingSignup || { email: $("#signup-email").value };
      if (!draft.email) return;
      try {
        await api("/auth/otp/email/send", {
          method: "POST",
          body: JSON.stringify({ email: draft.email }),
        });
        showAuthBanner("Verification code resent to your email!", "success");
        startEmailOtpCooldown(60);
      } catch (err) {
        showAuthBanner(err.message);
      }
    });
  }

  const goSignupFromOtp = $("#go-signup-from-email-otp");
  if (goSignupFromOtp) {
    goSignupFromOtp.addEventListener("click", () => showAuthPanel("signup"));
  }

  $("#forgot-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAuthBanner();
    const btn = $("#forgot-submit");
    btn.disabled = true;
    try {
      const result = await api("/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: $("#forgot-email").value }),
      });
      const extra = result.resetLink ? ` Demo link: ${result.resetLink}` : "";
      showAuthBanner(`If that email has an account, a reset link was created.${extra}`, "success");
    } catch (err) {
      showAuthBanner(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAuthBanner();
    const btn = $("#reset-submit");
    btn.disabled = true;
    try {
      await api("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token: $("#reset-token").value, newPassword: $("#reset-password").value }),
      });
      showAuthBanner("Password updated — you can log in now.", "success");
      setTimeout(() => {
        window.history.replaceState({}, "", "/");
        showAuthPanel("login");
      }, 1200);
    } catch (err) {
      showAuthBanner(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#mobile-request-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAuthBanner();
    const btn = $("#mobile-request-submit");
    btn.disabled = true;
    try {
      const mobile = $("#mobile-number").value;
      const result = await api("/auth/otp/send", { method: "POST", body: JSON.stringify({ mobile }) });
      $("#otp-mobile").value = mobile;
      $("#otp-sent-to").textContent = `We created a code for ${mobile}.` + (result.code ? ` Demo code: ${result.code}` : "");
      $("#otp-name-field").hidden = false;
      showAuthPanel("otp");
    } catch (err) {
      showAuthBanner(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#otp-verify-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAuthBanner();
    const btn = $("#otp-verify-submit");
    btn.disabled = true;
    btn.textContent = "Verifying…";
    try {
      const { user } = await api("/auth/otp/verify", {
        method: "POST",
        body: JSON.stringify({
          mobile: $("#otp-mobile").value,
          code: $("#otp-code").value,
          fullName: $("#otp-name").value,
        }),
      });
      await onAuthed(user);
    } catch (err) {
      showAuthBanner(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Verify & log in";
    }
  });
}

async function onAuthed(user) {
  state.user = user;
  if (user?.color_theme) applyColorTheme(user.color_theme);
  await bootApp();
}

/* ============================================================
   APP BOOTSTRAP
   ============================================================ */

function fastBootApp() {
  $("#landing-page").hidden = true;
  $("#auth-wrap").hidden = true;
  $("#app-shell").hidden = false;
  updateProfileUI();

  const savedTeamId = localStorage.getItem("basecamp:lastTeam");
  const match = state.teams.find((t) => t.id === savedTeamId);
  state.currentTeamId = match ? match.id : state.teams[0]?.id || null;

  renderTeamSwitcherButton();
  renderTeamSwitcherList();
  renderCurrentView();
  if (state.currentTeamId) {
    switchTeam(state.currentTeamId, { skipRender: state.view === "main" || state.view === "my-work" }).catch(() => {});
  }
  prefetchTeams(state.teams);
}

async function bootApp() {
  if (state.user) {
    try { localStorage.setItem("proma:user", JSON.stringify(state.user)); } catch (e) {}
  }
  $("#landing-page").hidden = true;
  $("#auth-wrap").hidden = true;
  $("#app-shell").hidden = false;
  updateProfileUI();

  // If teams were not in local cache, render immediately
  if (!state.teams || state.teams.length === 0) {
    renderCurrentView();
  }

  try {
    const [teams, assigned, invites] = await Promise.all([
      api("/users/me/teams"),
      api("/users/me/assigned-tasks").catch(() => state.assignedTasks || []),
      api("/users/me/invites").catch(() => []),
    ]);
    state.teams = teams;
    state.assignedTasks = assigned;
    state.pendingTeamInvites = invites || [];

    pruneTeamBundleCache(teams.map((t) => t.id));
    syncAssignedTasks();
    persistTeamsCache();
    persistAssignedTasksCache();

    const savedTeamId = localStorage.getItem("basecamp:lastTeam");
    const match = state.teams.find((t) => t.id === savedTeamId);
    state.currentTeamId = match ? match.id : state.teams[0]?.id || null;

    renderTeamSwitcherButton();
    renderTeamSwitcherList();
    renderCurrentView();
    loadNotifications();
    if (state.currentTeamId) {
      switchTeam(state.currentTeamId, { skipRender: state.view === "main" || state.view === "my-work" }).catch(() => {});
    }
    prefetchTeams(state.teams);
  } catch (err) {
    console.warn("Background boot revalidation error:", err);
  }
}

function updateProfileUI() {
  const u = state.user;
  if (!u) return;
  $("#pm-name").textContent = u.full_name;
  $("#pm-email").textContent = u.email;
  const avatarEls = [$("#profile-avatar")];
  avatarEls.forEach((el) => {
    if (u.avatar_url) {
      el.innerHTML = `<img src="${escapeHtml(u.avatar_url)}" alt="${escapeHtml(u.full_name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      el.textContent = initials(u.full_name);
    }
  });
}

function computeClientEffectiveStatus(status, deadlineVal) {
  if (status === "complete") return "complete";
  if (!deadlineVal) return status || "todo";
  if (typeof deadlineVal === "string" && deadlineVal.length === 10 && !deadlineVal.includes("T")) {
    const today = new Date().toISOString().slice(0, 10);
    if (deadlineVal < today) return "overdue";
    return status || "todo";
  }
  const d = new Date(deadlineVal);
  if (!isNaN(d.getTime()) && d.getTime() < Date.now()) {
    return "overdue";
  }
  return status || "todo";
}

function isTaskDueToday(task) {
  if (!task || !task.deadline || task.effectiveStatus === "complete") return false;
  const d = new Date(task.deadline);
  if (isNaN(d.getTime())) return false;
  return d.toDateString() === new Date().toDateString();
}

function canEditTask(task) {
  if (!state.user || !task) return false;
  // Team owner or admin can manage any task
  if (state.currentTeamRole === "owner" || state.currentTeamRole === "admin") return true;
  // The member whom the activity is assigned has permission
  if (task.assigneeId && task.assigneeId === state.user.id) return true;
  // The user who created the activity has permission
  if (task.createdBy && task.createdBy === state.user.id) return true;
  // If activity is unassigned, any team member can assign / pick it up
  if (!task.assigneeId) return true;
  return false;
}

function recomputeLocalDashboard() {
  if (!state.tasks || !state.members) return;

  state.tasks.forEach((t) => {
    t.effectiveStatus = computeClientEffectiveStatus(t.status, t.deadline);
    t.isOverdue = t.effectiveStatus === "overdue";
    t.isDueToday = isTaskDueToday(t);
  });

  const tasks = state.tasks;
  const members = state.members;
  const total = tasks.length;
  const countBy = (s) => tasks.filter((t) => t.effectiveStatus === s).length;
  const todo = countBy("todo");
  const inProgress = countBy("in_progress");
  const complete = countBy("complete");
  const overdue = countBy("overdue");
  const completionPct = total === 0 ? 0 : Math.round((complete / total) * 100);

  const upcoming = tasks
    .filter((t) => t.effectiveStatus !== "complete" && t.effectiveStatus !== "overdue")
    .sort((a, b) => String(a.deadline || "").localeCompare(String(b.deadline || "")))
    .slice(0, 5);

  const overdueTasks = tasks
    .filter((t) => t.effectiveStatus === "overdue")
    .sort((a, b) => String(a.deadline || "").localeCompare(String(b.deadline || "")));

  const memberProgress = members.map((m) => {
    const mine = tasks.filter((t) => t.assigneeId === m.id);
    const mineComplete = mine.filter((t) => t.effectiveStatus === "complete").length;
    return {
      id: m.id,
      name: m.full_name,
      role: m.role,
      total: mine.length,
      complete: mineComplete,
      overdue: mine.filter((t) => t.effectiveStatus === "overdue").length,
      inProgress: mine.filter((t) => t.effectiveStatus === "in_progress").length,
      todo: mine.filter((t) => t.effectiveStatus === "todo").length,
      completionPct: mine.length === 0 ? 0 : Math.round((mineComplete / mine.length) * 100),
    };
  });

  const recentActivity = [...tasks]
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 6)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      updated_at: t.updatedAt,
      assignee_name: t.assigneeName,
    }));

  state.dashboard = {
    total,
    todo,
    inProgress,
    complete,
    overdue,
    completionPct,
    memberCount: members.length,
    upcoming,
    overdueTasks,
    memberProgress,
    recentActivity,
    generatedAt: new Date().toISOString(),
  };
}

// In-memory + session persistent cache for instant 0ms transitions
state.teamCache = state.teamCache || {};

function getTeamBundleFromCache(teamId) {
  if (state.teamCache[teamId]) return state.teamCache[teamId];
  try {
    const raw = sessionStorage.getItem(`proma:bundle:${teamId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.teamCache[teamId] = parsed;
      return parsed;
    }
  } catch (e) {}
  return null;
}

function saveTeamBundleToCache(teamId, bundle) {
  state.teamCache[teamId] = bundle;
  try {
    sessionStorage.setItem(`proma:bundle:${teamId}`, JSON.stringify(bundle));
  } catch (e) {}
}

function removeTeamBundleFromCache(teamId) {
  if (!teamId) return;
  delete state.teamCache[teamId];
  try {
    sessionStorage.removeItem(`proma:bundle:${teamId}`);
  } catch (e) {}
}

function clearTeamBundleCache() {
  state.teamCache = {};
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith("proma:bundle:")) sessionStorage.removeItem(key);
    }
  } catch (e) {}
}

function pruneTeamBundleCache(validTeamIds = []) {
  const valid = new Set(validTeamIds);
  Object.keys(state.teamCache || {}).forEach((teamId) => {
    if (!valid.has(teamId)) removeTeamBundleFromCache(teamId);
  });
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith("proma:bundle:")) continue;
      const teamId = key.slice("proma:bundle:".length);
      if (!valid.has(teamId)) sessionStorage.removeItem(key);
    }
  } catch (e) {}
}

function persistTeamsCache() {
  try {
    localStorage.setItem("proma:teams", JSON.stringify(state.teams || []));
  } catch (e) {}
}

function persistAssignedTasksCache() {
  try {
    localStorage.setItem("proma:assignedTasks", JSON.stringify(state.assignedTasks || []));
  } catch (e) {}
}

function persistActiveTeamBundle() {
  if (!state.currentTeamId || !state.currentTeam) return;
  saveTeamBundleToCache(state.currentTeamId, {
    team: state.currentTeam,
    members: state.members || [],
    pendingInvites: state.pendingInvites || [],
    tasks: state.tasks || [],
    dashboard: state.dashboard || null,
  });
}

function syncAndPersistWorkspaceState() {
  syncAssignedTasks();
  if (state.tasks && state.members) recomputeLocalDashboard();
  persistActiveTeamBundle();
  persistTeamsCache();
  persistAssignedTasksCache();
}

function forgetTeamData(teamId) {
  removeTeamBundleFromCache(teamId);
  state.assignedTasks = (state.assignedTasks || []).filter((task) => task.teamId !== teamId);
  if (state.currentTeamId !== teamId) return;
  state.currentTeam = null;
  state.currentTeamRole = null;
  state.members = [];
  state.pendingInvites = [];
  state.tasks = [];
  state.dashboard = null;
}

const inFlightPrefetches = new Set();
async function prefetchTeam(teamId) {
  if (!teamId || getTeamBundleFromCache(teamId) || inFlightPrefetches.has(teamId)) return;
  inFlightPrefetches.add(teamId);
  try {
    const bundle = await api(`/teams/${teamId}/bundle`);
    saveTeamBundleToCache(teamId, bundle);
  } catch (e) {
  } finally {
    inFlightPrefetches.delete(teamId);
  }
}

function prefetchTeams(teamsList) {
  if (!teamsList || !teamsList.length) return;
  teamsList.slice(0, 4).forEach((t, idx) => {
    setTimeout(() => prefetchTeam(t.id), idx * 80);
  });
}

const activeTeamFetches = new Map();

async function switchTeam(teamId, { skipRender, forceFresh } = {}) {
  if (!teamId) return;
  const previousTeamId = state.currentTeamId;
  const isTeamChange = previousTeamId !== teamId;
  if (isTeamChange) {
    state.dashboardMemberFilter = "all";
  }
  state.currentTeamId = teamId;
  localStorage.setItem("basecamp:lastTeam", teamId);

  // 1. Instant Cache Hit (0ms UI render)
  const cached = getTeamBundleFromCache(teamId);
  if (cached && !forceFresh) {
    state.currentTeam = cached.team;
    state.currentTeamRole = cached.team.role;
    state.members = cached.members;
    state.pendingInvites = cached.pendingInvites;
    state.tasks = cached.tasks;
    state.dashboard = cached.dashboard;

    const idx = state.teams.findIndex((t) => t.id === teamId);
    if (idx >= 0) state.teams[idx] = { ...state.teams[idx], ...cached.team };

    renderTeamSwitcherButton();
    renderTeamSwitcherList();
    if (!skipRender) renderCurrentView();
  } else {
    // 2. Initial load -> clear previous workspace data, then show known team info.
    if (isTeamChange || !state.currentTeam || state.currentTeam.id !== teamId) {
      state.dashboard = null;
      state.tasks = [];
      state.members = [];
      state.pendingInvites = [];
    }

    const knownTeam = state.teams.find((t) => t.id === teamId);
    if (knownTeam) {
      state.currentTeam = knownTeam;
      state.currentTeamRole = knownTeam.role || "member";
    } else if (isTeamChange) {
      state.currentTeam = null;
      state.currentTeamRole = null;
    }
    renderTeamSwitcherButton();
    renderTeamSwitcherList();
    if (!skipRender) renderCurrentView();
  }

  // 3. Deduplicate in-flight fetch
  if (activeTeamFetches.has(teamId) && !forceFresh) {
    return activeTeamFetches.get(teamId);
  }

  const fetchPromise = (async () => {
    try {
      const bundle = await api(`/teams/${teamId}/bundle`);
      saveTeamBundleToCache(teamId, bundle);

      // Only update active UI if user is still on this team
      if (state.currentTeamId === teamId) {
        state.currentTeam = bundle.team;
        state.currentTeamRole = bundle.team.role;
        state.members = bundle.members;
        state.pendingInvites = bundle.pendingInvites;
        state.tasks = bundle.tasks;
        state.dashboard = bundle.dashboard;

        const idx = state.teams.findIndex((t) => t.id === teamId);
        if (idx >= 0) state.teams[idx] = { ...state.teams[idx], ...bundle.team };

        syncAssignedTasks();
        persistTeamsCache();
        persistAssignedTasksCache();
        renderTeamSwitcherButton();
        renderTeamSwitcherList();
        if (!skipRender) renderCurrentView();
      }
      return bundle;
    } catch (err) {
      console.warn("switchTeam bundle fetch error:", err);
      // Purge cached bundle for this team on error to prevent stale/invalid state
      removeTeamBundleFromCache(teamId);
      if (err.status === 403 || err.status === 404) {
        forgetTeamData(teamId);
        state.teams = state.teams.filter((t) => t.id !== teamId);
        persistTeamsCache();
        persistAssignedTasksCache();
        renderTeamSwitcherButton();
        renderTeamSwitcherList();
      }

      // If cached data is already active, keep showing it and notify gracefully
      if (state.dashboard && state.currentTeamId === teamId) {
        toast("Working with offline/cached workspace data.");
        return;
      }

      const root = $("#view-root");
      if (!root) return;
      root.innerHTML = "";

      if (err.status === 403) {
        root.appendChild(render403View());
      } else if (err.status === 404) {
        root.appendChild(render404View());
      } else if (!navigator.onLine || err.isNetworkError) {
        root.appendChild(renderOfflineView());
      } else {
        // Friendly, non-catastrophic retry state
        root.appendChild(
          renderErrorView({
            badge: "Notice",
            type: "warning",
            title: "Workspace Connecting...",
            message: err.message || "Taking longer than usual to retrieve latest updates. Click below to retry.",
            primaryText: "↻ Retry Connection",
            primaryAction: () => switchTeam(teamId, { forceFresh: true }),
            secondaryText: "Back to Main Page",
            secondaryAction: () => setView("main"),
          })
        );
      }
    } finally {
      activeTeamFetches.delete(teamId);
    }
  })();

  activeTeamFetches.set(teamId, fetchPromise);
  return fetchPromise;
}

async function openTeamPage(teamId) {
  state.view = "dashboard";
  setActiveNav();
  await switchTeam(teamId);
}

async function refreshTeamData() {
  if (state.view === "main") {
    const [teams, assigned] = await Promise.all([
      api("/users/me/teams").catch(() => state.teams),
      api("/users/me/assigned-tasks").catch(() => state.assignedTasks),
    ]);
    state.teams = teams;
    state.assignedTasks = assigned;
    const teamIds = state.teams.map((t) => t.id);
    if (state.currentTeamId && !teamIds.includes(state.currentTeamId)) {
      forgetTeamData(state.currentTeamId);
      localStorage.removeItem("basecamp:lastTeam");
      state.currentTeamId = state.teams[0]?.id || null;
    }
    pruneTeamBundleCache(teamIds);
    syncAssignedTasks();
    persistTeamsCache();
    persistAssignedTasksCache();
    renderTeamSwitcherButton();
    renderTeamSwitcherList();
    renderCurrentView();
    return;
  }
  if (!state.currentTeamId) return;
  await switchTeam(state.currentTeamId, { forceFresh: true });
}

/* ============================================================
   TEAM SWITCHER
   ============================================================ */

function renderTeamSwitcherButton() {
  const team = state.teams.find((t) => t.id === state.currentTeamId);
  const tsIcon = $("#ts-icon");
  if (tsIcon) {
    tsIcon.innerHTML = team?.icon ? escapeHtml(team.icon) : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>';
  }
  $("#ts-name").textContent = team?.name || "Select a team";
}

function renderTeamSwitcherList() {
  const list = $("#ts-list");
  if (state.teams.length === 0) {
    list.innerHTML = `<p class="empty-note" style="padding:8px 10px;">No teams yet.</p>`;
    return;
  }
  list.innerHTML = state.teams
    .map(
      (t) => `
      <button class="ts-option ${t.id === state.currentTeamId && state.view !== "main" ? "is-current" : ""}" data-team-id="${t.id}">
        <span>${t.icon ? escapeHtml(t.icon) : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>'}</span>
        <span>${escapeHtml(t.name)}</span>
        <span class="ts-role">${t.role}</span>
      </button>`
    )
    .join("");
  $$(".ts-option", list).forEach((btn) => {
    btn.addEventListener("mouseenter", () => prefetchTeam(btn.dataset.teamId), { once: true });
    btn.addEventListener("click", async () => {
      $("#team-switcher-menu").hidden = true;
      await openTeamPage(btn.dataset.teamId);
    });
  });
}

function wireTeamSwitcher() {
  $("#team-switcher-btn").addEventListener("click", () => {
    $("#team-switcher-menu").hidden = !$("#team-switcher-menu").hidden;
  });
  $("#ts-new-team-btn").addEventListener("click", () => {
    $("#team-switcher-menu").hidden = true;
    openTeamModal();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".team-switcher-wrap")) $("#team-switcher-menu").hidden = true;
    if (!e.target.closest(".profile-menu-wrap")) $("#profile-menu").hidden = true;
  });
}

/* ============================================================
   NAV / VIEW DISPATCH
   ============================================================ */

function setActiveNav() {
  $$(".nav-item").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === state.view));

  const mainCreateBtn = $("#main-create-team-btn");
  const quickAddBtn = $("#quick-add-btn");
  const teamReportBtn = $("#team-report-btn");
  const teamLabel = $("#current-team-label");
  const viewTitle = $("#view-title");
  const footerText = $("#sidebar-footer-text");

  if (state.view === "main") {
    if (viewTitle) viewTitle.textContent = "Main Page";
    if (teamLabel) teamLabel.textContent = "ProMa Hub";
    if (mainCreateBtn) mainCreateBtn.hidden = false;
    if (quickAddBtn) quickAddBtn.hidden = true;
    if (teamReportBtn) teamReportBtn.hidden = true;
    if (footerText) footerText.textContent = "Welcome to your ProMa workspace.";
  } else if (state.view === "my-work") {
    if (viewTitle) viewTitle.textContent = "My Work";
    if (teamLabel) teamLabel.textContent = "Assigned to You";
    if (mainCreateBtn) mainCreateBtn.hidden = true;
    if (quickAddBtn) quickAddBtn.hidden = true;
    if (teamReportBtn) teamReportBtn.hidden = true;
    if (footerText) footerText.textContent = "All activities assigned to you across all your team projects.";
  } else {
    const titles = { dashboard: "Dashboard", tasks: "Activities", members: "Members", settings: "Team Settings" };
    if (viewTitle) viewTitle.textContent = titles[state.view] || "Dashboard";
    const team = state.teams.find((t) => t.id === state.currentTeamId) || state.currentTeam;
    const teamName = team ? escapeHtml(team.name) : "Team Workspace";
    if (teamLabel) {
      teamLabel.innerHTML = `
        <div class="breadcrumb-wrap">
          <span class="breadcrumb-link" id="breadcrumb-main-link">Main Page</span>
          <span class="breadcrumb-sep">/</span>
          <span>${teamName}</span>
        </div>`;
      const bcLink = $("#breadcrumb-main-link", teamLabel);
      if (bcLink) {
        bcLink.addEventListener("click", (e) => {
          e.preventDefault();
          setView("main");
        });
      }
    }
    const isManager = state.currentTeamRole === "owner" || state.currentTeamRole === "admin";
    if (mainCreateBtn) mainCreateBtn.hidden = true;
    if (quickAddBtn) quickAddBtn.hidden = !isManager;
    if (teamReportBtn) teamReportBtn.hidden = false;
    if (footerText) footerText.textContent = "Everyone on this team sees the same board.";
  }
}

async function setView(view) {
  state.view = view;
  setActiveNav();

  // If navigating to a team workspace view (dashboard, tasks, members, settings)
  if (["dashboard", "tasks", "members", "settings"].includes(view)) {
    if (!state.currentTeamId && state.teams && state.teams.length > 0) {
      const savedTeamId = localStorage.getItem("basecamp:lastTeam");
      const match = state.teams.find((t) => t.id === savedTeamId);
      state.currentTeamId = match ? match.id : state.teams[0].id;
    }

    if (state.currentTeamId) {
      // If team bundle is not loaded or for a different team, auto-load immediately!
      if (!state.dashboard || !state.currentTeam || state.currentTeam.id !== state.currentTeamId) {
        renderCurrentView(); // Render skeleton/placeholder immediately
        await switchTeam(state.currentTeamId);
        return;
      }
    }
  }

  renderCurrentView();
}

/* ============================================================
   ERROR VIEWS & RECOVERY STATES
   ============================================================ */

function renderErrorView({
  badge = "!",
  type = "danger",
  title = "Something went wrong",
  message = "An unexpected error occurred. Please try again.",
  primaryText = "↻ Try Again",
  primaryAction = () => renderCurrentView(),
  secondaryText = "Go to Main Page",
  secondaryAction = () => setView("main"),
} = {}) {
  const wrap = document.createElement("div");
  wrap.className = "error-page-wrap";
  wrap.innerHTML = `
    <div class="error-box error-${type}">
      <div class="error-badge">${badge}</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="error-box-actions">
        ${primaryText ? `<button class="btn btn-primary" id="error-primary-btn">${escapeHtml(primaryText)}</button>` : ""}
        ${secondaryText ? `<button class="btn btn-ghost" id="error-secondary-btn">${escapeHtml(secondaryText)}</button>` : ""}
      </div>
    </div>
  `;
  if (primaryText && primaryAction) {
    $("#error-primary-btn", wrap).addEventListener("click", primaryAction);
  }
  if (secondaryText && secondaryAction) {
    $("#error-secondary-btn", wrap).addEventListener("click", secondaryAction);
  }
  return wrap;
}

function render404View() {
  return renderErrorView({
    badge: "404",
    type: "warning",
    title: "Workspace or Page Not Found",
    message: "The requested project board or workspace does not exist or has been removed.",
    primaryText: "Back to Main Page",
    primaryAction: () => setView("main"),
    secondaryText: "+ Create New Team",
    secondaryAction: () => openTeamModal(),
  });
}

function render403View() {
  return renderErrorView({
    badge: "403",
    type: "warning",
    title: "Access Restricted",
    message: "You don't have permission to access this team workspace. Please ask the team owner for an invite.",
    primaryText: "Go to My Workspaces",
    primaryAction: () => setView("main"),
    secondaryText: "↻ Retry",
    secondaryAction: () => refreshTeamData(),
  });
}

function render500View(err = null) {
  return renderErrorView({
    badge: "500",
    type: "danger",
    title: "Internal Server Error",
    message: err?.message || "Our servers encountered an unexpected issue while loading this page. Please try again.",
    primaryText: "↻ Reload View",
    primaryAction: () => refreshTeamData(),
    secondaryText: "Go to Main Page",
    secondaryAction: () => setView("main"),
  });
}

function renderOfflineView() {
  return renderErrorView({
    badge: "Offline",
    type: "danger",
    title: "No Internet Connection",
    message: "You seem to be offline. ProMa needs an active internet connection to load and sync project activities.",
    primaryText: "↻ Check Connection & Retry",
    primaryAction: () => refreshTeamData(),
    secondaryText: "Back to Main Page",
    secondaryAction: () => setView("main"),
  });
}

function renderTasksSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "dashboard-skeleton-wrap";
  wrap.innerHTML = `
    <div class="skeleton-controls" style="margin-bottom:16px;">
      <div class="skeleton-shimmer" style="width:200px; height:34px; border-radius:8px;"></div>
      <div class="skeleton-shimmer" style="width:160px; height:34px; border-radius:8px;"></div>
    </div>
    <div class="panel" style="padding:16px;">
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:90%; height:16px;"></div></div>
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:75%; height:16px;"></div></div>
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:85%; height:16px;"></div></div>
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:65%; height:16px;"></div></div>
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:80%; height:16px;"></div></div>
    </div>
  `;
  return wrap;
}

function renderMembersSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "dashboard-skeleton-wrap";
  wrap.innerHTML = `
    <div class="team-grid">
      <div class="skeleton-shimmer skeleton-stat-card" style="height:180px; border-radius:12px;"></div>
      <div class="skeleton-shimmer skeleton-stat-card" style="height:180px; border-radius:12px;"></div>
      <div class="skeleton-shimmer skeleton-stat-card" style="height:180px; border-radius:12px;"></div>
    </div>
  `;
  return wrap;
}

function renderSettingsSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "dashboard-skeleton-wrap";
  wrap.innerHTML = `
    <div class="panel settings-section" style="padding:20px; margin-bottom:20px;">
      <div class="skeleton-shimmer skeleton-line" style="width:30%; height:20px; margin-bottom:16px;"></div>
      <div class="skeleton-shimmer skeleton-line" style="width:70%; height:36px; margin-bottom:12px;"></div>
      <div class="skeleton-shimmer skeleton-line" style="width:85%; height:60px; margin-bottom:12px;"></div>
    </div>
    <div class="panel settings-section" style="padding:20px;">
      <div class="skeleton-shimmer skeleton-line" style="width:25%; height:20px; margin-bottom:16px;"></div>
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:60%; height:16px;"></div></div>
      <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:50%; height:16px;"></div></div>
    </div>
  `;
  return wrap;
}

function syncAssignedTasks() {
  if (!state.user) return;
  const today = new Date().toISOString().slice(0, 10);

  if (Array.isArray(state.tasks)) {
    state.tasks.forEach((t) => {
      t.effectiveStatus = computeClientEffectiveStatus(t.status, t.deadline);
      t.isOverdue = t.effectiveStatus === "overdue";
      t.isDueToday = isTaskDueToday(t);
    });
  }

  if (Array.isArray(state.assignedTasks)) {
    const knownTeamIds = new Set((state.teams || []).map((team) => team.id));
    const teamMetaFor = (teamId) =>
      (state.teams || []).find((team) => team.id === teamId) ||
      (state.currentTeam?.id === teamId ? state.currentTeam : null);
    const withTeamMeta = (task) => {
      const team = teamMetaFor(task.teamId);
      return {
        ...task,
        teamName: task.teamName || team?.name,
        teamIcon: task.teamIcon || team?.icon,
      };
    };

    if (knownTeamIds.size > 0) {
      state.assignedTasks = state.assignedTasks.filter((task) => !task.teamId || knownTeamIds.has(task.teamId));
    }

    state.assignedTasks = state.assignedTasks.map((at) => {
      const live = (state.tasks || []).find((t) => t.id === at.id);
      return withTeamMeta(live ? { ...at, ...live } : at);
    });

    (state.tasks || []).forEach((t) => {
      if (t.assigneeId === state.user.id && !state.assignedTasks.some((at) => at.id === t.id)) {
        state.assignedTasks.unshift(withTeamMeta(t));
      }
    });

    if (state.currentTeamId) {
      state.assignedTasks = state.assignedTasks.filter((at) => {
        if (at.teamId === state.currentTeamId) {
          return (state.tasks || []).some((t) => t.id === at.id && t.assigneeId === state.user.id);
        }
        return true;
      });
    }

    state.assignedTasks = state.assignedTasks.map((at) => {
      at.effectiveStatus = computeClientEffectiveStatus(at.status, at.deadline);
      at.isOverdue = at.effectiveStatus === "overdue";
      at.isDueToday = isTaskDueToday(at);
      return withTeamMeta(at);
    });
  }
}

function renderCurrentView() {
  syncAssignedTasks();
  if (state.tasks && state.members) {
    recomputeLocalDashboard();
  }

  const root = $("#view-root");
  root.innerHTML = "";

  try {
    if (state.view === "main") {
      root.appendChild(renderMainPage());
      return;
    }
    if (state.view === "my-work") {
      root.appendChild(renderMyWork());
      return;
    }

    if (!state.currentTeamId) {
      if (state.teams && state.teams.length > 0) {
        state.currentTeamId = state.teams[0].id;
      } else {
        root.appendChild(
          renderErrorView({
            badge: "ProMa",
            type: "info",
            title: "No Team Selected",
            message: "Choose a team workspace from the Main Page or create a new team to begin managing activities.",
            primaryText: "Go to Main Page",
            primaryAction: () => setView("main"),
            secondaryText: "+ Create Team",
            secondaryAction: () => openTeamModal(),
          })
        );
        return;
      }
    }

    if (state.view === "dashboard") {
      if (!state.dashboard) {
        root.appendChild(renderDashboardSkeleton());
      } else {
        root.appendChild(renderDashboard());
      }
    } else if (state.view === "tasks") {
      if (!state.dashboard && state.tasks.length === 0) {
        root.appendChild(renderTasksSkeleton());
      } else {
        root.appendChild(renderTasks());
      }
    } else if (state.view === "members") {
      if (!state.dashboard && state.members.length === 0) {
        root.appendChild(renderMembersSkeleton());
      } else {
        root.appendChild(renderMembers());
      }
    } else if (state.view === "settings") {
      if (!state.dashboard && (!state.members || state.members.length === 0)) {
        root.appendChild(renderSettingsSkeleton());
      } else {
        root.appendChild(renderSettings());
      }
    } else {
      root.appendChild(render404View());
    }
  } catch (err) {
    console.error("Render View Error:", err);
    root.innerHTML = "";
    if (state.currentTeamId && !state.dashboard) {
      root.appendChild(renderDashboardSkeleton());
    } else {
      root.appendChild(render500View(err));
    }
  }
}

/* ============================================================
   MAIN PAGE (WORKSPACE HUB) VIEW
   ============================================================ */

async function handleAcceptInvite(inviteId) {
  try {
    const res = await api(`/teams/invites/${inviteId}/accept`, { method: "POST" });
    toast("Team invitation accepted!");
    await bootApp();
    if (res.teamId) {
      await openTeamPage(res.teamId);
    }
  } catch (err) {
    toast(err.message || "Failed to accept invitation");
  }
}

async function handleDeclineInvite(inviteId) {
  try {
    await api(`/teams/invites/${inviteId}/decline`, { method: "POST" });
    toast("Invitation declined.");
    await bootApp();
    renderCurrentView();
  } catch (err) {
    toast(err.message || "Failed to decline invitation");
  }
}

function renderMainPage() {
  const root = document.createElement("div");
  const u = state.user || {};
  const totalTeams = state.teams.length;
  const totalAssigned = state.assignedTasks.length;
  const inProgressCount = state.assignedTasks.filter((t) => t.effectiveStatus === "in_progress").length;
  const overdueCount = state.assignedTasks.filter((t) => t.effectiveStatus === "overdue").length;
  const completedCount = state.assignedTasks.filter((t) => t.effectiveStatus === "complete").length;
  const pendingInvites = state.pendingTeamInvites || [];

  root.innerHTML = `
    <!-- Welcome Card -->
    <div class="main-welcome-card">
      <div class="main-welcome-text">
        <h2>Welcome back, ${escapeHtml(u.full_name || "Team Member")}</h2>
        <p>${u.designation ? escapeHtml(u.designation) + " · " : ""}${u.bio ? escapeHtml(u.bio) : "Select a team workspace to view activities and progress, or create a new team."}</p>
      </div>
      <div class="main-welcome-actions">
        <button class="btn btn-white" id="main-hub-create-team">+ Create team</button>
        <button class="btn btn-ghost" id="main-hub-profile" style="color:#fff;border-color:rgba(255,255,255,0.4);">Edit profile</button>
      </div>
    </div>

    ${
      pendingInvites.length > 0
        ? `<div class="panel" style="margin-bottom:24px;border-left:4px solid var(--accent,#4f46e5);background:var(--bg-subtle,#f8fafc);">
             <div class="panel-head" style="margin-bottom:12px;">
               <h2 style="font-size:15px;color:var(--accent,#4f46e5);">Pending Team Invitations (${pendingInvites.length})</h2>
             </div>
             <div style="display:flex;flex-direction:column;gap:10px;">
               ${pendingInvites
                 .map(
                   (inv) => `
                 <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--panel-bg,#fff);border:1px solid var(--border);border-radius:8px;gap:12px;">
                   <div>
                     <strong style="font-size:14.5px;display:block;">${escapeHtml(inv.team_name)}</strong>
                     <span class="muted" style="font-size:12.5px;">Invited by ${escapeHtml(inv.inviter_name || "Admin")} · Role: <span style="text-transform:capitalize;">${escapeHtml(inv.role)}</span></span>
                   </div>
                   <div style="display:flex;gap:8px;flex-shrink:0;">
                     <button class="btn btn-sm btn-primary btn-accept-invite" data-invite-id="${inv.id}">Accept</button>
                     <button class="btn btn-sm btn-ghost btn-danger btn-decline-invite" data-invite-id="${inv.id}">Decline</button>
                   </div>
                 </div>`
                 )
                 .join("")}
             </div>
           </div>`
        : ""
    }

    <!-- Cross-team stats summary -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="num">${totalTeams}</div>
        <div class="label">Teams & Workspaces</div>
      </div>
      <div class="stat-card accent-todo">
        <div class="num">${totalAssigned}</div>
        <div class="label">Assigned to me</div>
      </div>
      <div class="stat-card accent-progress">
        <div class="num">${inProgressCount}</div>
        <div class="label">In Progress</div>
      </div>
      <div class="stat-card accent-overdue">
        <div class="num">${overdueCount}</div>
        <div class="label">Due / Overdue</div>
      </div>
      <div class="stat-card accent-complete">
        <div class="num">${completedCount}</div>
        <div class="label">Completed</div>
      </div>
    </div>

    <!-- Teams List / Grid Section -->
    <div class="section-head">
      <div>
        <h2>Your Team Workspaces</h2>
        <p class="muted" style="margin:2px 0 0;font-size:13px;">Click on any team to enter its project board, activities, and members.</p>
      </div>
      <button class="btn btn-primary btn-sm" id="hub-new-team-btn">+ New team</button>
    </div>

    <div class="teams-hub-grid" id="teams-hub-grid"></div>

    <!-- Assigned Tasks Across Teams Section -->
    <div class="section-head">
      <div>
        <h2>My Assigned Activities Across Teams</h2>
        <p class="muted" style="margin:2px 0 0;font-size:13px;">All tasks assigned to you across all your team projects.</p>
      </div>
    </div>
    <div id="assigned-tasks-container"></div>
  `;

  // Wire buttons inside main page
  const hubCreateBtn = $("#main-hub-create-team", root);
  if (hubCreateBtn) hubCreateBtn.addEventListener("click", () => openTeamModal());
  const hubProfileBtn = $("#main-hub-profile", root);
  if (hubProfileBtn) hubProfileBtn.addEventListener("click", () => openProfileModal());
  const hubNewTeamBtn = $("#hub-new-team-btn", root);
  if (hubNewTeamBtn) hubNewTeamBtn.addEventListener("click", () => openTeamModal());

  $$(".btn-accept-invite", root).forEach((btn) => {
    btn.addEventListener("click", () => handleAcceptInvite(btn.dataset.inviteId));
  });
  $$(".btn-decline-invite", root).forEach((btn) => {
    btn.addEventListener("click", () => handleDeclineInvite(btn.dataset.inviteId));
  });

  // Render Teams Grid
  const grid = $("#teams-hub-grid", root);
  if (state.teams.length === 0) {
    grid.innerHTML = `
      <div class="panel" style="grid-column: 1 / -1; text-align:center; padding:50px 20px;">
        <div style="margin-bottom:14px;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg></div>
        <h3 style="font-size:18px; margin-bottom:6px;">You don't belong to any teams yet</h3>
        <p class="muted" style="margin-bottom:20px; font-size:14px;">Create your first team workspace to start tracking tasks and collaborating.</p>
        <button class="btn btn-primary" id="hub-empty-create-btn">+ Create your first team</button>
      </div>`;
    $("#hub-empty-create-btn", grid).addEventListener("click", () => openTeamModal());
  } else {
    state.teams.forEach((t) => {
      const card = document.createElement("div");
      card.className = "team-hub-card";
      const total = t.task_count || 0;
      const pct = t.completion_pct || 0;
      const todo = t.todo_count || 0;
      const inProgress = t.in_progress_count || 0;
      const complete = t.completed_count || 0;
      const overdue = t.overdue_count || 0;
      const membersCount = t.member_count || 1;

      card.innerHTML = `
        <div class="team-hub-card-head">
          <div class="team-hub-card-title">
            <span class="icon">${t.icon ? escapeHtml(t.icon) : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>'}</span>
            <div>
              <h3>${escapeHtml(t.name)}</h3>
            </div>
          </div>
          <span class="badge badge-todo" style="text-transform:capitalize;font-size:11px;">${t.role || "member"}</span>
        </div>
        <p class="team-hub-card-desc">${escapeHtml(t.description || t.purpose || "No team description provided.")}</p>
        <div class="team-hub-card-stats">
          <span>${total} total activit${total === 1 ? "y" : "ies"}</span>
          <span style="font-family:var(--font-mono);">${pct}% done</span>
        </div>
        <div class="progress-track" style="margin-bottom:12px;">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="team-hub-card-pill-row">
          <span class="pill pill-todo">${todo} To Do</span>
          <span class="pill pill-progress">${inProgress} Active</span>
          <span class="pill pill-complete">${complete} Done</span>
          ${overdue > 0 ? `<span class="pill pill-overdue">${overdue} Overdue</span>` : ""}
        </div>
        <div class="team-hub-card-footer">
          <div class="members-count">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:2px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg> ${membersCount} member${membersCount === 1 ? "" : "s"}
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn btn-xs btn-ghost report-quick-btn" data-team-id="${t.id}" title="Generate one-click monthly report" style="padding:3px 8px;font-size:11.5px;">Report</button>
            <div class="enter-btn">Open Team Page →</div>
          </div>
        </div>
      `;
      card.addEventListener("mouseenter", () => prefetchTeam(t.id), { once: true });
      card.addEventListener("touchstart", () => prefetchTeam(t.id), { once: true, passive: true });
      card.addEventListener("click", (e) => {
        const rBtn = e.target.closest(".report-quick-btn");
        if (rBtn) {
          e.stopPropagation();
          openMonthlyReportModal(t.id);
          return;
        }
        openTeamPage(t.id);
      });
      grid.appendChild(card);
    });

    // Add "+ Create team" card at the end of grid
    const createCard = document.createElement("div");
    createCard.className = "team-hub-card-new";
    createCard.innerHTML = `
      <div class="plus-icon">+</div>
      <h4>Create New Team</h4>
      <p>Start a new project or workspace</p>
    `;
    createCard.addEventListener("click", () => openTeamModal());
    grid.appendChild(createCard);
  }

  // Render Assigned Tasks List
  const atContainer = $("#assigned-tasks-container", root);
  if (state.assignedTasks.length === 0) {
    atContainer.innerHTML = `<div class="panel"><p class="empty-note">No activities currently assigned to you across your teams.</p></div>`;
  } else {
    const list = document.createElement("div");
    list.className = "assigned-tasks-list";
    state.assignedTasks.forEach((task) => {
      const item = document.createElement("div");
      item.className = "assigned-task-item";
      item.innerHTML = `
        <span class="ati-team">${task.teamIcon ? escapeHtml(task.teamIcon) + " " : ""}${escapeHtml(task.teamName || "Team")}</span>
        <span class="ati-title">${escapeHtml(task.title)}</span>
        <span class="badge badge-${task.effectiveStatus}">${STATUS_LABEL[task.effectiveStatus] || task.effectiveStatus}</span>
        <span class="ati-deadline">${deadlineMeta(task)}</span>
      `;
      item.addEventListener("click", async () => {
        if (task.teamId) {
          await switchTeam(task.teamId, { skipRender: true });
          await setView("tasks");
          openTaskModal(task);
        }
      });
      list.appendChild(item);
    });
    atContainer.appendChild(list);
  }

  return root;
}

/* ============================================================
   DASHBOARD VIEW & CHARTS
   ============================================================ */

const chartRegistry = {};

function destroyChart(id) {
  if (chartRegistry[id]) {
    try { chartRegistry[id].destroy(); } catch (e) {}
    delete chartRegistry[id];
  }
}

function renderDashboardSkeleton() {
  const wrap = document.createElement("div");
  wrap.className = "dashboard-skeleton-wrap";
  wrap.innerHTML = `
    <!-- Skeleton Controls -->
    <div class="skeleton-controls">
      <div style="flex:1; max-width:420px;">
        <div class="skeleton-shimmer skeleton-line-title"></div>
        <div class="skeleton-shimmer skeleton-line-sub"></div>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <div class="skeleton-shimmer" style="width:160px; height:34px;"></div>
        <div class="skeleton-shimmer" style="width:120px; height:34px;"></div>
      </div>
    </div>

    <!-- Skeleton Stat Grid -->
    <div class="skeleton-stat-grid">
      <div class="skeleton-shimmer skeleton-stat-card"></div>
      <div class="skeleton-shimmer skeleton-stat-card"></div>
      <div class="skeleton-shimmer skeleton-stat-card"></div>
      <div class="skeleton-shimmer skeleton-stat-card"></div>
      <div class="skeleton-shimmer skeleton-stat-card"></div>
    </div>

    <!-- Skeleton Progress Track Panel -->
    <div class="skeleton-panel">
      <div class="skeleton-shimmer skeleton-line" style="width:30%; height:16px; margin-bottom:12px;"></div>
      <div class="skeleton-shimmer skeleton-line" style="height:8px; border-radius:99px; margin-bottom:0;"></div>
    </div>

    <!-- Skeleton Charts Grid -->
    <div class="charts-grid">
      <div class="chart-card">
        <div class="skeleton-shimmer skeleton-line" style="width:45%; height:16px; margin-bottom:12px;"></div>
        <div class="skeleton-shimmer skeleton-chart-box"></div>
      </div>
      <div class="chart-card">
        <div class="skeleton-shimmer skeleton-line" style="width:50%; height:16px; margin-bottom:12px;"></div>
        <div class="skeleton-shimmer skeleton-chart-box"></div>
      </div>
    </div>

    <!-- Skeleton Mini-Lists Grid -->
    <div class="dashboard-grid">
      <div class="panel">
        <div class="skeleton-shimmer skeleton-line" style="width:40%; height:16px; margin-bottom:16px;"></div>
        <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:75%; height:14px;"></div></div>
        <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:60%; height:14px;"></div></div>
        <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:80%; height:14px;"></div></div>
      </div>
      <div class="panel">
        <div class="skeleton-shimmer skeleton-line" style="width:40%; height:16px; margin-bottom:16px;"></div>
        <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:70%; height:14px;"></div></div>
        <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:50%; height:14px;"></div></div>
        <div class="skeleton-list-item"><div class="skeleton-shimmer skeleton-line" style="width:65%; height:14px;"></div></div>
      </div>
    </div>
  `;
  return wrap;
}

function renderDashboard() {
  if (state.tasks && state.members) {
    recomputeLocalDashboard();
  }
  if (!state.dashboard) {
    return renderDashboardSkeleton();
  }

  const d = state.dashboard;
  d.total = d.total || 0;
  d.todo = d.todo || 0;
  d.inProgress = d.inProgress || 0;
  d.complete = d.complete || 0;
  d.overdue = d.overdue || 0;
  d.completionPct = d.completionPct || 0;
  d.memberProgress = d.memberProgress || [];
  d.overdueTasks = d.overdueTasks || [];
  d.upcoming = d.upcoming || [];
  d.recentActivity = d.recentActivity || [];

  const root = document.createElement("div");
  const selectedMemberId = state.dashboardMemberFilter || "all";
  const selectedMember = selectedMemberId === "all" ? null : state.members.find((m) => m.id === selectedMemberId);

  // If a specific member is selected that no longer exists in team, revert to all
  if (selectedMemberId !== "all" && !selectedMember) {
    state.dashboardMemberFilter = "all";
  }

  // Member dropdown selector options
  const memberOptionsHtml = `
    <option value="all" ${selectedMemberId === "all" ? "selected" : ""}>All Members (Team Overview)</option>
    ${state.members
      .map(
        (m) => `<option value="${m.id}" ${selectedMemberId === m.id ? "selected" : ""}>${escapeHtml(m.full_name)} (${m.role})</option>`
      )
      .join("")}
  `;

  if (selectedMember) {
    // -------------------------------------------------------------
    // INDIVIDUAL MEMBER DASHBOARD VIEW
    // -------------------------------------------------------------
    const memberTasks = state.tasks.filter((t) => t.assigneeId === selectedMember.id);
    const mTotal = memberTasks.length;
    const mComplete = memberTasks.filter((t) => t.effectiveStatus === "complete").length;
    const mInProgress = memberTasks.filter((t) => t.effectiveStatus === "in_progress").length;
    const mTodo = memberTasks.filter((t) => t.effectiveStatus === "todo").length;
    const mOverdue = memberTasks.filter((t) => t.effectiveStatus === "overdue").length;
    const mPct = mTotal === 0 ? 0 : Math.round((mComplete / mTotal) * 100);

    root.innerHTML = `
      <!-- Dashboard Controls -->
      <div class="dashboard-controls">
        <div>
          <h2 style="font-size:18px; margin-bottom:2px;">Individual Member Progress</h2>
          <p class="muted" style="margin:0; font-size:13px;">Analyzing assigned tasks and personal progress for ${escapeHtml(selectedMember.full_name)}</p>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div class="member-select-wrap">
            <label for="dashboard-member-select">Member:</label>
            <select id="dashboard-member-select" class="member-dropdown-select">
              ${memberOptionsHtml}
            </select>
          </div>
          <button class="btn btn-sm btn-ghost" id="dash-gen-report-btn" title="Generate one-click monthly report">Monthly Report</button>
        </div>
      </div>

      <!-- Member Spotlight Banner -->
      <div class="member-spotlight-card">
        <div class="member-spotlight-info">
          <div class="avatar-lg">${initials(selectedMember.full_name)}</div>
          <div class="member-spotlight-details">
            <h3>
              ${escapeHtml(selectedMember.full_name)}
              <span class="badge badge-todo" style="text-transform:capitalize; font-size:11px;">${selectedMember.role}</span>
            </h3>
            <p>${selectedMember.designation ? escapeHtml(selectedMember.designation) + " · " : ""}${escapeHtml(selectedMember.email)}</p>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:26px; font-weight:700; font-family:var(--font-display); color:var(--accent);">${mPct}%</div>
          <div style="font-size:12px; color:var(--muted); font-weight:600;">Personal Completion</div>
        </div>
      </div>

      <!-- Member Metric Cards -->
      <div class="stat-grid">
        <div class="stat-card"><div class="num">${mTotal}</div><div class="label">Assigned activities</div></div>
        <div class="stat-card accent-todo"><div class="num">${mTodo}</div><div class="label">To Do</div></div>
        <div class="stat-card accent-progress"><div class="num">${mInProgress}</div><div class="label">In Progress</div></div>
        <div class="stat-card accent-complete"><div class="num">${mComplete}</div><div class="label">Complete</div></div>
        <div class="stat-card accent-overdue"><div class="num">${mOverdue}</div><div class="label">Due Work</div></div>
      </div>

      <!-- Personal Progress Track -->
      <div class="panel">
        <div class="panel-head">
          <h2>Task Completion Rate</h2>
          <span class="muted" style="font-family:var(--font-mono);font-size:13px;">${mComplete}/${mTotal} Activities Done (${mPct}%)</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${mPct}%"></div></div>
      </div>

      <!-- Charts Grid for Individual Member -->
      <div class="charts-grid">
        <!-- Pie Chart -->
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>Personal Status Breakdown (Pie Chart)</h3>
          </div>
          <div class="chart-container">
            <canvas id="member-pie-chart"></canvas>
          </div>
          <div class="chart-legend-row">
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--todo);"></span> To Do (${mTodo})</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--progress);"></span> In Progress (${mInProgress})</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--complete);"></span> Complete (${mComplete})</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--overdue);"></span> Due Work (${mOverdue})</div>
          </div>
        </div>

        <!-- Bar Chart -->
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>Activity Distribution by Status (Bar Chart)</h3>
          </div>
          <div class="chart-container">
            <canvas id="member-bar-chart"></canvas>
          </div>
          <div class="chart-legend-row">
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--accent);"></span> Activity Volume</div>
          </div>
        </div>
      </div>

      <!-- Individual Tasks List -->
      <div class="panel">
        <div class="panel-head">
          <h2>Activities Assigned to ${escapeHtml(selectedMember.full_name)} (${memberTasks.length})</h2>
        </div>
        <div id="member-tasks-list" class="mini-list"></div>
      </div>
    `;

    // Populate member tasks list
    const mtl = $("#member-tasks-list", root);
    if (memberTasks.length === 0) {
      mtl.innerHTML = `<p class="empty-note">No activities currently assigned to this member.</p>`;
    } else {
      memberTasks.forEach((t) => {
        const stripe = t.effectiveStatus === "overdue" ? "stripe-overdue" : t.isDueSoon ? "stripe-soon" : "";
        mtl.appendChild(miniItem(t, stripe));
      });
    }

    // Render charts asynchronously after DOM attachment
    setTimeout(() => {
      renderStatusDonutChart("member-pie-chart", { todo: mTodo, inProgress: mInProgress, complete: mComplete, overdue: mOverdue });
      renderStatusBarChart("member-bar-chart", { todo: mTodo, inProgress: mInProgress, complete: mComplete, overdue: mOverdue });
    }, 0);

  } else {
    // -------------------------------------------------------------
    // TEAM-WIDE DASHBOARD (ALL MEMBERS)
    // -------------------------------------------------------------
    root.innerHTML = `
      <!-- Dashboard Controls -->
      <div class="dashboard-controls">
        <div>
          <h2 style="font-size:18px; margin-bottom:2px;">Team Activity &amp; Performance Insights</h2>
          <p class="muted" style="margin:0; font-size:13px;">Real-time progress overview across all team members and activities</p>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <div class="member-select-wrap">
            <label for="dashboard-member-select">Member:</label>
            <select id="dashboard-member-select" class="member-dropdown-select">
              ${memberOptionsHtml}
            </select>
          </div>
          <button class="btn btn-sm btn-ghost" id="dash-gen-report-btn" title="Generate one-click monthly report">Monthly Report</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card"><div class="num">${d.total}</div><div class="label">Total activities</div></div>
        <div class="stat-card accent-todo"><div class="num">${d.todo}</div><div class="label">To Do</div></div>
        <div class="stat-card accent-progress"><div class="num">${d.inProgress}</div><div class="label">In Progress</div></div>
        <div class="stat-card accent-complete"><div class="num">${d.complete}</div><div class="label">Complete</div></div>
        <div class="stat-card accent-overdue"><div class="num">${d.overdue}</div><div class="label">Due Work</div></div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Overall Team Completion</h2>
          <span class="muted" style="font-family:var(--font-mono);font-size:13px;">${d.complete}/${d.total} Activities (${d.completionPct}%)</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${d.completionPct}%"></div></div>
      </div>

      <!-- Interactive Charts Grid (Pie Chart + Bar Chart) -->
      <div class="charts-grid">
        <!-- Pie / Donut Chart: Status Distribution -->
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>Activity Status Breakdown (Pie Chart)</h3>
            <span class="muted" style="font-size:12px; font-family:var(--font-mono);">${d.total} Total</span>
          </div>
          <div class="chart-container">
            <canvas id="team-pie-chart"></canvas>
          </div>
          <div class="chart-legend-row">
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--todo);"></span> To Do (${d.todo})</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--progress);"></span> In Progress (${d.inProgress})</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--complete);"></span> Complete (${d.complete})</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--overdue);"></span> Due Work (${d.overdue})</div>
          </div>
        </div>

        <!-- Bar Chart: Member Workload Comparison -->
        <div class="chart-card">
          <div class="chart-card-head">
            <h3>Member Workload &amp; Status (Bar Chart)</h3>
            <span class="muted" style="font-size:12px; font-family:var(--font-mono);">${d.memberProgress.length} Members</span>
          </div>
          <div class="chart-container">
            <canvas id="team-members-bar-chart"></canvas>
          </div>
          <div class="chart-legend-row">
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--complete);"></span> Complete</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--progress);"></span> In Progress</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--todo);"></span> To Do</div>
            <div class="chart-legend-item"><span class="chart-legend-dot" style="background:var(--overdue);"></span> Due Work</div>
          </div>
        </div>
      </div>

      <!-- Needs Attention Spotlight Panel (Section 7) -->
      <div class="panel">
        <div class="panel-head">
          <h2 style="display:flex;align-items:center;gap:8px;">
            <span>Needs Attention</span>
          </h2>
          <span class="muted" style="font-size:12.5px;">Urgent, overdue, &amp; today's deadlines</span>
        </div>
        <div id="needs-attention-list" class="mini-list"></div>
      </div>

      <div class="dash-grid">
        <div class="panel">
          <div class="panel-head"><h2>Individual progress</h2></div>
          <div id="member-progress"></div>
        </div>
        <div>
          <div class="panel"><div class="panel-head"><h2>Due Work</h2></div><div id="overdue-list" class="mini-list"></div></div>
          <div class="panel"><div class="panel-head"><h2>Upcoming deadlines</h2></div><div id="upcoming-list" class="mini-list"></div></div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Recent activity</h2></div>
        <div id="recent-list" class="mini-list"></div>
      </div>
    `;

    // Populate Needs Attention
    const naEl = $("#needs-attention-list", root);
    const today = new Date().toISOString().slice(0, 10);
    const overdueTasks = state.tasks.filter((t) => t.effectiveStatus === "overdue");
    const dueTodayTasks = state.tasks.filter((t) => t.deadline === today && t.effectiveStatus !== "complete" && t.effectiveStatus !== "overdue");
    const urgentTasks = state.tasks.filter((t) => (t.priority === "urgent" || t.priority === "high") && t.effectiveStatus !== "complete" && t.effectiveStatus !== "overdue" && t.deadline !== today);
    const attentionItems = [...overdueTasks, ...dueTodayTasks, ...urgentTasks];

    if (attentionItems.length === 0) {
      naEl.innerHTML = `<p class="empty-note" style="padding:14px;font-size:13px;color:var(--complete);font-weight:600;">You're all caught up. No urgent or overdue activities.</p>`;
    } else {
      attentionItems.slice(0, 6).forEach((t) => {
        const itemEl = document.createElement("div");
        itemEl.className = `mini-item ${t.effectiveStatus === "overdue" ? "stripe-overdue" : "stripe-soon"}`;
        itemEl.style.cursor = "pointer";
        const tag =
          t.effectiveStatus === "overdue"
            ? `<span class="badge badge-overdue" style="font-size:10.5px;">Overdue</span>`
            : t.deadline === today
            ? `<span class="badge badge-progress" style="font-size:10.5px;">Due Today</span>`
            : `<span class="badge badge-priority-urgent" style="font-size:10.5px;">Urgent</span>`;

        itemEl.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;">
            ${tag}
            <span>${escapeHtml(t.title)}</span>
          </div>
          <div class="mi-meta">Assigned to ${escapeHtml(t.assigneeName || "Unassigned")} · ${deadlineMeta(t)}</div>
        `;
        itemEl.addEventListener("click", () => openActivityDetailModal(t));
        naEl.appendChild(itemEl);
      });
    }

    const mp = $("#member-progress", root);
    if (d.memberProgress.length === 0) {
      mp.innerHTML = `<p class="empty-note">No members yet.</p>`;
    } else {
      d.memberProgress.forEach((m) =>
        mp.appendChild(progressRow(m.name, `${m.role} · ${m.complete}/${m.total}`, m.completionPct, `${m.completionPct}%`))
      );
    }

    const ol = $("#overdue-list", root);
    ol.innerHTML = "";
    if (d.overdueTasks.length === 0) ol.innerHTML = `<p class="empty-note">Nothing overdue. Nice work!</p>`;
    else d.overdueTasks.forEach((t) => ol.appendChild(miniItem(t, "stripe-overdue")));

    const ul = $("#upcoming-list", root);
    ul.innerHTML = "";
    if (d.upcoming.length === 0) ul.innerHTML = `<p class="empty-note">No upcoming deadlines.</p>`;
    else d.upcoming.forEach((t) => ul.appendChild(miniItem(t, t.isDueSoon ? "stripe-soon" : "")));

    const rl = $("#recent-list", root);
    rl.innerHTML = "";
    if (d.recentActivity.length === 0) rl.innerHTML = `<p class="empty-note">No activity yet.</p>`;
    else
      d.recentActivity.forEach((t) => {
        const el = document.createElement("div");
        el.className = "mini-item";
        el.innerHTML = `<span class="mi-title">${escapeHtml(t.title)}</span><span class="mi-meta">${escapeHtml(t.assignee_name || "Unassigned")} · ${STATUS_LABEL[t.status]}</span>`;
        rl.appendChild(el);
      });

    // Render team charts asynchronously after DOM attachment
    setTimeout(() => {
      renderStatusDonutChart("team-pie-chart", { todo: d.todo, inProgress: d.inProgress, complete: d.complete, overdue: d.overdue });
      renderTeamMembersBarChart("team-members-bar-chart", d.memberProgress);
    }, 0);
  }

  // Wire member dropdown
  const memberSelect = $("#dashboard-member-select", root);
  if (memberSelect) {
    memberSelect.addEventListener("change", (e) => {
      state.dashboardMemberFilter = e.target.value;
      renderCurrentView();
    });
  }

  // Wire monthly report button
  const dashReportBtn = $("#dash-gen-report-btn", root);
  if (dashReportBtn) {
    dashReportBtn.addEventListener("click", () => openMonthlyReportModal(state.currentTeamId));
  }

  return root;
}

// ---------- Chart Rendering Helpers ----------

function renderStatusDonutChart(canvasId, { todo, inProgress, complete, overdue }) {
  const canvas = $(`#${canvasId}`);
  if (!canvas) return;
  destroyChart(canvasId);

  const total = todo + inProgress + complete + overdue;

  if (window.Chart) {
    try {
      const ctx = canvas.getContext("2d");
      chartRegistry[canvasId] = new Chart(ctx, {
        type: "doughnut",
        data: {
          labels: ["To Do", "In Progress", "Complete", "Due Work"],
          datasets: [
            {
              data: total === 0 ? [1] : [todo, inProgress, complete, overdue],
              backgroundColor: total === 0 ? ["#E5E7EB"] : ["#94A3B8", "#F5A623", "#22C55E", "#EF4444"],
              borderWidth: 2,
              borderColor: "#FFFFFF",
              hoverOffset: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "68%",
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: total > 0,
              callbacks: {
                label: (item) => ` ${item.label}: ${item.raw} (${total ? Math.round((item.raw / total) * 100) : 0}%)`,
              },
            },
          },
        },
      });
    } catch (e) {
      console.warn("Chart.js donut error, fallback to SVG:", e);
      renderSvgDonut(canvas, { todo, inProgress, complete, overdue, total });
    }
  } else {
    renderSvgDonut(canvas, { todo, inProgress, complete, overdue, total });
  }
}

function renderTeamMembersBarChart(canvasId, memberProgress = []) {
  const canvas = $(`#${canvasId}`);
  if (!canvas) return;
  destroyChart(canvasId);

  if (memberProgress.length === 0) {
    canvas.parentElement.innerHTML = `<p class="empty-note">No members to display.</p>`;
    return;
  }

  if (window.Chart) {
    try {
      const ctx = canvas.getContext("2d");
      const labels = memberProgress.map((m) => m.name.split(" ")[0]);
      const completeData = memberProgress.map((m) => m.complete || 0);
      const inProgressData = memberProgress.map((m) => m.inProgress || 0);
      const todoData = memberProgress.map((m) => m.todo || 0);
      const overdueData = memberProgress.map((m) => m.overdue || 0);

      chartRegistry[canvasId] = new Chart(ctx, {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "Complete", data: completeData, backgroundColor: "#22C55E", borderRadius: 4 },
            { label: "In Progress", data: inProgressData, backgroundColor: "#F5A623", borderRadius: 4 },
            { label: "To Do", data: todoData, backgroundColor: "#94A3B8", borderRadius: 4 },
            { label: "Due Work", data: overdueData, backgroundColor: "#EF4444", borderRadius: 4 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { stacked: true, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: "index",
              intersect: false,
            },
          },
        },
      });
    } catch (e) {
      console.warn("Chart.js member bar error, fallback to SVG:", e);
      renderSvgBarChart(canvas, memberProgress);
    }
  } else {
    renderSvgBarChart(canvas, memberProgress);
  }
}

function renderStatusBarChart(canvasId, { todo, inProgress, complete, overdue }) {
  const canvas = $(`#${canvasId}`);
  if (!canvas) return;
  destroyChart(canvasId);

  if (window.Chart) {
    try {
      const ctx = canvas.getContext("2d");
      chartRegistry[canvasId] = new Chart(ctx, {
        type: "bar",
        data: {
          labels: ["To Do", "In Progress", "Complete", "Due Work"],
          datasets: [
            {
              label: "Activities",
              data: [todo, inProgress, complete, overdue],
              backgroundColor: ["#94A3B8", "#F5A623", "#22C55E", "#EF4444"],
              borderRadius: 6,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, ticks: { precision: 0 } },
          },
          plugins: {
            legend: { display: false },
          },
        },
      });
    } catch (e) {
      console.warn("Chart.js status bar error, fallback to SVG:", e);
      renderSvgBarChart(canvas, [
        { name: "To Do", complete: todo, total: todo, completionPct: 100 },
        { name: "In Progress", complete: inProgress, total: inProgress, completionPct: 100 },
        { name: "Complete", complete: complete, total: complete, completionPct: 100 },
        { name: "Due Work", complete: overdue, total: overdue, completionPct: 100 },
      ]);
    }
  } else {
    renderSvgBarChart(canvas, [
      { name: "To Do", complete: todo, total: todo, completionPct: 100 },
      { name: "In Progress", complete: inProgress, total: inProgress, completionPct: 100 },
      { name: "Complete", complete: complete, total: complete, completionPct: 100 },
      { name: "Due Work", complete: overdue, total: overdue, completionPct: 100 },
    ]);
  }
}

function renderSvgDonut(canvas, { todo, inProgress, complete, overdue, total }) {
  const container = canvas.parentElement;
  if (total === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:13px;">No activities to chart yet.</div>`;
    return;
  }
  const slices = [
    { value: complete, color: "#22C55E", label: "Complete" },
    { value: inProgress, color: "#F5A623", label: "In Progress" },
    { value: todo, color: "#94A3B8", label: "To Do" },
    { value: overdue, color: "#EF4444", label: "Due Work" },
  ].filter((s) => s.value > 0);

  let cumulativeAngle = 0;
  const radius = 80;
  const cx = 100;
  const cy = 100;
  const paths = slices.map((s) => {
    const angle = (s.value / total) * 360;
    const startAngle = cumulativeAngle;
    const endAngle = cumulativeAngle + angle;
    cumulativeAngle = endAngle;

    const x1 = cx + radius * Math.cos((Math.PI * (startAngle - 90)) / 180);
    const y1 = cy + radius * Math.sin((Math.PI * (startAngle - 90)) / 180);
    const x2 = cx + radius * Math.cos((Math.PI * (endAngle - 90)) / 180);
    const y2 = cy + radius * Math.sin((Math.PI * (endAngle - 90)) / 180);
    const largeArc = angle > 180 ? 1 : 0;

    return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${s.color}" />`;
  });

  container.innerHTML = `
    <svg viewBox="0 0 200 200" width="180" height="180">
      ${paths.join("")}
      <circle cx="${cx}" cy="${cy}" r="50" fill="#FFFFFF" />
      <text x="${cx}" y="${cy + 5}" text-anchor="middle" font-weight="700" font-size="14" fill="#1C1F26">${Math.round((complete / total) * 100)}%</text>
    </svg>
  `;
}

function renderSvgBarChart(canvas, memberProgress) {
  const container = canvas.parentElement;
  container.innerHTML = memberProgress
    .map(
      (m) => `
      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
          <span>${escapeHtml(m.name)}</span>
          <span>${m.complete}/${m.total}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${m.completionPct}%"></div></div>
      </div>`
    )
    .join("");
}

const STATUS_LABEL = { todo: "To Do", in_progress: "In Progress", complete: "Complete", overdue: "Due Work" };

function progressRow(title, sub, pct, fraction) {
  const row = document.createElement("div");
  row.className = "progress-row";
  row.innerHTML = `
    <div class="who">${escapeHtml(title)}<div class="sub">${escapeHtml(sub)}</div></div>
    <div class="bar-wrap"><div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div></div>
    <div class="pct">${fraction}</div>`;
  return row;
}

/* ============================================================
   PRIORITY & STATUS HELPERS
   ============================================================ */

const PRIORITY_LABELS = {
  low: { label: "Low", icon: "●", cls: "badge-priority-low" },
  normal: { label: "Normal", icon: "●", cls: "badge-priority-normal" },
  high: { label: "High", icon: "●", cls: "badge-priority-high" },
  urgent: { label: "Urgent", icon: "●", cls: "badge-priority-urgent" },
};

function priorityBadge(priority = "normal") {
  const p = PRIORITY_LABELS[priority] || PRIORITY_LABELS.normal;
  return `<span class="badge ${p.cls}">${p.icon} ${p.label}</span>`;
}

function miniItem(task, stripeClass) {
  const el = document.createElement("div");
  el.className = `mini-item ${stripeClass}`;
  const p = PRIORITY_LABELS[task.priority || "normal"] || PRIORITY_LABELS.normal;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;">
      <span style="font-size:10px;">${p.icon}</span>
      <span class="mi-title">${escapeHtml(task.title)}</span>
    </div>
    <span class="mi-meta">${escapeHtml(task.assigneeName)} · ${deadlineMeta(task)}</span>`;
  el.addEventListener("click", () => openActivityDetailModal(task));
  return el;
}

/* ============================================================
   ACTIVITIES (LIST & BOARD) VIEW
   ============================================================ */

state.taskViewMode = state.taskViewMode || "list";
state.taskSearch = state.taskSearch || "";
state.taskMemberFilter = state.taskMemberFilter || "all";
state.taskPriorityFilter = state.taskPriorityFilter || "all";
state.taskStatusFilter = state.taskStatusFilter || "all";

function renderTasks() {
  const root = document.createElement("div");

  // 1. Toolbar (View Switcher + Search + Filters + Add Activity)
  const toolbar = document.createElement("div");
  toolbar.className = "activities-toolbar";
  toolbar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <div class="activities-view-tabs">
        <button class="view-tab-btn ${state.taskViewMode === "list" ? "is-active" : ""}" id="tab-view-list">List</button>
        <button class="view-tab-btn ${state.taskViewMode === "board" ? "is-active" : ""}" id="tab-view-board">Board</button>
      </div>
      <div class="activities-search-box">
        <input type="text" id="task-search-input" placeholder="Search activities..." value="${escapeHtml(state.taskSearch)}" />
      </div>
    </div>
    <div class="activities-filter-row">
      <select class="filter-select" id="task-filter-status">
        <option value="all" ${state.taskStatusFilter === "all" ? "selected" : ""}>All Statuses</option>
        <option value="todo" ${state.taskStatusFilter === "todo" ? "selected" : ""}>To Do</option>
        <option value="in_progress" ${state.taskStatusFilter === "in_progress" ? "selected" : ""}>In Progress</option>
        <option value="complete" ${state.taskStatusFilter === "complete" ? "selected" : ""}>Complete</option>
        <option value="overdue" ${state.taskStatusFilter === "overdue" ? "selected" : ""}>Due / Overdue</option>
      </select>
      <select class="filter-select" id="task-filter-member">
        <option value="all" ${state.taskMemberFilter === "all" ? "selected" : ""}>All Members</option>
        ${state.members.map((m) => `<option value="${m.id}" ${state.taskMemberFilter === m.id ? "selected" : ""}>${escapeHtml(m.full_name)}</option>`).join("")}
      </select>
      <select class="filter-select" id="task-filter-priority">
        <option value="all" ${state.taskPriorityFilter === "all" ? "selected" : ""}>All Priorities</option>
        <option value="urgent" ${state.taskPriorityFilter === "urgent" ? "selected" : ""}>● Urgent</option>
        <option value="high" ${state.taskPriorityFilter === "high" ? "selected" : ""}>● High</option>
        <option value="normal" ${state.taskPriorityFilter === "normal" ? "selected" : ""}>● Normal</option>
        <option value="low" ${state.taskPriorityFilter === "low" ? "selected" : ""}>● Low</option>
      </select>
      ${state.currentTeamRole === "owner" || state.currentTeamRole === "admin" ? `<button class="btn btn-primary btn-sm" id="tasks-add-btn">+ Add activity</button>` : ""}
    </div>
  `;
  root.appendChild(toolbar);

  // Wire toolbar events
  $("#tab-view-list", toolbar).addEventListener("click", () => {
    state.taskViewMode = "list";
    renderCurrentView();
  });
  $("#tab-view-board", toolbar).addEventListener("click", () => {
    state.taskViewMode = "board";
    renderCurrentView();
  });
  const searchInput = $("#task-search-input", toolbar);
  const debouncedSearchRender = debounce(() => renderTasksContent(container), 150);
  searchInput.addEventListener("input", (e) => {
    state.taskSearch = e.target.value;
    debouncedSearchRender();
  });
  $("#task-filter-status", toolbar).addEventListener("change", (e) => {
    state.taskStatusFilter = e.target.value;
    renderTasksContent(container);
  });
  $("#task-filter-member", toolbar).addEventListener("change", (e) => {
    state.taskMemberFilter = e.target.value;
    renderTasksContent(container);
  });
  $("#task-filter-priority", toolbar).addEventListener("change", (e) => {
    state.taskPriorityFilter = e.target.value;
    renderTasksContent(container);
  });
  $("#tasks-add-btn", toolbar)?.addEventListener("click", () => openTaskModal());

  const container = document.createElement("div");
  container.id = "activities-container";
  root.appendChild(container);

  renderTasksContent(container);
  return root;
}

function getFilteredTasks() {
  return state.tasks.filter((t) => {
    // Search query filter
    if (state.taskSearch.trim()) {
      const q = state.taskSearch.trim().toLowerCase();
      const matchTitle = (t.title || "").toLowerCase().includes(q);
      const matchDesc = (t.description || "").toLowerCase().includes(q);
      const matchAssignee = (t.assigneeName || "").toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchAssignee) return false;
    }
    // Status filter
    if (state.taskStatusFilter !== "all") {
      if (state.taskStatusFilter === "overdue" && t.effectiveStatus !== "overdue") return false;
      if (state.taskStatusFilter !== "overdue" && t.status !== state.taskStatusFilter) return false;
    }
    // Member filter
    if (state.taskMemberFilter !== "all" && t.assigneeId !== state.taskMemberFilter) return false;
    // Priority filter
    if (state.taskPriorityFilter !== "all" && (t.priority || "normal") !== state.taskPriorityFilter) return false;

    return true;
  });
}

function renderTasksContent(container) {
  container.innerHTML = "";
  const filtered = getFilteredTasks();

  if (!state.dashboard && state.tasks.length === 0) {
    container.appendChild(renderTasksSkeleton());
    return;
  }

  if (state.tasks.length === 0) {
    const isManager = state.currentTeamRole === "owner" || state.currentTeamRole === "admin";
    container.innerHTML = `
      <div class="panel" style="text-align:center; padding: 60px 20px;">
        <div style="margin-bottom:14px;"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg></div>
        <h3 style="font-size:18px; margin-bottom:6px;">No activities yet</h3>
        <p class="muted" style="margin-bottom:20px; font-size:14px;">${isManager ? "Start by creating your team's first activity." : "No activities have been created for this team yet."}</p>
        ${isManager ? `<button class="btn btn-primary" id="empty-add-activity-btn">+ Add Activity</button>` : ""}
      </div>`;
    $("#empty-add-activity-btn", container)?.addEventListener("click", () => openTaskModal());
    return;
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="panel" style="text-align:center; padding: 40px 20px;">
        <p class="muted" style="font-size:14px;">No activities match your current search and filters.</p>
        <button class="btn btn-ghost btn-sm" id="clear-filters-btn" style="margin-top:10px;">Clear Filters</button>
      </div>`;
    $("#clear-filters-btn", container)?.addEventListener("click", () => {
      state.taskSearch = "";
      state.taskStatusFilter = "all";
      state.taskMemberFilter = "all";
      state.taskPriorityFilter = "all";
      renderCurrentView();
    });
    return;
  }

  if (state.taskViewMode === "list") {
    // Render List View
    const listWrap = document.createElement("div");
    listWrap.className = "panel";
    listWrap.style.padding = "0";
    listWrap.style.overflow = "hidden";

    const table = document.createElement("table");
    table.className = "report-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width:35%;">Activity</th>
          <th style="width:14%;">Priority</th>
          <th style="width:16%;">Assignee</th>
          <th style="width:15%;">Due Date</th>
          <th style="width:12%;">Status</th>
          <th style="width:8%;text-align:right;">Action</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = $("tbody", table);

    filtered.forEach((task) => {
      const tr = document.createElement("tr");
      tr.style.cursor = "pointer";
      const canEdit = canEditTask(task);
      const checklistDone = (task.checklist || []).filter((i) => i.done).length;
      const checklistTotal = (task.checklist || []).length;
      const checklistBadge = checklistTotal > 0 ? `<span class="badge" style="background:#F1F5F9;color:var(--muted);font-size:10.5px;margin-left:6px;">✓ ${checklistDone}/${checklistTotal}</span>` : "";

      tr.innerHTML = `
        <td>
          <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;flex-wrap:wrap;gap:4px;">
            ${escapeHtml(task.title)}
            ${checklistBadge}
          </div>
          ${task.description ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHtml(task.description)}</div>` : ""}
        </td>
        <td>${priorityBadge(task.priority)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            <div class="avatar" style="width:24px;height:24px;font-size:10px;">${initials(task.assigneeName)}</div>
            <span style="font-size:13px;">${escapeHtml(task.assigneeName || "Unassigned")}</span>
          </div>
        </td>
        <td>
          <span style="font-family:var(--font-mono);font-size:12.5px;">${deadlineMeta(task)}</span>
        </td>
        <td>
          ${
            canEdit
              ? `<select class="status-quick-select" data-task-id="${task.id}" style="padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:#fff;font-weight:600;">
                  <option value="todo" ${task.status === "todo" ? "selected" : ""}>To Do</option>
                  <option value="in_progress" ${task.status === "in_progress" ? "selected" : ""}>In Progress</option>
                  <option value="complete" ${task.status === "complete" ? "selected" : ""}>Complete</option>
                </select>`
              : `<span class="badge badge-${task.effectiveStatus}">${STATUS_LABEL[task.effectiveStatus] || task.status}</span>`
          }
        </td>
        <td style="text-align:right;">
          ${
            canEdit
              ? `<div style="display:inline-flex;align-items:center;gap:4px;">
                  ${
                    task.effectiveStatus !== "complete"
                      ? `<button class="btn btn-xs btn-primary mark-complete-quick-btn" data-task-id="${task.id}" title="Mark Complete">Done</button>`
                      : `<span style="color:#16924A;font-weight:700;font-size:12px;margin-right:4px;">Completed</span>`
                  }
                  ${
                    state.currentTeamRole === "owner" || state.currentTeamRole === "admin"
                      ? `<button class="btn btn-xs btn-ghost btn-danger delete-quick-btn" data-task-id="${task.id}" title="Delete Activity" style="padding:3px 6px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`
                      : ""
                  }
                </div>`
              : `<span style="font-size:11.5px;color:var(--muted);font-weight:500;">Assigned to ${escapeHtml(task.assigneeName)}</span>`
          }
        </td>
      `;

      tr.addEventListener("click", (e) => {
        if (e.target.closest("select") || e.target.closest("button")) return;
        openActivityDetailModal(task);
      });

      if (canEdit) {
        const select = $(".status-quick-select", tr);
        if (select) {
          select.addEventListener("change", async (e) => {
            e.stopPropagation();
            await updateTaskStatusQuick(task, select.value);
          });
        }

        const completeBtn = $(".mark-complete-quick-btn", tr);
        if (completeBtn) {
          completeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await updateTaskStatusQuick(task, "complete");
          });
        }

        const deleteBtn = $(".delete-quick-btn", tr);
        if (deleteBtn) {
          deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const id = task.id;
            const tTitle = task.title;
            showConfirmModal({
              title: "Delete Activity",
              message: `Are you sure you want to permanently delete "${escapeHtml(tTitle)}"? This cannot be undone.`,
              okText: "Delete Activity",
              onConfirm: async () => {
                const index = state.tasks.findIndex((t) => t.id === id);
                let removed = null;
                if (index !== -1) {
                  removed = state.tasks.splice(index, 1)[0];
                  syncAndPersistWorkspaceState();
                  renderCurrentView();
                }
                toast("Activity deleted");
                try {
                  await api(`/teams/${state.currentTeamId}/tasks/${id}`, { method: "DELETE" });
                } catch (err) {
                  if (removed) {
                    state.tasks.splice(index, 0, removed);
                    syncAndPersistWorkspaceState();
                    renderCurrentView();
                  }
                  toast(err.message || "Failed to delete activity");
                }
              },
            });
          });
        }
      }

      tbody.appendChild(tr);
    });

    listWrap.appendChild(table);
    container.appendChild(listWrap);

  } else {
    // Render 3-Column Board View
    const boardWrap = document.createElement("div");
    boardWrap.className = "board-columns";

    const boardCols = [
      { key: "todo", title: "To Do", badgeColor: "#94A3B8" },
      { key: "in_progress", title: "In Progress", badgeColor: "#F5A623" },
      { key: "complete", title: "Complete", badgeColor: "#22C55E" },
    ];

    boardCols.forEach((col) => {
      const colTasks = filtered.filter((t) => t.status === col.key);
      const colEl = document.createElement("div");
      colEl.className = "board-column";
      colEl.dataset.status = col.key;

      colEl.innerHTML = `
        <div class="board-column-head">
          <div class="board-column-title">
            <span style="width:10px;height:10px;border-radius:50%;background:${col.badgeColor};display:inline-block;"></span>
            ${col.title}
          </div>
          <span class="board-column-count">${colTasks.length}</span>
        </div>
        <div class="board-cards-wrap" id="col-cards-${col.key}"></div>
      `;

      const cardsWrap = $(".board-cards-wrap", colEl);

      // Drag & Drop event listeners on Column
      colEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        colEl.classList.add("drag-over");
      });
      colEl.addEventListener("dragleave", () => {
        colEl.classList.remove("drag-over");
      });
      colEl.addEventListener("drop", async (e) => {
        e.preventDefault();
        colEl.classList.remove("drag-over");
        const taskId = e.dataTransfer.getData("text/plain");
        const droppedTask = state.tasks.find((t) => t.id === taskId);
        if (droppedTask && droppedTask.status !== col.key) {
          if (!canEditTask(droppedTask)) {
            toast("Only the assigned member can change this activity's status");
            return;
          }
          await updateTaskStatusQuick(droppedTask, col.key);
        }
      });

      if (colTasks.length === 0) {
        cardsWrap.innerHTML = `<p class="empty-note" style="padding:20px 0;text-align:center;font-size:12.5px;">Drop activities here</p>`;
      } else {
        colTasks.forEach((t) => {
          const card = createBoardCard(t);
          cardsWrap.appendChild(card);
        });
      }

      boardWrap.appendChild(colEl);
    });

    container.appendChild(boardWrap);
  }
}

function createBoardCard(task) {
  const card = document.createElement("div");
  card.className = `board-card border-${task.effectiveStatus}`;
  const canEdit = canEditTask(task);
  card.draggable = canEdit;
  card.dataset.id = task.id;

  const checklistDone = (task.checklist || []).filter((i) => i.done).length;
  const checklistTotal = (task.checklist || []).length;
  const checklistBadge = checklistTotal > 0 ? `<span style="font-size:11px;color:var(--muted);">✓ ${checklistDone}/${checklistTotal}</span>` : "";

  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      ${priorityBadge(task.priority)}
      ${task.effectiveStatus === "overdue" ? `<span class="badge badge-overdue" style="font-size:10px;">Due Work</span>` : ""}
    </div>
    <div class="board-card-title">${escapeHtml(task.title)}</div>
    ${task.description ? `<p style="font-size:12px;color:var(--muted);margin:0 0 8px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHtml(task.description)}</p>` : ""}
    <div class="board-card-meta">
      <div style="display:flex;align-items:center;gap:5px;">
        <div class="avatar" style="width:20px;height:20px;font-size:9px;">${initials(task.assigneeName)}</div>
        <span style="font-size:11.5px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(task.assigneeName || "Unassigned")}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        ${checklistBadge}
        <span style="font-family:var(--font-mono);font-size:11.5px;">${deadlineMeta(task)}</span>
      </div>
    </div>
  `;

  if (canEdit) {
    card.addEventListener("dragstart", (e) => {
      card.classList.add("is-dragging");
      e.dataTransfer.setData("text/plain", task.id);
      e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
    });
  }

  card.addEventListener("click", () => {
    openActivityDetailModal(task);
  });

  return card;
}

async function updateTaskStatusQuick(task, newStatus) {
  if (!canEditTask(task)) {
    toast("Only the assigned member can change this activity's status");
    return;
  }
  const oldStatus = task.status;
  const oldEffective = task.effectiveStatus;

  // 1. Instant 0ms Optimistic UI update
  task.status = newStatus;
  task.effectiveStatus = computeClientEffectiveStatus(newStatus, task.deadline);
  syncAndPersistWorkspaceState();
  renderCurrentView();
  toast("Status updated");

  // 2. Background Sync
  try {
    const updated = await api(`/teams/${state.currentTeamId}/tasks/${task.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: newStatus }),
    });
    Object.assign(task, updated);
    syncAndPersistWorkspaceState();
  } catch (err) {
    // Revert if error
    task.status = oldStatus;
    task.effectiveStatus = oldEffective;
    syncAndPersistWorkspaceState();
    renderCurrentView();
    toast(err.message || "Failed to update status");
  }
}

/* ============================================================
   MY WORK VIEW (SECTION 13)
   ============================================================ */

function renderMyWork() {
  const root = document.createElement("div");
  root.className = "my-work-container";

  const allAssigned = state.assignedTasks || [];
  const today = new Date().toISOString().slice(0, 10);

  const overdueList = allAssigned.filter((t) => t.effectiveStatus === "overdue");
  const todayList = allAssigned.filter((t) => t.deadline === today && t.effectiveStatus !== "complete" && t.effectiveStatus !== "overdue");
  const upcomingList = allAssigned.filter((t) => t.effectiveStatus !== "complete" && t.effectiveStatus !== "overdue" && t.deadline !== today);
  const completedList = allAssigned.filter((t) => t.effectiveStatus === "complete");

  function renderGroup(title, icon, list, emptyMsg) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="my-work-group-title">
        <span style="font-size:12px;color:var(--accent);">${icon}</span>
        <span>${title} (${list.length})</span>
      </div>
      <div class="my-work-cards-grid"></div>
    `;
    const grid = $(".my-work-cards-grid", wrap);
    if (list.length === 0) {
      grid.innerHTML = `<p class="empty-note" style="grid-column:1/-1;">${emptyMsg}</p>`;
    } else {
      list.forEach((t) => {
        const card = document.createElement("div");
        card.className = `my-work-card border-${t.effectiveStatus}`;
        card.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;">${t.teamIcon ? t.teamIcon + " " : ""}${escapeHtml(t.teamName || "Team")}</span>
            ${priorityBadge(t.priority)}
          </div>
          <h4 style="font-size:14px;font-weight:600;margin-bottom:4px;">${escapeHtml(t.title)}</h4>
          ${t.description ? `<p style="font-size:12px;color:var(--muted);margin-bottom:8px;">${escapeHtml(t.description)}</p>` : ""}
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:10px;font-size:12px;">
            <span style="font-family:var(--font-mono);font-size:12px;">${deadlineMeta(t)}</span>
            <span class="badge badge-${t.effectiveStatus}">${STATUS_LABEL[t.effectiveStatus] || t.effectiveStatus}</span>
          </div>
        `;
        card.addEventListener("click", () => {
          if (t.teamId) {
            openTeamPage(t.teamId).then(() => {
              openActivityDetailModal(t);
            });
          }
        });
        grid.appendChild(card);
      });
    }
    return wrap;
  }

  root.appendChild(renderGroup("Overdue Work", "●", overdueList, "You're all caught up. No overdue work."));
  root.appendChild(renderGroup("Due Today", "●", todayList, "No activities due today."));
  root.appendChild(renderGroup("Upcoming Work", "●", upcomingList, "No upcoming activities."));
  root.appendChild(renderGroup("Recently Completed", "●", completedList, "No completed activities yet."));

  return root;
}

/* ============================================================
   ACTIVITY DETAIL MODAL (CHECKLIST + COMMENTS + ACTIONS)
   ============================================================ */

let currentDetailTask = null;

async function openActivityDetailModal(task) {
  currentDetailTask = task;
  const modal = $("#activity-detail-modal-backdrop");
  const body = $("#activity-detail-body");
  const canEdit = canEditTask(task);

  const pBadge = $("#detail-priority-badge");
  const p = PRIORITY_LABELS[task.priority || "normal"] || PRIORITY_LABELS.normal;
  pBadge.className = `badge ${p.cls}`;
  pBadge.textContent = `${p.icon} ${p.label}`;

  const sBadge = $("#detail-status-badge");
  sBadge.className = `badge badge-${task.effectiveStatus}`;
  sBadge.textContent = STATUS_LABEL[task.effectiveStatus] || task.status;

  const completeBtn = $("#detail-complete-btn");
  if (completeBtn) {
    completeBtn.hidden = !canEdit;
    completeBtn.textContent = task.status === "complete" ? "↺ Mark Incomplete" : "✓ Mark Complete";
  }

  const editBtn = $("#detail-edit-btn");
  if (editBtn) editBtn.hidden = !canEdit;

  const deleteBtn = $("#detail-delete-btn");
  if (deleteBtn) deleteBtn.hidden = !canEdit;

  const checklistItems = Array.isArray(task.checklist) ? task.checklist : [];
  const checklistDone = checklistItems.filter((i) => i.done).length;
  const checklistTotal = checklistItems.length;

  body.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px;">
      <h2 class="detail-title" style="margin:0;">${escapeHtml(task.title)}</h2>
      ${!canEdit ? `<span class="badge" style="background:var(--surface-sunken);color:var(--muted);font-size:11px;white-space:nowrap;">Read-Only View</span>` : ""}
    </div>
    <div class="detail-grid">
      <div>
        <div class="detail-item-label">Assigned To</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <div class="avatar" style="width:24px;height:24px;font-size:10px;">${initials(task.assigneeName)}</div>
          <strong>${escapeHtml(task.assigneeName || "Unassigned")}</strong>
        </div>
      </div>
      <div>
        <div class="detail-item-label">Due Date &amp; Time</div>
        <div style="font-family:var(--font-mono);">${fmtDate(task.deadline)} ${task.effectiveStatus === "overdue" ? `<span style="color:#EF4444;font-weight:700;">(Overdue)</span>` : ""}</div>
      </div>
      <div>
        <div class="detail-item-label">Status ${!canEdit ? `<span style="font-weight:normal;color:var(--muted);font-size:11px;">(Assignee only)</span>` : ""}</div>
        <select id="detail-status-select" class="form-select-sm" style="font-weight:600;" ${!canEdit ? "disabled title='Only the assigned member can change status'" : ""}>
          <option value="todo" ${task.status === "todo" ? "selected" : ""}>To Do</option>
          <option value="in_progress" ${task.status === "in_progress" ? "selected" : ""}>In Progress</option>
          <option value="complete" ${task.status === "complete" ? "selected" : ""}>Complete</option>
        </select>
      </div>
      <div>
        <div class="detail-item-label">Priority ${!canEdit ? `<span style="font-weight:normal;color:var(--muted);font-size:11px;">(Assignee only)</span>` : ""}</div>
        <select id="detail-priority-select" class="form-select-sm" style="font-weight:600;" ${!canEdit ? "disabled title='Only the assigned member can change priority'" : ""}>
          <option value="low" ${task.priority === "low" ? "selected" : ""}>● Low</option>
          <option value="normal" ${task.priority === "normal" || !task.priority ? "selected" : ""}>● Normal</option>
          <option value="high" ${task.priority === "high" ? "selected" : ""}>● High</option>
          <option value="urgent" ${task.priority === "urgent" ? "selected" : ""}>● Urgent</option>
        </select>
      </div>
    </div>

    ${task.description ? `<div class="detail-desc-box"><div class="detail-item-label">Description</div>${escapeHtml(task.description)}</div>` : ""}

    <!-- Checklist Section -->
    <div class="checklist-section">
      <div class="checklist-header">
        <strong style="font-size:14px;">Checklist</strong>
        <span class="checklist-progress-text" id="checklist-counter">${checklistDone} / ${checklistTotal} completed</span>
      </div>
      <div class="checklist-items-list" id="checklist-items-list"></div>
      <div class="checklist-add-row" ${!canEdit ? 'style="display:none;"' : ""}>
        <input type="text" id="checklist-add-input" class="checklist-add-input" placeholder="+ Add a checklist item..." />
        <button class="btn btn-sm btn-ghost" id="checklist-add-btn">+ Add</button>
      </div>
    </div>

    <!-- Comments Section -->
    <div class="comments-section">
      <strong style="font-size:14px;display:block;margin-bottom:10px;">Activity Comments</strong>
      <div class="comments-list" id="comments-list">
        <p class="empty-note">Loading comments...</p>
      </div>
      <div class="comment-add-box">
        <textarea id="comment-input" rows="2" placeholder="Write a comment or mention @username..."></textarea>
        <button class="btn btn-primary btn-sm" id="comment-post-btn" style="align-self:flex-end;">Post</button>
      </div>
    </div>
  `;

  // Render Checklist Rows
  renderChecklistRows(task);

  // Wire Status & Priority selects in detail view (if allowed)
  if (canEdit) {
    $("#detail-status-select", body)?.addEventListener("change", async (e) => {
      await updateTaskStatusQuick(task, e.target.value);
      openActivityDetailModal(task);
    });
    $("#detail-priority-select", body)?.addEventListener("change", async (e) => {
      const newPriority = e.target.value;
      task.priority = newPriority;
      syncAndPersistWorkspaceState();
      renderCurrentView();
      const updated = await api(`/teams/${state.currentTeamId}/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ priority: newPriority }) });
      Object.assign(task, updated);
      syncAndPersistWorkspaceState();
      openActivityDetailModal(task);
    });

    // Wire Checklist Add
    const addInput = $("#checklist-add-input", body);
    const addBtn = $("#checklist-add-btn", body);
    if (addInput && addBtn) {
      async function handleAddChecklist() {
        const text = addInput.value.trim();
        if (!text) return;
        task.checklist = Array.isArray(task.checklist) ? task.checklist : [];
        task.checklist.push({ id: "chk_" + Date.now(), text, done: false });
        addInput.value = "";
        renderChecklistRows(task);
        syncAndPersistWorkspaceState();
        const updated = await api(`/teams/${state.currentTeamId}/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ checklist: task.checklist }) });
        Object.assign(task, updated);
        syncAndPersistWorkspaceState();
      }
      addBtn.addEventListener("click", handleAddChecklist);
      addInput.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAddChecklist(); });
    }
  }

  // Load and Render Comments (all team members can participate)
  loadActivityComments(task.id);

  // Wire Comment Post
  const commentInput = $("#comment-input", body);
  const commentBtn = $("#comment-post-btn", body);
  async function handlePostComment() {
    const content = commentInput.value.trim();
    if (!content) return;
    commentBtn.disabled = true;
    try {
      await api(`/teams/${state.currentTeamId}/tasks/${task.id}/comments`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      commentInput.value = "";
      await loadActivityComments(task.id);
    } catch (err) {
      toast(err.message || "Failed to post comment");
    } finally {
      commentBtn.disabled = false;
    }
  }
  commentBtn.addEventListener("click", handlePostComment);

  modal.hidden = false;
}

function renderChecklistRows(task) {
  const listEl = $("#checklist-items-list");
  const counterEl = $("#checklist-counter");
  if (!listEl) return;
  const canEdit = canEditTask(task);
  const items = Array.isArray(task.checklist) ? task.checklist : [];
  const doneCount = items.filter((i) => i.done).length;
  if (counterEl) counterEl.textContent = `${doneCount} / ${items.length} completed`;

  if (items.length === 0) {
    listEl.innerHTML = `<p class="empty-note" style="margin:0;font-size:12.5px;">No checklist items added yet.</p>`;
    return;
  }

  listEl.innerHTML = items
    .map(
      (item) => `
      <div class="checklist-row ${item.done ? "is-done" : ""}" data-item-id="${item.id}">
        <input type="checkbox" ${item.done ? "checked" : ""} ${!canEdit ? "disabled title='Only assigned member can check items'" : ""} />
        <span style="flex:1;">${escapeHtml(item.text)}</span>
        ${canEdit ? `<button class="icon-btn chk-delete-btn" style="font-size:11px;" title="Delete item">✕</button>` : ""}
      </div>`
    )
    .join("");

  if (canEdit) {
    $$(".checklist-row", listEl).forEach((row) => {
      const chkId = row.dataset.itemId;
      const item = items.find((i) => i.id === chkId);
      const cb = $("input[type='checkbox']", row);
      cb.addEventListener("change", async () => {
        if (item) item.done = cb.checked;
        renderChecklistRows(task);
        syncAndPersistWorkspaceState();
        renderCurrentView();
        const updated = await api(`/teams/${state.currentTeamId}/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ checklist: items }) });
        Object.assign(task, updated);
        syncAndPersistWorkspaceState();
      });
      const del = $(".chk-delete-btn", row);
      if (del) {
        del.addEventListener("click", async () => {
          task.checklist = items.filter((i) => i.id !== chkId);
          renderChecklistRows(task);
          syncAndPersistWorkspaceState();
          renderCurrentView();
          const updated = await api(`/teams/${state.currentTeamId}/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ checklist: task.checklist }) });
          Object.assign(task, updated);
          syncAndPersistWorkspaceState();
        });
      }
    });
  }
}

async function loadActivityComments(taskId) {
  const listEl = $("#comments-list");
  if (!listEl) return;
  try {
    const comments = await api(`/teams/${state.currentTeamId}/tasks/${taskId}/comments`);
    if (comments.length === 0) {
      listEl.innerHTML = `<p class="empty-note" style="margin:0;font-size:12.5px;">No comments yet. Start the conversation!</p>`;
      return;
    }
    listEl.innerHTML = comments
      .map(
        (c) => `
        <div class="comment-card">
          <div class="avatar" style="width:26px;height:26px;font-size:10px;">${initials(c.full_name)}</div>
          <div class="comment-content">
            <div class="comment-head">
              <span class="comment-author">${escapeHtml(c.full_name)}</span>
              <span class="comment-time">${fmtTimeAgo(c.created_at)}</span>
            </div>
            <div style="line-height:1.4;">${highlightMentions(escapeHtml(c.content))}</div>
          </div>
        </div>`
      )
      .join("");
  } catch (err) {
    listEl.innerHTML = `<p class="empty-note" style="color:var(--overdue);">Could not load comments.</p>`;
  }
}

function highlightMentions(text) {
  return text.replace(/@([a-zA-Z0-9_-]+)/g, '<strong style="color:var(--accent);">@$1</strong>');
}

function fmtTimeAgo(isoString) {
  if (!isoString) return "";
  const sec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function closeActivityDetailModal() {
  $("#activity-detail-modal-backdrop").hidden = true;
  currentDetailTask = null;
}

/* ============================================================
   MEMBER SPOTLIGHT MODAL (SECTION 15)
   ============================================================ */

function openMemberDetailModal(member) {
  const modal = $("#member-detail-modal-backdrop");
  const body = $("#member-detail-body");

  const memberTasks = state.tasks.filter((t) => t.assigneeId === member.id);
  const total = memberTasks.length;
  const complete = memberTasks.filter((t) => t.effectiveStatus === "complete").length;
  const inProgress = memberTasks.filter((t) => t.effectiveStatus === "in_progress").length;
  const todo = memberTasks.filter((t) => t.effectiveStatus === "todo").length;
  const overdue = memberTasks.filter((t) => t.effectiveStatus === "overdue").length;
  const pct = total === 0 ? 0 : Math.round((complete / total) * 100);

  body.innerHTML = `
    <div class="member-spotlight-card" style="margin-bottom:16px;">
      <div class="member-spotlight-info">
        ${member.avatar_url ? `<div class="avatar-lg" style="overflow:hidden;padding:0;"><img src="${escapeHtml(member.avatar_url)}" alt="${escapeHtml(member.full_name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" /></div>` : `<div class="avatar-lg">${initials(member.full_name)}</div>`}
        <div class="member-spotlight-details">
          <h3>
            ${escapeHtml(member.full_name)}
            <span class="badge badge-todo" style="text-transform:capitalize;font-size:11px;">${member.role}</span>
          </h3>
          <p>${member.designation ? escapeHtml(member.designation) + " · " : ""}${escapeHtml(member.email)}</p>
        </div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:24px;font-weight:700;color:var(--accent);font-family:var(--font-display);">${pct}%</div>
        <div style="font-size:12px;color:var(--muted);font-weight:600;">Completion Rate</div>
      </div>
    </div>

    <div class="stat-grid" style="margin-bottom:16px;">
      <div class="stat-card"><div class="num">${total}</div><div class="label">Total Activities</div></div>
      <div class="stat-card accent-complete"><div class="num">${complete}</div><div class="label">Completed</div></div>
      <div class="stat-card accent-progress"><div class="num">${inProgress}</div><div class="label">In Progress</div></div>
      <div class="stat-card accent-todo"><div class="num">${todo}</div><div class="label">To Do</div></div>
      <div class="stat-card accent-overdue"><div class="num">${overdue}</div><div class="label">Due Work</div></div>
    </div>

    <div class="panel" style="margin-bottom:0;">
      <div class="panel-head">
        <h2>Assigned Activities (${total})</h2>
      </div>
      <div class="mini-list" id="member-modal-task-list"></div>
    </div>
  `;

  const taskList = $("#member-modal-task-list", body);
  if (memberTasks.length === 0) {
    taskList.innerHTML = `<p class="empty-note">No activities assigned to this member.</p>`;
  } else {
    memberTasks.forEach((t) => {
      const stripe = t.effectiveStatus === "overdue" ? "stripe-overdue" : t.isDueSoon ? "stripe-soon" : "";
      taskList.appendChild(miniItem(t, stripe));
    });
  }

  modal.hidden = false;
}

function closeMemberDetailModal() {
  $("#member-detail-modal-backdrop").hidden = true;
}

/* ============================================================
   DELETE CONFIRMATION MODAL (SECTION 27)
   ============================================================ */

let confirmCallback = null;

function showConfirmModal({ title = "Confirm Action", message = "Are you sure you want to proceed?", okText = "Delete", onConfirm = () => {} }) {
  $("#confirm-modal-title").textContent = title;
  $("#confirm-modal-message").textContent = message;
  $("#confirm-modal-ok").textContent = okText;
  confirmCallback = onConfirm;
  $("#confirm-modal-backdrop").hidden = false;
}

function closeConfirmModal() {
  $("#confirm-modal-backdrop").hidden = true;
  confirmCallback = null;
}

/* ============================================================
   NOTIFICATIONS SYSTEM (SECTION 21)
   ============================================================ */

async function loadNotifications() {
  if (!state.user) return;
  try {
    const list = await api("/notifications");
    state.notifications = list;
    const unread = list.filter((n) => !n.is_read).length;
    const badge = $("#notif-badge");
    if (badge) {
      badge.textContent = unread;
      badge.hidden = unread === 0;
    }
    renderNotificationsList();
  } catch (err) {}
}

function renderNotificationsList() {
  const container = $("#notif-list");
  if (!container) return;
  if (!state.notifications || state.notifications.length === 0) {
    container.innerHTML = `<p class="empty-note" style="padding:20px;text-align:center;">No notifications yet.</p>`;
    return;
  }
  container.innerHTML = state.notifications
    .map(
      (n) => `
      <div class="notif-item ${!n.is_read ? "is-unread" : ""}" data-id="${n.id}">
        <div class="notif-item-title">${escapeHtml(n.title)}</div>
        <div class="notif-item-msg">${escapeHtml(n.message)}</div>
        <div class="notif-item-time">${fmtTimeAgo(n.created_at)}</div>
      </div>`
    )
    .join("");

  $$(".notif-item", container).forEach((item) => {
    item.addEventListener("click", async () => {
      const id = item.dataset.id;
      item.classList.remove("is-unread");
      await api(`/notifications/${id}/read`, { method: "PUT" }).catch(() => {});
      loadNotifications();
    });
  });
}

async function markAllNotificationsRead() {
  await api("/notifications/mark-all-read", { method: "POST" }).catch(() => {});
  await loadNotifications();
}

/* ============================================================
   MEMBERS VIEW
   ============================================================ */

function renderMembers() {
  const root = document.createElement("div");

  if (!state.dashboard && (!state.members || state.members.length === 0)) {
    root.appendChild(renderMembersSkeleton());
    return root;
  }

  const grid = document.createElement("div");
  grid.className = "team-grid";

  if (!state.members || state.members.length === 0) {
    grid.innerHTML = `<p class="empty-note">No members yet.</p>`;
  }

  state.members.forEach((m) => {
    const mine = state.tasks.filter((t) => t.assigneeId === m.id);
    const complete = mine.filter((t) => t.effectiveStatus === "complete").length;
    const pct = mine.length ? Math.round((complete / mine.length) * 100) : 0;

    const card = document.createElement("div");
    card.className = "team-card";
    card.style.cursor = "pointer";
    card.innerHTML = `
      <div class="team-card-head">
        <h3 style="display:flex;align-items:center;gap:10px;">
          ${m.avatar_url ? `<span class="avatar" style="width:32px;height:32px;overflow:hidden;padding:0;"><img src="${escapeHtml(m.avatar_url)}" alt="${escapeHtml(m.full_name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" /></span>` : `<span class="avatar" style="width:32px;height:32px;font-size:12px;">${initials(m.full_name)}</span>`}
          ${escapeHtml(m.full_name)}
        </h3>
        <span class="badge badge-todo" style="text-transform:capitalize;font-size:11px;">${m.role}</span>
      </div>
      <div class="team-sub">${m.designation ? escapeHtml(m.designation) + " · " : ""}${mine.length} activit${mine.length === 1 ? "y" : "ies"} · ${pct}% done</div>
      <div class="progress-track" style="margin-bottom:14px;"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="member-list" id="mine-${m.id}"></div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".member-row")) return;
      openMemberDetailModal(m);
    });

    const list = $(`#mine-${m.id}`, card);
    if (mine.length === 0) {
      list.innerHTML = `<p class="empty-note" style="margin:0;">No activities assigned.</p>`;
    } else {
      mine.slice(0, 4).forEach((t) => {
        const row = document.createElement("div");
        row.className = "member-row";
        row.style.cursor = "pointer";
        row.innerHTML = `<span class="m-name">${escapeHtml(t.title)}</span><span class="badge badge-${t.effectiveStatus}">${STATUS_LABEL[t.effectiveStatus]}</span>`;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          openActivityDetailModal(t);
        });
        list.appendChild(row);
      });
    }
    grid.appendChild(card);
  });

  const unassigned = (state.tasks || []).filter((t) => !t.assigneeId);
  if (unassigned.length > 0) {
    const completeCount = unassigned.filter((t) => t.effectiveStatus === "complete").length;
    const pct = unassigned.length ? Math.round((completeCount / unassigned.length) * 100) : 0;

    const uCard = document.createElement("div");
    uCard.className = "team-card";
    uCard.style.borderStyle = "dashed";
    uCard.innerHTML = `
      <div class="team-card-head">
        <h3 style="display:flex;align-items:center;gap:10px;">
          <span class="avatar" style="width:32px;height:32px;font-size:12px;background:#F1F5F9;color:var(--text);font-weight:700;">-</span>
          Unassigned Activities
        </h3>
        <span class="badge badge-todo" style="font-size:11px;">Unassigned</span>
      </div>
      <div class="team-sub">${unassigned.length} activit${unassigned.length === 1 ? "y" : "ies"} · ${pct}% done</div>
      <div class="progress-track" style="margin-bottom:14px;"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="member-list" id="unassigned-task-list"></div>
    `;

    const uList = $("#unassigned-task-list", uCard);
    unassigned.slice(0, 4).forEach((t) => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.style.cursor = "pointer";
      row.innerHTML = `<span class="m-name">${escapeHtml(t.title)}</span><span class="badge badge-${t.effectiveStatus}">${STATUS_LABEL[t.effectiveStatus]}</span>`;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        openActivityDetailModal(t);
      });
      uList.appendChild(row);
    });
    grid.appendChild(uCard);
  }

  root.appendChild(grid);
  return root;
}

/* ============================================================
   TEAM SETTINGS VIEW
   ============================================================ */

function renderSettings() {
  const root = document.createElement("div");
  const knownTeam = state.teams.find((x) => x.id === state.currentTeamId);
  const t = state.currentTeam || knownTeam || { name: "Team Workspace", icon: "", description: "", purpose: "" };
  state.currentTeam = t;
  const isAdmin = ["owner", "admin"].includes(state.currentTeamRole || t.role || "member");
  const members = state.members || [];
  const pendingInvites = state.pendingInvites || [];

  const infoPanel = document.createElement("div");
  infoPanel.className = "panel settings-section";
  infoPanel.innerHTML = `
    <div class="panel-head"><h2>Team details</h2></div>
    <form id="settings-team-form" class="form" style="max-width:480px;">
      <div class="field-row">
        <label class="field"><span>Icon / badge</span><input type="text" id="settings-icon" maxlength="4" value="${escapeHtml(t.icon || "")}" placeholder="TEAM" style="width:80px;" ${isAdmin ? "" : "disabled"} /></label>
        <label class="field"><span>Team name</span><input type="text" id="settings-name" value="${escapeHtml(t.name || "")}" required ${isAdmin ? "" : "disabled"} /></label>
      </div>
      <label class="field"><span>Description</span><textarea id="settings-description" rows="2" ${isAdmin ? "" : "disabled"}>${escapeHtml(t.description || "")}</textarea></label>
      <label class="field"><span>Purpose / project</span><input type="text" id="settings-purpose" value="${escapeHtml(t.purpose || "")}" ${isAdmin ? "" : "disabled"} /></label>
      ${isAdmin ? `<div class="form-actions"><div class="spacer"></div><button type="submit" class="btn btn-primary">Save changes</button></div>` : `<p class="empty-note">Only team owners and admins can edit these details.</p>`}
    </form>
  `;
  root.appendChild(infoPanel);
  if (isAdmin) {
    $("#settings-team-form", infoPanel).addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api(`/teams/${state.currentTeamId}`, {
          method: "PUT",
          body: JSON.stringify({
            name: $("#settings-name", infoPanel).value,
            description: $("#settings-description", infoPanel).value,
            icon: $("#settings-icon", infoPanel).value,
            purpose: $("#settings-purpose", infoPanel).value,
          }),
        });
        toast("Team updated");
        removeTeamBundleFromCache(state.currentTeamId);
        await refreshTeamData();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  const membersPanel = document.createElement("div");
  membersPanel.className = "panel settings-section";
  membersPanel.innerHTML = `
    <div class="panel-head">
      <h2>Members</h2>
      ${isAdmin ? `<button class="btn btn-primary btn-sm" id="settings-add-member-btn">+ Add member</button>` : ""}
    </div>
    <div class="member-list" id="settings-member-list"></div>
  `;
  root.appendChild(membersPanel);
  if (isAdmin) $("#settings-add-member-btn", membersPanel).addEventListener("click", openMemberModal);

  const mList = $("#settings-member-list", membersPanel);
  if (members.length === 0) {
    mList.innerHTML = `<p class="empty-note" style="padding:10px 0;">Loading members...</p>`;
  } else {
    members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "member-row";
      const isOwner = m.role === "owner";
      const canManage = isAdmin && m.id !== state.user?.id;
      row.innerHTML = `
        <div class="member-info-col" style="display:flex;align-items:center;gap:10px;flex:1;min-width:120px;overflow:hidden;">
          <span class="avatar">${initials(m.full_name)}</span>
          <span class="m-name">${escapeHtml(m.full_name)} <span class="muted" style="font-weight:500;">${m.id === state.user?.id ? "(you)" : ""}</span></span>
        </div>
        <div class="member-actions-col" style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          ${
            canManage && !isOwner
              ? `<select class="role-select" data-user-id="${m.id}" aria-label="Member role">
                   <option value="member" ${m.role === "member" ? "selected" : ""}>Member</option>
                   <option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option>
                 </select>`
              : `<span class="m-count" style="text-transform:capitalize;">${m.role}</span>`
          }
          ${canManage && !isOwner ? `<button data-remove-user="${m.id}" title="Remove member" class="icon-btn" style="color:var(--overdue);padding:4px 6px;">✕</button>` : ""}
        </div>
      `;
      mList.appendChild(row);
    });
  }

  mList.addEventListener("change", async (e) => {
    const sel = e.target.closest(".role-select");
    if (!sel) return;
    try {
      await api(`/teams/${state.currentTeamId}/members/${sel.dataset.userId}`, { method: "PUT", body: JSON.stringify({ role: sel.value }) });
      toast("Role updated");
      removeTeamBundleFromCache(state.currentTeamId);
      await refreshTeamData();
    } catch (err) {
      toast(err.message);
    }
  });
  mList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-remove-user]");
    if (!btn) return;
    if (!confirm("Remove this person from the team?")) return;
    try {
      await api(`/teams/${state.currentTeamId}/members/${btn.dataset.removeUser}`, { method: "DELETE" });
      toast("Member removed");
      removeTeamBundleFromCache(state.currentTeamId);
      await refreshTeamData();
    } catch (err) {
      toast(err.message);
    }
  });

  if (isAdmin && pendingInvites.length > 0) {
    const invPanel = document.createElement("div");
    invPanel.className = "panel settings-section";
    invPanel.innerHTML = `<div class="panel-head"><h2>Pending invites (${pendingInvites.length})</h2></div><div id="invite-list" style="display:flex;flex-direction:column;gap:8px;"></div>`;
    root.appendChild(invPanel);
    const invList = $("#invite-list", invPanel);
    pendingInvites.forEach((inv) => {
      const row = document.createElement("div");
      row.className = "invite-row";

      const inviteUrl = inv.token ? `${window.location.origin}/?invite=${inv.token}` : "";

      row.innerHTML = `
        <div class="invite-info-col" style="display:flex;align-items:center;gap:8px;flex:1;min-width:140px;">
          <span class="inv-email" style="font-weight:600;font-size:13.5px;">${escapeHtml(inv.email)}</span>
          <span class="badge badge-normal" style="font-size:11px;text-transform:capitalize;">${escapeHtml(inv.role || "member")}</span>
        </div>
        <div class="invite-actions-col" style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          ${inviteUrl ? `<button class="btn btn-xs btn-ghost btn-copy-invite" data-invite-link="${escapeHtml(inviteUrl)}" title="Copy Invite Link" style="border:1px solid var(--border);font-size:12px;">📋 Copy Link</button>` : ""}
          <button class="btn btn-xs btn-ghost btn-resend-invite" data-invite-id="${inv.id}" title="Resend Invite Email" style="border:1px solid var(--border);font-size:12px;">✉ Resend</button>
          <button data-cancel-invite="${inv.id}" class="icon-btn" title="Cancel invite" style="font-size:12px;color:var(--danger,#ef4444);margin-left:4px;">✕</button>
        </div>
      `;
      invList.appendChild(row);
    });

    invList.addEventListener("click", async (e) => {
      const copyBtn = e.target.closest(".btn-copy-invite");
      if (copyBtn) {
        const link = copyBtn.dataset.inviteLink;
        if (link) {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(link).then(() => {
              toast("Invite link copied to clipboard!");
            }).catch(() => {
              prompt("Copy this invite link:", link);
            });
          } else {
            prompt("Copy this invite link:", link);
          }
        }
        return;
      }

      const resendBtn = e.target.closest(".btn-resend-invite");
      if (resendBtn) {
        resendBtn.disabled = true;
        try {
          const res = await api(`/teams/${state.currentTeamId}/invites/${resendBtn.dataset.inviteId}/resend`, { method: "POST" });
          toast(res.message || "Invitation resent!");
        } catch (err) {
          toast(err.message || "Failed to resend invite");
        } finally {
          resendBtn.disabled = false;
        }
        return;
      }

      const cancelBtn = e.target.closest("[data-cancel-invite]");
      if (cancelBtn) {
        if (!confirm("Cancel this invitation?")) return;
        try {
          await api(`/teams/${state.currentTeamId}/invites/${cancelBtn.dataset.cancelInvite}`, { method: "DELETE" });
          toast("Invite cancelled");
          removeTeamBundleFromCache(state.currentTeamId);
          await refreshTeamData();
        } catch (err) {
          toast(err.message);
        }
      }
    });
  }

  if (state.currentTeamRole === "owner") {
    const danger = document.createElement("div");
    danger.className = "danger-zone settings-section";
    danger.innerHTML = `
      <h3>Delete this team</h3>
      <p class="muted" style="margin-bottom:12px;">This permanently deletes all of this team's activities and removes every member. This can't be undone.</p>
      <button class="btn btn-ghost btn-danger" id="delete-team-btn">Delete team</button>
    `;
    root.appendChild(danger);
    $("#delete-team-btn", danger).addEventListener("click", async () => {
      if (!confirm(`Delete "${t.name}"? This can't be undone.`)) return;
      try {
        const deletedTeamId = state.currentTeamId;
        await api(`/teams/${deletedTeamId}`, { method: "DELETE" });
        toast("Team deleted");
        forgetTeamData(deletedTeamId);
        state.teams = state.teams.filter((x) => x.id !== deletedTeamId);
        localStorage.removeItem("basecamp:lastTeam");
        state.currentTeamId = state.teams[0]?.id || null;
        const [teams, assigned] = await Promise.all([
          api("/users/me/teams").catch(() => state.teams),
          api("/users/me/assigned-tasks").catch(() => []),
        ]);
        state.teams = teams;
        state.assignedTasks = assigned;
        pruneTeamBundleCache(state.teams.map((team) => team.id));
        syncAndPersistWorkspaceState();
        renderTeamSwitcherButton();
        renderTeamSwitcherList();
        await setView("main");
      } catch (err) {
        toast(err.message);
      }
    });
  }

  return root;
}

/* ============================================================
   TASK MODAL
   ============================================================ */

function openTaskModal(task = null) {
  if (task && task.id && !canEditTask(task)) {
    toast("Only the assigned member can edit this activity");
    return;
  }
  if (!task) {
    const isManager = state.currentTeamRole === "owner" || state.currentTeamRole === "admin";
    if (!isManager) {
      toast("Only team admins and owners have permission to add activities.");
      return;
    }
  }
  const now = new Date();
  const defaultEndTime = toInputDateTime(now, "18:00");

  const assigneeSel = $("#task-assignee");
  if (assigneeSel) {
    assigneeSel.innerHTML = `<option value="">Unassigned</option>` + (state.members || []).map((m) => `<option value="${m.id}">${escapeHtml(m.full_name)}</option>`).join("");
    assigneeSel.value = task ? task.assigneeId || "" : "";
  }

  if ($("#task-modal-title")) $("#task-modal-title").textContent = task ? "Activity details" : "Add activity";
  if ($("#task-id")) $("#task-id").value = task ? task.id : "";
  if ($("#task-title")) $("#task-title").value = task ? task.title : "";
  if ($("#task-description")) $("#task-description").value = task ? task.description || "" : "";

  const startEl = $("#task-start");
  if (startEl) {
    startEl.value = task ? toInputDateTime(task.startDate) : "";
  }

  const deadlineEl = $("#task-deadline");
  if (deadlineEl) {
    deadlineEl.value = task ? toInputDateTime(task.deadline) : defaultEndTime;
  }

  if ($("#task-priority")) $("#task-priority").value = task ? (task.priority || "normal") : "normal";
  if ($("#task-status")) $("#task-status").value = task ? task.status : "todo";
  if ($("#status-field")) $("#status-field").hidden = !task;
  const isManager = state.currentTeamRole === "owner" || state.currentTeamRole === "admin";
  if ($("#task-delete-btn")) $("#task-delete-btn").hidden = !task || !isManager;
  if ($("#task-save-btn")) $("#task-save-btn").textContent = task ? "Save changes" : "Save activity";
  if ($("#task-modal-backdrop")) $("#task-modal-backdrop").hidden = false;
  if ($("#task-title")) $("#task-title").focus();
}
function closeTaskModal() { $("#task-modal-backdrop").hidden = true; }

async function handleTaskSubmit(e) {
  e.preventDefault();
  const id = $("#task-id").value;

  if (!id) {
    const isManager = state.currentTeamRole === "owner" || state.currentTeamRole === "admin";
    if (!isManager) {
      toast("Only team admins and owners have permission to add activities.");
      return;
    }
  }

  const rawStart = $("#task-start").value;
  const rawDeadline = $("#task-deadline").value;

  if (!rawDeadline) {
    toast("Please select a due date and time.");
    return;
  }

  const payload = {
    title: $("#task-title").value.trim(),
    description: $("#task-description").value.trim(),
    assigneeId: $("#task-assignee").value || null,
    startDate: rawStart ? new Date(rawStart).toISOString() : null,
    deadline: new Date(rawDeadline).toISOString(),
    priority: $("#task-priority") ? $("#task-priority").value : "normal",
  };
  if (id) payload.status = $("#task-status").value;

  const now = new Date();
  if (!id && new Date(payload.deadline).getTime() < now.getTime() - 60000) {
    toast("Due date and time cannot be in the past.");
    return;
  }
  if (!id && payload.startDate && new Date(payload.startDate).getTime() < now.getTime() - 60000) {
    toast("Start date and time cannot be in the past.");
    return;
  }

  const saveBtn = $("#task-save-btn");
  saveBtn.disabled = true;

  try {
    if (id) {
      const target = state.tasks.find((t) => t.id === id);
      const snapshot = target ? { ...target } : null;
      const assigneeObj = state.members.find((m) => m.id === payload.assigneeId);
      if (target) {
        target.title = payload.title;
        target.description = payload.description;
        target.assigneeId = payload.assigneeId;
        target.assigneeName = assigneeObj ? assigneeObj.full_name : "Unassigned";
        target.startDate = payload.startDate;
        target.deadline = payload.deadline;
        target.priority = payload.priority;
        target.status = payload.status;
        target.effectiveStatus = computeClientEffectiveStatus(payload.status, payload.deadline);
        syncAndPersistWorkspaceState();
        renderCurrentView();
      }
      closeTaskModal();
      try {
        const updated = await api(`/teams/${state.currentTeamId}/tasks/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        if (target) Object.assign(target, updated);
        syncAndPersistWorkspaceState();
        renderCurrentView();
        toast("Activity updated");
      } catch (saveErr) {
        // Roll back the optimistic edit so the UI reflects what's actually
        // on the server instead of permanently showing rejected state.
        if (target && snapshot) {
          Object.assign(target, snapshot);
          syncAndPersistWorkspaceState();
          renderCurrentView();
        }
        toast(saveErr.message || "Failed to update activity");
      }
    } else {
      const created = await api(`/teams/${state.currentTeamId}/tasks`, { method: "POST", body: JSON.stringify(payload) });
      state.tasks.unshift(created);
      syncAndPersistWorkspaceState();
      renderCurrentView();
      closeTaskModal();
      toast("Activity added");
    }
  } catch (err) {
    toast(err.message);
  } finally {
    saveBtn.disabled = false;
  }
}

async function handleTaskDelete() {
  const isManager = state.currentTeamRole === "owner" || state.currentTeamRole === "admin";
  if (!isManager) {
    toast("Only team admins and owners have permission to delete activities.");
    return;
  }
  const id = $("#task-id").value;
  if (!id) return;
  const task = state.tasks.find((t) => t.id === id);
  const taskTitle = task ? `"${task.title}"` : "this activity";

  showConfirmModal({
    title: "Delete Activity",
    message: `Are you sure you want to permanently delete ${escapeHtml(taskTitle)}? This cannot be undone.`,
    okText: "Delete Activity",
    onConfirm: async () => {
      // Optimistic delete
      const index = state.tasks.findIndex((t) => t.id === id);
      let removed = null;
      if (index !== -1) {
        removed = state.tasks.splice(index, 1)[0];
        syncAndPersistWorkspaceState();
        renderCurrentView();
      }
      closeTaskModal();
      closeActivityDetailModal();
      toast("Activity deleted");

      try {
        await api(`/teams/${state.currentTeamId}/tasks/${id}`, { method: "DELETE" });
      } catch (err) {
        if (removed) {
          state.tasks.splice(index, 0, removed);
          syncAndPersistWorkspaceState();
          renderCurrentView();
        }
        toast(err.message || "Failed to delete activity");
      }
    },
  });
}

/* ============================================================
   CREATE TEAM MODAL
   ============================================================ */

function openTeamModal() {
  $("#team-icon").value = "";
  $("#team-name").value = "";
  $("#team-description").value = "";
  $("#team-purpose").value = "";
  $("#team-members").value = "";
  $("#team-modal-backdrop").hidden = false;
  $("#team-name").focus();
}
function closeTeamModal() { $("#team-modal-backdrop").hidden = true; }

async function handleTeamSubmit(e) {
  e.preventDefault();
  // Guard against double-submission (e.g. an impatient double-click, or a
  // slow connection where the button is clicked again before the first
  // request resolves) — without this, two teams could be created from one
  // "Create team" click.
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn?.disabled) return;
  if (submitBtn) submitBtn.disabled = true;
  try {
    const memberEmails = $("#team-members").value.split(",").map((s) => s.trim()).filter(Boolean);
    const team = await api("/teams", {
      method: "POST",
      body: JSON.stringify({
        name: $("#team-name").value.trim(),
        description: $("#team-description").value.trim(),
        icon: $("#team-icon").value.trim() || "",
        purpose: $("#team-purpose").value.trim(),
        memberEmails,
      }),
    });
    toast("Team created");
    closeTeamModal();
    const [teams, assigned] = await Promise.all([
      api("/users/me/teams"),
      api("/users/me/assigned-tasks").catch(() => []),
    ]);
    state.teams = teams;
    state.assignedTasks = assigned;
    pruneTeamBundleCache(state.teams.map((t) => t.id));
    persistTeamsCache();
    persistAssignedTasksCache();
    await openTeamPage(team.id);
  } catch (err) {
    toast(err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

/* ============================================================
   ADD MEMBER MODAL
   ============================================================ */

function openMemberModal() {
  $("#member-identifier").value = "";
  $("#member-role").value = "member";
  $("#member-modal-backdrop").hidden = false;
  $("#member-identifier").focus();
}
function closeMemberModal() { $("#member-modal-backdrop").hidden = true; }

function openInviteSuccessModal(message, inviteLink) {
  if ($("#invite-success-msg")) $("#invite-success-msg").textContent = message || "An invitation has been generated.";
  if ($("#invite-success-link-input")) $("#invite-success-link-input").value = inviteLink || window.location.origin;
  $("#invite-success-modal-backdrop").hidden = false;
  setTimeout(() => {
    $("#invite-success-link-input")?.select();
  }, 100);
}
function closeInviteSuccessModal() {
  $("#invite-success-modal-backdrop").hidden = true;
}

async function handleMemberSubmit(e) {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn?.disabled) return;
  if (submitBtn) submitBtn.disabled = true;
  try {
    const result = await api(`/teams/${state.currentTeamId}/members`, {
      method: "POST",
      body: JSON.stringify({ identifier: $("#member-identifier").value.trim(), role: $("#member-role").value }),
    });
    closeMemberModal();
    removeTeamBundleFromCache(state.currentTeamId);
    await refreshTeamData();

    if (result.added) {
      toast("Member added to team!");
    } else if (result.invited || result.inviteLink) {
      openInviteSuccessModal(result.message, result.inviteLink);
    } else {
      toast("Invitation sent!");
    }
  } catch (err) {
    toast(err.message);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

/* ============================================================
   PROFILE / PASSWORD / NOTIFICATIONS MODALS
   ============================================================ */

function updateAvatarPreview(url, name) {
  const preview = $("#profile-avatar-preview");
  if (!preview) return;
  if (url) {
    preview.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
  } else {
    preview.textContent = initials(name || "User");
  }
}

function handleAvatarFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    toast("Please select a valid image file (PNG, JPG, WebP).");
    return;
  }

  const reader = new FileReader();
  reader.onload = function (evt) {
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement("canvas");
      const maxDim = 256;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        }
      } else {
        if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      $("#profile-avatar-url").value = dataUrl;
      updateAvatarPreview(dataUrl, $("#profile-name").value);
      toast("Image ready to save!");
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
}

function openProfileModal() {
  const u = state.user;
  $("#profile-name").value = u.full_name;
  $("#profile-username").value = u.username;
  $("#profile-email").value = u.email;
  $("#profile-mobile").value = u.mobile || "";
  $("#profile-designation").value = u.designation || "";
  $("#profile-bio").value = u.bio || "";
  $("#profile-avatar-url").value = u.avatar_url || "";
  updateAvatarPreview(u.avatar_url, u.full_name);
  $("#profile-modal-backdrop").hidden = false;
  $("#profile-menu").hidden = true;
}
function closeProfileModal() { $("#profile-modal-backdrop").hidden = true; }

async function handleProfileSubmit(e) {
  e.preventDefault();
  const username = $("#profile-username").value.trim();
  if (!username) {
    toast("Username is required.");
    return;
  }
  if (username.length < 3) {
    toast("Username must be at least 3 characters long.");
    return;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    toast("Username can only contain letters, numbers, dots, underscores, and dashes.");
    return;
  }

  try {
    const { user } = await api("/users/me", {
      method: "PUT",
      body: JSON.stringify({
        fullName: $("#profile-name").value.trim(),
        username,
        mobile: $("#profile-mobile").value.trim(),
        designation: $("#profile-designation").value.trim(),
        bio: $("#profile-bio").value.trim(),
        avatarUrl: $("#profile-avatar-url").value.trim(),
      }),
    });
    state.user = user;
    updateProfileUI();
    toast("Profile updated");
    closeProfileModal();
    await refreshTeamData();
  } catch (err) {
    toast(err.message);
  }
}

function openPasswordModal() {
  $("#current-password").value = "";
  $("#new-password").value = "";
  $("#password-modal-backdrop").hidden = false;
  $("#profile-menu").hidden = true;
}
function closePasswordModal() { $("#password-modal-backdrop").hidden = true; }

async function handlePasswordSubmit(e) {
  e.preventDefault();
  try {
    await api("/users/me/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword: $("#current-password").value, newPassword: $("#new-password").value }),
    });
    toast("Password updated");
    closePasswordModal();
  } catch (err) {
    toast(err.message);
  }
}

function openNotifModal() {
  if (!state.user) return;
  $("#notif-email").checked = state.user.notif_email !== false;
  $("#notif-assignment").checked = state.user.notif_assignment !== false;
  $("#notif-due-reminders").checked = state.user.notif_due_reminders !== false;
  $("#notif-overdue").checked = state.user.notif_overdue !== false;
  $("#notif-team-invites").checked = state.user.notif_team_invites !== false;
  $("#notif-modal-backdrop").hidden = false;
  $("#profile-menu").hidden = true;
}
function closeNotifModal() { $("#notif-modal-backdrop").hidden = true; }

async function handleNotifSave() {
  try {
    const result = await api("/users/me/notifications", {
      method: "PUT",
      body: JSON.stringify({
        notifEmail: $("#notif-email").checked,
        notifAssignment: $("#notif-assignment").checked,
        notifDueReminders: $("#notif-due-reminders").checked,
        notifOverdue: $("#notif-overdue").checked,
        notifTeamInvites: $("#notif-team-invites").checked,
      }),
    });
    state.user.notif_email = result.notif_email;
    state.user.notif_assignment = result.notif_assignment;
    state.user.notif_due_reminders = result.notif_due_reminders;
    state.user.notif_overdue = result.notif_overdue;
    state.user.notif_team_invites = result.notif_team_invites;
    toast("Notification preferences saved");
    closeNotifModal();
  } catch (err) {
    toast(err.message);
  }
}

async function handleLogout() {
  try {
    localStorage.removeItem("proma:user");
    localStorage.removeItem("proma:teams");
    localStorage.removeItem("proma:assignedTasks");
    clearTeamBundleCache();
  } catch (e) {}
  try {
    await api("/auth/logout", { method: "POST" });
  } catch (e) {}
  window.location.href = "/";
}

/* ============================================================
   MONTHLY REPORT GENERATOR
   ============================================================ */

let currentReportData = null;

async function openMonthlyReportModal(teamId = null, selectedMonth = null) {
  const targetTeamId = teamId || state.currentTeamId;
  if (!targetTeamId) {
    toast("Please select a team workspace first.");
    return;
  }

  const team = state.teams.find((t) => t.id === targetTeamId) || state.currentTeam;
  const teamName = team ? team.name : "Team Workspace";
  $("#report-team-subtitle").textContent = `${team?.icon ? team.icon + " " : ""}${teamName} · Executive Summary`;

  // Populate month select dropdown (past 12 months)
  const monthSelect = $("#report-month-select");
  monthSelect.innerHTML = "";
  const now = new Date();
  const currentMonthISO = selectedMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label + (i === 0 ? " (Current)" : "");
    if (val === currentMonthISO) opt.selected = true;
    monthSelect.appendChild(opt);
  }

  // Open modal
  $("#report-modal-backdrop").hidden = false;

  // Load report data
  await loadAndRenderReport(targetTeamId, currentMonthISO);

  // On month dropdown change
  monthSelect.onchange = async () => {
    await loadAndRenderReport(targetTeamId, monthSelect.value);
  };
}

async function loadAndRenderReport(teamId, month) {
  const area = $("#report-printable-area");
  area.innerHTML = `
    <div style="text-align:center; padding: 60px 20px;">
      <div style="font-size:32px; margin-bottom:12px;">⏳</div>
      <p style="font-size:15px; font-weight:600; color:var(--muted);">Generating professional monthly report...</p>
    </div>
  `;

  try {
    const data = await api(`/teams/${teamId}/reports/monthly?month=${month}`);
    currentReportData = data;
    renderReportContent(data);
  } catch (err) {
    console.error("Report generation error:", err);
    area.innerHTML = `
      <div style="text-align:center; padding: 40px 20px;">
        <div style="margin-bottom:12px;"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--overdue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg></div>
        <h3 style="font-size:18px; margin-bottom:8px;">Failed to generate report</h3>
        <p class="muted" style="margin-bottom:16px;">${escapeHtml(err.message || "Could not retrieve report data.")}</p>
        <button class="btn btn-primary btn-sm" id="retry-report-load-btn">↻ Retry</button>
      </div>
    `;
    $("#retry-report-load-btn")?.addEventListener("click", () => loadAndRenderReport(teamId, month));
  }
}

function renderReportContent(data) {
  const area = $("#report-printable-area");
  const { team, periodLabel, generatedAt, generatedBy, kpis, memberBreakdown, unassignedTasks } = data;

  const healthStatus =
    kpis.completionPct >= 75
      ? { text: "High Performance / On Track", color: "#16924A", bg: "#E8F8EE" }
      : kpis.completionPct >= 50
      ? { text: "Moderate Velocity / Progressing", color: "#B4780F", bg: "#FEF4E6" }
      : { text: "Action Needed / Behind Schedule", color: "#EF4444", bg: "#FEECEB" };

  let membersHtml = "";
  if (memberBreakdown.length === 0) {
    membersHtml = `<p class="empty-note">No members found in this team workspace.</p>`;
  } else {
    membersHtml = memberBreakdown
      .map((mb) => {
        const m = mb.member;
        const taskRows =
          mb.tasks.length === 0
            ? `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px;">No activities assigned for this period.</td></tr>`
            : mb.tasks
                .map(
                  (t) => `
                <tr>
                  <td style="font-weight:600;">
                    ${escapeHtml(t.title)}
                    ${t.description ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">${escapeHtml(t.description)}</div>` : ""}
                  </td>
                  <td>
                    <span class="badge badge-${t.effectiveStatus}">${STATUS_LABEL[t.effectiveStatus] || t.effectiveStatus}</span>
                  </td>
                  <td style="font-family:var(--font-mono);font-size:12px;">
                    ${t.startDate ? fmtDate(t.startDate) : "—"} → ${t.deadline ? fmtDate(t.deadline) : "—"}
                  </td>
                  <td style="font-size:12px;color:var(--muted);">
                    ${t.effectiveStatus === "complete" ? "Completed" : t.effectiveStatus === "overdue" ? "Due Work" : "Active"}
                  </td>
                </tr>
              `
                )
                .join("");

        return `
          <div class="report-member-card">
            <div class="report-member-header">
              <div class="report-member-info">
                <div class="avatar" style="width:34px;height:34px;font-size:12px;">${initials(m.full_name)}</div>
                <div>
                  <strong style="font-size:14px;">${escapeHtml(m.full_name)}</strong>
                  <span class="badge badge-todo" style="font-size:10px;text-transform:capitalize;margin-left:4px;">${m.role}</span>
                  <div style="font-size:11.5px;color:var(--muted);">${m.designation ? escapeHtml(m.designation) + " · " : ""}${escapeHtml(m.email)}</div>
                </div>
              </div>
              <div class="report-member-badges">
                <span style="color:#16924A;">✓ ${mb.complete} Done</span> ·
                <span style="color:#B4780F;">${mb.inProgress} Active</span> ·
                <span style="color:#EF4444;">${mb.overdue} Overdue</span> ·
                <strong>${mb.completionPct}% Rate</strong>
              </div>
            </div>
            <table class="report-table">
              <thead>
                <tr>
                  <th style="width:45%;">Activity / Task</th>
                  <th style="width:18%;">Status</th>
                  <th style="width:22%;">Timeline</th>
                  <th style="width:15%;">Notes</th>
                </tr>
              </thead>
              <tbody>
                ${taskRows}
              </tbody>
            </table>
          </div>
        `;
      })
      .join("");
  }

  let unassignedHtml = "";
  if (unassignedTasks && unassignedTasks.length > 0) {
    unassignedHtml = `
      <div class="report-section-title">Unassigned Team Activities (${unassignedTasks.length})</div>
      <div class="report-member-card">
        <table class="report-table">
          <thead>
            <tr>
              <th style="width:45%;">Activity Name</th>
              <th style="width:20%;">Status</th>
              <th style="width:20%;">Deadline</th>
              <th style="width:15%;">Assignment</th>
            </tr>
          </thead>
          <tbody>
            ${unassignedTasks
              .map(
                (t) => `
              <tr>
                <td style="font-weight:600;">${escapeHtml(t.title)}</td>
                <td><span class="badge badge-${t.effectiveStatus}">${STATUS_LABEL[t.effectiveStatus] || t.effectiveStatus}</span></td>
                <td style="font-family:var(--font-mono);font-size:12px;">${t.deadline ? fmtDate(t.deadline) : "—"}</td>
                <td style="color:var(--muted);font-size:12px;">Unassigned</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  area.innerHTML = `
    <!-- Formal Report Banner Header -->
    <div class="report-header-banner">
      <div>
        <div class="report-brand-name">ProMa<span style="color:var(--accent);">.</span></div>
        <h1 class="report-main-title">Monthly Activity &amp; Performance Report</h1>
        <p style="font-size:14px;color:var(--muted);margin:4px 0 0;">
          Team Workspace: <strong>${escapeHtml(team.name)}</strong>
        </p>
      </div>
      <div class="report-meta-table">
        <div><strong>Reporting Period:</strong> ${escapeHtml(periodLabel)}</div>
        <div><strong>Generated Date:</strong> ${new Date(generatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>
        <div><strong>Prepared By:</strong> ${escapeHtml(generatedBy || "Team Lead")}</div>
      </div>
    </div>

    <!-- Executive Summary & KPIs -->
    <div class="report-section-title">Executive Summary &amp; Key Performance Indicators</div>
    
    <div class="report-kpi-grid">
      <div class="report-kpi-box">
        <div class="num">${kpis.total}</div>
        <div class="lbl">Total Activities</div>
      </div>
      <div class="report-kpi-box" style="border-color:var(--complete-tint);">
        <div class="num" style="color:#16924A;">${kpis.complete}</div>
        <div class="lbl">Completed</div>
      </div>
      <div class="report-kpi-box" style="border-color:var(--progress-tint);">
        <div class="num" style="color:#B4780F;">${kpis.inProgress}</div>
        <div class="lbl">In Progress</div>
      </div>
      <div class="report-kpi-box" style="border-color:var(--overdue-tint);">
        <div class="num" style="color:var(--overdue);">${kpis.overdue}</div>
        <div class="lbl">Due / Overdue</div>
      </div>
      <div class="report-kpi-box">
        <div class="num" style="color:var(--accent);">${kpis.completionPct}%</div>
        <div class="lbl">Delivery Rate</div>
      </div>
    </div>

    <!-- Health Assessment Bar -->
    <div style="background:${healthStatus.bg};border:1px solid ${healthStatus.color}33;border-radius:var(--radius-sm);padding:10px 16px;display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <span style="font-weight:700;font-size:13px;color:${healthStatus.color};">Team Health Rating: ${healthStatus.text}</span>
      <span style="font-family:var(--font-mono);font-size:12.5px;font-weight:600;color:${healthStatus.color};">${kpis.complete} of ${kpis.total} activities delivered (${kpis.completionPct}%)</span>
    </div>

    <!-- Member Breakdown Section -->
    <div class="report-section-title">Member-by-Member Activity Log &amp; Contribution</div>
    ${membersHtml}

    ${unassignedHtml}

    <!-- Sign-off & Audit Trail -->
    <div class="report-signoff">
      <div class="report-signoff-box">
        <div><strong>Prepared by:</strong> ${escapeHtml(generatedBy || "Project Lead")}</div>
        <div class="report-signoff-line"></div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:4px;">Signature &amp; Date</div>
      </div>
      <div class="report-signoff-box" style="text-align:right;">
        <div><strong>Approved by:</strong> _____________________________</div>
        <div class="report-signoff-line" style="margin-left:auto;"></div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:4px;">Executive / Manager Review</div>
      </div>
    </div>
  `;
}

function exportReportCSV() {
  if (!currentReportData) {
    toast("No report data available to export.");
    return;
  }
  const { team, period, memberBreakdown, unassignedTasks } = currentReportData;
  const rows = [
    ["Member Name", "Member Role", "Member Email", "Activity Title", "Status", "Start Date", "Deadline", "Notes / Description"],
  ];

  memberBreakdown.forEach((mb) => {
    const m = mb.member;
    if (mb.tasks.length === 0) {
      rows.push([m.full_name, m.role, m.email, "No activities", "—", "—", "—", "—"]);
    } else {
      mb.tasks.forEach((t) => {
        rows.push([
          m.full_name,
          m.role,
          m.email,
          t.title,
          t.effectiveStatus,
          t.startDate || "",
          t.deadline || "",
          t.description || "",
        ]);
      });
    }
  });

  if (unassignedTasks) {
    unassignedTasks.forEach((t) => {
      rows.push(["Unassigned", "—", "—", t.title, t.effectiveStatus, t.startDate || "", t.deadline || "", t.description || ""]);
    });
  }

  const csvContent =
    "data:text/csv;charset=utf-8," +
    rows.map((row) => row.map((val) => `"${String(val).replace(/"/g, '""')}"`).join(",")).join("\n");

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  const cleanTeamName = team.name.toLowerCase().replace(/[^a-z0-9]/g, "_");
  link.setAttribute("download", `${cleanTeamName}_monthly_report_${period}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast("Report CSV downloaded");
}

/* ============================================================
   INIT
   ============================================================ */

function wireModals() {
  const mainCreateBtn = $("#main-create-team-btn");
  if (mainCreateBtn) mainCreateBtn.addEventListener("click", () => openTeamModal());
  const sidebarBrand = $("#sidebar-brand-btn");
  if (sidebarBrand) sidebarBrand.addEventListener("click", () => { setView("main"); closeMobileSidebar(); });

  // ── Mobile sidebar toggle ──
  const _sidebar = document.querySelector(".sidebar");
  const _sidebarOverlay = $("#sidebar-overlay");
  const _hamburgerBtn = $("#sidebar-toggle-btn");

  function closeMobileSidebar() {
    if (_sidebar) _sidebar.classList.remove("is-open");
    if (_sidebarOverlay) _sidebarOverlay.classList.remove("is-open");
  }

  if (_hamburgerBtn) {
    _hamburgerBtn.addEventListener("click", () => {
      _sidebar.classList.toggle("is-open");
      _sidebarOverlay.classList.toggle("is-open");
    });
  }
  if (_sidebarOverlay) {
    _sidebarOverlay.addEventListener("click", closeMobileSidebar);
  }
  // Auto-close sidebar on nav item click (mobile UX)
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", closeMobileSidebar);
  });

  const teamReportBtn = $("#team-report-btn");
  if (teamReportBtn) teamReportBtn.addEventListener("click", () => openMonthlyReportModal());

  $("#report-modal-close").addEventListener("click", () => { $("#report-modal-backdrop").hidden = true; });
  $("#report-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "report-modal-backdrop") $("#report-modal-backdrop").hidden = true; });
  $("#report-print-btn").addEventListener("click", () => window.print());
  $("#report-export-csv-btn").addEventListener("click", exportReportCSV);

  $("#quick-add-btn").addEventListener("click", () => openTaskModal());
  $("#task-modal-close").addEventListener("click", closeTaskModal);
  $("#task-cancel-btn").addEventListener("click", closeTaskModal);
  $("#task-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "task-modal-backdrop") closeTaskModal(); });
  $("#task-form").addEventListener("submit", handleTaskSubmit);
  $("#task-delete-btn").addEventListener("click", handleTaskDelete);

  // Activity Detail Modal Wiring
  $("#activity-detail-close")?.addEventListener("click", closeActivityDetailModal);
  $("#activity-detail-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "activity-detail-modal-backdrop") closeActivityDetailModal();
  });
  $("#detail-edit-btn")?.addEventListener("click", () => {
    if (currentDetailTask) {
      if (!canEditTask(currentDetailTask)) {
        toast("Only the assigned member can edit this activity");
        return;
      }
      const t = currentDetailTask;
      closeActivityDetailModal();
      openTaskModal(t);
    }
  });
  $("#detail-complete-btn")?.addEventListener("click", async () => {
    if (currentDetailTask) {
      if (!canEditTask(currentDetailTask)) {
        toast("Only the assigned member can change this activity's status");
        return;
      }
      const nextStatus = currentDetailTask.status === "complete" ? "todo" : "complete";
      await updateTaskStatusQuick(currentDetailTask, nextStatus);
      openActivityDetailModal(currentDetailTask);
    }
  });
  $("#detail-delete-btn")?.addEventListener("click", () => {
    if (currentDetailTask) {
      if (!canEditTask(currentDetailTask)) {
        toast("Only the assigned member can delete this activity");
        return;
      }
      const id = currentDetailTask.id;
      const tTitle = currentDetailTask.title;
      showConfirmModal({
        title: "Delete Activity",
        message: `Are you sure you want to permanently delete "${tTitle}"? This cannot be undone.`,
        okText: "Delete Activity",
        onConfirm: async () => {
          const index = state.tasks.findIndex((t) => t.id === id);
          let removed = null;
          if (index !== -1) {
            removed = state.tasks.splice(index, 1)[0];
            syncAndPersistWorkspaceState();
            renderCurrentView();
          }
          closeActivityDetailModal();
          toast("Activity deleted");
          try {
            await api(`/teams/${state.currentTeamId}/tasks/${id}`, { method: "DELETE" });
          } catch (err) {
            if (removed) {
              state.tasks.splice(index, 0, removed);
              syncAndPersistWorkspaceState();
              renderCurrentView();
            }
            toast(err.message || "Failed to delete activity");
          }
        },
      });
    }
  });

  // Member Detail Modal Wiring
  $("#member-detail-close")?.addEventListener("click", closeMemberDetailModal);
  $("#member-detail-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "member-detail-modal-backdrop") closeMemberDetailModal();
  });

  // Confirmation Modal Wiring
  $("#confirm-modal-close")?.addEventListener("click", closeConfirmModal);
  $("#confirm-modal-cancel")?.addEventListener("click", closeConfirmModal);
  $("#confirm-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "confirm-modal-backdrop") closeConfirmModal();
  });
  $("#confirm-modal-ok")?.addEventListener("click", async () => {
    if (confirmCallback) {
      const cb = confirmCallback;
      closeConfirmModal();
      await cb();
    }
  });

  // Topbar Notification Bell & Dropdown Wiring
  const notifBtn = $("#topbar-notif-btn");
  const notifDropdown = $("#notif-dropdown");
  if (notifBtn && notifDropdown) {
    notifBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      notifDropdown.hidden = !notifDropdown.hidden;
      if (!notifDropdown.hidden) {
        loadNotifications();
      }
    });
  }
  $("#notif-mark-all")?.addEventListener("click", markAllNotificationsRead);

  // Close dropdowns on document click
  document.addEventListener("click", (e) => {
    if (notifDropdown && !notifDropdown.hidden && !e.target.closest(".topbar-notif-wrap")) {
      notifDropdown.hidden = true;
    }
    const profileMenu = $("#profile-menu");
    if (profileMenu && !profileMenu.hidden && !e.target.closest(".profile-wrap")) {
      profileMenu.hidden = true;
    }
  });

  $("#team-modal-close").addEventListener("click", closeTeamModal);
  $("#team-cancel-btn").addEventListener("click", closeTeamModal);
  $("#team-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "team-modal-backdrop") closeTeamModal(); });
  $("#team-form").addEventListener("submit", handleTeamSubmit);

  $("#member-modal-close").addEventListener("click", closeMemberModal);
  $("#member-cancel-btn").addEventListener("click", closeMemberModal);
  $("#member-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "member-modal-backdrop") closeMemberModal(); });
  $("#member-form").addEventListener("submit", handleMemberSubmit);

  $("#invite-success-modal-close")?.addEventListener("click", closeInviteSuccessModal);
  $("#invite-success-done-btn")?.addEventListener("click", closeInviteSuccessModal);
  $("#invite-success-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "invite-success-modal-backdrop") closeInviteSuccessModal();
  });
  $("#invite-success-copy-btn")?.addEventListener("click", () => {
    const input = $("#invite-success-link-input");
    if (input && input.value) {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(input.value).then(() => {
          toast("Invite link copied to clipboard!");
        }).catch(() => {
          input.select();
          document.execCommand("copy");
          toast("Invite link copied!");
        });
      } else {
        input.select();
        document.execCommand("copy");
        toast("Invite link copied!");
      }
    }
  });
  $("#invite-success-link-input")?.addEventListener("click", (e) => {
    e.target.select();
  });

  $("#profile-modal-close").addEventListener("click", closeProfileModal);
  $("#profile-cancel-btn").addEventListener("click", closeProfileModal);
  $("#profile-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "profile-modal-backdrop") closeProfileModal(); });
  $("#profile-form").addEventListener("submit", handleProfileSubmit);

  $("#profile-upload-btn")?.addEventListener("click", () => $("#profile-avatar-file")?.click());
  $("#profile-avatar-file")?.addEventListener("change", handleAvatarFileSelect);
  $("#profile-remove-avatar-btn")?.addEventListener("click", () => {
    $("#profile-avatar-url").value = "";
    updateAvatarPreview("", $("#profile-name").value);
  });
  $("#profile-avatar-url")?.addEventListener("input", (e) => {
    updateAvatarPreview(e.target.value, $("#profile-name").value);
  });

  $("#password-modal-close").addEventListener("click", closePasswordModal);
  $("#password-cancel-btn").addEventListener("click", closePasswordModal);
  $("#password-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "password-modal-backdrop") closePasswordModal(); });
  $("#password-form").addEventListener("submit", handlePasswordSubmit);

  $("#notif-modal-close").addEventListener("click", closeNotifModal);
  $("#notif-modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "notif-modal-backdrop") closeNotifModal(); });
  $("#notif-save-btn").addEventListener("click", handleNotifSave);

  $("#profile-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#profile-menu").hidden = !$("#profile-menu").hidden;
  });
  $("#pm-edit-profile").addEventListener("click", openProfileModal);
  $("#pm-change-password").addEventListener("click", openPasswordModal);
  $("#pm-notifications").addEventListener("click", openNotifModal);
  $("#pm-logout").addEventListener("click", handleLogout);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#auth-wrap").hidden) closeAuth();
    if (notifDropdown) notifDropdown.hidden = true;
    [
      "task-modal-backdrop", "team-modal-backdrop", "member-modal-backdrop",
      "profile-modal-backdrop", "password-modal-backdrop", "notif-modal-backdrop",
      "report-modal-backdrop", "activity-detail-modal-backdrop", "member-detail-modal-backdrop",
      "confirm-modal-backdrop",
    ].forEach((id) => { const el = $("#" + id); if (el) el.hidden = true; });
  });

  // Password visibility toggles
  document.querySelectorAll(".password-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wrap = btn.closest(".password-input-wrap");
      if (!wrap) return;
      const input = wrap.querySelector("input");
      if (!input) return;
      const isPass = input.type === "password";
      input.type = isPass ? "text" : "password";
      const showIcon = btn.querySelector(".eye-show");
      const hideIcon = btn.querySelector(".eye-hide");
      if (showIcon && hideIcon) {
        showIcon.style.display = isPass ? "none" : "block";
        hideIcon.style.display = isPass ? "block" : "none";
      }
    });
  });
}

function setupNetworkListeners() {
  let banner = $("#offline-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "offline-banner";
    banner.className = "offline-banner";
    banner.hidden = true;
    document.body.prepend(banner);
  }

  function updateOnlineStatus() {
    if (!navigator.onLine) {
      banner.textContent = "You are currently offline. Please check your internet connection.";
      banner.className = "offline-banner";
      banner.hidden = false;
    } else {
      if (!banner.hidden) {
        banner.textContent = "Connection restored.";
        banner.className = "offline-banner is-online";
        setTimeout(() => { banner.hidden = true; }, 3000);
        if (state.user) refreshTeamData().catch(() => {});
      }
    }
  }

  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  if (!navigator.onLine) updateOnlineStatus();
}

window.addEventListener("error", (e) => {
  console.error("Global Error Caught:", e.error || e.message);
  const root = $("#view-root");
  if (root && root.children.length === 0 && !$("#app-shell").hidden) {
    root.innerHTML = "";
    root.appendChild(
      renderErrorView({
        badge: "500",
        type: "danger",
        title: "An unexpected error occurred",
        message: e.message || "A runtime script error occurred. You can reload the view or return to the main page.",
        primaryText: "↻ Reload Page",
        primaryAction: () => window.location.reload(),
        secondaryText: "Main Page",
        secondaryAction: () => setView("main"),
      })
    );
  }
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled Promise Rejection:", e.reason);
  if (e.reason?.status === 403) {
    const root = $("#view-root");
    if (root && !$("#app-shell").hidden) {
      root.innerHTML = "";
      root.appendChild(render403View());
    }
  } else if (e.reason?.status === 404) {
    const root = $("#view-root");
    if (root && !$("#app-shell").hidden) {
      root.innerHTML = "";
      root.appendChild(render404View());
    }
  }
});

/* ============================================================
   THEME MANAGER (LIGHT / DARK MODE)
   ============================================================ */

function getStoredTheme() {
  return localStorage.getItem("proma:theme") || "light";
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("proma:theme", theme);

  const iconEl = $("#theme-toggle-icon");
  const pmIconEl = $("#pm-theme-icon");
  const pmTextEl = $("#pm-theme-text");

  const isDark = theme === "dark";
  const sunSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
  const moonSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
  const pmSunSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
  const pmMoonSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

  if (iconEl) iconEl.innerHTML = isDark ? sunSvg : moonSvg;
  if (pmIconEl) pmIconEl.innerHTML = isDark ? pmSunSvg : pmMoonSvg;
  if (pmTextEl) pmTextEl.textContent = isDark ? "Light Theme" : "Dark Theme";

  if (state.dashboard && typeof Chart !== "undefined") {
    setTimeout(() => {
      if ($("#team-pie-chart")) {
        const d = state.dashboard;
        renderStatusDonutChart("team-pie-chart", { todo: d.todo, inProgress: d.inProgress, complete: d.complete, overdue: d.overdue });
        renderTeamMembersBarChart("team-members-bar-chart", d.memberProgress);
      }
    }, 50);
  }
}

function toggleTheme() {
  const current = getStoredTheme();
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
}

function initTheme() {
  const saved = getStoredTheme();
  setTheme(saved);

  $("#theme-toggle-btn")?.addEventListener("click", toggleTheme);
  $("#pm-theme-toggle")?.addEventListener("click", toggleTheme);
}

/* ============================================================
   APPEARANCE (COLOR THEME)
   ============================================================ */

const COLOR_THEMES = [
  { id: "proma-blue", name: "ProMa Blue", a: "#2563EB", b: "#1D4ED8" },
  { id: "ocean", name: "Ocean", a: "#0891B2", b: "#0E7490" },
  { id: "emerald", name: "Emerald", a: "#059669", b: "#047857" },
  { id: "violet", name: "Violet", a: "#7C3AED", b: "#6D28D9" },
  { id: "slate", name: "Slate", a: "#475569", b: "#334155" },
  { id: "sunset", name: "Sunset", a: "#EA580C", b: "#C2410C" },
];

function getStoredColorTheme() {
  return localStorage.getItem("proma:colorTheme") || "proma-blue";
}

function applyColorTheme(themeId) {
  const valid = COLOR_THEMES.some((t) => t.id === themeId) ? themeId : "proma-blue";
  document.documentElement.setAttribute("data-color-theme", valid);
  localStorage.setItem("proma:colorTheme", valid);
  renderThemeOptionList(valid);
}

function renderThemeOptionList(activeId) {
  const list = $("#theme-option-list");
  if (!list) return;
  list.innerHTML = "";
  COLOR_THEMES.forEach((t) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-option" + (t.id === activeId ? " is-selected" : "");
    btn.innerHTML = `
      <span class="theme-swatch" style="--swatch-a:${t.a};--swatch-b:${t.b};"></span>
      <span class="theme-option-name">${escapeHtml(t.name)}</span>
      <span class="theme-option-check">✓</span>`;
    btn.addEventListener("click", () => selectColorTheme(t.id));
    list.appendChild(btn);
  });
}

async function selectColorTheme(themeId) {
  // Apply immediately — no need to wait on the network for the UI to update.
  applyColorTheme(themeId);
  if (!state.user) return;
  try {
    await api("/users/me/theme", { method: "PUT", body: JSON.stringify({ colorTheme: themeId }) });
    state.user.color_theme = themeId;
    try { localStorage.setItem("proma:user", JSON.stringify(state.user)); } catch (e) {}
  } catch (err) {
    toast(err.message || "Failed to save theme preference");
  }
}

function initColorTheme() {
  applyColorTheme(getStoredColorTheme());
  $("#pm-appearance")?.addEventListener("click", () => {
    $("#profile-menu").hidden = true;
    renderThemeOptionList(getStoredColorTheme());
    $("#appearance-modal-backdrop").hidden = false;
  });
  $("#appearance-modal-close")?.addEventListener("click", () => { $("#appearance-modal-backdrop").hidden = true; });
  $("#appearance-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "appearance-modal-backdrop") $("#appearance-modal-backdrop").hidden = true;
  });
}

async function init() {
  initTheme();
  initColorTheme();
  setupNetworkListeners();
  wireLandingAndOverlay();
  wireAuthNav();
  wireAuthForms();
  wireTeamSwitcher();
  wireModals();
  $$(".nav-item").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.view)));

  // 1. Instant 0ms Fast Startup from Local Storage
  let hasCachedSession = false;
  try {
    const cachedUser = localStorage.getItem("proma:user");
    const cachedTeams = localStorage.getItem("proma:teams");
    const cachedTasks = localStorage.getItem("proma:assignedTasks");
    if (cachedUser) {
      state.user = JSON.parse(cachedUser);
      state.teams = cachedTeams ? JSON.parse(cachedTeams) : [];
      state.assignedTasks = cachedTasks ? JSON.parse(cachedTasks) : [];
      hasCachedSession = true;
      fastBootApp();
    }
  } catch (e) {}

  if (!hasCachedSession) {
    showLanding();
  }

  // Handle password-reset deep link: /reset-password?token=...
  if (window.location.pathname === "/reset-password") {
    const token = new URLSearchParams(window.location.search).get("token");
    $("#reset-token").value = token || "";
    openAuth("reset");
  }

  // Handle invite deep link / Google OAuth error surfaced via query params
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite");
  if (inviteToken) {
    try { localStorage.setItem("proma:pendingInviteToken", inviteToken); } catch (e) {}
    if (!state.user && !hasCachedSession) {
      openAuth("signup");
      showAuthBanner("You've been invited to join a team! Create an account or sign in to accept your invitation.", "success");
    }
  }
  if (params.get("authError")) {
    openAuth("login");
    showAuthBanner(params.get("authError"));
  }

  // 2. Background Auth Revalidation (Non-Blocking)
  try {
    const { user } = await api("/auth/me");
    state.user = user;
    if (user?.color_theme) applyColorTheme(user.color_theme);
    await bootApp();

    if (inviteToken && state.user) {
      // Re-fetch pending invites and teams so newly attached teams show immediately
      const [teams, invites] = await Promise.all([
        api("/users/me/teams").catch(() => state.teams),
        api("/users/me/invites").catch(() => []),
      ]);
      state.teams = teams;
      state.pendingTeamInvites = invites;
      renderCurrentView();
      if (invites.length > 0) {
        toast("You have pending team invitations ready to accept!");
      }
    }
  } catch (e) {
    // If not authenticated, clear invalid cached session and show landing page
    if (hasCachedSession) {
      try {
        localStorage.removeItem("proma:user");
        localStorage.removeItem("proma:teams");
        localStorage.removeItem("proma:assignedTasks");
      } catch (err) {}
      state.user = null;
      state.teams = [];
      showLanding();
    }
  }

  // Keep data fresh automatically.
  setInterval(async () => {
    if (document.hidden || !state.user) return;
    await refreshTeamData();
  }, 60000);
}

document.addEventListener("DOMContentLoaded", init);
