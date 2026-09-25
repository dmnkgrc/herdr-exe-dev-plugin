#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { deleteVm, load, withLock } from "./core.mjs";

export async function confirm(
  env = process.env,
  input = stdin,
  output = stdout,
  report = process.stderr,
) {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  const id = env.HERDR_EXE_DEV_MAPPING;
  if (!stateDir)
    throw new Error(
      "Open this confirmation pane through the exe.dev Delete action.",
    );
  if (!id)
    throw new Error("No VM mapping exists for this workspace.");
  const displayed = load(stateDir, id);
  output.write(
    `Deletion permanently destroys all VM data, including uncommitted and unpushed Git work.\n`,
  );
  const reader = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY),
  });
  // readline redraws its line on a terminal, erasing any prompt written before
  // it, so the question has to be the prompt readline owns.
  const typed = await reader.question(`Delete ${displayed.vm.name}? [y/N] `);
  reader.close();
  if (!/^y(es)?$/i.test(typed.trim()))
    throw new Error("Deletion cancelled; the VM is untouched.");
  // Deletion spends a minute in remote checks, so report each stage rather than
  // leaving the pane silent between the answer and the result.
  const started = Date.now();
  const progress = (message) => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    report.write(`[${clock}] ${message}\n`);
  };
  return withLock(stateDir, id, () => {
    const current = load(stateDir, id);
    if (JSON.stringify(current) !== JSON.stringify(displayed))
      throw new Error(
        "Mapping changed during confirmation; reopen the deletion pane.",
      );
    const deleted = deleteVm(stateDir, current, current.vm.name, { progress });
    progress(
      deleted.cleanupError
        ? `Destroyed ${current.vm.name}, but local cleanup needs attention: ${deleted.cleanupError}`
        : `Destroyed ${current.vm.name} and cleaned up its machine profile and route.`,
    );
    return deleted;
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
      // readline.close() paused stdin, so a new data listener will not resume it.
      stdin.resume();
      await new Promise((resolve) => stdin.once("data", resolve));
      process.exit(1);
    }
  }
}
