// lib/dashboardStats.js
// Computes the team dashboard summary (status counts, upcoming/overdue
// tasks, per-member progress) from an already-enriched task list and member
// list. Pulled out because routes/dashboard.js and the /bundle route in
// routes/teams.js both computed this exact same thing independently.
function computeDashboardStats(tasks, members) {
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

  return {
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
  };
}

module.exports = { computeDashboardStats };
