import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

type DockerBuildSandbox = {
  rootDir: string;
  scriptPath: string;
  logPath: string;
  binDir: string;
};

async function writeDockerStub(binDir: string, logPath: string) {
  const stub = `#!/usr/bin/env bash
set -euo pipefail
log="$DOCKER_STUB_LOG"
if [[ "\${1:-}" == "buildx" && "\${2:-}" == "version" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  echo "build $*" >>"$log"
  exit 0
fi
if [[ "\${1:-}" == "buildx" && "\${2:-}" == "build" ]]; then
  echo "buildx $*" >>"$log"
  exit 0
fi
echo "other $*" >>"$log"
exit 0
`;

  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "docker"), stub, { mode: 0o755 });
  await writeFile(logPath, "");
}

async function createDockerBuildSandbox(): Promise<DockerBuildSandbox> {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-docker-build-"));
  const scriptPath = join(rootDir, "scripts", "docker", "build-image.sh");
  const dockerfilePath = join(rootDir, "Dockerfile");
  const binDir = join(rootDir, "bin");
  const logPath = join(rootDir, "docker-stub.log");

  await mkdir(join(rootDir, "scripts", "docker"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "docker", "build-image.sh"), scriptPath);
  await chmod(scriptPath, 0o755);
  await writeFile(dockerfilePath, "FROM scratch\n");
  await writeDockerStub(binDir, logPath);

  return { rootDir, scriptPath, logPath, binDir };
}

function requireSandbox(sandbox: DockerBuildSandbox | null): DockerBuildSandbox {
  if (!sandbox) {
    throw new Error("sandbox missing");
  }
  return sandbox;
}

function createEnv(
  sandbox: DockerBuildSandbox,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? sandbox.rootDir,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    TMPDIR: process.env.TMPDIR,
    DOCKER_STUB_LOG: sandbox.logPath,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function runDockerBuild(
  sandbox: DockerBuildSandbox,
  args: string[] = [],
  overrides: Record<string, string | undefined> = {},
) {
  return spawnSync("bash", [sandbox.scriptPath, ...args], {
    cwd: sandbox.rootDir,
    env: createEnv(sandbox, overrides),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function readDockerLog(sandbox: DockerBuildSandbox) {
  return readFile(sandbox.logPath, "utf8");
}

function gitAvailable() {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

async function initGitRepo(rootDir: string, branchName: string) {
  const run = (args: string[]) =>
    spawnSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  expect(run(["init", "-b", branchName]).status).toBe(0);
  expect(run(["config", "user.email", "openclaw-test@example.com"]).status).toBe(0);
  expect(run(["config", "user.name", "OpenClaw Test"]).status).toBe(0);
  expect(run(["add", "Dockerfile", "scripts/docker/build-image.sh"]).status).toBe(0);
  expect(run(["commit", "-m", "test"]).status).toBe(0);
  const revParse = run(["rev-parse", "--short=12", "HEAD"]);
  expect(revParse.status).toBe(0);
  return revParse.stdout.trim();
}

describe("scripts/docker/build-image.sh", () => {
  let sandbox: DockerBuildSandbox | null = null;

  beforeAll(async () => {
    sandbox = await createDockerBuildSandbox();
  });

  afterAll(async () => {
    if (!sandbox) {
      return;
    }
    await rm(sandbox.rootDir, { recursive: true, force: true });
    sandbox = null;
  });

  it("builds a local image without compose, onboarding, or env writes", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerBuild(activeSandbox);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("==> Building image: openclaw:local");
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      `build build -t openclaw:local -f ${join(activeSandbox.rootDir, "Dockerfile")} ${activeSandbox.rootDir}`,
    );

    const envFileStat = await stat(join(activeSandbox.rootDir, ".env")).catch(() => null);
    expect(envFileStat).toBeNull();
  });

  it("forwards image tags and build args, including empty helper toggles", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerBuild(activeSandbox, [], {
      OPENCLAW_IMAGE: "ghcr.io/example/openclaw:fork",
      OPENCLAW_DOCKER_EXTRA_TAGS:
        "ghcr.io/example/openclaw:stable, ghcr.io/example/openclaw:latest",
      OPENCLAW_DOCKER_APT_PACKAGES: "ffmpeg git",
      OPENCLAW_EXTENSIONS: "matrix",
      OPENCLAW_INSTALL_BROWSER: "1",
      OPENCLAW_INSTALL_CODEX_CLI: "",
      OPENCLAW_CODEX_VERSION: "rust-v0.95.0",
      OPENCLAW_INSTALL_GOG_CLI: "",
      OPENCLAW_GOG_CLI_VERSION: "v0.11.1",
      OPENCLAW_INSTALL_GOPLACES: "",
      OPENCLAW_GOPLACES_VERSION: "v0.3.1",
      OPENCLAW_DOCKER_TARGET: "base-default",
      OPENCLAW_DOCKER_NO_CACHE: "1",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      "build build --no-cache --target base-default -t ghcr.io/example/openclaw:fork",
    );
    expect(log).toContain("-t ghcr.io/example/openclaw:stable");
    expect(log).toContain("-t ghcr.io/example/openclaw:latest");
    expect(log).toContain("--build-arg OPENCLAW_DOCKER_APT_PACKAGES=ffmpeg git");
    expect(log).toContain("--build-arg OPENCLAW_EXTENSIONS=matrix");
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_BROWSER=1");
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_CODEX_CLI=");
    expect(log).toContain("--build-arg OPENCLAW_CODEX_VERSION=rust-v0.95.0");
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_GOG_CLI=");
    expect(log).toContain("--build-arg OPENCLAW_GOG_CLI_VERSION=v0.11.1");
    expect(log).toContain("--build-arg OPENCLAW_INSTALL_GOPLACES=");
    expect(log).toContain("--build-arg OPENCLAW_GOPLACES_VERSION=v0.3.1");
  });

  it("uses buildx push for multi-platform registry builds", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerBuild(activeSandbox, [], {
      OPENCLAW_IMAGE: "ghcr.io/example/openclaw:main",
      OPENCLAW_DOCKER_PLATFORMS: "linux/amd64,linux/arm64",
      OPENCLAW_DOCKER_PUSH: "1",
    });

    expect(result.status).toBe(0);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      `buildx buildx build --platform linux/amd64,linux/arm64 --push -t ghcr.io/example/openclaw:main -f ${join(activeSandbox.rootDir, "Dockerfile")} ${activeSandbox.rootDir}`,
    );
  });

  it("can generate a git-based tag for ghcr push workflows", async () => {
    if (!gitAvailable()) {
      return;
    }

    const activeSandbox = requireSandbox(sandbox);
    const shortSha = await initGitRepo(activeSandbox.rootDir, "feature/ghcr-push");

    const result = runDockerBuild(activeSandbox, [], {
      OPENCLAW_IMAGE_REPO: "ghcr.io/example/openclaw",
      OPENCLAW_DOCKER_TAG_FROM_GIT: "1",
      OPENCLAW_DOCKER_PLATFORMS: "linux/amd64,linux/arm64",
      OPENCLAW_DOCKER_PUSH: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Generated image tag: feature-ghcr-push-${shortSha}`);
    const log = await readDockerLog(activeSandbox);
    expect(log).toContain(
      `buildx buildx build --platform linux/amd64,linux/arm64 --push -t ghcr.io/example/openclaw:feature-ghcr-push-${shortSha} -f ${join(activeSandbox.rootDir, "Dockerfile")} ${activeSandbox.rootDir}`,
    );
  });

  it("rejects multi-platform builds without an explicit push flow", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerBuild(activeSandbox, [], {
      OPENCLAW_DOCKER_PLATFORMS: "linux/amd64,linux/arm64",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENCLAW_DOCKER_PLATFORMS with multiple platforms requires OPENCLAW_DOCKER_PUSH=1.",
    );
  });

  it("prints usage with --help", async () => {
    const activeSandbox = requireSandbox(sandbox);

    const result = runDockerBuild(activeSandbox, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: ./scripts/docker/build-image.sh");
    expect(result.stdout).toContain("Build the OpenClaw Docker image");
  });
});
