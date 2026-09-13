#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { deleteVm, load, withLock } from "./core.mjs";

export async function confirm(
  env = process.env,
  input = stdin,
  output = stdout,
) {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  const id = env.HERDR_EXE_DEV_MAPPING;
  if (!stateDir || !id)
    throw new Error(
      "Open this confirmation pane through the exe.dev Delete action.",
    );
  const displayed = load(stateDir, id);
  output.write(
    `Deletion permanently destroys all VM data, including ignored files and databases.\nGit checks cannot back up non-Git data.\nType ${displayed.vm.name} to delete: `,
  );
  const reader = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY),
  });
  const typed = await reader.question("");
  reader.close();
  return withLock(stateDir, id, () => {
    const current = load(stateDir, id);
    if (JSON.stringify(current) !== JSON.stringify(displayed))
      throw new Error(
        "Mapping changed during confirmation; reopen the deletion pane.",
      );
    return deleteVm(stateDir, current, typed);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ ok: true, ...(await confirm()) }));
  } catch (error) {
    process.stderr.write(`\nexe.dev deletion failed: ${error.message}\n`);
    process.exitCode = 1;
    // The pane closes on exit, so an unread refusal would look like a no-op.
    if (stdin.isTTY) {
      process.stderr.write("Press any key to close this pane.\n");
      stdin.setRawMode(true);
      await new Promise((resolve) => stdin.once("data", resolve));
      process.exit(1);
    }
  }
}
