/**
 * Windows Job Object ownership for external Agent process trees.
 *
 * Architecture requires that Windows Agent children are placed in a Job Object and that
 * cleanup waits until the job reports zero active processes - root-PID `taskkill /T` alone
 * is not sufficient. Bun does not expose CREATE_SUSPENDED, so the child is spawned first and
 * assigned immediately; LimitFlags omit breakaway so descendants cannot leave the job once
 * assigned (nested jobs on Windows 8+).
 *
 * Official sources:
 * - https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
 * - https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject
 * - https://bun.sh/docs/runtime/ffi (HANDLE as u64 on Windows)
 */

import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_INFORMATION = 0x0400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectBasicAccountingInformation = 1;
const JobObjectExtendedLimitInformation = 9;
/** x64 sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION). */
const EXTENDED_LIMIT_INFORMATION_BYTES = 144;
/** Offset of LimitFlags inside JOBOBJECT_BASIC_LIMIT_INFORMATION. */
const LIMIT_FLAGS_OFFSET = 16;
/** Offset of ActiveProcesses inside JOBOBJECT_BASIC_ACCOUNTING_INFORMATION. */
const ACTIVE_PROCESSES_OFFSET = 40;
const BASIC_ACCOUNTING_BYTES = 48;

export type WindowsJobObject = {
  readonly handle: bigint;
  assign(processId: number): void;
  terminate(exitCode?: number): void;
  activeProcesses(): number;
  close(): void;
};

export type WindowsJobObjectFactory = () => WindowsJobObject;

type Kernel32 = {
  symbols: {
    CreateJobObjectW: (security: Pointer | null, name: Pointer | null) => bigint;
    CloseHandle: (handle: bigint) => number;
    SetInformationJobObject: (
      job: bigint,
      classId: number,
      info: Pointer,
      length: number,
    ) => number;
    AssignProcessToJobObject: (job: bigint, process: bigint) => number;
    TerminateJobObject: (job: bigint, exitCode: number) => number;
    QueryInformationJobObject: (
      job: bigint,
      classId: number,
      info: Pointer,
      length: number,
      returned: Pointer | null,
    ) => number;
    OpenProcess: (access: number, inherit: number, processId: number) => bigint;
    GetLastError: () => number;
  };
};

let kernel32: Kernel32 | null | undefined;

function loadKernel32(): Kernel32 {
  if (kernel32 !== undefined) {
    if (kernel32 === null) throw new Error("Windows Job Object APIs are unavailable");
    return kernel32;
  }
  try {
    kernel32 = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      SetInformationJobObject: {
        args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
      QueryInformationJobObject: {
        args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
      GetLastError: { args: [], returns: FFIType.u32 },
    }) as Kernel32;
    return kernel32;
  } catch (error) {
    kernel32 = null;
    throw new Error("Windows Job Object APIs are unavailable", { cause: error });
  }
}

function winError(api: string, k: Kernel32): Error {
  return new Error(`${api} failed (Win32 ${k.symbols.GetLastError()})`);
}

/** Creates a Job Object with KILL_ON_JOB_CLOSE and no breakaway limits. */
export function createWindowsJobObject(): WindowsJobObject {
  const k = loadKernel32();
  const handle = k.symbols.CreateJobObjectW(null, null);
  if (handle === 0n) throw winError("CreateJobObjectW", k);

  const limits = new Uint8Array(EXTENDED_LIMIT_INFORMATION_BYTES);
  new DataView(limits.buffer).setUint32(
    LIMIT_FLAGS_OFFSET,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    true,
  );
  if (
    k.symbols.SetInformationJobObject(
      handle,
      JobObjectExtendedLimitInformation,
      ptr(limits),
      limits.byteLength,
    ) === 0
  ) {
    k.symbols.CloseHandle(handle);
    throw winError("SetInformationJobObject", k);
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    k.symbols.CloseHandle(handle);
  };

  return {
    handle,
    assign(processId: number) {
      if (!Number.isSafeInteger(processId) || processId <= 0)
        throw new Error("Job Object assign requires a positive process id");
      const access = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION;
      const process = k.symbols.OpenProcess(access, 0, processId);
      if (process === 0n) throw winError("OpenProcess", k);
      try {
        if (k.symbols.AssignProcessToJobObject(handle, process) === 0)
          throw winError("AssignProcessToJobObject", k);
      } finally {
        k.symbols.CloseHandle(process);
      }
    },
    terminate(exitCode = 1) {
      if (k.symbols.TerminateJobObject(handle, exitCode) === 0)
        throw winError("TerminateJobObject", k);
    },
    activeProcesses() {
      const accounting = new Uint8Array(BASIC_ACCOUNTING_BYTES);
      if (
        k.symbols.QueryInformationJobObject(
          handle,
          JobObjectBasicAccountingInformation,
          ptr(accounting),
          accounting.byteLength,
          null,
        ) === 0
      )
        throw winError("QueryInformationJobObject", k);
      return new DataView(accounting.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true);
    },
    close,
  };
}

/** True when this process can load the Win32 Job Object APIs. */
export function windowsJobObjectsAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    loadKernel32();
    return true;
  } catch {
    return false;
  }
}
