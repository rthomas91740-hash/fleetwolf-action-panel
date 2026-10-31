# Fleet Wolf Action Panel

A MyGeotab add-in that turns fleet data into a to-do list. It opens on what needs attention, puts an estimated cost on it where it can, and lets a manager hand each item to the right person.

## Install

1. The page is published from this repo's `index.html` on GitHub Pages, the same way as the other Fleet Wolf add-ins.
2. In the customer's MyGeotab database, open **System Settings > Add-Ins**, add a new add-in, and paste the contents of `addin-config.json` on the **Configuration** tab. Select **Done**, then save.
3. Reload MyGeotab and open **Fleet Wolf Action Panel** in the Add-Ins menu.
4. Sign in as an administrator, open **Settings**, and set the fuel price, work days and access levels.

Embedding doesn't work for this add-in. `manifest.json` is about 113,000 characters and the Configuration box stops at 50,000, and adding files on the Files tab left the saved add-in with no page.

## Check on first install

These could only be tested against a simulated MyGeotab API, so confirm them in a real database:

- The to-do list loads and the numbers match a known vehicle's trip history.
- **Delegate** saves, and the person sees the task under **My tasks**.
- **View trips** opens the right vehicle and dates.
- Custom security clearances show their names and land on the right access level.
- The **Cameras** orb's counts match the Assets > Cameras page. Geotab documents the camera reading for rules but not for the API, so this is the first thing to confirm.
- The **Vehicle Faults** list matches the Faults page, and each code lands in the right section. Severity and source labels were written without live data to compare against.
- If you turn on **Message vehicle**, a test message reaches the vehicle. It is off by default.

## To-dos it raises

| To-do | Raised when |
|---|---|
| Safety | A vehicle passes the event minimum and either the rate per 1,000 miles or the rise over last period. |
| Idle fuel | A group passes the cost floor and either idle time is rising or idling per work day is high. |
| Off-schedule use | A vehicle drives on days its schedule says it should be parked. |
| Unused vehicle | A vehicle reports normally but does not drive on any scheduled work day. |
| Device not reporting (Health) | A vehicle that was recently driving has stopped reporting. |
| Device not locating (Health) | A GO device is reporting without a usable GPS position. |
| Camera problem (Health) | Geotab's camera health reading is Unstable, Unhealthy or Not Working. |
| Device fault (Health) | A fault from the GO device or camera itself, such as being unplugged. |
| Vehicle fault code (Vehicle Faults) | A vehicle has an active medium or high severity code. Low severity codes are listed but raise no to-do unless Settings says so. |

Health and Vehicle Faults each open from their own orbs with a summary, and their to-dos can be delegated like any other. Camera checks read Geotab's "Video device health" status diagnostic (`aOzdYMcJkw06ft9g4uXvpIA`), which Geotab documents for GO Focus, GO Focus Plus, Lytx Surfsight and Xirgo. Other cameras, and vehicles with no reading, are not counted. Fault codes run through today; everything else uses complete days.

The panel opens on a dark command center in the style of the Fleet Wolf website. The numbers on the orbs and the moons circling them are real to-do counts. An orb's glow shows its worst severity: red for high, amber for medium, and a high-severity orb also pulses. The sweep, rings and float are decoration. **Pause motion** stops them for that viewer, and they also stop when a computer is set to reduce motion.

Every threshold is in Settings. Each period is complete days only and is compared with the same number of days before it.

## Access levels and delegation

Each person's level comes from their MyGeotab security clearance: Administrator, Supervisor, Standard (Default User and, unless changed, custom clearances) or View Only. Drive App users have no access to the panel.

- Supervisors and above see the full list. The bar can be changed in Settings.
- Everyone below sees **My tasks** only, and the panel does not load fleet data for them.
- Delegation only goes to a lower level, and only to someone who can already see the vehicles involved.
- A finished task hides its to-do for 7 days. If the problem is still there, it returns.
- Only administrators can change settings.

Hiding the list is a convenience, not a security boundary. MyGeotab's own clearances and data access decide what a user can actually read. Delegated tasks and settings are stored in MyGeotab's add-in storage, which any signed-in user of that database could read through the API.

View Only users are not offered as delegates, because MyGeotab will not let them save and they could never mark a task done. Tasks do not notify anyone yet; people see them next time they open the panel.

## Develop

No dependencies. Node.js is only needed for maintenance.

    npm test
    npm run build
    npm run demo

`npm run demo` serves the real page on http://127.0.0.1:8766 with a made-up fleet and a user switcher. Demo files are not included in `manifest.json`.

Owner notes are logged in `NOTES.md`.
