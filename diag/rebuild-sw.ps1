$ErrorActionPreference = 'Stop'
$dir = 'E:\HOME\Local\siyuan-test-ws\data\storage\petal\siyuan-plugin-browser\extensions\edge-eeagobfjdenkkddmbclomhiblgggliao-19f6031'
$bak = [IO.File]::ReadAllText("$dir\sw.js.bak-sydiag")
$probe = [IO.File]::ReadAllText('E:\HOME\Code\siyuan\siyuan-plugin-browser\diag\sy-probe-v5.js')
[IO.File]::WriteAllText("$dir\sw.js", $probe + "`n" + $bak)
$new = [IO.File]::ReadAllText("$dir\sw.js")
Write-Output "len=$($new.Length)"
Write-Output "v9=$($new.Contains('v9-installed'))"
Write-Output "wrap=$($new.Contains('__syProbeWrapped'))"
$trapCount = [regex]::Matches($new, 'defineProperty\(self,\s*.__syOnMessageHandlers').Count
Write-Output "accessor-trap-on-handlers=$trapCount"
