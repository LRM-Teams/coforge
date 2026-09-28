#!/usr/bin/env python3
"""SkillsBench container tool-plane sidecar: official task containers over HTTP.

Mirrors the official BenchFlow sandbox contract for native task.md packages:

  image      = docker build <task>/environment/ (Dockerfile context)
  mounts     = <task>/verifier  -> /verifier  (read-only: the agent can never
                                              tamper with the verifier)
               <logs>/<episode> -> /logs      (verifier writes reward.txt)
  verdict    = bash /verifier/test.sh -> /logs/verifier/reward.txt
               (test.sh rewrites reward.txt unconditionally, so a stale or
               agent-forged file cannot survive the official verifier run;
               we additionally unlink reward.txt before verifying)

Endpoints (stdlib JSON, mirroring tau2_env_server.py):

  GET  /health
  POST /env     {task_id, episode_id}   -> build image (cached per task) and
                                            start the container; idempotent per
                                            episode_id (first call wins)
  POST /execute {episode_id, command, timeout_sec, call_id}
                                         -> docker exec in the container
                                            workdir; stdout/stderr/exit code
  POST /close   {episode_id}             -> best-effort: start async verify
                                            (the runner calls this only for
                                            user_simulator episodes, 15s budget)
  POST /verify  {episode_id}             -> synchronous official verification:
                                            unlink reward.txt, run
                                            bash /verifier/test.sh (bounded by
                                            the task's verifier timeout), read
                                            the fresh reward.txt, record the
                                            verdict, tear the container down
  GET  /verdicts                          -> lifecycle log tail (grading joins)
  POST /oracle  {task_id}                 -> sanity: run oracle/solve.sh then
                                            the official verifier on a fresh
                                            container; must yield reward 1

Every state transition is appended to the lifecycle JSONL (--log), the
grading driver's source of truth. Fail-closed: a missing reward.txt after the
verifier run is an error verdict, never a silent pass.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VENDOR_COMMIT = "9a1f4dd5f7659f75707435da3ce854b6e48321d1"
SLB_VENDOR_COMMIT = "a0da045a8bf64b8a8ff20730c4d6ef10dc4e2c5b"
DEFAULT_VERIFIER_TIMEOUT = 900
DEFAULT_BUILD_TIMEOUT = 1800
DEFAULT_EXEC_TIMEOUT = 120

# Benchmark profiles: SkillsBench and SkillLearnBench share the container
# contract (verifier writes /logs/verifier/reward.txt) but differ in mount
# points, oracle naming, and task metadata format.
PROFILES = {
    "skillsbench": {
        "verifier_dirname": "verifier",
        "verifier_mount": "/verifier",
        "verifier_entry": "/verifier/test.sh",
        "oracle_dirname": "oracle",
        "oracle_mount": "/oracle",
        "oracle_entry": "/oracle/solve.sh",
        "metadata": "task_md",
        "inject_skill_stubs": False,
    },
    "skilllearnbench": {
        "verifier_dirname": "tests",
        "verifier_mount": "/tests",
        "verifier_entry": "/tests/test.sh",
        "oracle_dirname": "solution",
        "oracle_mount": "/solution",
        "oracle_entry": "/solution/solve.sh",
        "metadata": "task_toml",
        "inject_skill_stubs": True,
    },
    # SkillFlow (arXiv 2604.17308): same task layout as SkillLearnBench
    # (instruction.md/task.toml/environment/tests/solution, reward.txt
    # convention) but nested family/<task> and no base-image skill stubs.
    "skillflow": {
        "verifier_dirname": "tests",
        "verifier_mount": "/tests",
        "verifier_entry": "/tests/test.sh",
        "oracle_dirname": "solution",
        "oracle_mount": "/solution",
        "oracle_entry": "/solution/solve.sh",
        "metadata": "task_toml",
        "inject_skill_stubs": False,
    },
}

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.S)
WORKDIR_RE = re.compile(r"^WORKDIR\s+(\S+)", re.M)
SKILL_COPY_RE = re.compile(r"^COPY\s+(skills/\S+)", re.M)


class SidecarError(ValueError):
    pass


def parse_frontmatter(task_md_path: Path) -> dict:
    text = task_md_path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise SidecarError(f"{task_md_path}: missing YAML frontmatter")
    meta: dict = {}
    current: str | None = None
    for line in match.group(1).splitlines():
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if indent == 0 and stripped.endswith(":"):
            current = stripped[:-1]
            meta[current] = {}
        elif indent == 2 and ":" in stripped:
            key, _, value = stripped.partition(":")
            if current is not None:
                meta[current][key.strip()] = value.strip()
            else:
                meta[key.strip()] = value.strip()
    return meta


def task_body(task_md_path: Path) -> str:
    text = task_md_path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    return text[match.end():].strip() if match else text.strip()


def parse_limits(meta: dict) -> dict:
    env = meta.get("environment", {}) or {}
    verifier = meta.get("verifier", {}) or {}
    agent = meta.get("agent", {}) or {}

    def number(value: str | None, default: float) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    return {
        "cpus": int(number(env.get("cpus"), 1)),
        "memory_mb": int(number(env.get("memory_mb"), 4096)),
        "verifier_timeout": number(verifier.get("timeout_sec"), DEFAULT_VERIFIER_TIMEOUT),
        "agent_timeout": number(agent.get("timeout_sec"), 900),
    }


def parse_toml_limits(toml_path: Path) -> dict:
    import tomllib
    with toml_path.open("rb") as handle:
        meta = tomllib.load(handle)
    return parse_limits(meta)


def parse_workdir(environment_dir: Path) -> str:
    dockerfile = environment_dir / "Dockerfile"
    text = dockerfile.read_text(encoding="utf-8")
    matches = WORKDIR_RE.findall(text)
    return matches[-1] if matches else "/root"


def run(cmd: list[str], *, timeout: int, input_text: str | None = None) -> dict:
    try:
        completed = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                                   input=input_text)
        return {"returncode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
    except subprocess.TimeoutExpired as exc:
        return {"returncode": 124, "stdout": (exc.stdout or b"").decode() if isinstance(exc.stdout, bytes) else (exc.stdout or ""),
                "stderr": f"timeout after {timeout}s", "timed_out": True}


@dataclass
class EpisodeEnv:
    task_id: str
    episode_id: str
    container: str
    image: str
    workdir: str
    limits: dict
    created_at: float
    actions: int = 0
    verify_started: bool = False
    verify_done: bool = False
    verdict: dict | None = None


class EnvServer:
    def __init__(self, tasks_root: Path, log_path: Path, profile: str = "skillsbench",
                 exec_proxy: str = "") -> None:
        self.lock = threading.Lock()
        self.tasks_root = tasks_root.resolve()
        self.log_path = log_path.resolve()
        self.profile = PROFILES[profile]
        self.exec_proxy = exec_proxy
        self.episodes: dict[str, EpisodeEnv] = {}
        self.images: dict[str, str] = {}
        log_path.parent.mkdir(parents=True, exist_ok=True)

    def _exec_env_args(self) -> list[str]:
        """Environment plumbing for verifier/oracle execs.

        The official protocol assumes public network egress (uv/pytest installs
        at verify time). This host reaches the internet through a local proxy;
        exporting it into the exec is an environment accommodation, recorded
        per verdict — never a verifier change.
        """
        if not self.exec_proxy:
            return []
        return ["-e", f"https_proxy={self.exec_proxy}",
                "-e", f"HTTPS_PROXY={self.exec_proxy}",
                "-e", f"http_proxy={self.exec_proxy}",
                "-e", f"HTTP_PROXY={self.exec_proxy}",
                "-e", "no_proxy=localhost,127.0.0.1",
                "-e", "NO_PROXY=localhost,127.0.0.1"]

    # -- lifecycle log ----------------------------------------------------
    def _append(self, kind: str, episode_id: str, payload: dict) -> None:
        record = {"t": round(time.time(), 3), "kind": kind, "episode_id": episode_id, **payload}
        with self.lock:
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    # -- task helpers -----------------------------------------------------
    def task_dir(self, task_id: str) -> Path:
        # skilllearnbench task ids are "<task>/<task>-<n>" instance paths.
        path = self.tasks_root / task_id
        if not path.is_dir():
            raise SidecarError(f"unknown task {task_id} under {self.tasks_root}")
        metadata = "task.toml" if self.profile["metadata"] == "task_toml" else "task.md"
        if not (path / metadata).is_file():
            raise SidecarError(f"unknown task {task_id} under {self.tasks_root}")
        return path

    def _limits(self, task_dir: Path) -> dict:
        if self.profile["metadata"] == "task_toml":
            return parse_toml_limits(task_dir / "task.toml")
        return parse_limits(parse_frontmatter(task_dir / "task.md"))

    def build_image(self, task_id: str) -> str:
        with self.lock:
            cached = self.images.get(task_id)
        if cached:
            return cached
        task_dir = self.task_dir(task_id)
        image = "sbbench-" + re.sub(r"[^a-z0-9._-]", "-", task_id.lower())
        context = self.build_context(task_dir, task_id)
        # Docker's predefined proxy ARGs: apt/pip inside the build inherit
        # them, so image builds work on hosts whose egress needs the proxy
        # (the -e exec flags alone only cover run/exec).
        proxy_build_args: list[str] = []
        if self.exec_proxy:
            proxy_build_args = [
                "--build-arg", f"http_proxy={self.exec_proxy}",
                "--build-arg", f"https_proxy={self.exec_proxy}",
                "--build-arg", "no_proxy=127.0.0.1,localhost",
            ]
        try:
            result = run(["docker", "build", "-t", image, *proxy_build_args, str(context)],
                         timeout=DEFAULT_BUILD_TIMEOUT)
        finally:
            if context != task_dir / "environment":
                shutil.rmtree(context.parent, ignore_errors=True)
        if result["returncode"] != 0:
            raise SidecarError(f"docker build failed for {task_id}: {result['stderr'][-2000:]}")
        with self.lock:
            self.images[task_id] = image
        self._append("image_built", "", {"task_id": task_id, "image": image})
        return image

    def build_context(self, task_dir: Path, task_id: str) -> Path:
        """Build context for the task environment.

        SkillsBench builds the reference <task>/environment/ directory directly.
        SkillLearnBench follows the official `_prepare_base_build_env` semantics
        (evaluate_skills.py): the base image must NOT bake in any oracle skill, so
        existing `skills/` is excluded and an empty `skills/` (with one stub
        subdir per `COPY skills/<subdir>` Dockerfile instruction) is injected to
        satisfy the Dockerfile while keeping the base hermetic.
        """
        if not self.profile.get("inject_skill_stubs"):
            return task_dir / "environment"
        tmp_root = Path(tempfile.mkdtemp(prefix="slb_buildctx_"))
        build_env = tmp_root / "environment"
        shutil.copytree(task_dir / "environment", build_env,
                        ignore=shutil.ignore_patterns("skills"))
        skills_dir = build_env / "skills"
        skills_dir.mkdir(parents=True)
        dockerfile = build_env / "Dockerfile"
        if dockerfile.exists():
            for match in SKILL_COPY_RE.finditer(dockerfile.read_text(encoding="utf-8")):
                stub_sub = match.group(1).split("/", 1)[1]
                (skills_dir / stub_sub).mkdir(parents=True, exist_ok=True)
        return build_env

    # -- endpoints --------------------------------------------------------
    def ensure(self, task_id: str, episode_id: str, mount_oracle: bool = False) -> EpisodeEnv:
        with self.lock:
            entry = self.episodes.get(episode_id)
        if entry is not None:
            if entry.task_id != task_id:
                raise SidecarError(f"episode {episode_id} already bound to task {entry.task_id}")
            return entry
        task_dir = self.task_dir(task_id)
        limits = self._limits(task_dir)
        image = self.build_image(task_id)
        container = "sb-" + re.sub(r"[^a-z0-9-]", "-", episode_id.lower())[:90]
        logs_dir = self.log_path.parent / "container-logs" / container
        (logs_dir / "verifier").mkdir(parents=True, exist_ok=True)
        mounts = [
            f"{task_dir / self.profile['verifier_dirname']}:{self.profile['verifier_mount']}:ro",
            f"{logs_dir}:/logs",
        ]
        # Leak discipline: the oracle/solution (reference solution) is NEVER
        # mounted into agent containers — only oracle-sanity runs see it.
        if mount_oracle:
            mounts.append(f"{task_dir / self.profile['oracle_dirname']}:{self.profile['oracle_mount']}:ro")
        run_args = ["docker", "run", "-d", "--rm", "--name", container,
                    "--cpus", str(limits["cpus"]),
                    "--memory", f"{limits['memory_mb']}m"]
        for mount in mounts:
            run_args.extend(["-v", mount])
        run_args.extend([image, "sleep", "infinity"])
        started = run(run_args, timeout=120)
        if started["returncode"] != 0 or not started["stdout"].strip():
            raise SidecarError(f"docker run failed for {episode_id}: {started['stderr'][-2000:]}")
        workdir = parse_workdir(task_dir / "environment")
        entry = EpisodeEnv(task_id=task_id, episode_id=episode_id, container=container,
                           image=image, workdir=workdir, limits=limits,
                           created_at=time.time())
        with self.lock:
            self.episodes[episode_id] = entry
        self._append("env_created", episode_id, {
            "task_id": task_id, "container": container, "image": image,
            "workdir": workdir, "limits": limits,
            "exec_proxy": self.exec_proxy or None})
        return entry

    def execute(self, episode_id: str, command: str, timeout_sec: int | None, call_id: str) -> dict:
        with self.lock:
            entry = self.episodes.get(episode_id)
        if entry is None:
            raise SidecarError(f"unknown episode {episode_id}; POST /env first")
        if entry.verify_started:
            raise SidecarError(f"episode {episode_id} is closing; no further execution")
        budget = min(int(timeout_sec or DEFAULT_EXEC_TIMEOUT), 900)
        exec_args = ["docker", "exec"] + self._exec_env_args() + [
            "-w", entry.workdir, entry.container,
            "timeout", str(budget), "bash", "-lc", command]
        result = run(exec_args, timeout=budget + 30)
        entry.actions += 1
        payload = {"call_id": call_id, "command": command,
                   "exit_code": result["returncode"],
                   "stdout": result["stdout"][-8000:], "stderr": result["stderr"][-4000:],
                   "n_actions": entry.actions}
        self._append("exec", episode_id, payload)
        return {"exit_code": result["returncode"], "stdout": result["stdout"][-16000:],
                "stderr": result["stderr"][-4000:]}

    def verify(self, episode_id: str) -> dict:
        with self.lock:
            entry = self.episodes.get(episode_id)
        if entry is None:
            raise SidecarError(f"unknown episode {episode_id}; POST /env first")
        if entry.verify_done and entry.verdict is not None:
            return entry.verdict
        entry.verify_started = True
        self._append("verify_started", episode_id, {"task_id": entry.task_id})
        # A stale or agent-forged reward.txt cannot survive: unlink, then let
        # the official test.sh write a fresh one.
        run(["docker", "exec", entry.container, "rm", "-f", "/logs/verifier/reward.txt"],
            timeout=30)
        budget = int(entry.limits["verifier_timeout"])
        verify_exec = ["docker", "exec"] + self._exec_env_args() + [entry.container, "timeout", str(budget),
                        "bash", self.profile["verifier_entry"]]
        verified = run(verify_exec, timeout=budget + 60)
        reward = run(["docker", "exec", entry.container, "cat", "/logs/verifier/reward.txt"],
                     timeout=30)
        output_tail = (verified["stdout"] + verified["stderr"])[-6000:]
        if reward["returncode"] != 0 or not reward["stdout"].strip():
            verdict = {"episode_id": episode_id, "task_id": entry.task_id,
                       "reward": 0.0, "graded": False,
                       "error": "official verifier produced no reward.txt",
                       "verifier_exit": verified["returncode"],
                       "verifier_output_tail": output_tail}
        else:
            token = reward["stdout"].strip().splitlines()[0]
            try:
                value = float(token)
            except ValueError:
                verdict = {"episode_id": episode_id, "task_id": entry.task_id,
                           "reward": 0.0, "graded": False,
                           "error": f"unparseable reward {token!r}",
                           "verifier_exit": verified["returncode"],
                           "verifier_output_tail": output_tail}
            else:
                verdict = {"episode_id": episode_id, "task_id": entry.task_id,
                           "reward": value, "graded": True,
                           "verifier_exit": verified["returncode"],
                           "verifier_output_tail": output_tail}
        entry.verdict = verdict
        entry.verify_done = True
        self._append("verdict", episode_id, verdict)
        # Teardown: the verdict is durable in the lifecycle log.
        run(["docker", "rm", "-f", entry.container], timeout=60)
        self._append("container_removed", episode_id, {"task_id": entry.task_id})
        return verdict

    def close_async(self, episode_id: str) -> dict:
        """Runner-side best-effort hook (15s budget): start verify in background."""
        with self.lock:
            entry = self.episodes.get(episode_id)
        if entry is None or entry.verify_started:
            return {"ok": True, "verifying": entry is not None and entry.verify_started}
        threading.Thread(target=self.verify, args=(episode_id,), daemon=True).start()
        return {"ok": True, "verifying": True}

    def oracle_sanity(self, task_id: str) -> dict:
        episode_id = f"oracle-sanity@{task_id}"
        entry = self.ensure(task_id, episode_id, mount_oracle=True)
        solve = run(["docker", "exec"] + self._exec_env_args() + ["-w", entry.workdir, entry.container,
                     "timeout", str(int(entry.limits["agent_timeout"])),
                     "bash", self.profile["oracle_entry"]],
                    timeout=int(entry.limits["agent_timeout"]) + 60)
        self._append("oracle_run", episode_id, {"task_id": task_id, "exit_code": solve["returncode"],
                                                 "tail": (solve["stdout"] + solve["stderr"])[-3000:]})
        verdict = self.verify(episode_id)
        verdict["oracle_exit"] = solve["returncode"]
        return verdict


class Handler(BaseHTTPRequestHandler):
    server_version = "skillsbench-env/1.0"

    def log_message(self, fmt, *args):  # quiet access log
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})
        if self.path == "/verdicts":
            records = []
            for line in self.server.env.log_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # tolerate a polluted (non-JSON) line without killing the door
            return self._json(200, {"records": records})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})
        try:
            if self.path == "/env":
                entry = self.server.env.ensure(str(payload["task_id"]), str(payload["episode_id"]))
                return self._json(200, {"ok": True, "container": entry.container,
                                        "workdir": entry.workdir, "limits": entry.limits})
            if self.path == "/execute":
                result = self.server.env.execute(str(payload["episode_id"]),
                                                 str(payload["command"]),
                                                 payload.get("timeout_sec"),
                                                 str(payload.get("call_id", "")))
                return self._json(200, result)
            if self.path == "/close":
                return self._json(200, self.server.env.close_async(str(payload["episode_id"])))
            if self.path == "/verify":
                return self._json(200, self.server.env.verify(str(payload["episode_id"])))
            if self.path == "/oracle":
                return self._json(200, self.server.env.oracle_sanity(str(payload["task_id"])))
            if self.path == "/prebuild":
                for task_id in payload.get("task_ids", []):
                    self.server.env.build_image(str(task_id))
                return self._json(200, {"ok": True, "images": dict(self.server.env.images)})
            if self.path == "/shutdown":
                for episode_id, entry in list(self.server.env.episodes.items()):
                    run(["docker", "rm", "-f", entry.container], timeout=60)
                    self.server.env.episodes.pop(episode_id, None)
                return self._json(200, {"ok": True})
        except SidecarError as exc:
            return self._json(400, {"error": str(exc)})
        except KeyError as exc:
            return self._json(400, {"error": f"missing field {exc}"})
        return self._json(404, {"error": "not found"})


class EnvHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, env: EnvServer):
        super().__init__(address, Handler)
        self.env = env


def main() -> int:
    parser = argparse.ArgumentParser(description="SkillsBench/SkillLearnBench container tool-plane sidecar")
    parser.add_argument("--tasks-root", required=True,
                        help="vendored tasks/ directory (skilllearnbench: instance parents)")
    parser.add_argument("--profile", choices=("skillsbench", "skilllearnbench", "skillflow"), default="skillsbench")
    parser.add_argument("--port", type=int, default=8731)
    parser.add_argument("--log", default="skillsbench-lifecycle.jsonl")
    parser.add_argument("--exec-proxy", default="",
                        help="https proxy URL passed into verifier/oracle execs (environment plumbing; e.g. http://172.17.0.1:7893)")
    args = parser.parse_args()
    tasks_root = Path(args.tasks_root).resolve()
    if not tasks_root.is_dir():
        raise SystemExit(f"tasks root not a directory: {tasks_root}")
    server = EnvHTTPServer(("127.0.0.1", args.port), EnvServer(tasks_root, Path(args.log), profile=args.profile,
                                                                exec_proxy=args.exec_proxy))
    print(f"{args.profile} env sidecar on http://127.0.0.1:{args.port} tasks={tasks_root} log={args.log}")
    print(f"vendor commit pin: {VENDOR_COMMIT if args.profile == 'skillsbench' else SLB_VENDOR_COMMIT}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())