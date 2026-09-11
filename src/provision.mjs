#!/usr/bin/env node
import { stdin } from "node:process";
import { action } from "./action.mjs";

function provision(env = process.env) {
  const id = env.HERDR_EXE_DEV_ACTION;
  if (!id)
    throw new Error(
      "Open this provisioning pane through an exe.dev agent action.",
    );
  process.stdout.write(
    `Preparing exe.dev ${id}. This pane reports setup progress; inspect the new agent tab for login and readiness.\n`,
  );
  return action({
    ...env,
    HERDR_PLUGIN_ACTION_ID: id,
    HERDR_EXE_DEV_PROVISION: "1",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_cwd: env.HERDR_EXE_DEV_CWD,
    }),
  });
}
try {
  console.log(JSON.stringify({ ok: true, ...provision() }));
} catch (error) {
  process.stderr.write(`\nexe.dev provisioning failed: ${error.message}\n`);
  process.exitCode = 1;
  if (stdin.isTTY) {
    process.stderr.write("Press any key to close this pane.\n");
    stdin.setRawMode(true);
    await new Promise((resolve) => stdin.once("data", resolve));
  }
}
