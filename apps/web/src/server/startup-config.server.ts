import { readFileDeliveryConfig } from "./files/file-delivery.server";

/**
 * Deployment configuration that must be valid before the server accepts a single request.
 * The server entry calls this at module load, so a bad or unreadable value stops the process
 * during boot: the deployment's health check never passes, `remote-deploy.sh` keeps the previous
 * release, and no user request ever sees the error. Reading lazily on first use instead turns a
 * deployment mistake into request failures for whoever happens to hit that code path first.
 *
 * Optional features stay optional: an unset `COFORGE_FILE_DELIVERY_URL` is valid ("disabled"),
 * only a set URL with a missing or unreadable key is a boot failure.
 */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const delivery = readFileDeliveryConfig(env);
  console.info(
    JSON.stringify({
      event: "startup_config_checked",
      file_delivery: delivery ? "configured" : "disabled",
    }),
  );
}
