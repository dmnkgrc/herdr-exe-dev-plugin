import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = process.env.EXE_FIXTURE;
if (!directory) throw new Error("Disposable fixture directory required.");
const mode = process.argv[2];
let args = process.argv.slice(3);
const file = path.join(directory, "transport.json");
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const control = JSON.parse(
  fs.readFileSync(path.join(directory, "control.json"), "utf8"),
);
fs.appendFileSync(
  path.join(directory, "calls.jsonl"),
  `${JSON.stringify({ mode, args })}\n`,
);
const persist = () => fs.writeFileSync(file, JSON.stringify(state));
const print = (value) => console.log(JSON.stringify(value));
const reply = (value) => print({ id: "fixture", result: value });
const remoteRoot = path.join(directory, "remote-home", "project");
const remoteEnvironment = {
  PATH: `${path.join(directory, "remote-bin")}:${process.env.PATH}`,
  HOME: path.join(directory, "remote-home"),
  EXE_FIXTURE: directory,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSH_COMMAND: path.join(directory, "origin-ssh"),
  GIT_SSH_VARIANT: "ssh",
};
function execute(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    timeout: 15000,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1])
    throw new Error(`Missing fixture option ${name}`);
  return args[index + 1];
}
function pane(workspace, tab) {
  const index = state.panes.length + 1;
  const value = {
    pane_id: `w${workspace.number}:p${index}`,
    terminal_id: `terminal-${index}`,
    workspace_id: workspace.workspace_id,
    tab_id: tab,
    cwd: "/home/exedev/project",
    agent: null,
    agent_status: "unknown",
    revision: 0,
    focused: false,
  };
  state.panes.push(value);
  return value;
}

if (mode === "ssh") {
  if (args[0] === "-G") {
    execute("/usr/bin/ssh", [
      "-F",
      path.join(directory, "ssh-config"),
      ...args,
    ]);
  } else if (args.includes("exe.dev")) {
    args = args.slice(args.indexOf("exe.dev") + 1);
    if (args[0] === "ls" && args[1] === "--json") {
      if (state.deleted && control.loseDeleteInventory)
        throw new Error("Simulated inventory outage after deletion.");
      print({ vms: state.vms });
    } else if (args[0] === "new") {
      if (
        args.length !== 7 ||
        !args[1].startsWith("--name=") ||
        args[5] !== "--tag=herdr-exe-dev" ||
        args[6] !== "--json"
      )
        throw new Error("Unexpected provider allocation argv.");
      const name = args[1].slice(7);
      state.vms.push({
        vm_name: name,
        created_at: "fixture-creation-1",
        tags: ["herdr-exe-dev"],
        ssh_dest: control.alternateRoute
          ? `vm+${name}@vm.exe.xyz`
          : `${name}.exe.xyz`,
        ssh_host: control.alternateRoute ? "vm.exe.xyz" : `${name}.exe.xyz`,
        ssh_user: control.alternateRoute ? `vm+${name}` : undefined,
      });
      persist();
      if (control.loseCreateResponse)
        throw new Error("Simulated lost create response.");
      print({});
    } else if (args[0] === "cp") {
      if (
        args.length !== 8 ||
        args[3] !== "--copy-tags=false" ||
        !args[4].startsWith("--cpu=") ||
        !args[5].startsWith("--memory=") ||
        !args[6].startsWith("--disk=") ||
        args[7] !== "--json"
      )
        throw new Error("Unexpected provider copy argv.");
      if (!state.vms.some((vm) => vm.vm_name === args[1]))
        throw new Error(`Unknown copy source: ${args[1]}`);
      if (control.refuseCopy) {
        print({ error: control.refuseCopy });
        process.exit(1);
      }
      const name = args[2];
      state.vms.push({
        vm_name: name,
        created_at: "fixture-creation-copy",
        tags: [],
        ssh_dest: `${name}.exe.xyz`,
        ssh_host: `${name}.exe.xyz`,
      });
      persist();
      print({});
    } else if (args[0] === "tag") {
      if (args.length !== 4 || args[3] !== "--json")
        throw new Error("Unexpected provider tag argv.");
      const target = state.vms.find((vm) => vm.vm_name === args[1]);
      if (!target) throw new Error(`Unknown tag target: ${args[1]}`);
      if (control.failCopyTag) throw new Error("Simulated tag failure.");
      target.tags = [...new Set([...target.tags, args[2]])];
      persist();
      print({});
    } else if (args[0] === "rm" && args.length === 3 && args[2] === "--json") {
      state.vms = state.vms.filter((vm) => vm.vm_name !== args[1]);
      state.deleted = true;
      persist();
      if (control.loseDeleteResponse)
        throw new Error("Simulated lost delete response.");
      print({});
    } else throw new Error(`Unexpected provider argv: ${args}`);
  } else {
    if (args.length !== 25 || !args.at(-1).startsWith("bash -lc '"))
      throw new Error("Remote command serialization changed.");
    const input = fs.readFileSync(0);
    execute(
      "/bin/sh",
      ["-c", args.at(-1).replaceAll("/home/exedev/project", remoteRoot)],
      {
        input,
        env: remoteEnvironment,
        cwd: remoteEnvironment.HOME,
      },
    );
    if (control.startAfterInspection && args.at(-1).includes("git rev-list")) {
      control.busyPane = state.panes.at(-1).pane_id;
      fs.writeFileSync(
        path.join(directory, "control.json"),
        JSON.stringify(control),
      );
    }
  }
} else if (mode === "local-herdr") {
  if (args[0] === "--version") console.log("herdr 0.9.0");
  else if (args[0] === "plugin" && args[1] === "pane" && args[2] === "open") {
    if (option("--plugin") !== "exe-dev")
      throw new Error("Wrong plugin identity.");
  } else if (args.join(" ") === "machine list --json") print(state.machines);
  else if (args[0] === "machine" && args[1] === "add") {
    state.machines.push({
      id: "machine-1",
      target: args[2],
      session: option("--remote-session"),
      enabled: true,
    });
    persist();
  } else if (args[0] === "machine" && args[1] === "enable") {
    const machine = state.machines.find((value) => value.id === args[2]);
    if (!machine) throw new Error("Unknown machine.");
    machine.enabled = true;
    persist();
  } else if (args[0] === "machine" && args[1] === "remove") {
    if (control.failCleanup) throw new Error("Simulated cleanup failure.");
    state.machines = state.machines.filter((value) => value.id !== args[2]);
    persist();
    if (control.loseCleanupReply)
      throw new Error("Simulated lost cleanup response.");
  } else throw new Error(`Unexpected local Herdr argv: ${args}`);
} else if (mode === "remote-herdr") {
  if (args[0] === "--version") console.log("herdr 0.9.0");
  else if (args[0] === "--skill")
    console.log("# Fixture Herdr skill\nRemote fixture commands only.");
  else {
    if (args[0] !== "--session" || args[1] !== "exe-dev")
      throw new Error("Missing explicit remote session.");
    args = args.slice(2);
    if (args.join(" ") === "workspace list") {
      if (control.serverNotRunning) {
        console.error(
          JSON.stringify({
            id: "cli:workspace:list",
            error: {
              code: "server_not_running",
              message: "no herdr server is running",
            },
          }),
        );
        process.exit(1);
      }
      reply({ type: "workspace_list", workspaces: state.workspaces });
    }
    else if (args[0] === "workspace" && args[1] === "create") {
      if (option("--cwd") !== remoteRoot)
        throw new Error("Workspace cwd was not the fixture checkout.");
      const number = state.workspaces.length + 1;
      const workspace = {
        workspace_id: `w${number}`,
        number,
        label: option("--label"),
        focused: false,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: `w${number}:t1`,
        agent_status: "unknown",
      };
      const tab = {
        tab_id: workspace.active_tab_id,
        workspace_id: workspace.workspace_id,
        number: 1,
        label: "shell",
        pane_count: 1,
        focused: false,
        agent_status: "unknown",
      };
      state.workspaces.push(workspace);
      state.tabs.push(tab);
      const rootPane = pane(workspace, tab.tab_id);
      persist();
      if (control.loseWorkspaceResponse)
        throw new Error("Simulated lost workspace response.");
      reply({ type: "workspace_created", workspace, tab, root_pane: rootPane });
    } else if (args[0] === "workspace" && args[1] === "get") {
      const workspace = state.workspaces.find(
        (value) => value.workspace_id === args[2],
      );
      if (!workspace) throw new Error("Unknown workspace.");
      reply({ type: "workspace_info", workspace });
    } else if (args[0] === "workspace" && args[1] === "focus") {
      if (!state.workspaces.some((value) => value.workspace_id === args[2]))
        throw new Error("Unknown workspace.");
      reply({ type: "ok" });
    } else if (args[0] === "pane" && args[1] === "list") {
      reply({
        type: "pane_list",
        panes: state.panes.filter(
          (value) => value.workspace_id === option("--workspace"),
        ),
      });
    } else if (args[0] === "tab" && args[1] === "create") {
      const workspace = state.workspaces.find(
        (value) => value.workspace_id === option("--workspace"),
      );
      if (!workspace || option("--cwd") !== remoteRoot)
        throw new Error("Unknown tab target.");
      const number = state.tabs.length + 1;
      const tab = {
        tab_id: `${workspace.workspace_id}:t${number}`,
        workspace_id: workspace.workspace_id,
        number,
        label: option("--label"),
        pane_count: 1,
        focused: false,
        agent_status: "unknown",
      };
      state.tabs.push(tab);
      const rootPane = pane(workspace, tab.tab_id);
      persist();
      reply({ type: "tab_created", tab, root_pane: rootPane });
    } else if (args[0] === "pane" && args[1] === "run") {
      if (
        args.length !== 4 ||
        !state.panes.some((value) => value.pane_id === args[2])
      )
        throw new Error("Unsafe pane dispatch.");
      execute("/bin/sh", ["-c", args.slice(3).join(" ")], {
        env: remoteEnvironment,
        cwd: remoteRoot,
      });
      reply({ type: "ok" });
    } else if (args[0] === "pane" && args[1] === "process-info") {
      const value = state.panes.find(
        (item) => item.pane_id === option("--pane"),
      );
      if (!value) throw new Error("Unknown process target.");
      reply({
        type: "pane_process_info",
        process_info: {
          pane_id: value.pane_id,
          shell_pid: 100,
          foreground_process_group_id:
            control.busyPane === value.pane_id ? 200 : 100,
          foreground_processes: [{ pid: 100, name: "bash" }],
        },
      });
    } else throw new Error(`Unexpected remote Herdr argv: ${args}`);
  }
} else throw new Error(`Unexpected fixture mode: ${mode}`);
