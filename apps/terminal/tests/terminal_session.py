"""Exercise the actual terminal lifecycle and keyboard workflow on a synthetic book."""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import urllib.request


binary, endpoint, request_dir = sys.argv[1:4]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
environment = dict(os.environ, TERM="xterm-256color", NO_COLOR="1")
child = subprocess.Popen(
    [binary, "--endpoint", endpoint, "--book", "local-book", "--request-dir", request_dir, "tui"],
    stdin=slave, stdout=slave, stderr=slave, env=environment, start_new_session=True,
)
captured = bytearray()


def read_available(timeout=0.1):
    readable, _, _ = select.select([master], [], [], timeout)
    if readable:
        try:
            captured.extend(os.read(master, 65536))
        except OSError:
            pass


def plain():
    text = captured.decode("utf-8", errors="replace")
    text = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    return re.sub(r"\x1b\[[0-9;? :><=]*[A-Za-z~]", "", text)


def wait_for(text, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        read_available()
        if text in plain():
            return
        if child.poll() is not None:
            break
    raise AssertionError(f"TUI did not show {text!r}:\n{plain()[-7000:]}")


def send(data):
    os.write(master, data)
    time.sleep(0.07)
    read_available(0.01)


def paste(text):
    send(b"\x1b[200~" + text.encode() + b"\x1b[201~")


def report():
    request = urllib.request.Request(
        endpoint + "/v1/reports.get",
        data=json.dumps({"version": "rastrata-application-v1", "bookId": "local-book", "input": {"asOf": "2026-01-31"}}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)["data"]


try:
    wait_for("Create your local book")
    paste("PTY Co")
    send(b"\t\t")
    send(b"\x15")  # Ctrl+u clears the default fiscal year.
    paste("2026")
    send(b"\t\r")  # Last setup field submits the reviewed starting chart.
    wait_for("CHART OF ACCOUNTS")
    send(b"2n")
    wait_for("Journal draft")
    send(b"\x15")
    paste("2026-01-15")
    send(b"\t")
    paste("OPEN-PTY")
    send(b"\t")
    paste("Owner contribution")
    send(b"\t")
    paste("owner-contribution-pty")
    send(b"\t")
    paste("Owner contributed USD 1000")
    send(b"\t")
    paste("receipt-pty")
    send(b"\t\x10")  # Ctrl+p selects the debit account.
    wait_for("SELECT EXACT VALUE")
    paste("1000")
    send(b"\r")
    paste("1000.00")
    send(b"\t\t\x10")
    paste("3000")
    send(b"\r\t")
    paste("1000.00")
    send(b"\x13")  # Ctrl+s saves the draft without posting.
    wait_for("Draft saved")
    send(b"\x07")  # Ctrl+g inspects the immutable source event.
    wait_for("Source event")
    wait_for("owner-contribution-pty")
    wait_for("Status: unposted")
    send(b"\x1b")  # Return to the saved editor.
    send(b"\r")  # Last editor field prepares the exact posting.
    wait_for("REVIEW / postDraft")
    assert report()["balanceSheet"]["assets"] == "0.00", "preview posted a journal"
    send(b"\r")
    wait_for("COMMITTED")
    result = report()
    assert result["balanceSheet"]["assets"] == "1000.00"
    assert result["trialBalance"]["debit"] == "1000.00"
    assert result["trialBalance"]["credit"] == "1000.00"
    send(b"4")
    wait_for("TRIAL BALANCE")
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 40, 0, 0))
    child.send_signal(signal.SIGWINCH)
    time.sleep(0.2)
    read_available()
    send(b"t")
    wait_for("PROFIT & LOSS")
    send(b"q")
    child.wait(timeout=5)
    assert child.returncode == 0, f"terminal exit code {child.returncode}"
    after = termios.tcgetattr(slave)
    # Darwin adds PENDIN as kernel queue state when canonical mode is restored;
    # it is not a changed terminal setting. Compare every actual mode/control
    # character/speed while excluding only that documented transient state.
    # https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/tty.c
    restored, original = after.copy(), before.copy()
    if sys.platform == "darwin":
        restored[3] &= ~termios.PENDIN
        original[3] &= ~termios.PENDIN
    assert restored == original, f"terminal modes were not restored: before={before!r} after={after!r}"
    assert b"\x1b[?1049l" in captured, "alternate screen was not restored"
    print(json.dumps({"keyboardSetup": True, "keyboardPosting": True, "previewAssets": "0.00", "postedAssets": "1000.00", "resized": "40x20", "terminalRestored": True}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait(timeout=5)
    os.close(master)
    os.close(slave)
