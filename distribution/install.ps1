param([string]$CacheRoot = '', [string]$WriterSource = '', [string]$ModelStore = '', [switch]$SkipQualityModel)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$modelRoot = ''
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Local-Path([string]$relative) {
  $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
  if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'An installation path escaped its folder.' }
  $ancestor = $target
  while ($ancestor -and $ancestor -ne $root) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "The installation path contains a link: $ancestor" }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  return $target
}
function Matches([string]$file, $entry) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -ne $entry.bytes) { return $false }
  $stream = [IO.File]::OpenRead($file)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant() -eq $entry.sha256 }
  finally { $stream.Dispose(); $hasher.Dispose() }
}
function Model-Path([string]$relative) {
  $target=[IO.Path]::GetFullPath((Join-Path $modelRoot $relative))
  if(-not $target.StartsWith($modelRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'An unsafe model path was rejected.'}
  return $target
}
function Obtain($entry) {
  $target = if($entry.path.StartsWith('writer/models/')){Model-Path $entry.path.Substring(14)}else{Local-Path $entry.path}
  if (Matches $target $entry) { Write-Host "Already checked: $($entry.label)"; return $target }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
  $cached = if ($CacheRoot) { Join-Path $CacheRoot $entry.sha256 } else { '' }
  if ((-not $cached -or -not (Matches $cached $entry)) -and $entry.path.StartsWith('writer/models/blobs/')) {
    $modelCache = Join-Path $env:USERPROFILE ('.ollama/models/blobs/sha256-'+$entry.sha256)
    if(Matches $modelCache $entry){$cached=$modelCache}
  }
  # A verified optional cache supports offline distribution and interrupted installations.
  if ($cached -and (Matches $cached $entry)) { Copy-Item -LiteralPath $cached -Destination ($target+'.partial') }
  else {
    Write-Host "Downloading $($entry.label) ($([math]::Round($entry.bytes/1GB,2)) GiB)..." -ForegroundColor Cyan
    & curl.exe --fail --location --retry 3 --retry-delay 2 --connect-timeout 30 --continue-at - --output ($target+'.partial') $entry.url
    if ($LASTEXITCODE -eq 33) {
      # Only the verified in-folder partial target is restarted when the server cannot resume.
      if (Test-Path -LiteralPath ($target+'.partial')) { Remove-Item -LiteralPath ($target+'.partial') }
      & curl.exe --fail --location --retry 3 --connect-timeout 30 --output ($target+'.partial') $entry.url
    }
    if ($LASTEXITCODE -ne 0) { throw "Download interrupted: $($entry.label). Run Install again to resume." }
  }
  Write-Host "Checking $($entry.label)..."
  if (-not (Matches ($target+'.partial') $entry)) {
    Move-Item -LiteralPath ($target+'.partial') -Destination ($target+'.invalid-'+[Guid]::NewGuid().ToString('N'))
    throw "Checksum mismatch: $($entry.label). Run Install again for a fresh download; the invalid file was set aside."
  }
  Move-Item -LiteralPath ($target+'.partial') -Destination $target -Force
  return $target
}
function Expand-Checked([string]$archive, [string]$relative) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $destination = Local-Path $relative
  [IO.Directory]::CreateDirectory($destination) | Out-Null
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('/',[IO.Path]::DirectorySeparatorChar)
      $target = Local-Path (Join-Path $relative $name)
      if (-not $target.StartsWith($destination+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {throw 'Archive contains an unsafe path.'}
      if (-not $entry.Name) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)
    }
  } finally { $zip.Dispose() }
}

$lock = $null
try {
  Write-Host "`nYuE Studio - first-time installation`n" -ForegroundColor Cyan
  Write-Host 'Music, writing and radio run locally after setup. No account or API key is needed.'
  Write-Host 'YuE2 model weights are licensed for noncommercial use. See licenses/YuE2-MODEL-LICENSE.txt.'
  $manifest = Get-Content -LiteralPath (Local-Path 'install-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1) {throw 'Unsupported installation manifest.'}
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {throw 'Windows curl.exe is required. Use an updated Windows 10 or Windows 11 installation.'}
  $lock = [IO.File]::Open((Local-Path '.installation.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $desktopExe = Local-Path 'desktop/YuE Studio.exe'
  $running = Get-CimInstance Win32_Process -Filter "name='YuE Studio.exe'" | Where-Object {$_.ExecutablePath -eq $desktopExe}
  if ($running) {throw 'Close this copy of YuE Studio before installing or repairing its dependencies.'}
  $standardModels=Join-Path $env:USERPROFILE '.ollama/models'
  if($ModelStore){$modelRoot=[IO.Path]::GetFullPath($ModelStore)}
  elseif($env:OLLAMA_MODELS){$modelRoot=[IO.Path]::GetFullPath($env:OLLAMA_MODELS)}
  elseif((Test-Path -LiteralPath $standardModels) -or (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs/Ollama/ollama.exe'))){$modelRoot=[IO.Path]::GetFullPath($standardModels)}
  else{$modelRoot=Local-Path 'writer/models'}
  $modelRoot=$modelRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)
  Write-Host "Model store: $modelRoot"
  Write-Host 'Existing models stay in place. Only missing or damaged pinned Granite files are downloaded.'
  foreach ($entry in $manifest.music) { $null = Obtain $entry }
  if(-not $WriterSource){$WriterSource=Join-Path $env:LOCALAPPDATA 'Programs/Ollama'}
  $reuseWriter = $true
  foreach($entry in $manifest.writerRuntimeFiles){
    $candidate=Join-Path $WriterSource $entry.path
    if(-not (Matches $candidate $entry)){$reuseWriter=$false;break}
  }
  if($reuseWriter){
    Write-Host 'Reusing the exact checked Ollama runtime from this PC...'
    foreach($entry in $manifest.writerRuntimeFiles){
      $target=Local-Path ('writer/'+$entry.path)
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      Copy-Item -LiteralPath (Join-Path $WriterSource $entry.path) -Destination $target -Force
    }
  } else {
    foreach ($entry in $manifest.ollama) {
      $archive = Obtain $entry
      Write-Host "Unpacking $($entry.label)..."
      Expand-Checked $archive 'writer'
    }
  }
  foreach ($model in $manifest.writers) {
    if ($SkipQualityModel -and $model.optional) {continue}
    foreach ($entry in $model.files) { $null = Obtain $entry }
    $modelManifest = Model-Path $model.manifestPath.Substring(14)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($modelManifest)) | Out-Null
    [IO.File]::WriteAllText($modelManifest,$model.manifestJson,[Text.UTF8Encoding]::new($false))
  }
  Write-Host 'Checking the music engine and detecting this computer...'
  $runtimeExe = Local-Path 'runtime/audiocpp_cli.exe'
  $probe = [Diagnostics.Process]::new()
  $probe.StartInfo.FileName = $runtimeExe
  $probe.StartInfo.Arguments = '--list-devices'
  $probe.StartInfo.UseShellExecute = $false
  $probe.StartInfo.CreateNoWindow = $true
  $probe.StartInfo.RedirectStandardOutput = $true
  $probe.StartInfo.RedirectStandardError = $true
  try {
    $null = $probe.Start()
    $stdout = $probe.StandardOutput.ReadToEndAsync()
    $stderr = $probe.StandardError.ReadToEndAsync()
    $probe.WaitForExit()
    $deviceOutput = $stdout.Result + "`n" + $stderr.Result
    if ($probe.ExitCode -ne 0) {throw 'The music engine could not start. Install the current graphics driver from AMD, NVIDIA or Intel, then run Install again.'}
  } finally { $probe.Dispose() }
  $devices = @([regex]::Matches($deviceOutput,'(?m)^Vulkan:(\d+) "(.+?)" \[(GPU|IGPU)\]') | ForEach-Object { [pscustomobject]@{index=[int]$_.Groups[1].Value;name=$_.Groups[2].Value;type=$_.Groups[3].Value} })
  $device = $devices | Sort-Object @{Expression={if($_.type -eq 'GPU'){0}else{1}}},index | Select-Object -First 1
  $backend = if($device){'vulkan'}else{'cpu'}
  $runtime = Get-Content -LiteralPath (Local-Path 'runtime/runtime.json') -Raw | ConvertFrom-Json
  $runtime.backend = $backend
  $runtime.deviceIndex = if($device){$device.index}else{$null}
  $runtime.device = if($device){$device.name}else{'CPU - no Vulkan graphics device found'}
  $runtime.verified = $true
  $runtime | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Local-Path 'runtime/runtime.json') -Encoding UTF8
  $cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
  $ram = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  @{gpu=$runtime.device;cpu=$cpu;ramGB=[math]::Round($ram/1GB)} | ConvertTo-Json | Set-Content -LiteralPath (Local-Path 'runtime/hardware.json') -Encoding UTF8
  # UTF-8 without BOM is needed by the Node service on Windows PowerShell 5.1.
  foreach($relative in @('runtime/runtime.json','runtime/hardware.json')) {
    $file=Local-Path $relative; $text=[IO.File]::ReadAllText($file); [IO.File]::WriteAllText($file,$text,[Text.UTF8Encoding]::new($false))
  }
  $existingUrl='http://127.0.0.1:11434'
  if($env:OLLAMA_HOST){
    $hostText=$env:OLLAMA_HOST
    if($hostText -notmatch '^https?://'){$hostText='http://'+$hostText}
    try{$hostUri=[Uri]$hostText;if($hostUri.Host -in @('127.0.0.1','localhost','::1')){$existingUrl=$hostUri.GetLeftPart([UriPartial]::Authority)}}catch{}
  }
  $portable=@{version=1;writerModels=$modelRoot;existingOllamaUrl=$existingUrl;recommendedModel='granite4.2:3b'} | ConvertTo-Json
  [IO.File]::WriteAllText((Local-Path 'portable.json'),$portable,[Text.UTF8Encoding]::new($false))
  if (-not $device) {Write-Host 'No Vulkan GPU was found. CPU rendering is available but can be very slow.' -ForegroundColor Yellow}
  Write-Host "`nReady. Double-click 2 - Run YuE Studio.cmd.`n" -ForegroundColor Green
} catch {
  Write-Host "`nInstallation did not finish: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Your songs and settings were not removed. Run Install again after resolving the problem.'
  exit 1
} finally {if($lock){$lock.Dispose()}}
