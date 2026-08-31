import { e2eDiscovery } from "../../../src/server/auth/e2e-device-auth.server";

export default defineEventHandler((event) => e2eDiscovery(event.req));
