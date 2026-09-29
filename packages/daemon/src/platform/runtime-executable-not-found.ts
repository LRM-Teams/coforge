/** The spawner could not find a runtime executable on the PATH the Agent launches with. Thrown
 * only for the executable itself; any other `ENOENT` while spawning (a missing working directory)
 * stays the plain spawn error. */
export class RuntimeExecutableNotFoundError extends Error {
  readonly code = "runtime_not_found";
  constructor(
    readonly executable: string,
    options?: ErrorOptions,
  ) {
    super(`Executable not found in $PATH: "${executable}"`, options);
    this.name = "RuntimeExecutableNotFoundError";
  }
}
