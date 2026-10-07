---
title: "Reconnect Descript"
group: fix_it
screen: connect
last_checked: 2026-09-26
keywords: descript, reconnect, key, not working, red
fix: connect-descript
---

Descript's key stopped working or it's out of credits. The built-in editor does its job meanwhile.

## The card says what's wrong

![Step 1](/help/screenshots/reconnect-descript-1.png)
<!-- api: POST /api/connections/descript/key {"key":"bad-key-help-demo"} -->
<!-- target: .card:has(h3:text-is("Descript")) -->

Open **Settings**, **Connect accounts**. The **Descript** card says the key isn't working.

## Top up, or make a new key

![Step 2](/help/screenshots/reconnect-descript-2.png)
<!-- mock: descript-credits -->

Log in to Descript. Top up, or make a new key, then copy the key.

## Paste the new key

![Step 3](/help/screenshots/reconnect-descript-3.png)
<!-- api: POST /api/connections/descript/key {"key":"bad-key-help-demo"} -->
<!-- target: role=textbox[name="Editor · Descript key"] -->

Tap **Disconnect** if you see it, paste the new key and tap **Check key**.

## The light turns green

![Step 4](/help/screenshots/reconnect-descript-4.png)
<!-- route: /settings -->
<!-- api: POST /api/connections/descript/key {"key":"good-descript-demo-key"} -->
<!-- target: [data-health="descript"] -->

The card turns green, and so does its light on **Settings**.

## Did this work?

If not, tap **No** below and we'll open the matching fix-it guide or email your helper.
