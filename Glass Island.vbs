Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Falta instalar: abre una terminal en esta carpeta y ejecuta npm.cmd install", 48, "Glass Island"
  WScript.Quit
End If
CreateObject("WScript.Shell").Run """" & exe & """ """ & dir & """", 0, False
