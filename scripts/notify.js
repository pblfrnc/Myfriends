'use strict';
// Notificação nativa do sistema (macOS, Windows, Linux), sem dependências.
// Desligue com MYFRIENDS_NOTIFY=0.
const { spawn } = require('child_process');

const clean = (s, max) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f]/g, '').slice(0, max);

function notify(title, body, subtitle = '') {
  if (process.env.MYFRIENDS_NOTIFY === '0') return false;
  title = clean(title, 80); body = clean(body, 240); subtitle = clean(subtitle, 80);
  try {
    let cmd, args;
    if (process.platform === 'darwin') {
      // Os textos vão como argumentos (argv), nunca dentro do código AppleScript.
      cmd = 'osascript';
      args = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv) sound name "Glass"', '-e', 'end run', title, body, subtitle];
    } else if (process.platform === 'win32') {
      cmd = 'powershell.exe';
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$n = New-Object System.Windows.Forms.NotifyIcon;',
        '$n.Icon = [System.Drawing.SystemIcons]::Information;',
        '$n.BalloonTipTitle = $env:MF_TITLE; $n.BalloonTipText = $env:MF_BODY; $n.Visible = $true;',
        '$n.ShowBalloonTip(8000); Start-Sleep -Seconds 9; $n.Dispose()',
      ].join(' ');
      args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps];
    } else {
      cmd = 'notify-send';
      args = ['-a', 'MyFriends', subtitle ? `${title} · ${subtitle}` : title, body];
    }
    const child = spawn(cmd, args, {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, MF_TITLE: subtitle ? `${title} · ${subtitle}` : title, MF_BODY: body },
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

module.exports = { notify };
