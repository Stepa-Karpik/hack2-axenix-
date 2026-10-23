param([switch]$Build)
. "$PSScriptRoot/environment.ps1"
if($Build){& ./mvnw.cmd -B -ntp -pl apps/server -am -DskipTests package;if($LASTEXITCODE){throw 'Build failed'}}
Copy-Item apps/server/target/server-0.1.0-SNAPSHOT.jar .local/dev-server.jar -Force
& java -jar .local/dev-server.jar
