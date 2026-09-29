/** The daemon stopped its Workspace connection before that connection came up: a deliberate stop
 * (shutdown, restart, replacement), never a cloud failure. */
export class DaemonConnectionStoppedError extends Error {
  constructor() {
    super("The Workspace connection was stopped before it connected");
    this.name = "DaemonConnectionStoppedError";
  }
}
