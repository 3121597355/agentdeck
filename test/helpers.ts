import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { TestContext } from "node:test";

export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-inbox-test-"));
  t.after(() => {
    const target = resolve(dir);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("agent-inbox-test-")) throw new Error("Unsafe test cleanup target");
    rmSync(target, { recursive: true, force: true });
  });
  return dir;
}
