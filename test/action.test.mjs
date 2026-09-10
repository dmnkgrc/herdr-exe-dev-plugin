import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { ROOT } from "../src/core.mjs";
import { fixture } from "./fixture.mjs";

function successful(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const allocations = (f) =>
  f.calls().filter((call) => call.mode === "ssh" && call.args.includes("new"))
    .length;

test("real scripts provision an ordinary repository once, open independent tabs and reconnect without seeding", (t) => {
  const f = fixture(t);
  f.git(f.source, "commit", "--allow-empty", "-qm", "unpublished seed");
  assert.equal(
    successful(f.invoke("start-agent")).phase,
    "preparation-submitted",
  );
  assert.equal(f.transport().vms.length, 0);
  assert.equal(successful(f.provision()).phase, "agent-submitted");
  const mapped = f.mapping();
  const remote = path.join(f.directory, "remote-home", "project");
  assert.equal(f.git(remote, "rev-parse", "HEAD"), mapped.seed.revision);
  assert.notEqual(
    f.git(f.bare, "rev-parse", "refs/heads/main"),
    mapped.seed.revision,
  );
  assert.equal(successful(f.provision()).phase, "agent-submitted");
  const before = f.transport();
  assert.equal(successful(f.invoke("reconnect")).phase, "workspace-focused");
  assert.deepEqual(f.transport(), before);
  assert.equal(allocations(f), 1);
  assert.equal(before.workspaces.length, 1);
  assert.equal(before.tabs.length, 3);
  assert.equal(
    fs.readFileSync(
      path.join(f.directory, "remote-home", "agent-runs"),
      "utf8",
    ),
    "agent ran\nagent ran\n",
  );
});

test("lost creation response recovers the recorded bundle without allocating again", (t) => {
  const f = fixture(t);
  f.control({ loseCreateResponse: true, alternateRoute: true });
  assert.notEqual(f.provision().status, 0);
  const mapped = f.mapping();
  assert.equal(mapped.phase, "creating");
  assert.ok(
    fs.existsSync(
      path.join(f.directory, "state", "mappings", mapped.id, "seed.bundle"),
    ),
  );
  f.control({});
  assert.equal(successful(f.invoke("status")).phase, "creating");
  assert.equal(successful(f.invoke("recover")).phase, "ready");
  assert.equal(f.mapping().vm.route.user, `vm+${mapped.vm.name}`);
  assert.equal(f.mapping().vm.route.host, "vm.exe.xyz");
  assert.equal(allocations(f), 1);
  assert.equal(f.transport().tabs.length, 1);
  assert.equal(successful(f.provision()).phase, "agent-submitted");
});

test("failed setup retries the frozen hook and completes attachment without reseeding", (t) => {
  const f = fixture(t, { setup: ["sh", "-c", 'test -f "$HOME/allow-setup"'] });
  assert.notEqual(f.provision().status, 0);
  const original = f.mapping();
  assert.equal(original.phase, "setup-failed");
  assert.equal(original.seeded, true);
  assert.equal(successful(f.invoke("status")).phase, "setup-failed");
  fs.writeFileSync(
    path.join(f.source, ".herdr", "exe.json"),
    JSON.stringify({ setup: ["false"] }),
  );
  fs.writeFileSync(
    path.join(f.directory, "remote-home", "allow-setup"),
    "allowed",
  );
  assert.equal(successful(f.invoke("retry-setup")).phase, "ready");
  assert.equal(f.mapping().seed.revision, original.seed.revision);
  assert.ok(f.mapping().workspaceId);
  assert.equal(allocations(f), 1);
});

test("linked worktree moves retain their own administrative identity; removed worktrees use explicit selection", (t) => {
  const f = fixture(t);
  const linked = path.join(f.directory, "linked");
  const moved = path.join(f.directory, "moved");
  f.git(f.source, "worktree", "add", "-qb", "topic", linked);
  successful(f.provision({ HERDR_EXE_DEV_CWD: linked }));
  const mapped = f.mapping();
  f.git(f.source, "worktree", "move", linked, moved);
  successful(
    f.invoke("reconnect", {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: moved }),
    }),
  );
  f.git(f.source, "worktree", "remove", moved);
  successful(
    f.invoke("reconnect", {
      HERDR_EXE_DEV_MAPPING: mapped.id,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: moved }),
    }),
  );
  assert.equal(allocations(f), 1);
});

test("real ssh -G rejects extra identities before allocation and reuses its intent after route repair", (t) => {
  const f = fixture(t);
  const sshConfig = path.join(f.directory, "ssh-config");
  const original = fs.readFileSync(sshConfig, "utf8");
  fs.appendFileSync(
    sshConfig,
    "Host *\n IdentityFile /fixture/unapproved-identity\n",
  );
  const refused = f.provision();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /routing is not active/);
  const name = f.mapping().vm.name;
  assert.equal(f.transport().vms.length, 0);
  assert.notEqual(f.invoke("recover").status, 0);
  assert.equal(f.transport().vms.length, 0);
  fs.writeFileSync(sshConfig, original);
  successful(f.provision());
  assert.equal(f.mapping().vm.name, name);
  assert.equal(allocations(f), 1);
});

test("lost workspace creation is reconciled without duplicating the workspace or VM", (t) => {
  const f = fixture(t);
  f.control({ loseWorkspaceResponse: true });
  assert.notEqual(f.provision().status, 0);
  assert.equal(f.mapping().phase, "ready");
  assert.equal(f.transport().workspaces.length, 1);
  f.control({});
  assert.equal(successful(f.invoke("recover")).phase, "ready");
  assert.equal(f.transport().workspaces.length, 1);
  assert.equal(allocations(f), 1);
});

test("confirmed deletion rejects unpublished work and active processes, and reconciles a lost delete response", (t) => {
  const f = fixture(t);
  successful(f.provision());
  const mapped = f.mapping();
  const remote = path.join(f.directory, "remote-home", "project");
  const remove = () =>
    spawnSync(process.execPath, [path.join(ROOT, "src", "confirm.mjs")], {
      env: { ...f.env, HERDR_EXE_DEV_MAPPING: mapped.id },
      input: `${mapped.vm.name}\n`,
      encoding: "utf8",
      timeout: 30000,
    });
  fs.writeFileSync(path.join(remote, "unpublished.txt"), "private work\n");
  f.git(remote, "config", "user.name", "Fixture");
  f.git(remote, "config", "user.email", "fixture@example.test");
  f.git(remote, "add", ".");
  f.git(remote, "commit", "-qm", "unpublished");
  assert.notEqual(remove().status, 0);
  assert.equal(f.transport().vms.length, 1);
  f.git(remote, "push", f.bare, "HEAD:refs/heads/main");
  f.control({ busyPane: f.transport().panes.at(-1).pane_id });
  const busy = remove();
  assert.notEqual(busy.status, 0);
  assert.match(busy.stderr, /idle shell/);
  f.control({ startAfterInspection: true });
  const raced = remove();
  assert.notEqual(raced.status, 0);
  assert.match(raced.stderr, /idle shell/);
  f.control({ loseDeleteResponse: true, loseDeleteInventory: true });
  assert.notEqual(remove().status, 0);
  assert.equal(f.mapping().phase, "deleting");
  f.control({ failCleanup: true });
  assert.equal(successful(f.invoke("recover")).phase, "deleted");
  assert.match(successful(f.invoke("status")).cleanupError, /cleanup failure/);
  f.control({ loseCleanupReply: true });
  assert.match(
    successful(f.invoke("recover")).cleanupError,
    /lost cleanup response/,
  );
  f.control({});
  assert.equal(successful(f.invoke("recover")).cleanupError, undefined);
  assert.equal(f.mapping().phase, "deleted");
  assert.equal(f.transport().vms.length, 0);
  assert.equal(f.transport().machines.length, 0);
  assert.equal(
    f.calls().filter((call) => call.mode === "ssh" && call.args.includes("rm"))
      .length,
    1,
  );
});
