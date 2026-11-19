[Setup]
AppName=MobileTV
AppVersion={#AppVersion}
AppPublisher=gemron
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
SetupArchitecture=x64
MinVersion=10.0.19041
CreateAppDir=no
Uninstallable=no
CreateUninstallRegKey=no
UsePreviousLanguage=no
DisableWelcomePage=yes
DisableReadyPage=yes
DisableFinishedPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=MobileTV-{#AppVersion}-Online-Setup-x64
SetupIconFile={#AppIcon}
CloseApplications=no

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{src}\{#PayloadName}"; DestDir: "{tmp}"; DestName: "{#PayloadName}"; ExternalSize: {#PayloadSize}; Hash: "{#PayloadHash}"; Flags: external ignoreversion; Check: UseAdjacentFile; AfterInstall: InstallPayload
Source: "{param:SOURCE|https://github.com/gemron/mobile-tv-screen/releases/download/v{#AppVersion}/{#PayloadName}}"; DestDir: "{tmp}"; DestName: "{#PayloadName}"; ExternalSize: {#PayloadSize}; Hash: "{#PayloadHash}"; Flags: external download ignoreversion; Check: ShouldDownload; AfterInstall: InstallPayload

[Code]
var
  PayloadInstalled: Boolean;

function UseAdjacentFile: Boolean;
begin
  Result := (ExpandConstant('{param:SOURCE|}') = '') and FileExists(ExpandConstant('{src}\{#PayloadName}'));
end;

function ShouldDownload: Boolean;
begin
  Result := not UseAdjacentFile;
end;

procedure InstallPayload;
var
  Args, Arg, Key: String;
  I, Eq, ExitCode: Integer;
begin
  Args := '/SP- /LANG=' + ActiveLanguage;
  for I := 1 to ParamCount do begin
    Arg := ParamStr(I);
    Eq := Pos('=', Arg);
    if Eq > 0 then Key := Uppercase(Copy(Arg, 1, Eq - 1)) else Key := Uppercase(Arg);
    if (Key = '/VERYSILENT') or (Key = '/SILENT') or (Key = '/SUPPRESSMSGBOXES') or
       (Key = '/NORESTART') or (Key = '/NOICONS') or (Key = '/DIR') or (Key = '/GROUP') or
       (Key = '/TASKS') or (Key = '/MERGETASKS') then
      Args := Args + ' "' + Arg + '"';
  end;
  if not Exec(ExpandConstant('{tmp}\{#PayloadName}'), Args, '', SW_SHOW, ewWaitUntilTerminated, ExitCode) then
    RaiseException(SysErrorMessage(ExitCode));
  if ExitCode <> 0 then
    RaiseException(FmtMessage(SetupMessage(msgErrorFunctionFailed), ['Setup', IntToStr(ExitCode)]));
  PayloadInstalled := True;
end;

function GetCustomSetupExitCode: Integer;
begin
  if PayloadInstalled then Result := 0 else Result := 1;
end;
