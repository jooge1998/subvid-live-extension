$ErrorActionPreference = "Stop"

$hostName = "com.subvid.hymt2"
$extensionId = Read-Host "ID de SubVid en chrome://extensions (activa Modo de desarrollador y copia el ID)"
if ($extensionId -notmatch '^[a-p]{32}$') { throw "El ID de extensión de Chrome debe tener 32 letras entre a y p." }

$defaultServer = "C:\Users\Equipo\Desktop\Proyectos\IA\llama.cpp\build-vulkan\bin\Release\llama-server.exe"
$defaultModel = "C:\Users\Equipo\Desktop\Proyectos\IA\subvid.app\models\Hy-MT2-1.8B-Q4_K_M.gguf"
$serverInput = Read-Host "Ruta completa a llama-server.exe (Enter usa $defaultServer)"
$modelInput = Read-Host "Ruta completa al GGUF (Enter usa $defaultModel)"
$serverPath = if ($serverInput) { $serverInput.Trim('"') } else { $defaultServer }
$modelPath = if ($modelInput) { $modelInput.Trim('"') } else { $defaultModel }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "No existe llama-server.exe: $serverPath" }
if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) { throw "No existe el modelo GGUF: $modelPath" }
if ([IO.Path]::GetFileName($modelPath) -ne "Hy-MT2-1.8B-Q4_K_M.gguf") { throw "Selecciona el modelo probado Hy-MT2-1.8B-Q4_K_M.gguf para conservar el ID de modelo configurado en SubVid." }

$root = Join-Path $env:LOCALAPPDATA "SubVid\HyMt2NativeHost"
$data = Join-Path $env:LOCALAPPDATA "SubVid"
New-Item -ItemType Directory -Force -Path $root, $data | Out-Null
$project = Join-Path $PSScriptRoot "HyMt2Host.csproj"
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $root
if ($LASTEXITCODE -ne 0) { throw "No se pudo compilar el host Native Messaging (dotnet publish)." }

$config = @{ serverPath = (Resolve-Path -LiteralPath $serverPath).Path; modelPath = (Resolve-Path -LiteralPath $modelPath).Path; dataDirectory = $data } | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $data "hymt2-host.json") -Value $config -Encoding utf8
$manifestPath = Join-Path $root "$hostName.json"
$manifest = @{ name = $hostName; description = "Inicia y detiene el servidor local Hy-MT2 para SubVid"; path = (Join-Path $root "SubVid.HyMt2.NativeHost.exe"); type = "stdio"; allowed_origins = @("chrome-extension://$extensionId/") } | ConvertTo-Json -Depth 4
Set-Content -LiteralPath $manifestPath -Value $manifest -Encoding utf8

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Force -Path $registryPath | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Host "Host Hy-MT2 instalado para Chrome. Reinicia SubVid desde chrome://extensions." -ForegroundColor Green
Write-Host "Logs del servidor: $(Join-Path $data 'llama-server.stdout.log') y llama-server.stderr.log"
