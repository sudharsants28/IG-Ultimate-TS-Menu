# IG-Ultimate-TS-Menu

One small menu for **Instagram on the web (desktop)**. It sits in the header of a chat and lets you:

- **Unsend** your own messages (all of them, or only certain types, or only a date range)
- **Export** a chat to a file (TXT, JSON, HTML or PDF)
- **Jump** straight to the first message of a chat (or to a date)
- Run a **self-check** that tells you if the script still works after an Instagram update

It is a *userscript*. That means a small add-on in your browser (Violentmonkey or Tampermonkey) runs it for you. Nothing is sent anywhere. Everything happens inside your own browser.

> **Use at your own risk.** Unsending messages **cannot be undone**. This project is not made by, or connected to, Instagram or Meta.

---

## What you will see

In a chat header, between the person's name and the call icons:

```
[ TS ]  [ Select date ][ ⏫ ][ Export ⬇ ][ Unsend ✖ ]  [ 🚑 ]
```

| Button | Colour | What it does |
|---|---|---|
| **TS** | violet square, bold white letters | Opens this project page on GitHub |
| **Select date** | grey | Pick a start date and an end date, or choose *Full chat* |
| **⏫** | green square | Jump to the first message (or to your start date) |
| **Export ⬇** | blue | Save the chat as TXT, JSON, HTML or PDF |
| **Unsend ✖** | red | Unsend your messages (you choose what and when) |
| **🚑** | white square | Self-check: tests that the script can still read Instagram |

---

## Install (about 2 minutes)

### Step 1: install a userscript manager

Pick **one** of these. Both are free.

**Violentmonkey** (recommended): <https://violentmonkey.github.io/get-it/>
Works with Chrome, Firefox, Edge, Brave and other Chromium browsers. (Opera users: install it from the Chrome Web Store.)

**Tampermonkey**: <https://www.tampermonkey.net/>
Works with Chrome, Edge, Firefox, Safari and Opera. The page picks the right version for your browser.

Direct store pages:

| Browser | Tampermonkey | Violentmonkey |
|---|---|---|
| Chrome / Brave / Vivaldi | [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) | use the [Violentmonkey page](https://violentmonkey.github.io/get-it/) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/) | use the [Violentmonkey page](https://violentmonkey.github.io/get-it/) |
| Edge | use the [Tampermonkey page](https://www.tampermonkey.net/) | use the [Violentmonkey page](https://violentmonkey.github.io/get-it/) |
| Safari | use the [Tampermonkey page](https://www.tampermonkey.net/) (App Store) | not available |
| Opera | use the [Tampermonkey page](https://www.tampermonkey.net/) | install from the Chrome Web Store |

> **Chrome, Edge or Brave:** if the buttons do not show up later, open the extension's *Details* page (`chrome://extensions` or `edge://extensions`) and turn on **Allow User Scripts** if you see that switch. Then reload Instagram.

### Step 2: install the script

**Easy way (one click):** open this link. Your extension will show an **Install** page. Click **Install**.

<https://raw.githubusercontent.com/sudharsants28/IG-Ultimate-TS-Menu/main/IG-Ultimate-TS-Menu.user.js>

**Manual way (copy and paste):**

1. Open the file `IG-Ultimate-TS-Menu.user.js` from this page and copy **all** of its text.
2. Click the extension icon, then open the **Dashboard**.
3. Click **+** (new script). Delete everything in the editor.
4. Paste the code, then press **Save** (`Ctrl + S`).

### Step 3: open Instagram

Go to <https://www.instagram.com/direct/inbox/>, open any chat, and the buttons appear in the header. If you do not see them, press `F5` to reload the page.

When a new version is released, your extension updates the script automatically (you can also click *Check for updates* in the Dashboard).

---

## How to use it

### 1. Choose the dates (optional)

Click **Select date**. Choose a **From** date and a **To** date (or tick **Till today**), then press **Set date**. Or press **Full chat** to use the whole conversation.

- You can scroll the wheels with the mouse, or hover a wheel and **type** (for example `23`, or `may`, or `2024`).
- The day and month wheels go round in a circle.
- You can also just press **Jump**, **Export** or **Unsend** first. The date window opens by itself.
- The date is **forgotten** after every action, so you always choose again. This keeps you safe.

### 2. Jump

Press the green button. It scrolls to the first message of the chat, or to your start date. If that day has no messages, it lands on the nearest later day that has messages.

### 3. Export

Press **Export ⬇**. A window asks for:

- the name to print for you, and for the other person (already filled in, you can change it),
- the format: **TXT**, **JSON**, **HTML** or **PDF**,
- **Include media** (HTML and PDF only): saves the photos *you* sent inside the file. It is off by default, because it makes the file bigger.

**About PDF:** it has the same layout as the HTML file, always in the light theme. When the export is done, your browser's **print window** opens. Choose **Save as PDF** as the destination and press **Save**. (If the print window cannot open, the script saves an HTML file instead, which you can print yourself with `Ctrl + P`.)

While it runs you have two buttons:

- **Export till here** (yellow): stops reading and saves what it has so far. The file name ends with `_partial`.
- **Kill** (orange): cancels everything and saves nothing. `Esc` does the same.

### 4. Unsend

Press **Unsend ✖**, then:

1. Choose **what** to unsend: text, voice messages, media, reels, posts, other, or **EVERYTHING**.
2. Read the final confirmation, which shows the date range and the types you chose.
3. The script unsends your messages one by one, slowly and with small random pauses, so it does not look like a robot.

Only **your own** messages can be unsent (Instagram does not allow unsending someone else's). Press the orange **Stop** button or `Esc` at any time to stop.

While anything is running, the other buttons turn grey so nothing gets mixed up. Keep the tab open and in front.

### 5. Self-check 🚑

If something stops working (for example after an Instagram update), press the white 🚑 button. It looks at the page and shows a short report. It never changes your chat. Use **Copy report** and paste it into a GitHub issue, so the problem is easy to find and fix.

---

## Good to know

- **Desktop only.** It is built for Instagram on a computer browser. It is not tested on phones.
- **Instagram can change its website at any time.** When that happens a button may stop working until the script is updated. The self-check helps find which part broke.
- **Date ranges need Instagram in English.** The date labels are read in English.
- **Unsend in large amounts can make Instagram suspicious.** The script is slow on purpose, but there is no guarantee. Use it carefully, with a small test first.
- **Message types are guessed.** Instagram does not label messages, so *voice* and *other* are the least reliable. If a message is not recognised, it is skipped (unless you chose EVERYTHING).
- Nothing is saved between runs. No cookies, no storage, no tracking.

---

## Problems?

1. Reload the Instagram page (`F5`) and try again.
2. Press the 🚑 self-check and copy the report.
3. Open an issue here: <https://github.com/sudharsants28/IG-Ultimate-TS-Menu/issues>, and paste the report plus a short description.

---

## Credits

The Unsend engine is based on **[instagram-dm-unsender](https://github.com/thoughtsunificator/instagram-dm-unsender)** by Romain Lebesle (thoughtsunificator), released under the MIT license. Thank you for the original idea and code.

Everything else (the combined menu, date range, export, jump, self-check) was built for this project by **TS**.

## License

MIT License. See the [LICENSE](LICENSE) file. This project is not affiliated with Instagram or Meta.

---

## Changelog

- **v7**: first public release.
