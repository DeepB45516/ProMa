// lib/taskStatus.js
// A task is automatically "overdue" (Due Work) whenever its deadline has
// passed and it hasn't been marked complete. This is never stored — it's
// always computed live from status + deadline, so it can never drift out
// of sync with reality.

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function toISODateTime(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    if (value.includes("T") || value.includes(":") || value.includes(" ")) {
      const d = new Date(value);
      return !isNaN(d.getTime()) ? d.toISOString() : value;
    }
    return value;
  }
  const d = new Date(value);
  return !isNaN(d.getTime()) ? d.toISOString() : null;
}

function computeEffectiveStatus(status, deadlineVal) {
  if (status === "complete") return "complete";
  if (!deadlineVal) return status;
  
  if (typeof deadlineVal === "string" && deadlineVal.length === 10 && !deadlineVal.includes("T")) {
    if (deadlineVal < todayISO()) return "overdue";
    return status;
  }
  
  const d = new Date(deadlineVal);
  if (!isNaN(d.getTime()) && d.getTime() < Date.now()) {
    return "overdue";
  }
  return status;
}

// Accepts a raw DB row (snake_case) and returns an API-shaped task object.
function enrichTask(row) {
  const deadline = toISODateTime(row.deadline);
  const startDate = toISODateTime(row.start_date);
  const effectiveStatus = computeEffectiveStatus(row.status, deadline);
  const deadlineDate = deadline ? new Date(deadline) : null;
  
  let daysUntilDeadline = null;
  let isDueToday = false;

  if (deadlineDate && !isNaN(deadlineDate.getTime())) {
    const diffMs = deadlineDate.getTime() - Date.now();
    daysUntilDeadline = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    isDueToday = deadlineDate.toDateString() === new Date().toDateString() && effectiveStatus !== "complete";
  }

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
    isDueToday,
    isDueSoon:
      effectiveStatus !== "complete" &&
      effectiveStatus !== "overdue" &&
      daysUntilDeadline !== null &&
      daysUntilDeadline <= 2,
    daysUntilDeadline,
  };
}

module.exports = { computeEffectiveStatus, enrichTask, todayISO, toISODateTime };
