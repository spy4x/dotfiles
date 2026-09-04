#!/usr/bin/env python3
"""Generate DSH user-invocable skills from OpenCode slash commands.

Each OpenCode `command.<name>.template` in opencode.json becomes one
`<dshHome>/skills/<name>/SKILL.md` with `user-invocable: true` and
`disable-model-invocation: true`, so the Web UI surfaces it as a `/<name>`
command without polluting the model-facing skill catalog.

Re-run after editing opencode.json's `command` block:
    python3 tools/gen_dsh_skills.py
"""
import json
import pathlib
import re
import sys

OPENCODE = pathlib.Path(__file__).parent.parent / '.config' / 'opencode' / 'opencode.json'
DST = pathlib.Path(__file__).parent.parent / '.dsh' / 'skills'


def main():
    if not OPENCODE.is_file():
        sys.exit(f"opencode.json not found: {OPENCODE}")
    data = json.loads(OPENCODE.read_text())
    commands = data.get('command', {})
    DST.mkdir(parents=True, exist_ok=True)

    for name, spec in commands.items():
        template = spec.get('template', '').strip()
        description = spec.get('description', '').strip()
        if not template:
            continue

        out_dir = DST / name
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / 'SKILL.md'
        out.write_text(f"""---
name: {name}
description: {description}
user-invocable: true
disable-model-invocation: true
license: MIT
---

# /{name}

{template}

## Invocation

User types `/<name> $ARGUMENTS` in the DSH composer. DSH loads this skill's
content as a `<system-reminder>` for the next model step. The `$ARGUMENTS`
token above is replaced by the user's typed arguments.
""")
        print(f"wrote: {name}")


if __name__ == '__main__':
    main()