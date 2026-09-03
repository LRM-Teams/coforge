import daemonPackage from "../package.json";

export const COFORGE_DAEMON_VERSION = process.env.COFORGE_DAEMON_VERSION ?? daemonPackage.version;
