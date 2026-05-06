import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const bundleMacosDir = path.join(
  process.cwd(),
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
);

const dmgArtifact = /^(?:rw\.\d+\.)?Durian_\d+\.\d+\.\d+_[^/]+\.dmg$/;

try {
  const entries = await readdir(bundleMacosDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && dmgArtifact.test(entry.name))
      .map((entry) => rm(path.join(bundleMacosDir, entry.name), { force: true })),
  );
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
