!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Checking durian CLI..."
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if (-not (Get-Command durian -ErrorAction SilentlyContinue)) { irm https://raw.githubusercontent.com/gguf-org/durian/main/scripts/install.ps1 | iex }"`
!macroend
