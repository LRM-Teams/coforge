import { assertVapidKeyPair } from "../../apps/web/src/server/notifications/vapid-key-pair.server";

const publicKey = Bun.env.COFORGE_WEB_PUSH_PUBLIC_KEY?.trim();
const privateKey = Bun.env.COFORGE_WEB_PUSH_PRIVATE_KEY?.trim();
if (!publicKey || !privateKey) throw new Error("Web Push keys are required");
assertVapidKeyPair(publicKey, privateKey);
