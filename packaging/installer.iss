#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef SourceDir
  #error SourceDir is required
#endif

[Setup]
AppId={{7D611C6C-516B-49A9-A739-4C143B22A5B3}
AppName=MobileTV
AppVersion={#AppVersion}
AppVerName=MobileTV {#AppVersion}
AppPublisher=gemron
AppPublisherURL=https://github.com/gemron/mobile-tv-screen
AppSupportURL=https://github.com/gemron/mobile-tv-screen/issues
AppUpdatesURL=https://github.com/gemron/mobile-tv-screen/releases
DefaultDirName={localappdata}\Programs\MobileTV
DefaultGroupName=MobileTV
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupArchitecture=x64
MinVersion=10.0.19041
UninstallDisplayIcon={app}\MobileTV.exe
UninstallDisplayName=MobileTV
CloseApplications=yes
RestartApplications=no
LicenseFile={#ProjectRoot}\LICENSE
SetupIconFile={#AppIcon}
OutputDir={#OutputDir}
OutputBaseFilename=MobileTV-{#AppVersion}-Setup-x64
#ifndef CompressionLevel
  #define CompressionLevel "lzma2/max"
#endif
Compression={#CompressionLevel}
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
#include "obsolete-locales.iss"

[Icons]
Name: "{group}\MobileTV"; Filename: "{app}\MobileTV.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\MobileTV"; Filename: "{app}\MobileTV.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\MobileTV.exe"; Description: "{cm:LaunchProgram,MobileTV}"; Flags: nowait postinstall skipifsilent

; No [UninstallDelete] entries: user configuration and uploads are outside {app}
; and are deliberately retained across upgrades and uninstallations.
