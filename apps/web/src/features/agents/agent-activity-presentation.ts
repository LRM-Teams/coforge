import { m } from "@/paraglide/messages";

export function showsActivityMessage(activity: string) {
  return activity !== "starting" && activity !== "stopped" && activity !== "turn_completed";
}

export function activityDotClass(activity: string, level: string) {
  if (level === "error") return "bg-destructive";
  if (activity === "starting" || activity === "running_command") return "bg-amber-500";
  if (activity === "stopped") return "bg-muted-foreground";
  if (activity === "turn_completed") return "bg-emerald-500";
  return "bg-blue-500";
}

export function activityLabel(activity: string, level: string) {
  if (level === "error") return m.agent_activity_failed();
  if (activity === "working") return m.agent_avatar_working();
  if (activity === "starting") return m.agent_activity_starting();
  if (activity === "stopped") return m.agent_activity_stopped();
  if (activity === "turn_completed" || activity === "idle") return m.agent_activity_idle();
  if (activity === "running_command") return m.agent_activity_running_command();
  if (activity === "reading_file") return m.agent_activity_reading_file();
  if (activity === "writing_file") return m.agent_activity_writing_file();
  if (activity === "editing_file") return m.agent_activity_editing_file();
  if (activity === "using_tool") return m.agent_activity_using_tool();
  return `${m.agent_activity_other()}: ${activity}`;
}
