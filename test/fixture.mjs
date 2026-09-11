import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, quote } from "../src/core.mjs";

export function installFlock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "flock"),
    `#!/usr/bin/env python3
import fcntl, os, sys
assert sys.argv[1] == '-n'
fd = int(sys.argv[2]) if len(sys.argv) == 3 else os.open(sys.argv[2], os.O_CREAT | os.O_WRONLY, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)
if len(sys.argv) > 3:
    os.set_inheritable(fd, True)
    os.execvp(sys.argv[3], sys.argv[3:])
`,
    { mode: 0o755 },
  );
}
export function fixture(t, projectConfig) {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "exe-fixture-")),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["source", "config", "bin", "remote-home", "remote-bin"])
    fs.mkdirSync(path.join(directory, name));
  const source = path.join(directory, "source");
  const bare = path.join(directory, "origin.git");
  const env = {
    PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
    HOME: directory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(source, "init", "-q", "--initial-branch=main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  fs.writeFileSync(path.join(source, "README.md"), "fixture\n");
  if (projectConfig) {
    fs.mkdirSync(path.join(source, ".herdr"));
    fs.writeFileSync(
      path.join(source, ".herdr", "exe.json"),
      JSON.stringify(projectConfig),
    );
  }
  git(source, "add", ".");
  git(source, "commit", "-qm", "initial");
  git(source, "clone", "--bare", ".", bare);
  git(
    source,
    "remote",
    "add",
    "origin",
    "ssh://git@origin.example.test/project.git",
  );
  fs.writeFileSync(
    path.join(directory, "identity with spaces"),
    "fabricated fixture identity\n",
  );
  fs.writeFileSync(
    path.join(directory, "config", "config.json"),
    JSON.stringify({
      identityFile: path.join(directory, "identity with spaces"),
      cpu: 2,
      memory: "4GB",
      disk: "20GB",
    }),
  );
  fs.writeFileSync(
    path.join(directory, "ssh-config"),
    `Include ${path.join(directory, "state", "routes", "*.conf")}\n`,
  );
  fs.writeFileSync(
    path.join(directory, "transport.json"),
    JSON.stringify({
      vms: [],
      machines: [],
      workspaces: [],
      tabs: [],
      panes: [],
    }),
  );
  fs.writeFileSync(path.join(directory, "control.json"), "{}");
  const cli = fileURLToPath(new URL("./fixture-cli.mjs", import.meta.url));
  const wrapper = (target, mode) =>
    fs.writeFileSync(
      target,
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} ${quote(mode)} "$@"\n`,
      { mode: 0o755 },
    );
  wrapper(path.join(directory, "bin", "ssh"), "ssh");
  wrapper(path.join(directory, "bin", "herdr"), "local-herdr");
  wrapper(path.join(directory, "remote-bin", "herdr"), "remote-herdr");
  fs.writeFileSync(
    path.join(directory, "remote-bin", "bash"),
    '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(directory, "remote-bin", "pi"),
    '#!/bin/sh\nprintf "agent ran\\n" >> "$HOME/agent-runs"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(directory, "origin-ssh"),
    `#!/bin/sh\nexec git-upload-pack ${quote(bare)}\n`,
    { mode: 0o755 },
  );
  installFlock(path.join(directory, "remote-bin"));
  Object.assign(env, {
    EXE_FIXTURE: directory,
    HERDR_PLUGIN_STATE_DIR: path.join(directory, "state"),
    HERDR_PLUGIN_CONFIG_DIR: path.join(directory, "config"),
    HERDR_BIN_PATH: path.join(directory, "bin", "herdr"),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: source }),
  });
  return {
    directory,
    source,
    bare,
    env,
    git,
    invoke(action, extra = {}, options = {}) {
      return spawnSync(
        process.execPath,
        [path.join(ROOT, "src", "action.mjs")],
        {
          env: { ...env, HERDR_PLUGIN_ACTION_ID: action, ...extra },
          encoding: "utf8",
          timeout: 30000,
          ...options,
        },
      );
    },
    provision(extra = {}) {
      return spawnSync(
        process.execPath,
        [path.join(ROOT, "src", "provision.mjs")],
        {
          env: {
            ...env,
            HERDR_EXE_DEV_ACTION: "start-agent",
            HERDR_EXE_DEV_CWD: source,
            ...extra,
          },
          encoding: "utf8",
          timeout: 30000,
        },
      );
    },
    mapping() {
      const mappings = path.join(directory, "state", "mappings");
      const id = fs.readdirSync(mappings)[0];
      return JSON.parse(
        fs.readFileSync(path.join(mappings, id, "entry.json"), "utf8"),
      );
    },
    control(value) {
      fs.writeFileSync(
        path.join(directory, "control.json"),
        JSON.stringify(value),
      );
    },
    transport() {
      return JSON.parse(
        fs.readFileSync(path.join(directory, "transport.json"), "utf8"),
      );
    },
    calls() {
      return fs
        .readFileSync(path.join(directory, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
    },
  };
}
