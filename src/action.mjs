#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocate,
  archiveMapping,
  assertSameSeed,
  attachMachine,
  bundleFile,
  captureSeed,
  checkLocalHerdr,
  createBundle,
  ensureBinding,
  ensureRemoteHerdr,
  homeFiles,
  initializeRoute,
  installSkill,
  load,
  makeEntry,
  mappingId,
  MissingMappingError,
  openPane,
  operatorConfig,
  prepareRoute,
  prepareVm,
  providerList,
  pushHomeFiles,
  pushSecretFiles,
  recoverCreation,
  reconcileDeletion,
  remote,
  run,
  save,
  secretFiles,
  sshG,
  validateExisting,
  verifyBinding,
  withLock,
  herdr,
} from "./core.mjs";

function context(env) {
  try {
    return JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    throw new Error("Herdr supplied invalid action context JSON.");
  }
}
function location(env) {
  const value = context(env);
  const cwd =
    env.HERDR_EXE_DEV_PROVISION === "1"
      ? env.HERDR_EXE_DEV_CWD
      : (value.focused_pane_cwd ??
        value.workspace_cwd ??
        env.HERDR_EXE_DEV_CWD);
  if (!cwd || !path.isAbsolute(cwd))
    throw new Error(
      "Focus a Git worktree, or select HERDR_EXE_DEV_MAPPING explicitly.",
    );
  const root = fs.realpathSync(
    run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
  );
  return {
    root,
    gitDir: fs.realpathSync(
      run("git", ["-C", root, "rev-parse", "--absolute-git-dir"]),
    ),
    commonDir: fs.realpathSync(
      path.resolve(
        root,
        run("git", ["-C", root, "rev-parse", "--git-common-dir"]),
      ),
    ),
  };
}
function savedMapping(stateDir, env, local) {
  if (env.HERDR_EXE_DEV_MAPPING)
    return load(stateDir, env.HERDR_EXE_DEV_MAPPING);
  try {
    return load(stateDir, mappingId(local.gitDir, local.commonDir), local);
  } catch (error) {
    if (!(error instanceof MissingMappingError)) throw error;
    return undefined;
  }
}
function launchProvision(env, id, local, mapping) {
  const args = [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "exe-dev",
    "--entrypoint",
    "provision",
    "--env",
    `HERDR_EXE_DEV_ACTION=${id}`,
    "--no-focus",
  ];
  if (local) args.push("--env", `HERDR_EXE_DEV_CWD=${local.root}`);
  if (mapping) args.push("--env", `HERDR_EXE_DEV_MAPPING=${mapping.id}`);
  run(env.HERDR_BIN_PATH ?? "herdr", args);
  return { action: id, phase: "preparation-submitted", vm: mapping?.vm.name };
}
function prepareAttachment(stateDir, entry, progress) {
  progress("Preparing native Herdr and its skill.");
  ensureRemoteHerdr(entry);
  installSkill(entry);
  progress("Reconciling the remote workspace.");
  ensureBinding(stateDir, entry);
}
function provision(stateDir, entry, progress) {
  if (entry.phase === "intent") {
    progress("Verifying the frozen seed and local SSH route.");
    checkLocalHerdr(entry);
    createBundle(entry.seed, bundleFile(stateDir, entry));
    prepareRoute(stateDir, entry);
    sshG(entry);
    assertSameSeed(entry.seed);
    progress(
      "Allocating the recorded VM. An uncertain result will be retained.",
    );
    allocate(stateDir, entry);
  }
  if (["created", "setup-failed"].includes(entry.phase)) {
    prepareRoute(stateDir, entry);
    validateExisting(entry);
    remote(entry, "true");
    prepareVm(stateDir, entry, bundleFile(stateDir, entry), { progress });
  }
  if (entry.phase === "ready") prepareAttachment(stateDir, entry, progress);
}
function status(entry) {
  const vms = providerList(entry).filter((vm) => vm.vm_name === entry.vm.name);
  return {
    action: "status",
    phase: entry.phase,
    mapping: entry.id,
    vm: entry.vm.name,
    recordedCreation: entry.vm.createdAt,
    providerMatches: vms.map((vm) => ({
      createdAt: vm.created_at,
      tags: vm.tags,
      sshHost: vm.ssh_host,
    })),
    machineId: entry.machineId,
    workspaceId: entry.workspaceId,
    error: entry.error,
    cleanupError: entry.cleanupError,
  };
}
export function action(env = process.env) {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
  const id = env.HERDR_PLUGIN_ACTION_ID?.replace(/^exe-dev\./, "");
  if (!id || !stateDir || !configDir)
    throw new Error("Launch this command as a Herdr plugin action.");
  const launches = new Set(["start-agent"]);
  if (
    ![
      ...launches,
      "shell",
      "start",
      "check",
      "status",
      "recover",
      "retry-setup",
      "reconnect",
      "delete",
    ].includes(id)
  )
    throw new Error(`Unknown action: ${id}`);
  const local = env.HERDR_EXE_DEV_MAPPING ? undefined : location(env);
  let mapping = savedMapping(stateDir, env, local);
  // Deletion leaves a tombstone. Starting an agent for the worktree again means
  // the operator wants a VM, so retire the record instead of refusing forever.
  if (mapping?.phase === "deleted" && launches.has(id) && local) {
    withLock(stateDir, mapping.id, () => archiveMapping(stateDir, mapping));
    mapping = undefined;
  }
  if (launches.has(id) && env.HERDR_EXE_DEV_PROVISION !== "1")
    return launchProvision(env, id, local, mapping);
  if (id === "delete") {
    if (!mapping)
      throw new MissingMappingError("No VM mapping exists for this worktree.");
    run(env.HERDR_BIN_PATH ?? "herdr", [
      "plugin",
      "pane",
      "open",
      "--plugin",
      "exe-dev",
      "--entrypoint",
      "confirm",
      "--env",
      `HERDR_EXE_DEV_MAPPING=${mapping.id}`,
      "--focus",
    ]);
    return { action: id, phase: "confirmation-opened", vm: mapping.vm.name };
  }
  const started = Date.now();
  const progress = (message) => {
    if (env.HERDR_EXE_DEV_PROVISION !== "1") return;
    const seconds = Math.round((Date.now() - started) / 1000);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    process.stderr.write(`[${clock}] ${message}\n`);
  };
  const target = mapping?.id ?? mappingId(local.gitDir, local.commonDir);
  return withLock(stateDir, target, () => {
    let entry = savedMapping(stateDir, env, local);
    if (!entry) {
      if (!launches.has(id))
        throw new MissingMappingError(
          "No VM mapping exists for this worktree.",
        );
      const seed = captureSeed(local.root);
      if (mappingId(seed.gitDir, seed.commonDir) !== target)
        throw new Error(
          "Worktree identity changed during preflight; refusing allocation.",
        );
      entry = initializeRoute(
        makeEntry(
          stateDir,
          seed,
          operatorConfig(configDir),
          env.HERDR_BIN_PATH,
        ),
      );
      save(stateDir, entry);
    }
    if (id === "status") return status(entry);
    if (entry.phase === "deleted" && id !== "recover")
      throw new Error(
        "This mapping is a deletion tombstone; it will not recreate a VM.",
      );
    if (id === "recover") {
      if (["deleting", "deleted"].includes(entry.phase)) {
        reconcileDeletion(stateDir, entry);
        return {
          action: id,
          phase: entry.phase,
          vm: entry.vm.name,
          cleanupError: entry.cleanupError,
        };
      }
      if (entry.phase === "creating") recoverCreation(stateDir, entry);
      if (!["created", "ready"].includes(entry.phase))
        throw new Error(
          `Cannot automatically recover ${entry.phase}; VM and work are retained.`,
        );
      provision(stateDir, entry, progress);
      return { action: id, phase: entry.phase, vm: entry.vm.name };
    }
    if (
      launches.has(id) &&
      ["intent", "created", "setup-failed"].includes(entry.phase)
    )
      provision(stateDir, entry, progress);
    validateExisting(entry);
    if (id === "retry-setup") {
      if (entry.phase !== "setup-failed" || !entry.seeded)
        throw new Error(
          "retry-setup requires a completed seed and failed setup.",
        );
      prepareVm(stateDir, entry);
      prepareAttachment(stateDir, entry, progress);
      return { action: id, phase: entry.phase, vm: entry.vm.name };
    }
    if (!["ready", "setup-failed"].includes(entry.phase))
      throw new Error(
        `VM mapping is ${entry.phase}; inspect status or recover without another allocation.`,
      );
    if (entry.phase !== "ready" && id !== "shell")
      throw new Error(
        "Setup failed; use an inspection shell or retry-setup before launching work.",
      );
    if (!entry.machineId || !entry.workspaceId || !entry.rootPaneId)
      prepareAttachment(stateDir, entry, progress);
    attachMachine(stateDir, entry);
    try {
      verifyBinding(entry);
    } catch {
      progress("The saved remote workspace drifted; binding it again.");
      delete entry.workspaceId;
      delete entry.rootPaneId;
      delete entry.rootTerminalId;
      save(stateDir, entry);
      prepareAttachment(stateDir, entry, progress);
    }
    const configured = homeFiles(configDir);
    if (configured.length) {
      progress(
        `Copying ${configured.length} configured home files onto the VM.`,
      );
      pushHomeFiles(entry, configured);
    }
    const secrets = secretFiles(configDir);
    if (secrets.length) {
      progress(
        `Resolving ${secrets.length} configured secret files onto the VM.`,
      );
      pushSecretFiles(entry, secrets);
    }
    if (id === "shell")
      return {
        action: id,
        pane: openPane(stateDir, entry, undefined, "exe.dev shell"),
      };
    if (id === "start" || id === "check") {
      const hook = entry.project[id];
      if (!hook)
        throw new Error(
          `The seed has no committed .herdr/exe.json ${id} argv.`,
        );
      return {
        action: id,
        phase: "command-submitted",
        pane: openPane(stateDir, entry, hook, `exe.dev ${id}`),
      };
    }
    const machine = `exe.dev ${entry.vm.name}`;
    progress(
      `Focusing the remote worktree workspace. Select the ${machine} machine in Herdr to see it.`,
    );
    herdr(entry, ["workspace", "focus", entry.workspaceId]);
    return {
      action: id,
      phase: "workspace-focused",
      vm: entry.vm.name,
      machine,
      workspaceId: entry.workspaceId,
    };
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ ok: true, ...action() }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
