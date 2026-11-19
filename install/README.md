# Installing the platform on your own server

This directory installs the Apartment Association Platform for one association on its own
virtual server (VPS). One command, about 15 minutes, no files to edit. The design behind it is
docs/epics/E13_ROLLOUT.md; the technical contract is docs/DEPLOYMENT.md, "The simple install".

## What you need

- A fresh VPS with **Ubuntu 22.04 or 24.04, or Debian 12**, on **x86_64 (amd64)**: 2 GB of memory
  and 20 GB of disk are enough for one building. ARM servers are not supported yet.
- `root` access over SSH.
- Ports **80 and 443** free on the server (the installer stops if another program uses them).
- Optional: an own address such as `kyhistu.example.ee`. Without one, the site gets an address
  of the form `203-0-113-7.sslip.io`, which works at once.
- Optional: a mailbox that can send mail over SMTP (an app password of a regular mailbox is fine).
  Without it the platform works, but residents cannot be invited by e-mail until it is set.

## Install

As `root` on the server:

```sh
curl -fsSLO https://github.com/Chemoday/apartment-association-platform/releases/latest/download/install.sh
bash install.sh
```

This installs the latest version of the platform. For a given version on a new server, download the
installer of that release instead: `.../releases/download/v0.2.0/install.sh` (the releases and their
notes are on the project's GitHub page, under Releases). On a server that runs the platform
already, an installer only changes the answers and keeps the installed version; `update.sh`
(below) changes the version.

The installer first prepares the server without asking anything (2 to 3 minutes: it checks the
server, installs Docker when it is missing and downloads the platform). Then it asks at most five
questions, and after them it finishes on its own:

1. **The address of the site.** Type an own hostname, only the name: `kyhistu.example.ee` or
   `example.ee`, without `https://`, a port or a path. Before that, point it at the server: one DNS
   record of type `A` with the server's public IP, which the installer shows. The installer checks
   the record and tells you what to fix. Press Enter for no own address: the site then gets
   `<ip-with-dashes>.sslip.io`.
2. **Demo or a real installation.** A demo fills in a fictitious building that anyone can look at
   and act in as any role; it sends no mail. Questions 3 to 5 are skipped. A demo cannot later
   become the real installation: install the real one on a fresh server, or start over (below).
3. **The building.** Its address is looked up in the public building register of Estonia; pick
   the right building from the list, or type the address by hand when the register is not
   reachable or does not find it. Then the name of the association (for example `KÜ Näide 5`) and,
   optionally, its registry code (8 digits in Estonia).
4. **The chairman's e-mail.** The chairman gets an invitation to the site.
5. **E-mail (SMTP)**: the server, port, user name, password and the sender address of the mailbox
   the site sends from. The password is not shown while you type. Press Enter at the first prompt
   to skip it.

At the end the installer prints the address of the site, **the chairman's invitation link (shown
once; it is not written to any file)** and the next steps. With SMTP set, the chairman also gets
the invitation by e-mail.

## Afterwards

- **Run the installer again** at any time: it shows your previous answers as defaults (press Enter
  to keep them) and keeps every secret and all data. This is how you set or change the e-mail
  settings later. It never invites a chairman again unless you ask for it.
- **Update** to the latest version: `bash /opt/aap/bin/update.sh`, or to a given one:
  `bash /opt/aap/bin/update.sh v0.3.0`. Read the notes of the release first. A failed update rolls
  back on its own. Going back to an older version is refused: the database of a newer version may
  not work with an older one (`--allow-downgrade` exists for the rare case when the release notes
  say it is safe).
- **Which version runs:** the last line of `/opt/aap/install.log` that says `deploy ok`, or
  `cat /opt/aap/releases/$(cat /opt/aap/site/current_sha)/VERSION`.
- **Where things are:** everything lives in `/opt/aap`. `/opt/aap/install.log` records what the
  installer and the updates did; it holds no passwords, no e-mail addresses and no links.
- **Start over** (deletes all data of the site): `bash /opt/aap/bin/uninstall.sh --delete-data`.

## Without questions

Every answer can be given on the command line, which is how the installer is tested:

```sh
bash install.sh --yes --host kyhistu.example.ee --mode real \
    --building-address "Näide tn 5, Tallinn" --association-name "KÜ Näide 5" \
    --registry-code 80123456 --chairman-email chair@example.ee \
    --smtp-host smtp.example.ee --smtp-port 587 --smtp-user site@example.ee \
    --smtp-from site@example.ee --smtp-password-file /root/smtp-password
```

`bash install.sh --help` lists every option. The SMTP password is read from a file (or typed),
never taken from the command line, so it never lands in the shell history.
