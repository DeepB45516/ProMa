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
  const completeAfterDue = tasks.filter((t) => t.completedAfterDeadline).length;
  const overdue = countBy("overdue");
  const completionPct = total === 0 ? 0 : Math.round((complete / total) * 100);
  const activeTaskCount = tasks.filter((t) => t.effectiveStatus !== "complete").length;
  const workloadAverage = members.length === 0 ? 0 : activeTaskCount / members.length;

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
    const mineCompleteAfterDue = mine.filter((t) => t.completedAfterDeadline).length;
    const activeCount = mine.filter((t) => t.effectiveStatus !== "complete").length;
    const workloadState = activeCount > Math.ceil(workloadAverage) ? "high" : activeCount === 0 && workloadAverage > 0 ? "available" : "balanced";
    return {
      id: m.id,
      name: m.full_name,
      role: m.role,
      total: mine.length,
      complete: mineComplete,
      completeAfterDue: mineCompleteAfterDue,
      activeCount,
      workloadState,
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
    completeAfterDue,
    overdue,
    completionPct,
    workloadAverage,
    memberCount: members.length,
    upcoming,
    overdueTasks,
    memberProgress,
  };
}

module.exports = { computeDashboardStats };
