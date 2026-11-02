# Fallback for when win-audio.exe is missing: compiles the same helper source at run time and serves requests.
# Slower to start and uses more memory than the exe; see win-audio.cs for the protocol.
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Management -Path (Join-Path $PSScriptRoot 'win-audio.cs')
[MicManager.Audio]::Run()
