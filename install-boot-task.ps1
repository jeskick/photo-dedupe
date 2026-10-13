param(
  [Parameter(Mandatory = $true)][string]$Bat
)

$ErrorActionPreference = "Stop"

function Test-RealUser([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  $leaf = ($Name -split "\\")[-1]
  $skip = @("SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE", "Guest", "DefaultAccount", "WDAGUtilityAccount")
  return $skip -notcontains $leaf
}

function Complete-Account([string]$Name) {
  if ($Name -like ".\*") {
    return "$env:COMPUTERNAME\$($Name.Substring(2))"
  }
  return $Name
}

function Get-PrimaryAccount {
  $logged = (Get-CimInstance Win32_ComputerSystem).UserName
  if (Test-RealUser $logged) { return (Complete-Account $logged) }
  $who = "$env:USERDOMAIN\$env:USERNAME"
  if (Test-RealUser $who) { return $who }
  $last = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI" -ErrorAction SilentlyContinue).LastLoggedOnSAMUser
  if (Test-RealUser $last) { return (Complete-Account $last) }
  throw "no primary account"
}

if (-not (Test-Path -LiteralPath $Bat)) { throw "startup script missing" }
$Bat = (Resolve-Path -LiteralPath $Bat).Path
$account = Get-PrimaryAccount
$leaf = ($account -split "\\")[-1]
$existing = Get-ScheduledTask -TaskName "PhotoDedupe" -ErrorAction SilentlyContinue
if ($existing) {
  $current = [string]$existing.Principal.UserId
  $currentLeaf = ($current -split "\\")[-1]
  if ($currentLeaf -eq $leaf -and $existing.Actions.Execute -eq $Bat) { exit 0 }
}
$action = New-ScheduledTaskAction -Execute $Bat -WorkingDirectory (Split-Path -Parent $Bat)
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT20S"
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden
try {
  Register-ScheduledTask -TaskName "PhotoDedupe" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
} catch {
  exit 2
}
Write-Output $account
