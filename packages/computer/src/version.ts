import computerPackage from "../package.json";

export const COFORGE_COMPUTER_VERSION = Bun.env.COFORGE_COMPUTER_VERSION ?? computerPackage.version;
