// lib/taskStatus.js
// A task is automatically "overdue" (Due Work) whenever its deadline has
// passed and it hasn't been marked complete. This is never stored — it's
// always computed live from status + deadline, so it can never drift out
// of sync with reality.

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function toISODate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function computeEffectiveStatus(status, deadlineISO) {
  if (status === "complete") return "complete";
  if (deadlineISO && deadlineISO < todayISO()) return "overdue";
  return status; // "todo" | "in_progress"
}

// Accepts a raw DB row (snake_case) and returns an API-shaped task object.
function enrichTask(row) {
  const deadline = toISODate(row.deadline);
  const startDate = toISODate(row.start_date);
  const effectiveStatus = computeEffectiveStatus(row.status, deadline);
  const deadlineDate = deadline ? new Date(deadline) : null;
  const daysUntilDeadline = deadlineDate
    ? Math.ceil((deadlineDate - new Date(todayISO())) / (1000 * 60 * 60 * 24))
    : null;

  return {
    id: row.id,
    teamId: row.team_id,
    title: row.title,
    description: row.description,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name || "Unassigned",
    assigneeAvatar: row.assignee_avatar || null,
    status: row.status,
    priority: row.priority || "normal",
    checklist: Array.isArray(row.checklist) ? row.checklist : [],
    startDate,
    deadline,
    createdBy: row.created_by || null,
    createdAt: row.created_at ? (typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString()) : null,
    updatedAt: row.updated_at ? (typeof row.updated_at === "string" ? row.updated_at : new Date(row.updated_at).toISOString()) : null,
    effectiveStatus,
    isOverdue: effectiveStatus === "overdue",
    isDueToday: deadline === todayISO() && effectiveStatus !== "complete",
    isDueSoon:
      effectiveStatus !== "complete" &&
      effectiveStatus !== "overdue" &&
      daysUntilDeadline !== null &&
      daysUntilDeadline <= 2,
    daysUntilDeadline,
  };
}

module.exports = { computeEffectiveStatus, enrichTask, todayISO };
