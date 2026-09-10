import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installFlock } from "./fixture.mjs";
import {
  MissingMappingError,
  allocate,
  assertSameSeed,
  captureSeed,
  createBundle,
  credentialFreeUrl,
  initializeRoute,
  inspectionScript,
  load,
  prepareVm,
  sshG,
  makeEntry,
  prepareRoute,
  remoteArgs,
  save,
  seedScript,
} from "../src/core.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    ...options,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}
function project(t, name, origin = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `herdr-exe-${name}-`));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "work");
  run("git", ["init", "-q", root]);
  run("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
  run("git", ["-C", root, "config", "user.name", "Fixture"]);
  fs.mkdirSync(path.join(root, name === "nested" ? "app" : "src"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, name === "nested" ? "app" : "src", "file.txt"),
    name,
  );
  run("git", ["-C", root, "add", "."]);
  run("git", ["-C", root, "commit", "-qm", "initial"]);
  let bare;
  if (origin) {
    bare = path.join(base, "origin.git");
    run("git", ["init", "--bare", "-q", bare]);
    run("git", ["-C", root, "push", "-q", bare, "HEAD:refs/heads/master"]);
    run("git", [
      "--git-dir",
      bare,
      "symbolic-ref",
      "HEAD",
      "refs/heads/master",
    ]);
    run("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://example.test/fixture.git",
    ]);
  }
  return { base, root, bare };
}
function settings(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-exe-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key with space");
  fs.writeFileSync(key, "fixture");
  return {
    identityFile: fs.realpathSync(key),
    sshUser: "exedev",
    cpu: 2,
    memory: "4GB",
    disk: "20GB",
    agent: "pi",
    argv: ["pi"],
  };
}
function entry(t, fixture) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-exe-state-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  return [
    state,
    initializeRoute(makeEntry(state, captureSeed(fixture.root), settings(t))),
  ];
}
function executeScript(script, root, home) {
  const physicalRoot = path.join(
    fs.realpathSync(path.dirname(root)),
    path.basename(root),
  );
  const rewritten = script.replaceAll("/home/exedev/project", physicalRoot);
  const bin = path.join(home, "fixture-bin");
  installFlock(bin);
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", rewritten], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

test("captures two real repository layouts and executes the generated bundle seed script", (t) => {
  for (const name of ["flat", "nested"]) {
    const fixture = project(t, name, false);
    const seed = captureSeed(fixture.root);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exe-bundle-"));
    const bundle = { dir, file: path.join(dir, "seed.bundle") };
    t.after(() => fs.rmSync(bundle.dir, { recursive: true, force: true }));
    createBundle(seed, bundle.file);
    const [state, mapped] = entry(t, fixture);
    fs.mkdirSync(path.join(fixture.base, "home"));
    fs.copyFileSync(
      bundle.file,
      path.join(fixture.base, "home", "herdr-exe-seed.bundle"),
    );
    const remoteRoot = path.join(fixture.base, "remote project");
    const seeded = executeScript(
      seedScript(mapped),
      remoteRoot,
      path.join(fixture.base, "home"),
    );
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.equal(
      run("git", ["-C", remoteRoot, "rev-parse", "HEAD"]),
      seed.revision,
    );
    assert.ok(fs.existsSync(state));
  }
});

test("SSH serializes one shell-quoted command under OpenSSH joined-command semantics", (t) => {
  const fixture = project(t, "flat");
  const [, mapped] = entry(t, fixture);
  const args = remoteArgs(mapped, "set -eu\nprintf '%s\\n' SCRIPT_OK");
  assert.equal(args.length, 17);
  const result = spawnSync("sh", ["-c", args.at(-1)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "SCRIPT_OK");
  assert.match(args.at(-1), /^bash -lc '/);
});

test("mapping loads fail closed and allocation binds only one authenticated creation", (t) => {
  const fixture = project(t, "flat");
  const [state, mapped] = entry(t, fixture);
  save(state, mapped);
  fs.writeFileSync(path.join(state, "mappings", mapped.id, "entry.json"), "{");
  assert.throws(() => load(state, mapped.id), /Invalid mapping JSON/);
  assert.throws(() => load(state, "0".repeat(64)), MissingMappingError);
  save(state, mapped);
  const vms = [];
  const fake = (_bin, args) => {
    if (args[0] === "-G")
      return `hostname ${mapped.vm.route.host}\nuser exedev\nidentityfile ${mapped.settings.identityFile}\nidentitiesonly yes\nidentityagent none\nforwardagent no\nproxycommand none\nbatchmode yes\n`;
    if (args.includes("ls")) return JSON.stringify({ vms });
    if (args.some((value) => value.startsWith("--name="))) {
      vms.push({
        vm_name: mapped.vm.name,
        created_at: "created",
        tags: ["herdr-exe-dev"],
        ssh_host: mapped.vm.route.host,
        ssh_user: mapped.vm.route.user,
      });
      return "{}";
    }
    throw new Error(`unexpected provider argv: ${args.join("|")}`);
  };
  allocate(state, mapped, fake);
  assert.equal(mapped.phase, "created");
  assert.equal(mapped.vm.createdAt, "created");
  assert.throws(() => allocate(state, mapped, fake), /already attempted/);
});

test("inspection script runs in a real checkout and rejects destructive edge cases", (t) => {
  const fixture = project(t, "nested");
  const [, mapped] = entry(t, fixture);
  const remote = path.join(fixture.base, "remote");
  run("git", ["clone", "-q", fixture.bare, remote]);
  run("git", ["-C", remote, "config", "user.name", "Fixture"]);
  run("git", ["-C", remote, "config", "user.email", "fixture@example.test"]);
  mapped.seed.origin = run("git", [
    "-C",
    remote,
    "remote",
    "get-url",
    "origin",
  ]);
  const home = path.join(fixture.base, "home");
  fs.mkdirSync(home);
  const inspect = () => executeScript(inspectionScript(mapped), remote, home);
  const initial = inspect();
  assert.equal(initial.status, 0, `${initial.stdout}\n${initial.stderr}`);
  fs.writeFileSync(path.join(remote, "dirty"), "x");
  assert.notEqual(inspect().status, 0);
  fs.rmSync(path.join(remote, "dirty"));
  fs.appendFileSync(
    path.join(remote, run("git", ["-C", remote, "ls-files"]).split("\n")[0]),
    "changed",
  );
  run("git", ["-C", remote, "stash", "push", "-qm", "fixture"]);
  assert.notEqual(inspect().status, 0);
  run("git", ["-C", remote, "stash", "clear"]);
  run("git", [
    "-C",
    remote,
    "worktree",
    "add",
    "-q",
    path.join(fixture.base, "linked"),
  ]);
  assert.notEqual(inspect().status, 0);
  run("git", [
    "-C",
    remote,
    "worktree",
    "remove",
    "--force",
    path.join(fixture.base, "linked"),
  ]);
  fs.writeFileSync(path.join(remote, "unpublished"), "x");
  run("git", ["-C", remote, "add", "."]);
  run("git", ["-C", remote, "commit", "-qm", "unpublished"]);
  const unpublished = run("git", ["-C", remote, "rev-parse", "HEAD"]);
  assert.notEqual(inspect().status, 0);
  run("git", ["-C", remote, "reset", "--hard", "-q", "origin/HEAD"]);
  run("git", ["-C", remote, "tag", "private-tag", unpublished]);
  assert.notEqual(inspect().status, 0);
  run("git", ["-C", remote, "tag", "-d", "private-tag"]);
  run("git", ["-C", remote, "tag", "private-name", "HEAD"]);
  assert.notEqual(inspect().status, 0);
  run("git", ["-C", remote, "push", "origin", "refs/tags/private-name"]);
  assert.equal(inspect().status, 0);
  run("git", ["-C", remote, "tag", "-d", "private-name"]);
  run("git", ["-C", remote, "checkout", "--detach", "-q"]);
  assert.notEqual(inspect().status, 0);
  run("git", ["-C", remote, "checkout", "-q", "-"]);
  run("git", ["-C", remote, "remote", "remove", "origin"]);
  assert.notEqual(inspect().status, 0);
});

test("ambiguous creates retain intent, routing mismatches fail, and setup retries keep the frozen seed", (t) => {
  const fixture = project(t, "flat");
  const [state, mapped] = entry(t, fixture);
  save(state, mapped);
  const vms = [
    { vm_name: mapped.vm.name, created_at: "old", tags: ["herdr-exe-dev"] },
  ];
  const provider = (_bin, args) => {
    if (args.includes("ls")) return JSON.stringify({ vms });
    if (args.some((value) => value.startsWith("--name="))) {
      vms.push({
        vm_name: mapped.vm.name,
        created_at: "new",
        tags: ["herdr-exe-dev"],
      });
      return "{}";
    }
    throw new Error("unexpected provider command");
  };
  assert.throws(
    () => allocate(state, mapped, provider),
    /Ambiguous.*inventory/,
  );
  assert.equal(mapped.phase, "creating");
  assert.throws(
    () =>
      sshG(mapped, () => "hostname wrong\nuser exedev\nidentityfile nowhere\n"),
    /routing is not active/,
  );
  mapped.vm.createdAt = "new";
  mapped.phase = "created";
  mapped.seeded = true;
  mapped.project.setup = ["false"];
  save(state, mapped);
  let attempts = 0;
  const transport = {
    run: (_bin, args) => {
      if (args.at(-1).includes("false")) {
        attempts++;
        if (attempts === 1) throw new Error("setup failed");
      }
      return "";
    },
  };
  assert.throws(
    () => prepareVm(state, mapped, undefined, transport),
    /setup failed/,
  );
  prepareVm(state, mapped, undefined, transport);
  assert.equal(mapped.phase, "ready");
  assert.equal(attempts, 2);
});

test("Git URL validation rejects local and credential-bearing transports", () => {
  assert.equal(
    credentialFreeUrl("https://github.com/example/project.git"),
    true,
  );
  assert.equal(credentialFreeUrl("ssh://git@example.test/project.git"), true);
  assert.equal(credentialFreeUrl("git@example.test:team/project.git"), true);
  for (const value of [
    "file:///tmp/repo",
    "https://user:token@example.test/a",
    "https://example.test/a?token=x",
    "https://example.test/a#token",
    "ext::helper",
  ])
    assert.equal(credentialFreeUrl(value), false, value);
});

test("seed races include origin changes", (t) => {
  const fixture = project(t, "flat");
  const seed = captureSeed(fixture.root);
  run("git", [
    "-C",
    fixture.root,
    "remote",
    "set-url",
    "origin",
    "https://example.test/changed.git",
  ]);
  assert.throws(() => assertSameSeed(seed), /changed/);
  const [state, mapped] = entry(t, fixture);
  prepareRoute(state, mapped);
  assert.match(
    fs.readFileSync(
      path.join(state, "routes", `${mapped.vm.name}.conf`),
      "utf8",
    ),
    /IdentityFile ".*key with space"/,
  );
});
