param([switch]$SkipBuild)
. "$PSScriptRoot/environment.ps1"
function Invoke-JbDocker { & wsl.exe -d JavaBlueprints -u root -- docker @args; if($LASTEXITCODE){throw 'Docker command failed'} }
if(-not $SkipBuild){
 foreach($jbRequired in @('java','node','pnpm')){if(-not(Get-Command $jbRequired -ErrorAction SilentlyContinue)){throw "Missing $jbRequired. Install JDK21, Node24 and pnpm11 or configure portable tool directories in .env."}}

 & ./mvnw.cmd -B -ntp -DskipTests package
 if($LASTEXITCODE){throw 'Java build failed'}
 & pnpm install --frozen-lockfile --store-dir "$jbRoot/.local/cache/pnpm"
 if($LASTEXITCODE){throw 'Frontend installation failed'}
 & pnpm --dir apps/web build
 if($LASTEXITCODE){throw 'Frontend build failed'}
}
Invoke-JbDocker pull eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0
$jbWslRoot=(& wsl.exe -d JavaBlueprints -- wslpath -a $jbRoot.Replace('\','/')).Trim()
Invoke-JbDocker compose --env-file "$jbWslRoot/.env" -f "$jbWslRoot/infra/compose.yaml" up -d --build
$jbReady=$false
for($jbTry=0;$jbTry -lt 60;$jbTry++){
 try{$jbHealth=Invoke-RestMethod 'http://127.0.0.1:5174/api/v1/health' -TimeoutSec 2;if($jbHealth.data.status -eq 'up'){$jbReady=$true;break}}catch{}
 Start-Sleep -Seconds 1
}
if(-not $jbReady){throw 'Application did not become ready within 60 seconds. Inspect docker compose logs.'}
$jbCapabilities=Invoke-RestMethod 'http://127.0.0.1:5174/api/v1/capabilities' -TimeoutSec 5
Write-Output "Java Blueprints ready: http://127.0.0.1:5174 (runner available: $($jbCapabilities.data.runner.available))"
