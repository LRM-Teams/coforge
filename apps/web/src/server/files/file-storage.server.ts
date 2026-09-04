import { join } from "node:path";

export function fileStorageRoot() {
  return process.env.COFORGE_FILE_STORAGE_DIR ?? join(process.cwd(), ".data", "files");
}

export function fileStoragePath(objectKey: string) {
  return join(fileStorageRoot(), ...objectKey.split("/"));
}
