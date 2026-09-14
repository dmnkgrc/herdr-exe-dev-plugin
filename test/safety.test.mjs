import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  ROOT,
  captureSeed,
  commandScript,
  initializeRoute,
  installSkill,
  load,
  makeEntry,
  mappingId,
  ownedVm,
  providerList,
  reconcileDeletion,
  quote,
  save,
} from "../src/core.mjs";
import { fixture } from "./fixture.mjs";

function mapped(f) {
  const settings = JSON.parse(
    fs.readFileSync(path.join(f.directory, "config", "config.json"), "utf8"),
  );
  settings.sshUser = "exedev";
  return initializeRoute(
    makeEntry(path.join(f.directory, "state"), captureSeed(f.source), settings),
  );
}

test("sibling worktrees cannot inherit another removed worktree's mapping", (t) => {
  const f = fixture(t);
  const first = path.join(f.directory, "first");
  const second = path.join(f.directory, "second");
  f.git(f.source, "worktree", "add", "-qb", "first", first);
  f.git(f.source, "worktree", "add", "-qb", "second", second);
  const a = captureSeed(first),
    b = captureSeed(second);
  assert.equal(a.commonDir, b.commonDir);
  assert.notEqual(
    mappingId(a.gitDir, a.commonDir),
    mappingId(b.gitDir, b.commonDir),
  );
});

test("symlinked state directories and malformed frozen configuration fail closed", (t) => {
  const f = fixture(t);
  const entry = mapped(f);
  const state = path.join(f.directory, "state");
  const outside = path.join(f.directory, "outside");
  fs.mkdirSync(state);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(state, "mappings"));
  assert.throws(() => save(state, entry), /unsafe state directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(path.join(state, "mappings"));
  save(state, entry);
  const file = path.join(state, "mappings", entry.id, "entry.json");
  fs.writeFileSync(file, JSON.stringify({ ...entry, project: [] }));
  assert.throws(() => load(state, entry.id), /project configuration/);
  fs.writeFileSync(file, "{");
  assert.throws(() => load(state, entry.id), /Invalid mapping JSON/);
});

test("dirty, detached, unborn, LFS and initialized submodule seeds are rejected before allocation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "dirty"), "uncommitted");
  assert.notEqual(f.provision().status, 0);
  assert.equal(f.transport().vms.length, 0);
  fs.unlinkSync(path.join(f.source, "dirty"));
  f.git(f.source, "checkout", "--detach", "-q");
  assert.throws(() => captureSeed(f.source), /detached/);
  f.git(f.source, "checkout", "-q", "main");
  fs.writeFileSync(path.join(f.source, ".gitattributes"), "*.bin filter=lfs\n");
  fs.writeFileSync(
    path.join(f.source, "asset.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize 7\n`,
  );
  f.git(f.source, "add", ".");
  f.git(f.source, "commit", "-qm", "LFS fixture");
  assert.throws(() => captureSeed(f.source), /LFS/);
  f.git(f.source, "rm", ".gitattributes", "asset.bin");
  f.git(f.source, "commit", "-qm", "remove LFS fixture");
  const revision = f.git(f.source, "rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(f.source, ".gitmodules"),
    '[submodule "external"]\n path = external\n url = https://example.test/external.git\n',
  );
  f.git(f.source, "add", ".gitmodules");
  f.git(
    f.source,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${revision},external`,
  );
  fs.mkdirSync(path.join(f.source, "external"));
  f.git(f.source, "commit", "-qm", "submodule fixture");
  assert.doesNotThrow(() => captureSeed(f.source));
  f.git(
    f.source,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--quiet",
    f.bare,
    "vendored",
  );
  f.git(f.source, "commit", "-qm", "initialized submodule fixture");
  assert.throws(() => captureSeed(f.source), /submodules/i);
  const unborn = path.join(f.directory, "unborn");
  fs.mkdirSync(unborn);
  f.git(unborn, "init", "-q");
  assert.throws(() => captureSeed(unborn));
  assert.equal(f.transport().vms.length, 0);
});

test("shell serialization preserves empty, quoted and multiline arguments and stops on failed cd", (t) => {
  const f = fixture(t);
  const target = path.join(f.directory, "arguments.json");
  const values = ["", "two words", "a'b", "$(touch not-executed)", "one\ntwo"];
  const argv = [
    process.execPath,
    "-e",
    "require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)))",
    target,
    ...values,
  ];
  const script = `sh -lc ${quote(commandScript(argv).replaceAll("/home/exedev/project", f.source))}`;
  const result = spawnSync("sh", ["-c", script], {
    env: f.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), values);
  fs.unlinkSync(target);
  const absent = commandScript(argv).replaceAll(
    "/home/exedev/project",
    path.join(f.directory, "absent"),
  );
  assert.notEqual(
    spawnSync("sh", ["-c", `sh -lc ${quote(absent)}`], { env: f.env }).status,
    0,
  );
  assert.equal(fs.existsSync(target), false);
});

test("provider replacement, missing tags and changed routing never match saved ownership", (t) => {
  const f = fixture(t),
    entry = mapped(f);
  entry.vm.createdAt = "saved-creation";
  const vm = {
    vm_name: entry.vm.name,
    created_at: entry.vm.createdAt,
    tags: ["herdr-exe-dev"],
    ssh_host: entry.vm.route.host,
    ssh_user: "exedev",
  };
  assert.equal(ownedVm(entry, [vm]), vm);
  for (const changed of [
    { ...vm, created_at: "replacement" },
    { ...vm, tags: [] },
    { ...vm, ssh_host: "other.example.test" },
  ])
    assert.throws(() => ownedVm(entry, [changed]));
});

test("typed confirmation is invalidated when its saved mapping changes", async (t) => {
  const f = fixture(t),
    entry = mapped(f);
  save(f.env.HERDR_PLUGIN_STATE_DIR, entry);
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "src", "confirm.mjs")],
    {
      env: { ...f.env, HERDR_EXE_DEV_MAPPING: entry.id },
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "",
    submitted = false;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    if (submitted || !chunk.toString().includes(`Delete ${entry.vm.name}? [y/N]`))
      return;
    submitted = true;
    entry.settings.cpu += 1;
    save(f.env.HERDR_PLUGIN_STATE_DIR, entry);
    child.stdin.end("y\n");
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /Mapping changed during confirmation/);
  assert.equal(fs.existsSync(path.join(f.directory, "calls.jsonl")), false);
});

test("malformed inventory, removed tags and reused names cannot prove deletion", (t) => {
  const f = fixture(t),
    entry = mapped(f);
  entry.vm.createdAt = "original";
  entry.phase = "deleting";
  const state = f.env.HERDR_PLUGIN_STATE_DIR;
  save(state, entry);
  const inventory = (vms) => (_bin, args) => {
    assert.ok(args.includes("ls"));
    return JSON.stringify({ vms });
  };
  assert.throws(
    () => providerList(entry, inventory([null])),
    /Invalid.*inventory/,
  );
  for (const vm of [
    { vm_name: entry.vm.name, created_at: "original", tags: [] },
    {
      vm_name: entry.vm.name,
      created_at: "replacement",
      tags: ["herdr-exe-dev"],
    },
  ])
    assert.throws(
      () => reconcileDeletion(state, entry, inventory([vm])),
      /still present/,
    );
  assert.equal(load(state, entry.id).phase, "deleting");
});

test("skill installation does not follow a directory symlink into the checkout", (t) => {
  const f = fixture(t);
  const home = path.join(f.directory, "remote-home");
  fs.mkdirSync(path.join(home, ".agents"));
  fs.symlinkSync(f.source, path.join(home, ".agents", "skills"));
  assert.throws(
    () =>
      installSkill(mapped(f), (bin, args) => {
        assert.equal(bin, "ssh");
        const result = spawnSync("/bin/sh", ["-c", args.at(-1)], {
          env: {
            ...f.env,
            HOME: home,
            PATH: `${path.join(f.directory, "remote-bin")}:${f.env.PATH}`,
          },
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      }),
    /symlinked.*skill/,
  );
  assert.equal(fs.existsSync(path.join(f.source, "herdr")), false);
});

test("a deletion tombstone is retired so the worktree can allocate a new VM", (t) => {
  const f = fixture(t);
  assert.equal(f.provision().status, 0);
  const first = f.mapping();
  assert.equal(f.transport().vms.length, 1);
  const mappings = path.join(f.directory, "state", "mappings", first.id);
  fs.writeFileSync(
    path.join(mappings, "entry.json"),
    JSON.stringify({ ...first, phase: "deleted" }),
  );
  // The fixture shares one remote home; a replacement VM starts without a checkout.
  fs.rmSync(path.join(f.directory, "remote-home", "project"), {
    recursive: true,
    force: true,
  });
  const retry = f.provision();
  assert.doesNotMatch(retry.stderr, /tombstone/);
  const second = f.mapping();
  assert.equal(second.id, first.id);
  assert.notEqual(second.vm.name, first.vm.name);
  assert.notEqual(second.phase, "deleted");
  assert.equal(f.transport().vms.length, 2);
  const archived = fs
    .readdirSync(mappings)
    .filter((name) => name.startsWith("deleted-"));
  assert.equal(archived.length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(mappings, archived[0]), "utf8")).vm
      .name,
    first.vm.name,
  );
});
