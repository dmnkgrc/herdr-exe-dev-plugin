#!/usr/bin/env node
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
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
