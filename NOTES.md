# Fleet Wolf Action Panel: owner notes

Running log of notes from the owner, oldest first, with what happened to each.

## 2026-10-31

1. **Name and form.** "It will be an add in so we can install it. It can be called the Fleet Wolf Action Panel."
   - Status: built in. Packaged as an installable MyGeotab add-in under that name.

2. **Hierarchy and delegation.** "I want the ability for it to be hierarchy on userlist. There can be all the todo, but based on user access we can make it so a person with lesser user access can be delegated action based on the higher to do list."
   - Status: built in.
   - Everyone gets an access level from their MyGeotab security clearance. An administrator can adjust the level for any clearance in Settings.
   - Supervisors and above see the full to-do list. Anyone below sees only tasks handed to them.
   - A person can only delegate to someone at a lower level who can already see the vehicles involved.

3. **Repo.** "Let me know when I need to create a new repo."
   - Status: done 2026-10-31. Private repo: https://github.com/rthomas91740-hash/fleetwolf-action-panel. Geotab's public rule covers hosted add-in files, not the repo; this add-in embeds its files in `manifest.json`.

4. **Health and cameras.** "Can we add cameras into here as well, like an offline check. This could be a section for Health, devices not locating, cameras not locating etc. Then for another word not health but it's around the fault codes, etc."
   - Status: built in. Added a Health tab (GO devices not reporting or not locating, device faults, camera health) and a separate Vehicle Faults tab for engine and vehicle fault codes. Rename Vehicle Faults if a different word suits better.

5. **Orb interface.** "Can we design the interface to have orbs like my website to display the information. I think old school is too simple, the guys in offices now are video game raised. Let's do more visual even though it means nothing. Is Geotab capable of allowing us to create that?"
   - Status: built in. Add-ins are ordinary web pages, so Geotab allows it. The panel now opens on a dark orb command center matching the website. Orb numbers and moons are real counts; the motion around them is decoration.

6. **Signature and data box.** "I'd like my signature at bottom. Small, and I'd like the data information blurb you have to be condensed in a box that says something like for data set info click here."
   - Status: built in. The data notes open from a "For data set info, click here" box. Messages that data failed to load stay outside the box so they can't be missed.
   - Correction: "Not my signature like that. Just something like hosted or designed by randy@fleetwolf.com for support or technical service or customization." The bottom line now reads "Designed by Fleet Wolf · For support, technical service or customization: randy@fleetwolf.com", and the address opens an email.

7. **First install rejected.** "It didn't accept." MyGeotab said "The configuration object is not valid."
   - Status: saved in the fleetwolf2 database on 2026-10-31; first-install checks still to do. The Configuration box cuts text at 50,000 characters and `manifest.json` is about 113,000, so `paste-config.json` is pasted and `fleetWolfActionPanel.html` is added on the Files tab. If a later Geotab change breaks this, the fallback is hosting the page on a public HTTPS address with no dashes.
