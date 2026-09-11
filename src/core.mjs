import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const TAG = "herdr-exe-dev";
export const INTEGRATION_HOST = "github.int.exe.xyz";
export const SESSION = "exe-dev";
export const REMOTE_ROOT = "/home/exedev/project";
export const HERDR_VERSION = "0.9.0";
export const HERDR_ASSET =
  "https://github.com/herdrdev/herdr/releases/download/v0.9.0/herdr-linux-x86_64";
export const HERDR_SHA256 =
  "4fa1a01158dd8043da92d31b270780b0dcc10603038d9b61cac4d81ab63fb71f";
const ID = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const USER = /^[a-z_][a-z0-9_+.-]*$/i;
const HOST = /^[a-z0-9.-]+$/i;
const PHASES = new Set([
  "intent",
  "creating",
  "created",
  "seeding",
  "preparing",
  "setup-failed",
  "ready",
  "route-unsupported",
  "deleting",
  "deleted",
]);

export class MissingMappingError extends Error {}
export function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
export function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      // The provider reports refusals as JSON on stdout with a nonzero exit, so
      // reading stderr alone reduces a precise diagnostic to a bare exit code.
      `${bin} failed: ${(
        result.error?.message ||
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        `exit ${result.status}`
      ).slice(0, 4000)}`,
    );
  return result.stdout?.trim() ?? "";
}
export function parseJson(text, label) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new Error(`Invalid ${label} JSON.`);
  }
}
function regular(file, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error(`Refusing unsafe file: ${file}`);
    return stat;
  } catch (error) {
    if (error && error.code === "ENOENT" && optional) return undefined;
    throw error;
  }
}
function privateWrite(file, value) {
  regular(file, true);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
export function atomic(file, value) {
  privateWrite(file, JSON.stringify(value, null, 2));
}
export function readJson(file, label = file) {
  regular(file);
  return parseJson(fs.readFileSync(file, "utf8"), label);
}
export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function mappingId(gitDir, commonDir) {
  return hash(`${gitDir}\0${commonDir}`);
}
function stateDirectory(stateDir, ...parts) {
  if (!path.isAbsolute(stateDir))
    throw new Error("State directory must be absolute.");
  let directory = stateDir;
  for (const part of ["", ...parts]) {
    directory = path.join(directory, part);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Refusing unsafe state directory: ${directory}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return directory;
}
export function mappingFile(stateDir, id) {
  if (!ID.test(id)) throw new Error("Invalid mapping identity.");
  return path.join(stateDirectory(stateDir, "mappings", id), "entry.json");
}
function text(value) {
  return (
    typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value)
  );
}
function validateArgv(value, label) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (item, index) =>
        typeof item !== "string" ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(item) ||
        (index === 0 && !text(item)),
    )
  )
    throw new Error(`${label} must be a non-empty argv array.`);
  return value;
}
function validateEntry(entry, id) {
  if (
    !entry ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    entry.id !== id ||
    !ID.test(entry.id)
  )
    throw new Error("Invalid mapping schema.");
  if (
    !text(entry.worktree) ||
    !path.isAbsolute(entry.worktree) ||
    !text(entry.commonDir) ||
    !path.isAbsolute(entry.commonDir) ||
    !text(entry.gitDir) ||
    !path.isAbsolute(entry.gitDir) ||
    entry.id !== mappingId(entry.gitDir, entry.commonDir)
  )
    throw new Error("Invalid mapping worktree identity.");
  if (
    !entry.seed ||
    entry.seed.root !== entry.worktree ||
    entry.seed.commonDir !== entry.commonDir ||
    entry.seed.gitDir !== entry.gitDir ||
    !text(entry.seed.branch) ||
    !REVISION.test(entry.seed.revision) ||
    (entry.seed.origin !== undefined && !credentialFreeUrl(entry.seed.origin))
  )
    throw new Error("Invalid mapping seed identity.");
  if (
    !entry.settings ||
    !text(entry.settings.identityFile) ||
    !path.isAbsolute(entry.settings.identityFile) ||
    /[\x00-\x1f\x7f%$]/.test(entry.settings.identityFile) ||
    !USER.test(entry.settings.sshUser) ||
    !Number.isSafeInteger(entry.settings.cpu) ||
    entry.settings.cpu < 1 ||
    !/^[1-9][0-9]*GB$/.test(entry.settings.memory) ||
    !/^[1-9][0-9]*GB$/.test(entry.settings.disk)
  )
    throw new Error("Invalid mapping settings.");
  if (
    !entry.vm ||
    !NAME.test(entry.vm.name) ||
    (entry.vm.createdAt !== undefined && !text(entry.vm.createdAt)) ||
    !entry.vm.route ||
    !HOST.test(entry.vm.route.host) ||
    !USER.test(entry.vm.route.user)
  )
    throw new Error("Invalid mapping VM identity.");
  if (!PHASES.has(entry.phase)) throw new Error("Invalid mapping lifecycle.");
  if (
    !entry.project ||
    typeof entry.project !== "object" ||
    Array.isArray(entry.project)
  )
    throw new Error("Invalid frozen project configuration.");
  for (const key of ["setup", "start", "check"])
    if (entry.project[key] !== undefined) validateArgv(entry.project[key], key);
  if (entry.seeded !== undefined && typeof entry.seeded !== "boolean")
    throw new Error("Invalid seeded state.");
  if (entry.phase === "ready" && !entry.seeded)
    throw new Error("Ready mapping has no completed seed.");
  if (
    !["intent", "creating"].includes(entry.phase) &&
    !text(entry.vm.createdAt)
  )
    throw new Error("Mapping has no recorded creation identity.");
  for (const key of [
    "machineId",
    "workspaceId",
    "rootPaneId",
    "rootTerminalId",
  ])
    if (entry[key] !== undefined && !text(entry[key]))
      throw new Error("Invalid saved Herdr binding.");
  return entry;
}
export function load(stateDir, id, location) {
  const file = mappingFile(stateDir, id);
  if (!regular(file, true))
    throw new MissingMappingError(
      "No exe.dev VM mapping exists for this worktree. Use start-agent.",
    );
  const entry = validateEntry(readJson(file, "mapping"), id);
  if (
    location &&
    (entry.gitDir !== location.gitDir || entry.commonDir !== location.commonDir)
  )
    throw new Error("Saved mapping does not belong to this worktree.");
  return entry;
}
export function save(stateDir, entry) {
  validateEntry(entry, entry.id);
  atomic(mappingFile(stateDir, entry.id), entry);
}
export function withLock(stateDir, id, fn) {
  const directory = path.dirname(mappingFile(stateDir, id));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if (error && error.code === "EEXIST")
      throw new Error("An operation is already running for this worktree.");
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
function argv(value, label) {
  return [...validateArgv(value, label)];
}
function size(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*(?:G|GB)$/i.test(value))
    throw new Error(`${label} must be a positive whole-GiB size such as 8GB.`);
  return value.toUpperCase().replace(/G$/, "GB");
}
export function operatorConfig(configDir) {
  const file = path.join(configDir, "config.json");
  if (!regular(file, true))
    throw new Error(`Create ${file}; see README for a fabricated example.`);
  const value = readJson(file, "operator config");
  if (!text(value.identityFile) || !path.isAbsolute(value.identityFile))
    throw new Error("identityFile must be an absolute SSH identity path.");
  const identityFile = fs.realpathSync(value.identityFile);
  if (/[\x00-\x1f\x7f%$]/.test(identityFile))
    throw new Error(
      "identityFile cannot contain SSH-config control characters, percent tokens, or environment substitutions.",
    );
  if (!Number.isSafeInteger(value.cpu) || value.cpu < 1)
    throw new Error("Invalid operator configuration.");
  if (
    value.sshUser !== undefined &&
    (!text(value.sshUser) || !USER.test(value.sshUser))
  )
    throw new Error("sshUser must be a safe SSH user name.");
  if (
    value.baseVm !== undefined &&
    (!text(value.baseVm) || !NAME.test(value.baseVm))
  )
    throw new Error(
      "baseVm must be the provider name of an existing VM to copy.",
    );
  return {
    identityFile,
    cpu: value.cpu,
    memory: size(value.memory, "memory"),
    disk: size(value.disk, "disk"),
    sshUser: value.sshUser ?? "exedev",
    ...(value.baseVm === undefined ? {} : { baseVm: value.baseVm }),
  };
}
export function homeFiles(configDir) {
  const list = readJson(
    path.join(configDir, "config.json"),
    "operator config",
  ).homeFiles;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((item) => !text(item)))
    throw new Error("homeFiles must be an array of absolute file paths.");
  const home = os.homedir();
  return list.map((item) => {
    const relative = path.relative(home, item);
    if (
      !path.isAbsolute(item) ||
      !relative ||
      relative.split(path.sep).includes("..") ||
      path.isAbsolute(relative)
    )
      throw new Error(
        `homeFiles entry must be an absolute path inside ${home}: ${item}`,
      );
    // Deliberately follows symlinks: dotfile repositories are the usual source.
    const stat = fs.statSync(item);
    if (!stat.isFile())
      throw new Error(`homeFiles entry is not a regular file: ${item}`);
    if (stat.size > 1048576)
      throw new Error(`homeFiles entry exceeds 1 MiB: ${item}`);
    return { relative, source: item };
  });
}
export function pushHomeFiles(entry, files, execute = run) {
  for (const file of files)
    remote(
      entry,
      `set -eu\numask 077\ncd "$HOME"\nmkdir -p ${quote(path.dirname(file.relative))}\ncat > ${quote(file.relative)}`,
      { input: fs.readFileSync(file.source) },
      execute,
    );
  return files.length;
}
export function secretFiles(configDir) {
  const map = readJson(
    path.join(configDir, "config.json"),
    "operator config",
  ).secretFiles;
  if (map === undefined) return [];
  if (!map || typeof map !== "object" || Array.isArray(map))
    throw new Error(
      "secretFiles must map home-relative paths to the command that prints each file.",
    );
  return Object.entries(map).map(([relative, command]) => {
    if (
      !text(relative) ||
      path.isAbsolute(relative) ||
      path.normalize(relative).split(path.sep).includes("..")
    )
      throw new Error(
        `secretFiles paths must be relative to the remote home directory: ${relative}`,
      );
    if (!Array.isArray(command) || !command.length || !command.every(text))
      throw new Error(
        `secretFiles ${relative} must be a command and its arguments, as a list of non-empty strings.`,
      );
    return { relative, command };
  });
}
function readSecret(file) {
  const [program, ...args] = file.command;
  // Deliberately not the shared runner: its failures quote stdout, and stdout
  // here is the secret. No shell either, so the configured arguments cannot
  // become a second command.
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1048576,
    input: "",
  });
  if (result.error?.code === "ENOENT")
    throw new Error(
      `The command configured for ${file.relative} is not on PATH: ${program}`,
    );
  if (result.error || result.status !== 0)
    throw new Error(
      `Reading ${file.relative} failed: ${(
        result.error?.message ||
        result.stderr?.trim() ||
        `exit ${result.status}`
      ).slice(0, 2000)}`,
    );
  if (!result.stdout.length)
    throw new Error(`The command for ${file.relative} printed nothing.`);
  return result.stdout;
}
export function pushSecretFiles(entry, files, execute = run) {
  for (const file of files)
    remote(
      entry,
      `set -eu\numask 077\ncd "$HOME"\nmkdir -p ${quote(path.dirname(file.relative))}\ncat > ${quote(file.relative)}\nchmod 600 ${quote(file.relative)}`,
      { input: readSecret(file) },
      execute,
    );
  return files.length;
}
export function credentialFreeUrl(value) {
  if (!text(value) || /[\t ]/.test(value)) return false;
  if (/^[a-z_][a-z0-9_-]*@[a-z0-9.-]+:[^/?#:]+(?:\/[^?#]+)*$/i.test(value))
    return true;
  try {
    const parsed = new URL(value);
    return (
      ["https:", "ssh:"].includes(parsed.protocol) &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      !!parsed.hostname &&
      (parsed.protocol === "https:"
        ? !parsed.username
        : !parsed.username || USER.test(parsed.username))
    );
  } catch {
    return false;
  }
}
export function integrationUrl(origin) {
  if (!text(origin)) return undefined;
  const scp = /^[^@/]+@[a-z0-9.-]+:(.+)$/i.exec(origin);
  let pathname;
  if (scp) pathname = scp[1];
  else
    try {
      pathname = new URL(origin).pathname;
    } catch {
      return undefined;
    }
  const repo = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(pathname);
  if (!repo) return undefined;
  const url = `https://${INTEGRATION_HOST}/${repo[1]}/${repo[2]}.git`;
  return url === origin ? undefined : url;
}
export function cloneUrls(origin) {
  // The integration host leads: a laptop origin is often an SSH alias that only
  // resolves in the operator's ~/.ssh/config, so trying it first guarantees a
  // failed attempt on the VM. The origin stays as the fallback for repositories
  // the exe.dev GitHub integration does not cover.
  const integration = integrationUrl(origin);
  return integration ? [integration, origin] : [origin];
}
export function projectConfig(root, revision) {
  let exists;
  try {
    run("git", ["-C", root, "cat-file", "-e", `${revision}:.herdr/exe.json`]);
    exists = true;
  } catch (error) {
    if (
      /fatal: path '\.herdr\/exe\.json' does not exist in /.test(error.message)
    )
      exists = false;
    else throw error;
  }
  if (!exists) return {};
  const value = parseJson(
    run("git", ["-C", root, "show", `${revision}:.herdr/exe.json`]),
    ".herdr/exe.json",
  );
  if (
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["setup", "start", "check", "remoteUrl"].includes(key),
    )
  )
    throw new Error(
      ".herdr/exe.json must be an object with supported project keys.",
    );
  const command = (name) =>
    value[name] === undefined
      ? undefined
      : argv(value[name], `.herdr/exe.json ${name}`);
  if (value.remoteUrl !== undefined && !credentialFreeUrl(value.remoteUrl))
    throw new Error(
      ".herdr/exe.json remoteUrl must be a credential-free HTTPS or SSH Git URL.",
    );
  return {
    setup: command("setup"),
    start: command("start"),
    check: command("check"),
    remoteUrl: value.remoteUrl,
  };
}
export function originUrl(root, project) {
  if (project.remoteUrl) return project.remoteUrl;
  const remotes = run("git", ["-C", root, "remote"])
    .split(/\r?\n/)
    .filter(Boolean);
  if (!remotes.includes("origin")) return undefined;
  const value = run("git", ["-C", root, "remote", "get-url", "origin"]);
  if (!credentialFreeUrl(value))
    throw new Error(
      "origin contains credentials or is not a supported network Git URL; set a credential-free .herdr/exe.json remoteUrl.",
    );
  return value;
}
export function captureSeed(requestedCwd) {
  const cwd = fs.realpathSync(requestedCwd);
  let root;
  try {
    root = fs.realpathSync(
      run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
    );
  } catch {
    throw new Error("A committed Git worktree is required.");
  }
  if (
    run("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"])
  )
    throw new Error(
      "Refusing dirty worktree: commit, stash, or remove every change first.",
    );
  let branch;
  try {
    branch = run("git", [
      "-C",
      root,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
  } catch {
    throw new Error(
      "Refusing detached or unborn HEAD: select a committed branch first.",
    );
  }
  const revision = run("git", ["-C", root, "rev-parse", "HEAD"]);
  if (!REVISION.test(revision))
    throw new Error("Git returned an invalid HEAD revision.");
  const commonDir = fs.realpathSync(
    path.resolve(
      root,
      run("git", ["-C", root, "rev-parse", "--git-common-dir"]),
    ),
  );
  if (
    run("git", ["-C", root, "submodule", "status", "--recursive"])
      .split("\n")
      .some((line) => line.trim() && !line.startsWith("-"))
  )
    throw new Error(
      "Initialized submodules are not supported; deinitialize or remove them before allocation.",
    );
  const tracked = run("git", ["-C", root, "ls-files", "-z"]);
  if (
    tracked &&
    run("git", ["-C", root, "check-attr", "-z", "--stdin", "filter"], {
      input: tracked,
    })
      .split("\0")
      .includes("lfs")
  )
    throw new Error(
      "Git LFS is not supported; remove LFS paths before allocation.",
    );
  const project = projectConfig(root, revision);
  const gitDir = fs.realpathSync(
    run("git", ["-C", root, "rev-parse", "--absolute-git-dir"]),
  );
  return {
    root,
    commonDir,
    gitDir,
    branch,
    revision,
    project,
    origin: originUrl(root, project),
  };
}
export function bundleFile(stateDir, entry) {
  return path.join(
    path.dirname(mappingFile(stateDir, entry.id)),
    "seed.bundle",
  );
}
export function verifyBundle(seed, file) {
  regular(file);
  if (run("git", ["bundle", "list-heads", file]) !== `${seed.revision} HEAD`)
    throw new Error("Git bundle does not contain the captured HEAD.");
}
export function createBundle(seed, file) {
  if (regular(file, true)) return verifyBundle(seed, file);
  const exclude = seed.origin ? ["--not", "--remotes=origin"] : [];
  if (
    exclude.length &&
    !run("git", [
      "-C",
      seed.root,
      "rev-list",
      "--max-count=1",
      "HEAD",
      ...exclude,
    ])
  )
    return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    run("git", [
      "-C",
      seed.root,
      "bundle",
      "create",
      temporary,
      "HEAD",
      ...exclude,
    ]);
    fs.chmodSync(temporary, 0o600);
    verifyBundle(seed, temporary);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function assertSameSeed(seed) {
  const current = captureSeed(seed.root);
  if (
    current.root !== seed.root ||
    current.commonDir !== seed.commonDir ||
    current.gitDir !== seed.gitDir ||
    current.branch !== seed.branch ||
    current.revision !== seed.revision ||
    current.origin !== seed.origin
  )
    throw new Error(
      "Worktree changed while preparing the seed; no VM was allocated.",
    );
}
export function vmName(seed) {
  const id = mappingId(seed.gitDir, seed.commonDir);
  const label = path
    .basename(seed.root)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 44)
    .replace(/-+$/, "");
  return `herdr-exe-${label || id.slice(0, 12)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}
export function routeFile(stateDir, entry) {
  if (!NAME.test(entry.vm.name)) throw new Error("Invalid VM name.");
  return path.join(stateDirectory(stateDir, "routes"), `${entry.vm.name}.conf`);
}
export function knownHostsFile(stateDir) {
  return path.join(stateDirectory(stateDir), "known_hosts");
}
function sshConfig(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
export function routeText(entry) {
  return `Host ${entry.vm.name}\n  HostName ${entry.vm.route.host}\n  User ${entry.vm.route.user}\n  IdentityFile ${sshConfig(entry.settings.identityFile)}\n  IdentitiesOnly yes\n  IdentityAgent none\n  ForwardAgent no\n  ControlMaster no\n  ControlPath none\n  BatchMode yes\n  UserKnownHostsFile ${sshConfig(knownHostsFile(entry.stateDir))}\n  StrictHostKeyChecking accept-new\n`;
}
export function prepareRoute(stateDir, entry) {
  const file = routeFile(stateDir, entry);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = regular(file, true);
  const desired = routeText(entry);
  if (existing && fs.readFileSync(file, "utf8") !== desired) {
    const initial = routeText({
      ...entry,
      vm: {
        ...entry.vm,
        route: {
          host: `${entry.vm.name}.exe.xyz`,
          user: entry.settings.sshUser,
        },
      },
    });
    if (
      entry.phase !== "created" ||
      entry.seeded ||
      fs.readFileSync(file, "utf8") !== initial
    )
      throw new Error(`Refusing to overwrite custom SSH route file: ${file}`);
    privateWrite(file, desired);
  }
  if (!existing) privateWrite(file, desired);
  return file;
}
function sshValues(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (match)
      values.set(match[1].toLowerCase(), [
        ...(values.get(match[1].toLowerCase()) ?? []),
        match[2],
      ]);
  }
  return values;
}
export function sshG(entry, execute = run) {
  const values = sshValues(execute("ssh", ["-G", entry.vm.name]));
  const identityFiles = values.get("identityfile") ?? [];
  const identityMatches = identityFiles.filter((value) => {
    try {
      return fs.realpathSync(value) === entry.settings.identityFile;
    } catch {
      return path.resolve(value) === entry.settings.identityFile;
    }
  });
  const exactly = (key) =>
    (values.get(key) ?? []).length === 1 && values.get(key)[0];
  if (
    exactly("hostname") !== entry.vm.route.host ||
    exactly("port") !== "22" ||
    exactly("user") !== entry.vm.route.user ||
    identityFiles.length !== 1 ||
    identityMatches.length !== 1 ||
    exactly("identitiesonly") !== "yes" ||
    exactly("identityagent") !== "none" ||
    !["no", "false"].includes(exactly("controlmaster")) ||
    (values.has("controlpath") && exactly("controlpath") !== "none") ||
    !["no", "false"].includes(exactly("forwardagent")) ||
    (values.has("proxycommand") && exactly("proxycommand") !== "none") ||
    (values.has("proxyjump") && exactly("proxyjump") !== "none") ||
    exactly("batchmode") !== "yes" ||
    exactly("userknownhostsfile") !== knownHostsFile(entry.stateDir) ||
    exactly("stricthostkeychecking") !== "accept-new"
  )
    throw new Error(
      `SSH routing is not active for ${entry.vm.name}. Add “Include ${sshConfig(routeFile(entry.stateDir, entry))}” to your ~/.ssh/config, then retry.`,
    );
}
export function providerArgs(entry, tail) {
  return [
    "-T",
    "-F",
    "/dev/null",
    "-i",
    entry.settings.identityFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "exe.dev",
    ...tail,
  ];
}
export function providerList(entry, execute = run) {
  const value = parseJson(
    execute("ssh", providerArgs(entry, ["ls", "--json"])),
    "exe.dev inventory",
  );
  if (!Array.isArray(value.vms))
    throw new Error("Invalid exe.dev inventory JSON.");
  if (
    value.vms.some(
      (vm) =>
        !vm || typeof vm !== "object" || Array.isArray(vm) || !text(vm.vm_name),
    )
  )
    throw new Error(
      "Invalid exe.dev inventory entry; absence cannot be established.",
    );
  if (new Set(value.vms.map((vm) => vm.vm_name)).size !== value.vms.length)
    throw new Error("Ambiguous exe.dev inventory VM names.");
  return value.vms;
}
function routeFromVm(entry, vm) {
  if (
    vm.ssh_dest === undefined &&
    vm.ssh_host === undefined &&
    vm.ssh_user === undefined
  )
    throw new Error(
      "Provider inventory omitted SSH routing; refusing to guess.",
    );
  const destination =
    typeof vm.ssh_dest === "string"
      ? /^(?:([a-z_][a-z0-9_+.-]*)@)?([a-z0-9.-]+)$/i.exec(vm.ssh_dest)
      : undefined;
  const host = vm.ssh_host ?? destination?.[2];
  const user = vm.ssh_user ?? destination?.[1] ?? entry.settings.sshUser;
  if (
    (vm.ssh_dest !== undefined && !destination) ||
    !HOST.test(host ?? "") ||
    !USER.test(user) ||
    (destination && vm.ssh_host && vm.ssh_host !== destination[2]) ||
    (destination?.[1] && vm.ssh_user && vm.ssh_user !== destination[1])
  )
    throw new Error(
      "Provider returned an unsafe SSH route; VM is retained for recovery.",
    );
  return { host, user };
}
export function ownedVm(entry, vms = providerList(entry)) {
  const matches = vms.filter(
    (vm) =>
      vm.vm_name === entry.vm.name &&
      vm.created_at === entry.vm.createdAt &&
      Array.isArray(vm.tags) &&
      vm.tags.includes(TAG),
  );
  if (matches.length !== 1)
    throw new Error(
      "Recorded VM identity is missing or ambiguous; refusing this operation.",
    );
  const route = routeFromVm(entry, matches[0]);
  if (route.host !== entry.vm.route.host || route.user !== entry.vm.route.user)
    throw new Error(
      "Provider SSH route changed; refusing to retarget the recorded VM.",
    );
  return matches[0];
}
export function validateExisting(entry, execute = run) {
  ownedVm(entry, providerList(entry, execute));
  sshG(entry, execute);
}
export function bindCreatedVm(stateDir, entry, execute = run) {
  const matches = providerList(entry, execute).filter(
    (vm) =>
      vm.vm_name === entry.vm.name &&
      Array.isArray(vm.tags) &&
      vm.tags.includes(TAG) &&
      text(vm.created_at),
  );
  if (matches.length !== 1)
    throw new Error(
      "Creation response was not uniquely confirmed by authenticated inventory; VM is retained for recovery.",
    );
  entry.vm.createdAt = matches[0].created_at;
  try {
    entry.vm.route = routeFromVm(entry, matches[0]);
  } catch (error) {
    entry.phase = "route-unsupported";
    entry.error = error.message;
    save(stateDir, entry);
    throw error;
  }
  entry.phase = "created";
  save(stateDir, entry);
  prepareRoute(stateDir, entry);
  return entry;
}
export function allocate(stateDir, entry, execute = run) {
  if (entry.phase !== "intent")
    throw new Error(
      "Allocation was already attempted; inspect status or recover the recorded VM.",
    );
  entry.phase = "creating";
  save(stateDir, entry);
  const spec = [
    `--cpu=${entry.settings.cpu}`,
    `--memory=${entry.settings.memory}`,
    `--disk=${entry.settings.disk}`,
  ];
  if (entry.settings.baseVm) {
    // The source tags are dropped rather than inherited: they belong to whoever
    // maintains the base, and copying them would enlist this VM in their tooling.
    execute(
      "ssh",
      providerArgs(entry, [
        "cp",
        entry.settings.baseVm,
        entry.vm.name,
        "--copy-tags=false",
        ...spec,
        "--json",
      ]),
    );
    try {
      execute(
        "ssh",
        providerArgs(entry, ["tag", entry.vm.name, TAG, "--json"]),
      );
    } catch (error) {
      throw new Error(
        `Copied VM ${entry.vm.name} carries no ownership tag, so no further operation will match it; tag it with "ssh exe.dev tag ${entry.vm.name} ${TAG}" and recover, or delete it on the provider: ${error.message}`,
      );
    }
  } else
    execute(
      "ssh",
      providerArgs(entry, [
        "new",
        `--name=${entry.vm.name}`,
        ...spec,
        `--tag=${TAG}`,
        "--json",
      ]),
    );
  return bindCreatedVm(stateDir, entry, execute);
}
export function recoverCreation(stateDir, entry, execute = run) {
  if (entry.phase !== "creating")
    throw new Error("Only a pending creation can be recovered.");
  return bindCreatedVm(stateDir, entry, execute);
}
export function remoteArgs(entry, command) {
  return [
    "-T",
    "-F",
    "/dev/null",
    "-i",
    entry.settings.identityFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "BatchMode=yes",
    "-o",
    `UserKnownHostsFile=${sshConfig(knownHostsFile(entry.stateDir))}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
    `${entry.vm.route.user}@${entry.vm.route.host}`,
    `bash -lc ${quote(command)}`,
  ];
}
export function remote(entry, command, options = {}, execute = run) {
  // Keepalives, not a wall clock: seeding and setup are legitimately slow.
  return execute("ssh", remoteArgs(entry, command), {
    input: "",
    timeout: 0,
    ...options,
  });
}
export function commandScript(argvValue) {
  return `cd ${quote(REMOTE_ROOT)} && exec ${argvValue.map(quote).join(" ")}`;
}
export function seedScript(entry, bundled = true) {
  const root = quote(REMOTE_ROOT);
  const fetch = bundled
    ? `git fetch --no-tags "$HOME/herdr-exe-seed.bundle" HEAD\ntest "$(git rev-parse FETCH_HEAD)" = ${quote(entry.seed.revision)}\n`
    : "";
  const checkout = `git switch --no-track -C ${quote(entry.seed.branch)} ${quote(entry.seed.revision)}\nrm -f "$HOME/herdr-exe-seed.bundle"`;
  const preamble = `set -eu\numask 077\ntest ! -e ${root} && test ! -L ${root}\n`;
  if (!entry.seed.origin)
    return `${preamble}git init --object-format=${entry.seed.revision.length === 64 ? "sha256" : "sha1"} ${root}\ncd ${root}\n${fetch}${checkout}`;
  const clone = (url) =>
    `git clone --quiet --no-checkout --origin origin ${quote(url)} ${root}`;
  const [primary, ...rest] = cloneUrls(entry.seed.origin);
  const attempts = rest
    .map((url) => ` || { rm -rf ${root}; ${clone(url)}; }`)
    .join("");
  return `${preamble}${clone(primary)}${attempts}\ncd ${root}\n${fetch}git rev-parse --verify --quiet ${quote(`${entry.seed.revision}^{commit}`)} >/dev/null || { echo 'The recorded commit is missing on the VM; publish the branch, then start again.' >&2; exit 1; }\n${checkout}`;
}
export function setupScript(entry) {
  return entry.project.setup
    ? `set -eu\nexec flock -n "$HOME/.herdr-exe-setup.lock" sh -lc ${quote(commandScript(entry.project.setup))}`
    : "true";
}
export function transferBundle(entry, bundle) {
  const input = fs.openSync(
    bundle,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const result = spawnSync(
      "ssh",
      remoteArgs(entry, 'umask 077; cat > "$HOME/herdr-exe-seed.bundle"'),
      {
        stdio: [input, "pipe", "pipe"],
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `bundle transfer failed: ${result.error?.message || result.stderr?.toString().trim() || `exit ${result.status}`}`,
      );
  } finally {
    fs.closeSync(input);
  }
}
export function prepareVm(stateDir, entry, bundle, transport = {}) {
  const execute = transport.run ?? run;
  const transfer = transport.transfer ?? transferBundle;
  const progress = transport.progress ?? (() => {});
  if (!entry.vm.createdAt || !["created", "setup-failed"].includes(entry.phase))
    throw new Error("Setup is unavailable for this mapping.");
  try {
    if (!entry.seeded) {
      if (!bundle)
        throw new Error(
          "Seeding did not complete; retrying would overwrite uncertain remote state.",
        );
      entry.phase = "seeding";
      save(stateDir, entry);
      const uploaded = Boolean(regular(bundle, true));
      if (uploaded) {
        verifyBundle(entry.seed, bundle);
        progress(
          `Uploading ${Math.round(fs.statSync(bundle).size / 1e6)} MB of unpublished Git history to ${entry.vm.route.host}; this takes minutes with no output.`,
        );
        transfer(entry, bundle);
      }
      progress(
        entry.seed.origin
          ? `Cloning ${cloneUrls(entry.seed.origin)[0]} on the VM and checking out ${entry.seed.branch}.`
          : `Creating the ${entry.seed.branch} checkout on the VM.`,
      );
      remote(entry, seedScript(entry, uploaded), {}, execute);
      entry.seeded = true;
      save(stateDir, entry);
      fs.rmSync(bundle, { force: true });
    }
    entry.phase = "preparing";
    save(stateDir, entry);
    progress("Running committed project setup.");
    remote(entry, setupScript(entry), {}, execute);
    entry.phase = "ready";
    delete entry.error;
    save(stateDir, entry);
  } catch (error) {
    entry.phase = "setup-failed";
    entry.error = String(error.message);
    save(stateDir, entry);
    throw error;
  }
  return entry;
}
export function ensureRemoteHerdr(entry, execute = run) {
  remote(
    entry,
    `set -eu\nexport PATH="$HOME/.local/bin:$PATH"\nif command -v herdr >/dev/null 2>&1; then herdr --version | grep -Fxq 'herdr ${HERDR_VERSION}' || { echo 'Existing remote Herdr is incompatible; refusing to replace or restart it.' >&2; exit 1; }; elif test -e "$HOME/.local/bin/herdr"; then echo 'Existing remote Herdr path is not executable; refusing to replace it.' >&2; exit 1; else test "$(uname -m)" = x86_64; test ! -L "$HOME/.local"; test ! -L "$HOME/.local/bin"; mkdir -p "$HOME/.local/bin"; tmp=$(mktemp "$HOME/.local/bin/herdr.XXXXXX"); trap 'rm -f "$tmp"' EXIT; curl --fail --location --silent --show-error ${quote(HERDR_ASSET)} -o "$tmp"; printf '%s  %s\\n' ${quote(HERDR_SHA256)} "$tmp" | sha256sum --check --status; chmod 755 "$tmp"; mv -n "$tmp" "$HOME/.local/bin/herdr"; herdr --version | grep -Fxq 'herdr ${HERDR_VERSION}'; fi`,
    {},
    execute,
  );
}
export function installSkill(entry, execute = run) {
  remote(
    entry,
    `set -eu\nexport PATH="$HOME/.local/bin:$PATH"\ntmp=$(mktemp)\ntrap 'rm -f "$tmp"' EXIT\nherdr --skill > "$tmp"\nfor target in "$HOME/.agents/skills/herdr/SKILL.md" "$HOME/.claude/skills/herdr/SKILL.md"; do if test -e "$target" || test -L "$target"; then cmp -s "$tmp" "$target" || { echo "Existing Herdr skill differs: $target" >&2; exit 1; }; else directory=$(dirname "$target"); while test "$directory" != "$HOME"; do test ! -L "$directory" || { echo 'Refusing a symlinked Herdr skill directory.' >&2; exit 1; }; directory=$(dirname "$directory"); done; mkdir -p "$(dirname "$target")"; cp "$tmp" "$target"; fi; done`,
    {},
    execute,
  );
}
function localHerdr(entry) {
  return entry.herdrBin ?? "herdr";
}
export function herdr(entry, args, execute = run) {
  return remote(
    entry,
    `export PATH="$HOME/.local/bin:$PATH"\nexec herdr --session ${quote(SESSION)} ${args.map(quote).join(" ")}`,
    {},
    execute,
  );
}
function result(text, label) {
  const value = parseJson(text, label);
  return value.result && typeof value.result === "object"
    ? value.result
    : value;
}
function listed(value, label) {
  const parsed = result(value, label);
  return Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : Array.isArray(parsed.panes)
        ? parsed.panes
        : undefined;
}
export function checkLocalHerdr(entry, execute = run) {
  if (execute(localHerdr(entry), ["--version"]) !== `herdr ${HERDR_VERSION}`)
    throw new Error(
      `This plugin is verified for Herdr ${HERDR_VERSION}; refusing a different local release.`,
    );
}
function machineProfiles(entry, execute) {
  checkLocalHerdr(entry, execute);
  const profiles = parseJson(
    execute(localHerdr(entry), ["machine", "list", "--json"]),
    "Herdr machine list",
  );
  if (
    !Array.isArray(profiles) ||
    profiles.some(
      (profile) => !profile || typeof profile !== "object" || !text(profile.id),
    ) ||
    new Set(profiles.map((profile) => profile.id)).size !== profiles.length
  )
    throw new Error("Invalid Herdr machine list JSON.");
  return profiles;
}
export function machineProfile(entry, execute = run) {
  const profiles = machineProfiles(entry, execute);
  const matches = profiles.filter(
    (profile) =>
      profile &&
      profile.target === entry.vm.name &&
      profile.session === SESSION &&
      text(profile.id),
  );
  if (entry.machineId) {
    if (matches.length !== 1 || matches[0].id !== entry.machineId)
      throw new Error(
        "Saved Herdr machine profile is missing or changed; recovery will not recreate it.",
      );
    return matches[0];
  }
  if (matches.length > 1)
    throw new Error(
      "Herdr machine profile is ambiguous; recovery will not choose one.",
    );
  return matches[0];
}
export function attachMachine(stateDir, entry, execute = run) {
  const profile = machineProfile(entry, execute);
  if (profile) {
    if (profile.enabled === false)
      execute(localHerdr(entry), ["machine", "enable", profile.id]);
    entry.machineId = profile.id;
    save(stateDir, entry);
    return entry.machineId;
  }
  execute(localHerdr(entry), [
    "machine",
    "add",
    entry.vm.name,
    "--label",
    `exe.dev ${entry.vm.name}`,
    "--remote-session",
    SESSION,
  ]);
  const created = machineProfile(entry, execute);
  if (!created)
    throw new Error("Herdr did not create the requested machine profile.");
  entry.machineId = created.id;
  save(stateDir, entry);
  return entry.machineId;
}
function workspaceList(entry, execute) {
  const list = listed(
    herdr(entry, ["workspace", "list"], execute),
    "Herdr workspace list",
  );
  if (!list) throw new Error("Invalid Herdr workspace list JSON.");
  return list;
}
function paneList(entry, workspaceId, execute) {
  const list = listed(
    herdr(entry, ["pane", "list", "--workspace", workspaceId], execute),
    "Herdr pane list",
  );
  if (!list) throw new Error("Invalid Herdr pane list JSON.");
  return list;
}
export function ensureWorkspace(stateDir, entry, execute = run) {
  if (entry.workspaceId) return entry.workspaceId;
  const label = `exe.dev ${entry.vm.name}`;
  const matches = workspaceList(entry, execute).filter(
    (workspace) => workspace && workspace.label === label,
  );
  if (matches.length > 1)
    throw new Error(
      "Remote workspace recovery is ambiguous; refusing to create another workspace.",
    );
  if (matches.length === 1) {
    entry.workspaceId = matches[0].workspace_id;
    const panes = paneList(entry, entry.workspaceId, execute).filter(
      (pane) => pane && text(pane.pane_id),
    );
    if (
      panes.length !== 1 ||
      panes[0].cwd !== REMOTE_ROOT ||
      !text(panes[0].terminal_id)
    )
      throw new Error(
        "Recovered remote workspace has ambiguous panes or checkout.",
      );
    entry.rootPaneId = panes[0].pane_id;
    entry.rootTerminalId = panes[0].terminal_id;
    save(stateDir, entry);
    return entry.workspaceId;
  }
  const created = result(
    herdr(
      entry,
      [
        "workspace",
        "create",
        "--cwd",
        REMOTE_ROOT,
        "--label",
        label,
        "--no-focus",
      ],
      execute,
    ),
    "Herdr workspace create",
  );
  if (
    !text(created.workspace?.workspace_id) ||
    !text(created.root_pane?.pane_id) ||
    !text(created.root_pane?.terminal_id) ||
    created.root_pane?.cwd !== REMOTE_ROOT
  )
    throw new Error("Herdr did not return a remote workspace binding.");
  entry.workspaceId = created.workspace.workspace_id;
  entry.rootPaneId = created.root_pane.pane_id;
  entry.rootTerminalId = created.root_pane.terminal_id;
  save(stateDir, entry);
  return entry.workspaceId;
}
export function verifyBinding(entry, execute = run) {
  if (
    !entry.machineId ||
    !entry.workspaceId ||
    !entry.rootPaneId ||
    !text(entry.rootTerminalId)
  )
    throw new Error(
      "Remote Herdr binding is incomplete; recover attachment explicitly.",
    );
  machineProfile(entry, execute);
  const workspace = result(
    herdr(entry, ["workspace", "get", entry.workspaceId], execute),
    "Herdr workspace get",
  );
  if (
    workspace.workspace?.workspace_id !== entry.workspaceId ||
    workspace.workspace?.label !== `exe.dev ${entry.vm.name}`
  )
    throw new Error("Saved remote workspace is missing or changed.");
  if (
    !paneList(entry, entry.workspaceId, execute).some(
      (pane) =>
        pane?.pane_id === entry.rootPaneId &&
        pane.cwd === REMOTE_ROOT &&
        pane.terminal_id === entry.rootTerminalId,
    )
  )
    throw new Error("Saved remote root pane is missing or changed.");
}
export function ensureBinding(stateDir, entry, execute = run) {
  attachMachine(stateDir, entry, execute);
  ensureWorkspace(stateDir, entry, execute);
  verifyBinding(entry, execute);
}
export function openPane(stateDir, entry, argvValue, title, execute = run) {
  verifyBinding(entry, execute);
  const created = result(
    herdr(
      entry,
      [
        "tab",
        "create",
        "--workspace",
        entry.workspaceId,
        "--cwd",
        REMOTE_ROOT,
        "--label",
        title,
        "--no-focus",
      ],
      execute,
    ),
    "Herdr tab create",
  );
  if (!text(created.tab?.tab_id))
    throw new Error("Herdr did not return a remote tab ID.");
  const panes = paneList(entry, entry.workspaceId, execute).filter(
    (pane) => pane?.tab_id === created.tab.tab_id && text(pane.pane_id),
  );
  if (
    panes.length !== 1 ||
    panes[0].cwd !== REMOTE_ROOT ||
    !text(panes[0].terminal_id)
  )
    throw new Error(
      "Herdr did not return exactly one checkout pane for the new remote tab.",
    );
  const pane = panes[0].pane_id;
  if (argvValue)
    herdr(
      entry,
      ["pane", "run", pane, `sh -lc ${quote(commandScript(argvValue))}`],
      execute,
    );
  return pane;
}
export function inspectionScript(entry) {
  const fallback = integrationUrl(entry.seed.origin);
  const origin = entry.seed.origin
    ? `url=$(git remote get-url origin)\ntest "$url" = ${quote(entry.seed.origin)}${fallback ? ` || test "$url" = ${quote(fallback)}` : ""}\ntimeout 45 git fetch --prune --no-tags origin '+refs/heads/*:refs/remotes/origin/*'\n`
    : 'test -z "$(git remote)" || exit 1\necho "No origin is configured; cannot prove remote work is published." >&2\nexit 1\n';
  return `set -eu\nexec 9>"$HOME/.herdr-exe-setup.lock"\nflock -n 9\nrepo=${quote(REMOTE_ROOT)}\ncd "$repo"\ntest "$(git rev-parse --show-toplevel)" = "$repo"\n${origin}test -z "$(git stash list)"\ntest "$(git worktree list --porcelain | grep -c '^worktree ')" = 1\ntest -z "$(git status --porcelain --untracked-files=all)"\ntest -n "$(git symbolic-ref --quiet HEAD)"\ntest -z "$(git rev-list --branches --tags HEAD --not --remotes=origin)"\nlocal_tags=$(git for-each-ref --format='%(objectname) %(refname)' refs/tags)\nif test -n "$local_tags"; then\n  remote_tags=$(timeout 30 git ls-remote --tags --refs origin)\n  while read -r object ref; do\n    printf '%s\\n' "$remote_tags" | grep -Fxq "$(printf '%s\\t%s' "$object" "$ref")"\n  done <<< "$local_tags"\nfi`;
}
function activePanes(entry, execute) {
  for (const workspace of workspaceList(entry, execute)) {
    if (!text(workspace.workspace_id))
      throw new Error("Invalid live workspace identity.");
    for (const pane of paneList(entry, workspace.workspace_id, execute)) {
      if (!text(pane.pane_id)) throw new Error("Invalid live pane identity.");
      if (pane.agent)
        throw new Error(
          "A live Herdr agent is present; close it through native Herdr before deletion.",
        );
      const info = result(
        herdr(entry, ["pane", "process-info", "--pane", pane.pane_id], execute),
        "pane process information",
      ).process_info;
      if (
        !info ||
        info.pane_id !== pane.pane_id ||
        !Number.isSafeInteger(info.shell_pid) ||
        info.shell_pid <= 0 ||
        info.foreground_process_group_id !== info.shell_pid ||
        !Array.isArray(info.foreground_processes) ||
        info.foreground_processes.length !== 1 ||
        info.foreground_processes[0].pid !== info.shell_pid ||
        !["bash", "sh", "zsh", "fish", "dash", "ksh"].includes(
          info.foreground_processes[0].name,
        )
      )
        throw new Error(
          "Cannot prove every live pane is an idle shell; stop foreground work before deletion.",
        );
    }
  }
}
export function cleanupRoute(stateDir, entry) {
  const file = routeFile(stateDir, entry);
  if (!regular(file, true)) return;
  if (fs.readFileSync(file, "utf8") !== routeText(entry))
    throw new Error(
      "SSH route file changed; preserving it for manual cleanup.",
    );
  fs.rmSync(file);
}
export function deleteVm(stateDir, entry, typedName, transport = {}) {
  const execute = transport.run ?? run;
  if (typedName !== entry.vm.name)
    throw new Error("Typed VM name does not match; deletion cancelled.");
  validateExisting(entry, execute);
  // Only machine ownership is required, not the saved workspace and pane: a
  // closed workspace is less at risk, not more, and demanding it would leave a
  // VM whose workspace the operator closed permanently undeletable. The live
  // scan below still refuses an agent in any workspace.
  machineProfile(entry, execute);
  activePanes(entry, execute);
  remote(entry, inspectionScript(entry), { timeout: 120000 }, execute);
  activePanes(entry, execute);
  validateExisting(entry, execute);
  entry.phase = "deleting";
  save(stateDir, entry);
  try {
    execute("ssh", providerArgs(entry, ["rm", entry.vm.name, "--json"]));
  } catch (error) {
    entry.error = error.message;
    save(stateDir, entry);
  }
  return reconcileDeletion(stateDir, entry, execute);
}
export function reconcileDeletion(stateDir, entry, execute = run) {
  if (!["deleting", "deleted"].includes(entry.phase))
    throw new Error("No recorded deletion is pending.");
  if (providerList(entry, execute).some((vm) => vm.vm_name === entry.vm.name))
    throw new Error(
      "VM name is still present; deletion is unconfirmed. No additional delete was issued.",
    );
  entry.phase = "deleted";
  delete entry.error;
  save(stateDir, entry);
  try {
    const profiles = machineProfiles(entry, execute);
    const profile = profiles.find((value) => value.id === entry.machineId);
    if (
      (profile &&
        (profile.target !== entry.vm.name || profile.session !== SESSION)) ||
      profiles.some(
        (value) =>
          value.target === entry.vm.name && value.id !== entry.machineId,
      )
    )
      throw new Error(
        "Machine profile ownership changed; preserving profiles and routing for manual cleanup.",
      );
    if (profile)
      execute(localHerdr(entry), ["machine", "remove", entry.machineId]);
    cleanupRoute(stateDir, entry);
    delete entry.cleanupError;
  } catch (error) {
    entry.cleanupError = error.message;
  }
  save(stateDir, entry);
  return entry;
}
export function makeEntry(stateDir, seed, settings, herdrBin) {
  const id = mappingId(seed.gitDir, seed.commonDir);
  return {
    id,
    stateDir,
    worktree: seed.root,
    commonDir: seed.commonDir,
    gitDir: seed.gitDir,
    seed: {
      root: seed.root,
      commonDir: seed.commonDir,
      gitDir: seed.gitDir,
      branch: seed.branch,
      revision: seed.revision,
      origin: seed.origin,
    },
    project: seed.project,
    settings,
    herdrBin,
    vm: { name: vmName(seed), route: { host: "", user: settings.sshUser } },
    phase: "intent",
  };
}
export function initializeRoute(entry) {
  entry.vm.route.host = `${entry.vm.name}.exe.xyz`;
  return entry;
}
