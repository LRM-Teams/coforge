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
  if (level === "error") return "Error";
  if (activity === "thinking_started") return "Thinking";
  if (activity === "working") return "Working";
  if (activity === "starting") return "Starting";
  if (activity === "stopped") return "Stopped";
  if (activity === "turn_completed" || activity === "idle") return "Idle";
  if (activity === "running_command") return "Running command";
  if (activity === "reading_file") return "Reading file";
  if (activity === "writing_file") return "Writing file";
  if (activity === "editing_file") return "Editing file";
  if (activity === "using_tool") return "Using tool";
  return `Other: ${activity}`;
}
