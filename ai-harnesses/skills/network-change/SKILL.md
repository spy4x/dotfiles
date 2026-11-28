---
name: network-change
description: "How to change a machine's network without cutting it off: a second way in, a rollback timer armed before the change, checks, then persisting. Load before you change a VPN or tunnel, routes, DNS, a firewall, an interface, a NetworkManager connection, or SSH or proxy settings, on any of the owner's machines or servers."
---

# Network changes

Part of the global rules (`AGENTS.md`, "Network changes"); they bind as if written there. A broken
change on a machine with no other way in leaves the owner without internet and without an agent to
fix it, so every change can undo itself.

1. **Second way in, before you start.** Name it and check it works: SSH over the LAN next to SSH
   over a VPN, the provider's console or rescue system, or the owner at the keyboard. None → ask the
   owner first.
2. **Arm a rollback, then change.** Write the commands that undo the change, and schedule them
   before you apply it, so they run even when your session or the machine's internet dies:

   ```bash
   sudo -n systemd-run --collect --unit=net-rollback --on-active=120 /bin/sh -c '<commands that undo it>'
   ```

   Arming failed → do not apply the change.

   Undo means the state before the change: stop and disable the service, restore the saved config
   file, bring the old connection up. Save a copy of every file you change first.
3. **Check, then confirm.** On the changed machine, check what the change must keep working: a
   public site (`curl -sS -m 10 https://example.com`), name lookups (`getent hosts example.com`),
   and your own connection to the machine. All pass → `sudo -n systemctl stop net-rollback.timer`.
   Any fails → let the rollback run, then diagnose from the restored connection.
4. **Start first, persist after.** Apply with `systemctl start` or a runtime command; enable it at
   boot (`systemctl enable`, an autoconnect flag) only after step 3 passed, because the timer does
   not survive a reboot.
5. **Guard what stays on.** A tunnel that carries all traffic gets a guard that turns it off when
   the internet through it fails, like `tools/vpn-guard` (`docs/vpn-guard.md`), so a later failure
   on the far end cannot cut the machine off either.
