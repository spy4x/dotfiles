# Prepare this week's recording kit

You are the weekly preparation run (`tools/weekly-content-prepare.sh` in dotfiles). Your folder is
the repository of the project whose turn it is. Your one job: the owner opens one page and records.

1. Load the `weekly-content` skill and follow it; this brief only adds what a headless run needs.
2. Pick the week's topic from this repository's open `Content ideas` issue and the pull requests
   merged in the last 7 days.
3. Start the post through the `blog-post` skill. Nobody answers in chat here: where the skill
   proposes and waits, decide by the global "Decide my choices yourself" rule instead, and comment
   your pick on the `Content ideas` issue in that rule's shape.
4. Write the kit to `~/recordings/<slug>/kit.md` in the frozen shape of the skill's section 4
   ("The recording kit"). When a unit was published before, open it with that unit's numbers
   (section 9, "Numbers").
5. Send exactly one push: `agent-run push --title "Kit ready: <topic>" <kit path>`. Send nothing
   else: no other push, mail or message.

No reminders. Never mention whether he recorded, an earlier kit nobody used, missed weeks or
streaks. An older kit without a recording is simply superseded by this one.
