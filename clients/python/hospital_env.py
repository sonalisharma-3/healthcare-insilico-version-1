"""Python client for the hospital environment API (plan-master task 15.5).

reset, step, state, close, tasks, MCP calls, and a vectorised wrapper for N
parallel episodes. Standard library only. Not installed by npm install.

    from hospital_env import HospitalEnv
    env = HospitalEnv("http://127.0.0.1:3000", "hd_env_...")
    first = env.reset(task="<task id>", run="my-run", seed=1, condition="autonomous")
    out = env.step(first["episodeId"], {"tool": "read-chart", "args": {"type": "Patient", "id": "..."}})
    env.close(first["episodeId"])
"""
import json
import threading
import urllib.request
import urllib.error
import urllib.parse
from concurrent.futures import ThreadPoolExecutor


class EnvError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


class HospitalEnv:
    def __init__(self, base_url, token, timeout=60, run=None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.run = run
        self._named = {}
        self._lock = threading.Lock()

    def _call(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        req.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                text = r.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(text)
            except ValueError:
                parsed = {}
            raise EnvError(e.code, parsed.get("error", text[:200]), parsed.get("code"))

    def info(self):
        return self._call("GET", "/env/v1/info")

    def tasks(self, task_set=None, part=None):
        q = "&".join(f"{k}={v}" for k, v in (("taskSet", task_set), ("part", part)) if v)
        return self._call("GET", "/env/v1/tasks" + ("?" + q if q else ""))

    def reset(self, task=None, task_id=None, run=None, task_set=None, index=None, seed=0, condition="autonomous", clock=None, budgets=None, simulated_user=None):
        chosen_task = task if task is not None else task_id
        chosen_run = run if run is not None else (self.run or "default-run")
        chosen_seed = seed if isinstance(seed, int) else 0
        body = {"run": chosen_run, "seed": chosen_seed, "condition": condition}
        if chosen_task:
            body["task"] = chosen_task
        if task_set:
            body["taskSet"] = task_set
            body["index"] = index or 0
        if clock:
            body["clock"] = clock
        if budgets:
            body["budgets"] = budgets
        if simulated_user:
            body["simulatedUser"] = simulated_user
        out = self._call("POST", "/env/v1/reset", body)
        with self._lock:
            self._named[out["episodeId"]] = {
                "task": body.get("task"),
                "run": chosen_run,
                "seed": chosen_seed,
                "attempt": out["episodeId"],
            }
        return out

    def _four(self, episode_id):
        with self._lock:
            meta = self._named.get(episode_id)
        if not meta:
            raise ValueError("Unknown attempt: call reset first")
        return dict(meta)

    def step(self, episode_id, action):
        payload = self._four(episode_id)
        payload["action"] = action
        return self._call("POST", "/env/v1/step", payload)

    def state(self, episode_id):
        n = self._four(episode_id)
        q = urllib.parse.urlencode({"task": n["task"], "run": n["run"], "seed": n["seed"]})
        return self._call("GET", f"/env/v1/state/{urllib.parse.quote(episode_id, safe='')}?{q}")

    def close(self, episode_id):
        return self._call("POST", "/env/v1/close", self._four(episode_id))

    def finish_run(self, run=None):
        return self._call("POST", "/env/v1/runs/finish", {"run": run if run is not None else self.run})

    def mcp(self, episode_id, method, params=None, msg_id=1):
        n = self._four(episode_id)
        q = urllib.parse.urlencode({"task": n["task"], "run": n["run"], "seed": n["seed"]})
        return self._call("POST", f"/env/v1/mcp/{urllib.parse.quote(episode_id, safe='')}?{q}", {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}})

    def run_episode(self, reset_kwargs, policy, max_steps=50):
        """Runs one episode: policy(observation, tools, info) -> action dict."""
        first = self.reset(**reset_kwargs)
        obs, info, rewards, done, steps = first["observation"], first["info"], [], False, 0
        while not done and steps < max_steps:
            action = policy(obs, first["tools"], info)
            out = self.step(first["episodeId"], action)
            obs, info = out["observation"], out["info"]
            rewards.append(out["reward"])
            done = out["done"] or out["truncated"]
            steps += 1
        closed = self.close(first["episodeId"])
        return {"episodeId": first["episodeId"], "steps": steps, "rewards": rewards, "totalReward": closed["reward"], "rewardBreakdown": closed["rewardBreakdown"], "links": closed["links"]}


class VectorEnv:
    """N parallel episodes, each in its own thread. Episodes never see each other."""

    def __init__(self, env, n, workers=None):
        self.env = env
        self.n = n
        self.workers = workers or min(n, 32)

    def run(self, reset_kwargs_for, policy, max_steps=50):
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            return list(pool.map(lambda i: self.env.run_episode(reset_kwargs_for(i), policy, max_steps), range(self.n)))


def stub_policy(obs, tools, info):
    """Reads the patient once, then finishes. Replace with your model."""
    if not obs.get("result"):
        patient = (obs.get("briefing") or {}).get("patient") or ""
        return {"tool": "read-chart", "args": {"type": "Patient", "id": patient.split("/")[-1]}, "reasoning": "Look at the patient first"}
    return {"tool": "finish", "args": {"answer": "No action taken by the stub policy", "summary": "Stub policy finished"}}
