export type SupportedPlatform = "darwin" | "linux" | "win32";
export type SupportedArchitecture = "x64" | "arm64";

export type ComputerPlatform = {
  os: SupportedPlatform;
  architecture: SupportedArchitecture;
  releaseTarget: string;
};

export function currentComputerPlatform(
  input: {
    platform?: NodeJS.Platform;
    architecture?: string;
  } = {},
): ComputerPlatform {
  const os = input.platform ?? process.platform;
  if (os !== "darwin" && os !== "linux" && os !== "win32") {
    throw new Error(`unsupported platform: ${os}`);
  }
  const architecture = input.architecture ?? process.arch;
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`unsupported architecture: ${architecture}`);
  }
  return {
    os,
    architecture,
    releaseTarget: `${os === "win32" ? "windows" : os}-${architecture}`,
  };
}
