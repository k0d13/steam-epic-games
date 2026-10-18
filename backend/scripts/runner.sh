#!/bin/sh
# The runner for one legendary job on Linux. runner.lua fills in the {braced}
# names. Started under setsid, so killing the negative PID takes legendary down
# too. awk keeps POSIX: no capture groups, so a progress line is split on its
# punctuation instead, and the directory comes in through ENVIRON because `-v`
# would read its backslashes as escapes.

DIR={dir}
EXE={exe}
set -- {args}

echo $$ > "$DIR/{pid}"

# A subshell, so legendary's exit code survives the pipe. It lands under a
# temporary name and is moved in once awk has written everything else.
(
  # The blank line answers a prompt -y doesn't cover; see the PowerShell runner.
  printf '\n' | "$EXE" "$@" 2>&1
  echo $? > "$DIR/{exit}.part"
) | DIR="$DIR" awk '
  BEGIN { dir = ENVIRON["DIR"]; percent = 0; done = 0; total = 0; eta = ""; elapsed = ""; speed = 0 }
  {
    print >> (dir "/{log}"); fflush(dir "/{log}")

    if ($0 ~ /Progress: [0-9.]+% \([0-9]+\/[0-9]+\), Running for [0-9:]+, ETA: [0-9:]+/) {
      line = $0; sub(/.*Progress: /, "", line); gsub(/[%(),\/]/, " ", line)
      split(line, f, " ")
      percent = f[1]; done = f[2]; total = f[3]; elapsed = f[6]; eta = f[8]
    } else if ($0 ~ /Download[ \t]+- [0-9.]+ MiB\/s \(raw\)/) {
      line = $0; sub(/.*Download[ \t]+- /, "", line)
      split(line, f, " "); speed = f[1]
    } else {
      if ($0 ~ /(ERROR|CRITICAL):/) { print > (dir "/{error}"); close(dir "/{error}") }
      next
    }

    status = dir "/{status}"
    printf "percent=%s\ndownloaded=%s\ntotal=%s\neta=%s\nelapsed=%s\nspeed=%s\n",
      percent, done, total, eta, elapsed, speed > status
    close(status)
  }
'

mv "$DIR/{exit}.part" "$DIR/{exit}"
