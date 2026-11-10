"""Synchronize the merged catalog through the signed-in local Codex client."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
GROUPS = ["00 Base", "01 Semantic", "02 Control recipes", "Palette captions"]
MODES = [["Base"], ["Dark", "Light"], ["Default"], ["Default"]]


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], text=True, timeout=90).strip()


def leaves(group, path=()):
    for key, item in group.items():
        if key.startswith("$"):
            continue
        parts = path + (key,)
        if "$value" in item:
            yield ".".join(parts), item
        else:
            yield from leaves(item, parts)


def float32(value):
    return struct.unpack("!f", struct.pack("!f", value))[0]


def palette_caption(path, token, mode):
    if token["$type"] != "color":
        return None
    if path.startswith("base.color."):
        role = token["$extensions"]["app.caelos"]["paletteRole"]
        return "hex/" + role, "Approved palette — " + token["$value"]["hex"].upper()
    if path.startswith("sys.color.") and token.get("$description"):
        role = path.removeprefix("sys.color.")
        return "use/" + mode.lower() + "/" + role, "Use · " + token["$description"]
    return None


def compile_catalog(revision):
    files = git("ls-tree", "--name-only", revision + ":token_catalog").splitlines()
    rows = [{} for _ in GROUPS]
    names = {}
    for file in sorted(f for f in files if f.endswith(".tokens.json")):
        group = 0 if file.startswith("00-foundations") else 1 if file.startswith("00-semantic") else 2
        mode = MODES[group][-1 if ".light." in file else 0]
        for path, token in leaves(json.loads(git("show", revision + ":token_catalog/" + file))):
            published = token["$extensions"]["app.caelos"].get("figmaName")
            name = published or names.get(path, (None, path.replace(".", "/")))[1]
            if path in names and names[path] != (group, name):
                raise ValueError("Conflicting names across modes for " + path)
            names[path] = (group, name)
            value = token["$value"]
            caption = palette_caption(path, token, mode)
            if caption:
                label, content = caption
                rows[-1][label] = {"name":label, "type":"STRING", "values":{"Default":content}}
            kind = token["$type"]
            vt = {"color":"COLOR", "fontFamily":"STRING", "cubicBezier":"STRING",
                  "dimension":"FLOAT", "duration":"FLOAT", "number":"FLOAT", "fontWeight":"FLOAT"}[kind]
            if isinstance(value, str) and re.fullmatch(r"\{[^{}]+\}", value):
                target_group, target = names[value[1:-1]]
                value = {"alias":GROUPS[target_group] + "/" + target}
            elif kind == "color":
                h = value["hex"]
                value = [float32(int(h[n:n+2], 16) / 255) for n in (1, 3, 5)] + [float32(value["alpha"])]
            elif kind == "cubicBezier":
                value = ",".join(str(x) for x in value)
            elif vt == "FLOAT":
                value = float32(value["value"] if isinstance(value, dict) else value)
            row = rows[group].setdefault(name, {"name":name,"type":vt,"values":{}})
            if mode in row["values"] or row["type"] != vt:
                raise ValueError("Conflicting variables at " + name)
            row["values"][mode] = value
    return [dict(name=name, modes=modes, variables=sorted(group.values(), key=lambda x:x["name"]))
            for name, modes, group in zip(GROUPS, MODES, rows)]


class Client:
    def __init__(self, binary):
        self.p = subprocess.Popen([binary, "app-server"], cwd=ROOT, stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.seq = 0

    def send(self, data):
        self.p.stdin.write(json.dumps(data) + "\n")
        self.p.stdin.flush()

    def request(self, method, params):
        self.seq += 1
        self.send({"id":self.seq,"method":method,"params":params})
        for line in self.p.stdout:
            msg = json.loads(line)
            if "method" in msg and "id" in msg:
                raise RuntimeError("Codex requires interactive approval for " + msg["method"])
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise RuntimeError(method + " failed: " + str(msg["error"].get("code")))
                return msg["result"]
        raise RuntimeError("Codex disconnected during " + method)

    def start(self):
        self.request("initialize", {"clientInfo":{"name":"caelos-catalog","version":"1"},
                                    "capabilities":{"experimentalApi":True}})
        self.send({"method":"initialized"})
        self.thread = self.request("thread/start", {"ephemeral":True,"sandbox":"read-only"})["thread"]["id"]

    def tool(self, name, args):
        res = self.request("mcpServer/tool/call", {"threadId":self.thread,"server":"codex_apps",
                           "tool":"figma." + name,"arguments":args})
        if res.get("isError"):
            detail = res.get("content", [{}])[0].get("text", "unspecified error")
            raise RuntimeError("Figma " + name + " failed: " + detail.replace(os.environ["CAELOS_FIGMA_FILE"], "[file]")[:800])
        return res["content"][0]["text"]

    def close(self):
        self.p.terminate()
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait()


def digest(obj):
    def normalize(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, dict):
            return {k:normalize(v) for k,v in item.items()}
        if isinstance(item, list):
            return [normalize(v) for v in item]
        return item
    return hashlib.sha256(json.dumps(normalize(obj), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def compare(plan, live):
    clean = True
    for spec in plan:
        current = next((c for c in live if c["name"] == spec["name"]), None)
        if current is None:
            print("missing collection", spec["name"])
            clean = False
            continue
        current["variables"].sort(key=lambda x:x["name"])
        actual, wanted = digest(current), digest(spec)
        print(spec["name"], "live", actual, "catalog", wanted)
        if actual != wanted:
            clean = False
            if current["modes"] != spec["modes"]:
                print("  modes", current["modes"], "expected", spec["modes"])
            old = {v["name"]:v for v in current["variables"]}
            new = {v["name"]:v for v in spec["variables"]}
            for name in sorted(old.keys() | new.keys()):
                if old.get(name) != new.get(name):
                    print(" ", "legacy" if name not in new else "missing" if name not in old else "changed", name)
    return clean


def sync(revision, write):
    key = os.environ["CAELOS_FIGMA_FILE"]
    client = Client(os.environ.get("CODEX_BIN", "codex"))
    try:
        client.start()
        session = os.environ.get("CAELOS_FIGMA_SESSION")
        if not session:
            result = client.tool("create_session", {"fileKey":key,"description":"Synchronize and check the merged token catalog"})
            match = re.search(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", result)
            if match is None:
                raise RuntimeError("Figma returned no session identifier")
            session = match.group()
        def run(code, description):
            result = client.tool("use_figma", {"fileKey":key,"sessionId":session,"code":code,"description":description})
            return json.loads(result)
        plan = compile_catalog(revision)
        js = (ROOT / "scripts/figma-variables.js").read_text()
        if write:
            run(js + "\nawait libraryVariables(" + json.dumps(plan, separators=(",", ":")) + ", true); return 'true';",
                "Update library variables in place from the merged catalog")
        live = []
        for spec in plan:
            # Request a single collection at a time to keep response sizes bounded.
            minimal = [{**spec, "variables":[]}]
            live.extend(run(js + "\nreturn JSON.stringify(await libraryVariables(" + json.dumps(minimal) + ", false));",
                            "Read live " + spec["name"] + " variables for independent comparison"))
        return compare(plan, live)
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check","sync","watch"])
    args = parser.parse_args()
    def timeout(_signal, _frame):
        raise TimeoutError("Figma verification timed out")

    signal.signal(signal.SIGALRM, timeout)
    previous = None
    while True:
        try:
            git("fetch", "origin", "refs/heads/main")
            revision = git("rev-parse", "FETCH_HEAD")
            if revision != previous:
                signal.alarm(300)
                try:
                    clean = sync(revision, args.action != "check")
                finally:
                    signal.alarm(0)
                print("Checked main", revision, "clean" if clean else "drift", flush=True)
                if args.action != "watch":
                    return 0 if clean else 1
                previous = revision
        except (OSError, KeyError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            print("Sync unavailable:", error, file=sys.stderr, flush=True)
            if args.action != "watch":
                return 2
        time.sleep(60)


if __name__ == "__main__":
    sys.exit(main())
