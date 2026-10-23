$ErrorActionPreference = "Stop"
$hostName = "com.subvid.hymt2"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
if (Test-Path $registryPath) { Remove-Item -LiteralPath $registryPath -Force }
Write-Host "Se quitó el registro Native Messaging. Los archivos/logs de SubVid y el modelo se conservaron."
