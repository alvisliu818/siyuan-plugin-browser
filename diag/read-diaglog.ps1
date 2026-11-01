$ErrorActionPreference = 'Stop'
$db = 'C:\Users\alvisliu\AppData\Roaming\SiYuan-Electron\Partitions\siyuan-browser\Local Extension Settings\bchcpcnhjelkpkdjbmbnikbamkjdeenb'
$fs = [IO.File]::Open("$db\000003.log", 'Open', 'Read', [IO.FileShare]::ReadWrite)
$ms = New-Object IO.MemoryStream
$fs.CopyTo($ms)
$fs.Close()
$text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
Write-Output "total len=$($text.Length)"
$needle = 'syDiagLog'
$pos = $text.LastIndexOf($needle)
Write-Output "last $needle at: $pos"
if ($pos -lt 0) { return }
$start = $text.IndexOf('[', $pos)
Write-Output "start bracket at: $start"
$depth = 0; $inStr = $false; $esc = $false; $end = -1
for ($i = $start; $i -lt $text.Length; $i++) {
    $c = $text[$i]
    if ($esc) { $esc = $false; continue }
    if ($inStr) {
        if ($c -eq '\') { $esc = $true }
        elseif ($c -eq '"') { $inStr = $false }
        continue
    }
    if ($c -eq '"') { $inStr = $true; continue }
    if ($c -eq '[') { $depth++ }
    elseif ($c -eq ']') { $depth--; if ($depth -eq 0) { $end = $i; break } }
}
Write-Output "array end at: $end len=$($end - $start + 1)"
$json = $text.Substring($start, $end - $start + 1)
$arr = $json | ConvertFrom-Json
Write-Output "entries: $($arr.Count)"
$out = foreach ($e in $arr) { $e | ConvertTo-Json -Compress -Depth 5 }
[IO.File]::WriteAllLines('E:\HOME\Code\siyuan\siyuan-plugin-browser\diag\diaglog-tail.jsonl', $out)
Write-Output "saved diaglog-tail.jsonl"
