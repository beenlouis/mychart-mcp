"""Compute the env/secret set a connector's deploy.sh would apply, and diff it
against the live Cloud Run service (JSON on stdin). Prints the diff; exits 1 on drift."""
import json, os, re, sys

sh_path, project, region, project_number = sys.argv[1:5]
service = json.load(sys.stdin)
name = service["metadata"]["name"]
url = f"https://{name}-{project_number}.{region}.run.app"
c = service["spec"]["template"]["spec"]["containers"][0]

live = []
live_env = {}
for e in c.get("env", []):
    if "value" in e:
        live.append(f"ENV {e['name']}={e['value']}")
        live_env[e["name"]] = e["value"]
    else:
        r = e["valueFrom"]["secretKeyRef"]
        live.append(f"SEC {e['name']}={r['name']}:{r['key']}")
live.sort()

s = open(sh_path).read()
env = {
    "PROJECT_ID": project,
    "REGION": region,
    "PUBLIC_BASE_URL": url,
    "GOOGLE_CLIENT_ID": live_env.get("GOOGLE_CLIENT_ID", "<missing-live-GOOGLE_CLIENT_ID>"),
}


def sub(v):
    # ${VAR} and ${VAR:-default}: script-local vars first, then the shell env, then the default.
    def repl(m):
        k, dflt = m.group(1), m.group(2)
        if k in env:
            return env[k]
        if k in os.environ:
            return os.environ[k]
        return dflt if dflt is not None else m.group(0)
    return re.sub(r"\$\{(\w+)(?::-([^}]*))?\}", repl, v)


def split_list(v):
    # gcloud accepts a custom delimiter as ^DELIM^ prefix; default is a comma.
    m = re.match(r"\^([^^]+)\^", v)
    if m:
        return v[m.end():].split(m.group(1))
    return v.split(",")


for m in re.finditer(r'^(\w+)="([^"]*)"', s, re.M):
    k, v = m.group(1), m.group(2)
    if k in env or v.startswith("${"):
        continue
    env[k] = sub(v)

ev = re.search(r'--set-env-vars="([^"]*)"', s).group(1)
sv = re.search(r'--set-secrets="([^"]*)"', s).group(1)
want = sorted(["ENV " + kv for kv in split_list(sub(ev))] + ["SEC " + kv for kv in split_list(sub(sv))])

print(f"url={url}")
print(f"google_client_id={env['GOOGLE_CLIENT_ID']}")
print(f"live_revision={service['status']['latestReadyRevisionName']}")
only_live = sorted(set(live) - set(want))
only_want = sorted(set(want) - set(live))
if only_live or only_want:
    for x in only_live:
        print(f"  < live only : {x}")
    for x in only_want:
        print(f"  > script only: {x}")
    sys.exit(1)
print("match")
