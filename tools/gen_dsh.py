#!/usr/bin/env python3
"""Generate DSH agent presets from OpenCode agent files.

Each preset is one directory under dotfiles/.dsh/.agent-presets/<name>/,
containing preset.yml (metadata) and agent.cordis.yml (the composition).
The composition mounts:
  - persona (from the OpenCode agent body)
  - agent-instructions (loads AGENTS.md from cwd + ~/.dsh)
  - skill-filesystem (per-preset, because dsh-web-app disables it at host level)
  - tool-skill (the model-facing skill catalog + loader)

Re-run after editing any .config/opencode/agents/<name>.md:
    python3 tools/gen_dsh.py
"""
import pathlib
import sys

SRC = pathlib.Path(__file__).parent.parent / '.config' / 'opencode' / 'agents'
DST = pathlib.Path(__file__).parent.parent / '.dsh' / '.agent-presets'

ID_RE = __import__('re').compile(r'[a-z0-9][a-z0-9-]*')


def parse_frontmatter(text):
    parts = text.split('---', 2)
    if len(parts) < 3:
        return {}, text
    fm_text, body = parts[1], parts[2]
    fm = {}
    for line in fm_text.splitlines():
        if ':' in line and not line.startswith((' ', '-')):
            k, _, v = line.partition(':')
            fm[k.strip()] = v.strip()
    return fm, body.strip('\n')


def main():
    if not SRC.is_dir():
        sys.exit(f"opencode agents dir not found: {SRC}")
    DST.mkdir(parents=True, exist_ok=True)

    for f in sorted(SRC.glob('*.md')):
        name = f.stem
        if not ID_RE.fullmatch(name):
            print(f"SKIP {name}: id fails [a-z0-9][a-z0-9-]*")
            continue

        fm, body = parse_frontmatter(f.read_text())
        description = fm.get('description', '').strip()
        mode = fm.get('mode', 'subagent')
        kind = 'primary' if mode == 'primary' else 'subagent'
        pretty = name.replace('-', ' ').title()

        preset_dir = DST / name
        preset_dir.mkdir(parents=True, exist_ok=True)

        (preset_dir / 'preset.yml').write_text(
            f"name: {pretty}\n"
            f"description: {description}\n"
            f"kind: {kind}\n"
            f"order: 10\n"
        )

        indented = '\n'.join('      ' + line for line in body.splitlines())
        composition = f"""# Auto-generated from opencode/agents/{name}.md
# Body verbatim from the OpenCode agent file. Global AGENTS.md rules are
# folded in at runtime by @deepseek-ai/dsh-agent-instructions — they do not
# need to be repeated here.
#
# Skill discovery + tool: mounted per-preset because dsh-web-app disables
# them at the host level (presets own local discovery). skill-filesystem
# reads <dshHome>/skills for the global catalog; tool-skill exposes the
# catalog + loader to the model.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |-
{indented}

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: filesystem

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
"""
        (preset_dir / 'agent.cordis.yml').write_text(composition)
        print(f"wrote: {name} ({kind})")


if __name__ == '__main__':
    main()