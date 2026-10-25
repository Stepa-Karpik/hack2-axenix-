#!/usr/bin/env bash
set -euo pipefail
sha="${1:?Expected full commit SHA}"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$sha" ]]
payload=".local/release-payload-$sha"
mkdir -p "$payload"
docker build --label "org.opencontainers.image.revision=$sha" -f infra/server.Dockerfile -t "java-blueprints-server:$sha" .
docker build --label "org.opencontainers.image.revision=$sha" -f infra/runner/Dockerfile -t "java-blueprints-runner:$sha" .
cp infra/compose.production.yaml "$payload/compose.yaml"
docker image save "java-blueprints-server:$sha" "java-blueprints-runner:$sha" | gzip -1 > "$payload/images.tar.gz"
python3 - "$sha" "$payload" <<'PY'
import hashlib,json,subprocess,sys,pathlib
sha=sys.argv[1];p=pathlib.Path(sys.argv[2])
def image(name):
    ref=name+':'+sha
    value=json.loads(subprocess.check_output(['docker','image','inspect',ref]))[0]
    assert value['Config']['Labels']['org.opencontainers.image.revision']==sha
    return {'ref':ref,'id':value['Id']}
def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return h.hexdigest()
(p/'release.json').write_text(json.dumps({'commit':sha,'repository':'Stepa-Karpik/hack2-axenix-','server':image('java-blueprints-server'),'runner':image('java-blueprints-runner'),'composeSha256':digest(p/'compose.yaml'),'imageArchiveSha256':digest(p/'images.tar.gz')},indent=2)+'\n')
PY
tar -cf .local/release.tar -C "$payload" release.json compose.yaml images.tar.gz
sha256sum .local/release.tar > .local/release.tar.sha256
