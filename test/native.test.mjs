import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { quote } from "../src/core.mjs";

const version = spawnSync("herdr", ["--version"], { encoding: "utf8" });
const installed = version.stdout.trim().match(/^herdr (0\.9\.[0-9]+)$/);
test(
  "native Herdr 0.9.x preserves protocol envelopes and sends the quoted pane command intact",
  {
    skip:
      version.status !== 0 || !installed
        ? "Herdr 0.9.x is not installed"
        : false,
  },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hw-"));
    const socket = path.join(directory, "api.sock");
    const workspace = {
      workspace_id: "w1",
      number: 1,
      label: "fixture",
      focused: false,
      pane_count: 1,
      tab_count: 1,
      active_tab_id: "w1:t1",
      agent_status: "unknown",
    };
    const requests = [];
    const clients = new Set();
    const server = net.createServer((client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      let pending = "";
      client.on("data", (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const request = JSON.parse(pending.slice(0, index));
          pending = pending.slice(index + 1);
          requests.push(request);
          const responses = {
            ping: { type: "pong", version: installed[1], protocol: 22 },
            "workspace.get": { type: "workspace_info", workspace },
            "workspace.list": {
              type: "workspace_list",
              workspaces: [workspace],
            },
            "pane.send_input": { type: "ok" },
            "pane.process_info": {
              type: "pane_process_info",
              process_info: {
                pane_id: "w1:p1",
                shell_pid: 100,
                foreground_process_group_id: 100,
                foreground_processes: [{ pid: 100, name: "bash" }],
              },
            },
          };
          assert.ok(responses[request.method], request.method);
          client.write(
            `${JSON.stringify({ id: request.id, result: responses[request.method] })}\n`,
          );
        }
      });
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    t.after(async () => {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const invoke = async (args) => {
      const child = spawn("herdr", args, {
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          HERDR_SOCKET_PATH: socket,
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_STATE_HOME: path.join(directory, "state"),
          XDG_RUNTIME_DIR: path.join(directory, "runtime"),
        },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 0, stderr);
      return stdout ? JSON.parse(stdout).result : undefined;
    };
    assert.deepEqual(
      (await invoke(["workspace", "get", "w1"])).workspace,
      workspace,
    );
    assert.deepEqual((await invoke(["workspace", "list"])).workspaces, [
      workspace,
    ]);
    assert.equal(
      (await invoke(["pane", "process-info", "--pane", "w1:p1"])).process_info
        .shell_pid,
      100,
    );
    const command = `sh -lc ${quote("cd '/fixture project' && exec 'printf' '%s\\n' 'hello world'")}`;
    await invoke(["pane", "run", "w1:p1", command]);
    assert.deepEqual(
      requests.find((request) => request.method === "pane.send_input").params,
      { pane_id: "w1:p1", text: command, keys: ["Enter"] },
    );
  },
);
