; Custom NSIS hooks for Fleet Commander.
;
; Goal: updates must not keep re-adding the desktop shortcut. electron-builder
; recreates shortcuts on every (silent) update install, so a user who deleted
; the desktop icon gets it forced back each time. We preserve the user's
; choice: remember whether the desktop shortcut existed BEFORE the update, and
; if it didn't, delete the one electron-builder just recreated.
;
; First installs are untouched — the desktop shortcut is created as normal.
;
; The !ifndef matters: electron-builder includes this file in BOTH the installer
; and the uninstaller compile (both get the same shared header), but only the
; installer ever inserts customInit/customInstall. Declared unconditionally, the
; variable is unused in the uninstaller pass, and makensis reports that as
; "warning 6001: ... not referenced or never set" — which electron-builder runs
; with warnings-as-errors, failing the build at the packaging step.

!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutExisted
!endif

; Runs early, before the install section recreates shortcuts.
!macro customInit
  ${if} ${isUpdated}
    ${if} ${FileExists} "$DESKTOP\Fleet Commander.lnk"
      StrCpy $DesktopShortcutExisted "1"
    ${else}
      StrCpy $DesktopShortcutExisted "0"
    ${endif}
  ${endif}
!macroend

; Runs after electron-builder has (re)created its shortcuts.
!macro customInstall
  ${if} ${isUpdated}
    ${if} $DesktopShortcutExisted == "0"
      ; The user had removed the desktop icon — don't force it back on update.
      Delete "$DESKTOP\Fleet Commander.lnk"
    ${endif}
  ${endif}
!macroend
