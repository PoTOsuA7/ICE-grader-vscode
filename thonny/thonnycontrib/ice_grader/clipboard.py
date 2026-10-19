"""Puts a file on the clipboard, like copying it in the file manager, so pasting into a chat or an AI attaches it."""
import os
import pathlib
import subprocess
import sys

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def copy_command(platform=sys.platform, environ=os.environ):
    """-> (command, the tool's name for "not installed" errors). The file comes in ICE_FILE / ICE_URI."""
    if platform == "win32":
        return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:ICE_FILE"], "PowerShell"
    if platform == "darwin":
        return ["osascript", "-e", 'set the clipboard to (POSIX file (system attribute "ICE_FILE"))'], "osascript"
    if environ.get("WAYLAND_DISPLAY"):
        return ["sh", "-c", 'printf "%s\\r\\n" "$ICE_URI" | wl-copy --type text/uri-list'], "wl-copy"
    return ["sh", "-c", 'printf "%s\\r\\n" "$ICE_URI" | xclip -selection clipboard -t text/uri-list'], "xclip"


def copy_file(path, platform=sys.platform, run=subprocess.run):
    path = os.path.abspath(path)
    cmd, tool = copy_command(platform)
    env = dict(os.environ, ICE_FILE=path, ICE_URI=pathlib.Path(path).as_uri())
    try:
        r = run(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=20, creationflags=_NO_WINDOW)
    except FileNotFoundError:
        raise OSError("%s is not installed" % tool)
    except subprocess.TimeoutExpired:
        raise OSError("%s did not answer" % tool)
    err = (r.stderr or b"").decode("utf-8", "replace").strip()
    if r.returncode != 0:
        raise OSError(err.splitlines()[-1] if err else "%s failed (%d)" % (tool, r.returncode))
